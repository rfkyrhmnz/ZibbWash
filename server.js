'use strict';
/**
 * ZibbWash Laundry: server HTTP + API (Node.js murni, tanpa dependensi).
 *   node server.js            → http://localhost:3000
 * Variabel lingkungan opsional:
 *   PORT, HOST
 *   DB_FILE | DATA_DIR            lokasi database (di hosting: arahkan ke disk/volume permanen)
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *                                 salinan database di Upstash (gratis) untuk hosting tanpa disk permanen, mis. Render gratis
 *   REMOTE_DB_KEY                 awalan kunci di Upstash (bawaan "zibbwash")
 *   NODE_ENV=production           kata sandi admin awal dibuat acak bila ADMIN_PASSWORD kosong
 *   ADMIN_PASSWORD                kata sandi admin awal (hanya saat database pertama dibuat)
 *   RESET_ADMIN_PASSWORD=1        paksa kata sandi admin = ADMIN_PASSWORD saat start (lupa kata sandi)
 *   TRUST_PROXY=1                 percayai 1 lapis proxy untuk membaca IP asli (X-Forwarded-For), default mati
 *   GOOGLE_MAPS_API_KEY           menimpa kunci yang diisi di Admin > Tarif & pengaturan
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { Store, resolveDbFile } = require('./lib/store');
const { RemoteStore } = require('./lib/remote');
const auth = require('./lib/auth');
const L = require('./lib/logic');

const { HttpError } = L;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
};
const MAX_BODY = 200 * 1024;

function presentUser(u) {
  if (!u) return null;
  if (u.role === 'admin') return { id: u.id, role: 'admin', name: u.name, username: u.username };
  return {
    id: u.id, role: 'customer', name: u.name, phone: u.phone,
    stamps: u.stamps || 0, vouchers: u.vouchers || 0, totalStamps: u.totalStamps || 0, createdAt: u.createdAt,
  };
}

function createApp(opts = {}) {
  const publicDir = opts.publicDir || path.join(__dirname, 'public');
  const production = opts.production !== undefined ? !!opts.production : process.env.NODE_ENV === 'production';
  const dbLocation = opts.dbFile ? { file: opts.dbFile, persistent: true } : resolveDbFile();
  const store = new Store(dbLocation.file, { adminPassword: opts.adminPassword || process.env.ADMIN_PASSWORD || null, production });
  const remote = opts.remote || null; // RemoteStore (Upstash) bila dipakai; berkas lokal hanya jadi cache kerja
  if (remote) remote.attach(store);
  const loginLimiter = new auth.RateLimiter(8, 5 * 60 * 1000);
  const routes = [];

  // Di balik proxy hosting, alamat socket adalah milik proxy. Hanya bila TRUST_PROXY=n diset (n = jumlah proxy
  // tepercaya di depan server), IP klien dibaca dari entri ke-n dari kanan di X-Forwarded-For.
  // Default mati karena header itu bisa dipalsukan bila server tidak benar-benar berada di belakang proxy.
  const trustProxy = (() => {
    if (opts.trustProxy !== undefined) return Number(opts.trustProxy) || 0;
    const raw = String(process.env.TRUST_PROXY || '');
    return /^(true|yes|on)$/i.test(raw) ? 1 : Number(raw) || 0;
  })();
  function clientIp(req) {
    const peer = req.socket.remoteAddress || 'unknown';
    if (!trustProxy) return peer;
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return hops.length >= trustProxy ? hops[hops.length - trustProxy] : peer;
  }

  // Pembaruan langsung lewat Server-Sent Events: server hanya memberi tahu "pesanan X berubah"; klien lalu
  // mengambil datanya lewat endpoint biasa, jadi hak akses tetap diperiksa seperti biasa dan tidak ada data bocor.
  const STREAM = Symbol('stream');
  const live = new Set(); // { res, userId, role, token }
  const MAX_LIVE_PER_USER = 4;
  const MAX_LIVE_TOTAL = 500;
  function liveSend(c, chunk) { try { c.res.write(chunk); } catch { live.delete(c); } }
  function liveClose(match) {
    for (const c of [...live]) if (match(c)) { live.delete(c); try { c.res.end(); } catch { /* sudah putus */ } }
  }
  function publish(type, orderId, userId) {
    const msg = `event: ${type}\ndata: ${JSON.stringify({ id: orderId })}\n\n`;
    for (const c of live) if (c.role === 'admin' || (userId && c.userId === userId)) liveSend(c, msg);
  }
  // Komentar berkala menjaga koneksi tetap hidup melewati proxy yang memutus koneksi sepi.
  const heartbeat = setInterval(() => { for (const c of live) liveSend(c, ': ping\n\n'); }, 25000);
  heartbeat.unref();

  function route(method, pattern, access, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, access, handler });
  }
  const db = () => store.db;
  const settings = () => store.db.settings;

  function loadOrder(ctx, adminView) {
    const o = db().orders.find((x) => x.id === ctx.params.id);
    if (!o || (!adminView && o.userId !== ctx.user.id)) throw new HttpError(404, 'Pesanan tidak ditemukan.');
    return o;
  }

  function startSession(ctx, userId) {
    const token = auth.createSession(db(), userId);
    const secure = ctx.req.headers['x-forwarded-proto'] === 'https' || ctx.req.socket.encrypted ? '; Secure' : '';
    ctx.res.setHeader('Set-Cookie', `zw_sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(auth.SESSION_TTL_MS / 1000)}${secure}`);
  }

  // ───────────── publik ─────────────
  route('GET', '/api/config', null, () => {
    const s = settings();
    return {
      business: {
        name: s.business.name, phone: s.business.phone, whatsapp: s.business.whatsapp, address: s.business.address, lat: s.business.lat, lng: s.business.lng,
        instagram: s.business.instagram, email: s.business.email,
      },
      mapsKey: process.env.GOOGLE_MAPS_API_KEY || s.maps.apiKey || '',
      services: s.services, garmentTypes: s.garmentTypes, delivery: s.delivery, loyalty: s.loyalty, paymentMethods: s.paymentMethods,
    };
  });

  // ───────────── auth ─────────────
  route('POST', '/api/auth/register', null, (ctx) => {
    const b = ctx.body;
    const name = L.cleanStr(b.name, 60);
    const phone = L.normalizePhone(b.phone);
    const password = String(b.password || '');
    const errors = {};
    if (name.length < 2) errors.name = 'Nama minimal 2 huruf.';
    if (!L.isValidPhone(phone)) errors.phone = 'Nomor HP tidak valid. Contoh: 081234567890.';
    if (password.length < 6) errors.password = 'Kata sandi minimal 6 karakter.';
    if (password.length > 100) errors.password = 'Kata sandi terlalu panjang.';
    if (Object.keys(errors).length) throw new HttpError(422, 'Periksa kembali data pendaftaran.', errors);
    if (db().users.some((u) => u.role === 'customer' && u.phone === phone)) {
      throw new HttpError(409, 'Nomor ini sudah terdaftar.', { phone: 'Nomor ini sudah terdaftar. Silakan masuk.' });
    }
    const { salt, hash } = auth.hashPassword(password);
    const user = {
      id: crypto.randomUUID(), role: 'customer', name, phone, salt, hash,
      stamps: 0, vouchers: 0, totalStamps: 0, loyaltyLog: [], createdAt: new Date().toISOString(),
    };
    db().users.push(user);
    startSession(ctx, user.id);
    return { user: presentUser(user) };
  });

  route('POST', '/api/auth/login', null, (ctx) => {
    const role = ctx.body.role === 'admin' ? 'admin' : 'customer';
    const identifier = L.cleanStr(ctx.body.identifier, 60);
    const password = String(ctx.body.password || '');
    const key = `${clientIp(ctx.req)}|${role}|${identifier.toLowerCase()}`;
    const lim = loginLimiter.check(key);
    if (lim.limited) throw new HttpError(429, `Terlalu banyak percobaan. Coba lagi dalam ${Math.ceil(lim.retryAfterSec / 60)} menit.`);
    const fail = role === 'admin' ? 'Username atau kata sandi salah.' : 'Nomor HP atau kata sandi salah.';
    const user = role === 'admin'
      ? db().users.find((u) => u.role === 'admin' && u.username.toLowerCase() === identifier.toLowerCase())
      : db().users.find((u) => u.role === 'customer' && u.phone === L.normalizePhone(identifier));
    if (!user) { auth.verifyDummy(password); loginLimiter.fail(key); throw new HttpError(401, fail); }
    let ok = false;
    try { ok = auth.verifyPassword(password, user.salt, user.hash); } catch { ok = false; }
    if (!ok) { loginLimiter.fail(key); throw new HttpError(401, fail); }
    loginLimiter.reset(key);
    startSession(ctx, user.id);
    return { user: presentUser(user) };
  });

  route('POST', '/api/auth/logout', null, (ctx) => {
    auth.destroySession(db(), ctx.token);
    liveClose((c) => c.token === ctx.token);
    ctx.res.setHeader('Set-Cookie', 'zw_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return { ok: true };
  });

  // Aliran pembaruan langsung. Klien (EventSource) tersambung ulang otomatis bila terputus.
  route('GET', '/api/events', 'any', (ctx) => {
    if (live.size >= MAX_LIVE_TOTAL) throw new HttpError(503, 'Server sedang ramai. Coba lagi sebentar lagi.');
    const mine = [...live].filter((c) => c.userId === ctx.user.id);
    while (mine.length >= MAX_LIVE_PER_USER) { const oldest = mine.shift(); liveClose((c) => c === oldest); }
    const { req, res } = ctx;
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\nevent: hello\ndata: {}\n\n');
    const client = { res, userId: ctx.user.id, role: ctx.user.role, token: ctx.token };
    live.add(client);
    res.on('close', () => live.delete(client)); // pada Node ≥16 hanya 'close' milik res yang menandai koneksi putus
    return STREAM;
  });

  route('GET', '/api/auth/me', null, (ctx) => ({ user: presentUser(ctx.user) }));

  route('POST', '/api/auth/password', 'any', (ctx) => {
    const current = String(ctx.body.current || '');
    const next = String(ctx.body.next || '');
    const u = db().users.find((x) => x.id === ctx.user.id);
    let ok = false;
    try { ok = auth.verifyPassword(current, u.salt, u.hash); } catch { ok = false; }
    if (!ok) throw new HttpError(422, 'Kata sandi saat ini salah.', { current: 'Kata sandi saat ini salah.' });
    if (next.length < 6 || next.length > 100) throw new HttpError(422, 'Kata sandi baru minimal 6 karakter.', { next: 'Minimal 6 karakter.' });
    Object.assign(u, auth.hashPassword(next));
    auth.destroyUserSessions(db(), u.id, ctx.token);
    liveClose((c) => c.userId === u.id && c.token !== ctx.token);
    return { ok: true };
  });

  // ───────────── pelanggan ─────────────
  route('POST', '/api/quote', 'customer', (ctx) => L.quoteOrder(ctx.body, settings(), db().users.find((u) => u.id === ctx.user.id)));

  route('GET', '/api/orders', 'customer', (ctx) => ({
    orders: db().orders.filter((o) => o.userId === ctx.user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(L.presentOrder),
  }));

  route('POST', '/api/orders', 'customer', (ctx) => {
    const user = db().users.find((u) => u.id === ctx.user.id);
    const v = L.validateOrderInput(ctx.body, settings(), user);
    const order = L.createOrder(db(), user, v, settings());
    return { order: L.presentOrder(order) };
  });

  route('GET', '/api/orders/:id', 'customer', (ctx) => ({ order: L.presentOrder(loadOrder(ctx, false)) }));

  route('POST', '/api/orders/:id/cancel', 'customer', (ctx) => {
    const o = loadOrder(ctx, false);
    if (o.status !== 'received' || o.payment.status !== 'unpaid') {
      throw new HttpError(409, 'Pesanan sudah diproses, tidak bisa dibatalkan sendiri. Hubungi admin lewat WhatsApp.');
    }
    L.cancelOrder(db(), o, 'pelanggan', 'Dibatalkan oleh pelanggan.');
    return { order: L.presentOrder(o) };
  });

  route('POST', '/api/orders/:id/pay', 'customer', (ctx) => {
    const o = loadOrder(ctx, false);
    const method = String(ctx.body.method || '');
    if (!settings().paymentMethods.some((m) => m.id === method)) throw new HttpError(422, 'Metode pembayaran tidak tersedia.');
    if (method === 'cash') L.chooseCash(o);
    else L.markPaid(db(), o, method, 'pelanggan', new Date(), true);
    return { order: L.presentOrder(o), user: presentUser(db().users.find((u) => u.id === ctx.user.id)) };
  });

  route('GET', '/api/loyalty', 'customer', (ctx) => {
    const u = db().users.find((x) => x.id === ctx.user.id);
    return { user: presentUser(u), log: u.loyaltyLog || [], loyalty: settings().loyalty };
  });

  // ───────────── admin ─────────────
  route('GET', '/api/admin/stats', 'admin', () => {
    const stats = { new: 0, processing: 0, ready: 0, done: 0, cancelled: 0, awaitingPayment: 0, awaitingAmount: 0, revenue: 0, total: 0, customers: 0 };
    for (const o of db().orders) {
      stats.total += 1;
      stats[L.statusGroup(o.status)] += 1;
      const bill = L.computeBill(o);
      if (o.status !== 'cancelled' && o.payment.status === 'unpaid' && bill.isFinal) { stats.awaitingPayment += 1; stats.awaitingAmount += bill.total; }
      if (o.payment.status === 'paid') stats.revenue += bill.total;
    }
    stats.customers = db().users.filter((u) => u.role === 'customer').length;
    return { stats };
  });

  route('GET', '/api/admin/orders', 'admin', (ctx) => {
    const status = ctx.query.get('status') || 'all';
    const q = (ctx.query.get('q') || '').trim().toLowerCase();
    let list = db().orders.slice();
    if (status !== 'all') list = list.filter((o) => o.status === status || L.statusGroup(o.status) === status);
    if (q) list = list.filter((o) => o.id.toLowerCase().includes(q) || o.customerName.toLowerCase().includes(q) || o.customerPhone.includes(q));
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { orders: list.map(L.presentOrder) };
  });

  route('GET', '/api/admin/orders/:id', 'admin', (ctx) => {
    const o = loadOrder(ctx, true);
    const u = db().users.find((x) => x.id === o.userId);
    return { order: L.presentOrder(o), customer: u ? { name: u.name, phone: u.phone, stamps: u.stamps || 0, vouchers: u.vouchers || 0 } : null };
  });

  route('POST', '/api/admin/orders/:id/weight', 'admin', (ctx) => {
    const o = loadOrder(ctx, true);
    L.setWeight(db(), o, ctx.body.weight, 'admin');
    return { order: L.presentOrder(o) };
  });

  route('POST', '/api/admin/orders/:id/status', 'admin', (ctx) => {
    const o = loadOrder(ctx, true);
    const { award } = L.setStatus(db(), o, String(ctx.body.status || ''), ctx.body.note, 'admin');
    return { order: L.presentOrder(o), award };
  });

  route('POST', '/api/admin/orders/:id/payment', 'admin', (ctx) => {
    const o = loadOrder(ctx, true);
    const method = ctx.body.method ? String(ctx.body.method) : 'cash';
    if (!settings().paymentMethods.some((m) => m.id === method)) throw new HttpError(422, 'Metode pembayaran tidak tersedia.');
    const { award } = L.markPaid(db(), o, method, 'admin');
    return { order: L.presentOrder(o), award };
  });

  route('POST', '/api/admin/orders/:id/cancel', 'admin', (ctx) => {
    const o = loadOrder(ctx, true);
    L.cancelOrder(db(), o, 'admin', ctx.body.note || 'Dibatalkan oleh admin.');
    return { order: L.presentOrder(o) };
  });

  route('GET', '/api/admin/customers', 'admin', () => {
    const customers = db().users.filter((u) => u.role === 'customer').map((u) => {
      const orders = db().orders.filter((o) => o.userId === u.id);
      const spent = orders.filter((o) => o.payment.status === 'paid').reduce((s, o) => s + L.computeBill(o).total, 0);
      return { id: u.id, name: u.name, phone: u.phone, stamps: u.stamps || 0, vouchers: u.vouchers || 0, orders: orders.length, spent, createdAt: u.createdAt };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { customers, loyalty: settings().loyalty };
  });

  // Cadangan seluruh data (tanpa sesi login). Berisi data pelanggan dan hash kata sandi: simpan dengan aman.
  // Untuk memulihkan: hentikan server, salin berkas ini menjadi db.json di lokasi data, lalu jalankan lagi.
  route('GET', '/api/admin/backup', 'admin', (ctx) => {
    const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }).replace(/\D/g, '').slice(0, 12);
    ctx.res.setHeader('Content-Disposition', `attachment; filename="zibbwash-cadangan-${stamp}.json"`);
    const { sessions, ...data } = db(); // eslint-disable-line no-unused-vars
    return data;
  });

  route('GET', '/api/admin/settings', 'admin', () => {
    const s = settings();
    return { business: s.business, maps: s.maps, services: s.services, delivery: s.delivery, loyalty: s.loyalty };
  });

  route('PUT', '/api/admin/settings', 'admin', (ctx) => {
    const b = ctx.body || {};
    const s = settings();
    const errors = {};
    const int = (v, min, max, key, msg) => {
      const n = Number(v);
      if (v === '' || v == null || !Number.isFinite(n) || n < min || n > max) { errors[key] = msg; return null; }
      return n;
    };
    const next = JSON.parse(JSON.stringify({ business: s.business, maps: s.maps, services: s.services, delivery: s.delivery, loyalty: s.loyalty }));

    if (b.business) {
      const bb = b.business;
      const name = L.cleanStr(bb.name, 60);
      if (name.length < 2) errors['business.name'] = 'Nama bisnis wajib diisi.';
      const phone = L.normalizePhone(bb.phone);
      if (!L.isValidPhone(phone)) errors['business.phone'] = 'Nomor HP tidak valid.';
      const lat = int(bb.lat, -90, 90, 'business.lat', 'Latitude harus antara -90 dan 90.');
      const lng = int(bb.lng, -180, 180, 'business.lng', 'Longitude harus antara -180 dan 180.');
      // Medsos opsional: tidak dikirim = nilai lama dipertahankan; string kosong = disembunyikan dari website.
      const instagram = bb.instagram === undefined ? next.business.instagram : String(bb.instagram || '').trim().replace(/^@/, '');
      if (instagram && !/^[A-Za-z0-9._]{1,30}$/.test(instagram)) errors['business.instagram'] = 'Username Instagram hanya huruf, angka, titik, dan garis bawah (maksimal 30).';
      const email = bb.email === undefined ? next.business.email : String(bb.email || '').trim();
      if (email && !(email.length <= 100 && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(email))) errors['business.email'] = 'Alamat email tidak valid.';
      if (!errors['business.name'] && !errors['business.phone'] && lat != null && lng != null) {
        Object.assign(next.business, { name, phone, whatsapp: '62' + phone.slice(1), address: L.cleanStr(bb.address, 200), lat, lng, instagram, email });
      }
    }
    if (b.maps) {
      const key = String(b.maps.apiKey || '').trim();
      if (!/^[\w-]{0,120}$/.test(key)) errors['maps.apiKey'] = 'Kunci API hanya boleh berisi huruf, angka, strip, dan garis bawah.';
      else next.maps.apiKey = key;
    }
    if (Array.isArray(b.services)) {
      for (const sv of b.services) {
        const cur = next.services.find((x) => x.id === sv.id);
        if (!cur) continue;
        const price = int(sv.pricePerKg, 0, 1000000, `services.${sv.id}.pricePerKg`, 'Tarif harus 0 sampai 1.000.000.');
        const eta = L.cleanStr(sv.eta, 30);
        if (price != null) cur.pricePerKg = Math.round(price);
        if (eta) cur.eta = eta;
      }
    }
    if (b.delivery) {
      const d = b.delivery;
      const freeKm = int(d.freeKm, 0, 50, 'delivery.freeKm', 'Gratis ongkir 0–50 km.');
      const perKm = int(d.perKm, 0, 100000, 'delivery.perKm', 'Tarif per km 0–100.000.');
      const maxKm = int(d.maxKm, 1, 200, 'delivery.maxKm', 'Jangkauan 1–200 km.');
      if (freeKm != null) next.delivery.freeKm = freeKm;
      if (perKm != null) next.delivery.perKm = Math.round(perKm);
      if (maxKm != null) next.delivery.maxKm = maxKm;
      next.delivery.chargePerLeg = !!d.chargePerLeg;
      const openTime = d.openTime === undefined ? next.delivery.openTime : String(d.openTime);
      const closeTime = d.closeTime === undefined ? next.delivery.closeTime : String(d.closeTime);
      if (!L.TIME_RE.test(openTime)) errors['delivery.openTime'] = 'Isi jam buka dengan format JJ:MM.';
      if (!L.TIME_RE.test(closeTime)) errors['delivery.closeTime'] = 'Isi jam tutup dengan format JJ:MM.';
      else if (L.TIME_RE.test(openTime) && closeTime <= openTime) errors['delivery.closeTime'] = 'Jam tutup harus lebih lambat dari jam buka.';
      next.delivery.openTime = openTime;
      next.delivery.closeTime = closeTime;
    }
    if (b.loyalty) {
      const l = b.loyalty;
      const min = int(l.minTransaction, 0, 10000000, 'loyalty.minTransaction', 'Minimal transaksi 0–10.000.000.');
      const need = int(l.stampsForReward, 1, 50, 'loyalty.stampsForReward', 'Jumlah stamp 1–50.');
      const kg = int(l.rewardMaxKg, 0.5, 50, 'loyalty.rewardMaxKg', 'Batas berat hadiah 0,5–50 kg.');
      if (min != null) next.loyalty.minTransaction = Math.round(min);
      if (need != null) next.loyalty.stampsForReward = Math.round(need);
      if (kg != null) next.loyalty.rewardMaxKg = kg;
    }
    if (Object.keys(errors).length) throw new HttpError(422, 'Ada isian yang belum valid.', errors);
    Object.assign(s.business, next.business);
    Object.assign(s.maps, next.maps);
    s.services = next.services;
    Object.assign(s.delivery, next.delivery);
    Object.assign(s.loyalty, next.loyalty);
    return { ok: true };
  });

  // ───────────── HTTP plumbing ─────────────
  function sendJson(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new HttpError(413, 'Data terlalu besar.')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bukan objek');
          resolve(parsed);
        } catch { reject(new HttpError(400, 'Format data tidak valid (harus JSON).')); }
      });
      req.on('error', reject);
    });
  }

  async function handleApi(req, res, url) {
    const matches = [];
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (m) matches.push({ r, m });
    }
    if (!matches.length) throw new HttpError(404, 'Endpoint tidak ditemukan.');
    const hit = matches.find((x) => x.r.method === req.method);
    if (!hit) throw new HttpError(405, 'Metode tidak diizinkan.');
    const { r, m } = hit;

    const cookies = auth.parseCookies(req.headers.cookie);
    const token = cookies.zw_sid || null;
    const sess = auth.findSession(db(), token);
    const user = sess ? db().users.find((u) => u.id === sess.userId) : null;
    const ctx = { req, res, token, user: user ? presentUser(user) : null, params: {}, query: url.searchParams, body: {} };
    r.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(m[i + 1]); });

    if (r.access) {
      if (!ctx.user) throw new HttpError(401, 'Silakan masuk terlebih dahulu.');
      if (r.access !== 'any' && ctx.user.role !== r.access) throw new HttpError(403, 'Akun ini tidak punya akses ke halaman tersebut.');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const ct = String(req.headers['content-type'] || '');
      const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
      if (hasBody && !ct.includes('application/json')) throw new HttpError(415, 'Content-Type harus application/json.');
      ctx.body = await readBody(req);
    }
    const result = r.handler(ctx);
    if (result === STREAM) return; // respons dikelola handler (aliran SSE)
    if (req.method !== 'GET') {
      store.save();
      announce(result);
    }
    sendJson(res, 200, result);
  }

  // Setelah data tersimpan, beri tahu admin dan pemilik pesanan bahwa pesanan itu berubah.
  function announce(result) {
    const id = result && result.order && result.order.id;
    if (!id) return;
    const o = db().orders.find((x) => x.id === id);
    publish('orders', id, o && o.userId);
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end('Bad request'); }
    if (rel.includes('\0')) { res.writeHead(400); return res.end('Bad request'); }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(publicDir, rel));
    if (file !== publicDir && !file.startsWith(publicDir + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Halaman tidak ditemukan.');
      }
      const ext = path.extname(file).toLowerCase();
      const isAsset = ['.png', '.jpg', '.jpeg', '.webp', '.ico', '.svg'].includes(ext);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': isAsset ? 'public, max-age=86400' : 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
    try {
      if (url.pathname === '/healthz') sendJson(res, 200, remote ? { ok: true, store: remote.status() } : { ok: true }); // untuk pengecekan kesehatan oleh hosting
      else if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else serveStatic(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) {
        if (!res.headersSent) sendJson(res, e.status, { error: e.message, fields: e.fields || undefined });
      } else {
        console.error('[ERROR]', e);
        if (!res.headersSent) sendJson(res, 500, { error: 'Terjadi kesalahan di server. Coba lagi sebentar lagi.' });
      }
    }
  });

  server.on('close', () => clearInterval(heartbeat));
  return {
    server, store, production, persistent: dbLocation.persistent || !!remote, remote,
    closeLive: () => liveClose(() => true),
  };
}

