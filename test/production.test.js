'use strict';
/**
 * Uji hal-hal yang dibutuhkan saat website dipasang online: health check, kata sandi admin yang aman,
 * lokasi database, pembaca IP di balik proxy, pembaruan langsung (SSE), dan cadangan data.
 * Jalankan dengan `npm test`. Setiap uji memakai database sementara.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createApp } = require('../server');
const { resolveDbFile } = require('../lib/store');

const cleanups = [];
test.after(async () => { for (const fn of cleanups.reverse()) await fn(); });

async function start(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zibbwash-prod-'));
  const app = createApp({ dbFile: path.join(tmp, 'db.json'), ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  cleanups.push(async () => {
    app.closeLive();
    await new Promise((r) => app.server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return { ...app, base };
}

// Panggil API dengan cookie sesi opsional; kembalikan status, JSON, dan cookie baru bila ada.
async function api(base, method, url, { cookie, body, headers } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(headers || {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  let json = null;
  try { json = await res.json(); } catch { /* bukan JSON */ }
  return { status: res.status, json, headers: res.headers, cookie: set ? set.split(';')[0] : null };
}

async function login(base, role, identifier, password) {
  const r = await api(base, 'POST', '/api/auth/login', { body: { role, identifier, password } });
  assert.equal(r.status, 200, `login ${identifier} gagal: ${r.status}`);
  return r.cookie;
}

// Buka aliran SSE dan kumpulkan nama event yang diterima.
function openStream(base, cookie) {
  return new Promise((resolve, reject) => {
    const events = [];
    let ended = false;
    const req = http.get(base + '/api/events', { headers: cookie ? { Cookie: cookie } : {} }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve({ status: res.statusCode, events, close() {}, ended: () => true }); }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const m = /^event: (.+)$/m.exec(block);
          if (m) events.push({ name: m[1], data: (/^data: (.*)$/m.exec(block) || [])[1] });
        }
      });
      res.on('end', () => { ended = true; });
      res.on('close', () => { ended = true; });
      resolve({ status: 200, events, close: () => req.destroy(), ended: () => ended, contentType: res.headers['content-type'] });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 1500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await wait(20); }
  return fn();
}

test('health check terbuka tanpa login', async () => {
  const { base } = await start();
  const r = await api(base, 'GET', '/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
});

test('mode produksi: kata sandi admin dibuat acak, bukan admin123', async () => {
  const { base, store } = await start({ production: true });
  const pw = store.generatedAdminPassword;
  assert.ok(pw && pw.length >= 16, 'kata sandi acak minimal 16 karakter');
  assert.equal(store.adminHasDefaultPassword(), false);
  const bad = await api(base, 'POST', '/api/auth/login', { body: { role: 'admin', identifier: 'admin', password: 'admin123' } });
  assert.equal(bad.status, 401);
  const ok = await api(base, 'POST', '/api/auth/login', { body: { role: 'admin', identifier: 'admin', password: pw } });
  assert.equal(ok.status, 200);
});

test('mode produksi dengan ADMIN_PASSWORD eksplisit: dipakai apa adanya, tidak dibuat acak', async () => {
  const { store } = await start({ production: true, adminPassword: 'Kata-Sandi-Kuat-1' });
  assert.equal(store.generatedAdminPassword, null);
  assert.equal(store.adminHasDefaultPassword(), false);
});

test('mode pengembangan tetap admin123 dan terdeteksi sebagai kata sandi bawaan', async () => {
  const { store } = await start({ production: false });
  assert.equal(store.generatedAdminPassword, null);
  assert.equal(store.adminHasDefaultPassword(), true);
});

test('resetAdminPassword mengganti kata sandi dan mengeluarkan sesi admin', async () => {
  const { base, store } = await start();
  const cookie = await login(base, 'admin', 'admin', 'admin123');
  assert.equal((await api(base, 'GET', '/api/admin/stats', { cookie })).status, 200);
  assert.equal(store.resetAdminPassword('Baru-Banget-2'), true);
  assert.equal((await api(base, 'GET', '/api/admin/stats', { cookie })).status, 401, 'sesi lama harus mati');
  assert.equal((await api(base, 'POST', '/api/auth/login', { body: { role: 'admin', identifier: 'admin', password: 'admin123' } })).status, 401);
  await login(base, 'admin', 'admin', 'Baru-Banget-2');
});

test('lokasi database: DB_FILE > DATA_DIR > volume Railway > folder proyek', () => {
  const r = (env) => resolveDbFile(env, '/app');
  assert.deepEqual(r({ DB_FILE: '/x/a.json', DATA_DIR: '/d', RAILWAY_VOLUME_MOUNT_PATH: '/v' }), { file: '/x/a.json', persistent: true });
  assert.deepEqual(r({ DATA_DIR: '/d', RAILWAY_VOLUME_MOUNT_PATH: '/v' }), { file: path.join('/d', 'db.json'), persistent: true });
  assert.deepEqual(r({ RAILWAY_VOLUME_MOUNT_PATH: '/v' }), { file: path.join('/v', 'db.json'), persistent: true });
  assert.deepEqual(r({}), { file: path.join('/app', 'data', 'db.json'), persistent: false });
});

test('pembatas login: header X-Forwarded-For diabaikan kecuali TRUST_PROXY diset', async () => {
  const { base } = await start(); // trustProxy mati
  const attempt = (xff) => api(base, 'POST', '/api/auth/login', {
    body: { role: 'admin', identifier: 'admin', password: 'salah' }, headers: { 'X-Forwarded-For': xff },
  });
  for (let i = 0; i < 8; i++) assert.equal((await attempt('1.1.1.1')).status, 401);
  assert.equal((await attempt('1.1.1.1')).status, 429);
  // Mengganti header tidak bisa dipakai untuk menghindari batas.
  assert.equal((await attempt('2.2.2.2')).status, 429);
});

test('pembatas login dengan TRUST_PROXY=1: dihitung per IP klien, awalan palsu tidak membantu', async () => {
  const { base } = await start({ trustProxy: 1 });
  const attempt = (xff) => api(base, 'POST', '/api/auth/login', {
    body: { role: 'admin', identifier: 'admin', password: 'salah' }, headers: { 'X-Forwarded-For': xff },
  });
  for (let i = 0; i < 8; i++) assert.equal((await attempt('9.9.9.9, 1.1.1.1')).status, 401);
  assert.equal((await attempt('1.1.1.1')).status, 429, 'IP klien sama = kena batas');
  assert.equal((await attempt('5.5.5.5, 1.1.1.1')).status, 429, 'entri palsu di depan tidak mengubah IP klien');
  assert.equal((await attempt('2.2.2.2')).status, 401, 'IP klien lain tidak ikut terkunci');
});

test('cadangan data: hanya admin, tanpa sesi, diunduh sebagai berkas JSON', async () => {
  const { base } = await start();
  assert.equal((await api(base, 'GET', '/api/admin/backup')).status, 401);
  const reg = await api(base, 'POST', '/api/auth/register', { body: { name: 'Pelanggan Cadangan', phone: '081200001111', password: 'rahasia1' } });
  assert.equal(reg.status, 200);
  assert.equal((await api(base, 'GET', '/api/admin/backup', { cookie: reg.cookie })).status, 403);

  const cookie = await login(base, 'admin', 'admin', 'admin123');
  const r = await api(base, 'GET', '/api/admin/backup', { cookie });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="zibbwash-cadangan-\d{12}\.json"$/);
  assert.ok(Array.isArray(r.json.users) && Array.isArray(r.json.orders) && r.json.settings);
  assert.equal(r.json.sessions, undefined, 'sesi login tidak boleh ikut dicadangkan');
  assert.ok(r.json.users.some((u) => u.phone === '081200001111'));
});

test('pembaruan langsung: admin dan pemilik pesanan diberi tahu, pelanggan lain tidak', async () => {
  const { base } = await start();
  assert.equal((await openStream(base, null)).status, 401, 'tamu ditolak');

  const a = await api(base, 'POST', '/api/auth/register', { body: { name: 'Pelanggan A', phone: '081211110001', password: 'rahasia1' } });
  const b = await api(base, 'POST', '/api/auth/register', { body: { name: 'Pelanggan B', phone: '081211110002', password: 'rahasia1' } });
  const adminCookie = await login(base, 'admin', 'admin', 'admin123');

  const sa = await openStream(base, a.cookie);
  const sb = await openStream(base, b.cookie);
  const sadm = await openStream(base, adminCookie);
  for (const s of [sa, sb, sadm]) {
    assert.equal(s.status, 200);
    assert.match(s.contentType, /text\/event-stream/);
    assert.ok(await until(() => s.events.some((e) => e.name === 'hello')), 'event hello diterima');
  }

  // A membuat pesanan → A (pemilik) dan admin diberi tahu, B tidak.
  const created = await api(base, 'POST', '/api/orders', {
    cookie: a.cookie,
    body: { serviceId: 'wash-fold', garments: [{ type: 'Pakaian harian', qty: 5 }], estimatedWeight: 3, handover: 'dropoff', returnMethod: 'self' },
  });
  assert.equal(created.status, 200);
  const id = created.json.order.id;
  assert.ok(await until(() => sa.events.some((e) => e.name === 'orders')), 'pemilik diberi tahu pesanan baru');
  assert.ok(await until(() => sadm.events.some((e) => e.name === 'orders')), 'admin diberi tahu pesanan baru');

  // Admin memasukkan berat → pemilik diberi tahu lagi, dan isi event hanya berisi ID pesanan.
  const before = sa.events.filter((e) => e.name === 'orders').length;
  const w = await api(base, 'POST', `/api/admin/orders/${id}/weight`, { cookie: adminCookie, body: { weight: 3.2 } });
  assert.equal(w.status, 200);
  assert.ok(await until(() => sa.events.filter((e) => e.name === 'orders').length > before), 'pemilik diberi tahu perubahan berat');
  const last = sa.events.filter((e) => e.name === 'orders').pop();
  assert.deepEqual(JSON.parse(last.data), { id });

  await wait(150);
  assert.equal(sb.events.filter((e) => e.name === 'orders').length, 0, 'pelanggan lain tidak menerima apa pun');
  for (const s of [sa, sb, sadm]) s.close();
});

test('pembaruan langsung: aliran ditutup saat pengguna keluar', async () => {
  const { base } = await start();
  const reg = await api(base, 'POST', '/api/auth/register', { body: { name: 'Pelanggan C', phone: '081211110003', password: 'rahasia1' } });
  const s = await openStream(base, reg.cookie);
  assert.equal(s.status, 200);
  assert.equal(s.ended(), false);
  assert.equal((await api(base, 'POST', '/api/auth/logout', { cookie: reg.cookie })).status, 200);
  assert.ok(await until(() => s.ended()), 'aliran harus ditutup server setelah logout');
});

test('pembaruan langsung: satu pengguna dibatasi 4 sambungan, yang tertua diputus', async () => {
  const { base } = await start();
  const reg = await api(base, 'POST', '/api/auth/register', { body: { name: 'Pelanggan D', phone: '081211110004', password: 'rahasia1' } });
  const streams = [];
  for (let i = 0; i < 5; i++) streams.push(await openStream(base, reg.cookie));
  assert.ok(await until(() => streams[0].ended()), 'sambungan tertua diputus');
  assert.equal(streams[4].ended(), false);
  streams.forEach((s) => s.close());
});