module.exports = { createApp };

if (require.main === module) {
  main().catch((e) => { console.error('\n  [GAGAL]', e.message, '\n'); process.exit(1); });
}

async function main() {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';

  // Penyimpanan jarak jauh (Upstash): ambil snapshot SEBELUM Store dibuat. Bila Upstash tak terjangkau, berhenti
  // di sini (lempar error) supaya tidak memulai dengan database kosong lalu menimpa data asli.
  const remote = RemoteStore.fromEnv(process.env);
  let restored = false;
  if (remote) {
    restored = await remote.restore(resolveDbFile().file);
    remote.onConflict = () => process.exit(1);
  }

  const { server, store, production, persistent, closeLive } = createApp({ remote });

  const flag = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));
  const lines = [];
  if (flag(process.env.RESET_ADMIN_PASSWORD) && process.env.ADMIN_PASSWORD) {
    store.resetAdminPassword(process.env.ADMIN_PASSWORD);
    lines.push('[INFO] Kata sandi admin disetel ulang dari ADMIN_PASSWORD. Hapus RESET_ADMIN_PASSWORD agar tidak terulang tiap restart.');
  }
  if (store.generatedAdminPassword) {
    lines.push(
      '================================================================',
      ' AKUN ADMIN DIBUAT. Catat sekarang, kata sandi ini tidak ditampilkan lagi:',
      `   username : admin`,
      `   kata sandi: ${store.generatedAdminPassword}`,
      ' Segera ganti lewat menu "Ganti kata sandi" setelah masuk.',
      '================================================================',
    );
  } else if (store.adminHasDefaultPassword()) {
    lines.push(production
      ? '[PERINGATAN] Admin masih memakai kata sandi bawaan "admin123". Siapa pun bisa masuk. Ganti SEKARANG (atau set ADMIN_PASSWORD dan RESET_ADMIN_PASSWORD=1 lalu deploy ulang).'
      : '[INFO] Admin: username "admin", kata sandi awal "admin123". Segera ganti.');
  }
  if (production && !persistent) {
    lines.push('[PERINGATAN] Data disimpan di folder aplikasi. Di hosting, berkas ini hilang saat deploy ulang atau restart. Pasang disk/volume permanen lalu set DB_FILE atau DATA_DIR ke lokasinya, atau isi UPSTASH_REDIS_REST_URL dan UPSTASH_REDIS_REST_TOKEN.');
  }
  if (remote) {
    lines.push(restored
      ? '[INFO] Database dipulihkan dari Upstash. Perubahan disalin ke sana otomatis.'
      : '[INFO] Upstash masih kosong: database baru dikirim ke sana. Perubahan berikutnya disalin otomatis.');
  }

  server.listen(port, host, () => {
    console.log('\n  ZibbWash Laundry berjalan');
    console.log(`  Buka  : http://localhost:${port}`);
    console.log(`  Data  : ${store.file}${remote ? ' (cache) + Upstash' : ''}`);
    console.log(`  Mode  : ${production ? 'produksi' : 'pengembangan'}\n`);
    for (const l of lines) console.log(`  ${l}`);
    if (lines.length) console.log('');
  });

  // Penutupan rapi saat hosting mengirim SIGTERM (deploy ulang, atau Render menidurkan layanan gratis):
  // putus aliran SSE, tunggu permintaan yang berjalan, kirim sisa perubahan ke Upstash, baru keluar.
  let stopping = false;
  const stop = async (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n  ${sig} diterima, menutup server...`);
    setTimeout(() => process.exit(0), remote ? 14000 : 4000).unref();
    closeLive();
    const closed = new Promise((r) => server.close(r));
    if (server.closeIdleConnections) server.closeIdleConnections();
    await Promise.race([closed, new Promise((r) => setTimeout(r, 3000))]);
    if (remote) {
      const ok = await remote.flush(8000);
      console.log(ok ? '  Data tersimpan ke Upstash.' : '  [PERINGATAN] Sebagian perubahan belum sempat tersimpan ke Upstash.');
      remote.stop();
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
