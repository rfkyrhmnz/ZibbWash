'use strict';
/**
 * Logika bisnis ZibbWash: validasi pesanan, hitung tagihan, alur tracking, pembayaran, dan stamp loyalitas.
 * Fungsi-fungsi di sini hanya memodifikasi objek `db` di memori (tanpa I/O) sehingga mudah diuji.
 */
const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message, fields) { super(message); this.status = status; this.fields = fields; }
}

// ───────────────────────── util ─────────────────────────
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const cleanStr = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);

function normalizePhone(raw) {
  let p = String(raw || '').replace(/[\s\-().]/g, '');
  if (p.startsWith('+62')) p = '0' + p.slice(3);
  else if (p.startsWith('62')) p = '0' + p.slice(2);
  return p;
}
const isValidPhone = (p) => /^08\d{8,12}$/.test(p);

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function jakartaYmd(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', year: '2-digit', month: '2-digit', day: '2-digit' })
    .formatToParts(date).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  return `${parts.year}${parts.month}${parts.day}`;
}

function nextOrderId(db, now = new Date()) {
  const prefix = `ZW-${jakartaYmd(now)}-`;
  let max = 0;
  for (const o of db.orders) {
    if (o.id.startsWith(prefix)) max = Math.max(max, parseInt(o.id.slice(prefix.length), 10) || 0);
  }
  return prefix + String(max + 1).padStart(3, '0');
}

// ───────────────────────── jam operasional ─────────────────────────
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMinutes = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
const jakartaClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/**
 * Status kurir pada waktu `now` (WIB). Buka bila openTime ≤ jam < closeTime.
 * nextDay: true bila sudah lewat jam tutup, sehingga jam buka berikutnya jatuh besok.
 * Padanan di browser: public/js/util.js (kesamaannya diuji di test/hours.test.js).
 */
function courierStatus(delivery, now = new Date()) {
  const t = toMinutes(jakartaClock.format(now));
  const from = toMinutes(delivery.openTime);
  const to = toMinutes(delivery.closeTime);
  return { open: t >= from && t < to, nextDay: t >= to };
}

/** Catatan penjemputan pada log pesanan. Tanggal ditulis eksplisit agar tetap jelas saat dibaca belakangan. */
function pickupNote(delivery, now) {
  const c = courierStatus(delivery, now);
  if (c.open) return 'Menunggu kurir menjemput.';
  const day = new Date(now.getTime() + (c.nextDay ? 86400000 : 0))
    .toLocaleDateString('id-ID', { day: 'numeric', month: 'long', timeZone: 'Asia/Jakarta' });
  return `Dipesan di luar jam operasional. Kurir menjemput ${day} mulai pukul ${delivery.openTime.replace(':', '.')} WIB.`;
}

// ───────────────────────── tagihan ─────────────────────────
const legsOf = (handover, returnMethod) => (handover === 'pickup' ? 1 : 0) + (returnMethod === 'delivery' ? 1 : 0);

/**
 * Tagihan = berat × tarif layanan + ongkir − diskon voucher.
 * Ongkir: gratis sampai freeKm; kelebihannya dibulatkan ke atas per km × perKm.
 * Bila chargePerLeg aktif, ongkir dikalikan jumlah arah yang dipakai (jemput dan/atau antar).
 * `order` bisa berupa pesanan utuh atau draf (butuh: rates, handover, returnMethod, distanceKm, voucherUsed, estimatedWeight, actualWeight).
 */
function computeBill(order) {
  const r = order.rates;
  const isFinal = order.actualWeight != null;
  const weight = isFinal ? order.actualWeight : (order.estimatedWeight || 0);
  const serviceTotal = Math.round(weight * r.pricePerKg);
  const legs = legsOf(order.handover, order.returnMethod);
  const distanceKm = order.distanceKm || 0;
  let extraKm = 0;
  let shippingFee = 0;
  if (legs > 0) {
    extraKm = Math.max(0, Math.ceil(distanceKm - r.freeKm - 1e-9));
    const perLeg = extraKm * r.perKm;
    shippingFee = r.chargePerLeg ? perLeg * legs : perLeg;
  }
  const discountKg = order.voucherUsed ? Math.min(weight, r.rewardMaxKg) : 0;
  const discount = Math.round(discountKg * r.pricePerKg);
  const total = Math.max(0, serviceTotal + shippingFee - discount);
  return {
    isFinal, weight, pricePerKg: r.pricePerKg, serviceTotal,
    legs, distanceKm, freeKm: r.freeKm, perKm: r.perKm, chargePerLeg: r.chargePerLeg, extraKm, shippingFee,
    discountKg, discount, total,
    earnsStamp: total >= r.minStamp, minStamp: r.minStamp,
  };
}

function ratesFor(service, settings) {
  return {
    pricePerKg: service.pricePerKg,
    freeKm: settings.delivery.freeKm,
    perKm: settings.delivery.perKm,
    chargePerLeg: !!settings.delivery.chargePerLeg,
    rewardMaxKg: settings.loyalty.rewardMaxKg,
    minStamp: settings.loyalty.minTransaction,
  };
}

// ───────────────────────── alur tracking ─────────────────────────
const STATUS_LABEL = {
  received: 'Pesanan diterima', pickup: 'Dijemput kurir', weighed: 'Ditimbang di outlet',
  washing: 'Sedang dicuci', drying: 'Sedang dikeringkan', finishing: 'Sedang dilipat',
  ready: 'Siap diambil', delivering: 'Dalam pengantaran', done: 'Selesai', cancelled: 'Dibatalkan',
};

function buildFlow(order) {
  const finish = order.finish || 'dilipat';
  const steps = [{
    key: 'received', label: 'Pesanan diterima',
    desc: order.handover === 'pickup' ? 'Pesanan masuk. Kurir akan menjemput pakaianmu.' : 'Pesanan masuk. Antar pakaianmu ke outlet.',
  }];
  if (order.handover === 'pickup') steps.push({ key: 'pickup', label: 'Dijemput kurir', desc: 'Kurir mengambil pakaian di lokasimu.' });
  steps.push(
    { key: 'weighed', label: 'Ditimbang di outlet', desc: 'Pakaian ditimbang, tagihan final dibuat.' },
    { key: 'washing', label: 'Sedang dicuci', desc: 'Pakaian sedang dicuci.' },
    { key: 'drying', label: 'Sedang dikeringkan', desc: 'Pakaian sedang dikeringkan.' },
    { key: 'finishing', label: `Sedang ${finish}`, desc: `Pakaian sedang ${finish}.` },
    order.returnMethod === 'delivery'
      ? { key: 'ready', label: 'Siap diantar', desc: 'Cucian siap dan menunggu kurir.' }
      : { key: 'ready', label: 'Siap diambil', desc: 'Cucian siap, silakan ambil di outlet.' },
  );
  if (order.returnMethod === 'delivery') steps.push({ key: 'delivering', label: 'Dalam pengantaran', desc: 'Kurir sedang mengantar cucianmu.' });
  steps.push({ key: 'done', label: 'Selesai', desc: 'Pesanan selesai. Terima kasih!' });
  return steps;
}

const flowIndex = (order, key) => buildFlow(order).findIndex((s) => s.key === key);

function statusGroup(status) {
  if (status === 'received') return 'new';
  if (status === 'done') return 'done';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'ready' || status === 'delivering') return 'ready';
  return 'processing';
}

function addLog(order, entry, now = new Date()) {
  const at = now.toISOString();
  order.log.push({ at, kind: entry.kind || 'info', status: entry.status || null, label: entry.label || '', note: entry.note || '', by: entry.by || 'sistem' });
  order.updatedAt = at;
}

function logLoyalty(user, type, orderId, note, now = new Date()) {
  user.loyaltyLog = user.loyaltyLog || [];
  user.loyaltyLog.unshift({ at: now.toISOString(), type, orderId, note });
  if (user.loyaltyLog.length > 100) user.loyaltyLog.length = 100;
}

// ───────────────────────── validasi & pembuatan pesanan ─────────────────────────
const hasCoords = (a) => !!a && a.lat != null && a.lat !== '' && a.lng != null && a.lng !== '';

function resolveDistance(address, settings, errors) {
  if (!hasCoords(address)) {
    errors.address = 'Tentukan lokasi penjemputan/pengantaran di peta.';
    return null;
  }
  const lat = Number(address.lat);
  const lng = Number(address.lng);
  if (!isNum(lat) || !isNum(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    errors.address = 'Koordinat lokasi tidak valid.';
    return null;
  }
  const b = settings.business;
  const straight = haversineKm(b.lat, b.lng, lat, lng);
  // Jarak dari peta (rute jalan) dipercaya selama masuk akal: tidak boleh lebih pendek dari garis lurus
  // dan tidak boleh jauh melebihi kewajaran.
  let km;
  const client = Number(address.distanceKm);
  if (address.distanceKm != null && address.distanceKm !== '' && Number.isFinite(client) && client >= 0) {
    km = Math.min(Math.max(client, straight), straight * 3 + 1);
  } else {
    km = straight * 1.3;
  }
  km = round1(km);
  if (km > settings.delivery.maxKm) {
    errors.address = `Lokasi di luar jangkauan antar-jemput (maksimal ${settings.delivery.maxKm} km dari outlet).`;
    return null;
  }
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, km };
}

function validateOrderInput(input, settings, user) {
  const errors = {};
  const i = input || {};
  const svc = settings.services.find((s) => s.id === i.serviceId);
  if (!svc) errors.serviceId = 'Pilih layanan terlebih dahulu.';

  const allowed = new Set(settings.garmentTypes);
  const seen = new Set();
  const garments = [];
  if (Array.isArray(i.garments)) {
    for (const g of i.garments.slice(0, 30)) {
      if (!g || !allowed.has(g.type) || seen.has(g.type)) continue;
      seen.add(g.type);
      const qty = Math.round(Number(g.qty));
      garments.push({ type: g.type, qty: Number.isFinite(qty) && qty >= 1 ? Math.min(qty, 999) : 1 });
    }
  }
  if (!garments.length) errors.garments = 'Pilih minimal satu jenis pakaian.';

  let estimatedWeight = null;
  if (i.estimatedWeight !== '' && i.estimatedWeight != null) {
    const w = Number(i.estimatedWeight);
    if (!Number.isFinite(w) || w <= 0 || w > 100) errors.estimatedWeight = 'Estimasi berat harus antara 0,1 dan 100 kg.';
    else estimatedWeight = round2(w);
  }

  const handover = i.handover;
  const returnMethod = i.returnMethod;
  if (!['dropoff', 'pickup'].includes(handover)) errors.handover = 'Pilih cara menyerahkan pakaian.';
  if (!['self', 'delivery'].includes(returnMethod)) errors.returnMethod = 'Pilih cara mengambil cucian.';

  let address = null;
  let distanceKm = 0;
  if (legsOf(handover, returnMethod) > 0 && !errors.handover && !errors.returnMethod) {
    const a = i.address || {};
    const r = resolveDistance(a, settings, errors);
    const text = cleanStr(a.text, 300);
    if (r) {
      if (text.length < 5) errors.addressText = 'Tulis alamat lengkap (nama jalan, nomor, patokan) agar kurir mudah menemukan.';
      address = { text, lat: r.lat, lng: r.lng };
      distanceKm = r.km;
    }
  }

  const notes = cleanStr(i.notes, 300);

  let useVoucher = false;
  if (i.useVoucher) {
    if (!svc || svc.id !== settings.loyalty.rewardServiceId) errors.useVoucher = 'Voucher hanya berlaku untuk layanan Wash & Fold.';
    else if (!user || (user.vouchers || 0) < 1) errors.useVoucher = 'Kamu belum punya voucher gratis.';
    else useVoucher = true;
  }

  if (Object.keys(errors).length) throw new HttpError(422, 'Data pesanan belum lengkap.', errors);
  return { svc, garments, estimatedWeight, handover, returnMethod, address, distanceKm, notes, useVoucher };
}

/** Hitung perkiraan tagihan untuk form pemesanan (tidak menyimpan apa pun, toleran terhadap data belum lengkap). */
function quoteOrder(input, settings, user) {
  const i = input || {};
  const svc = settings.services.find((s) => s.id === i.serviceId);
  const handover = ['dropoff', 'pickup'].includes(i.handover) ? i.handover : 'dropoff';
  const returnMethod = ['self', 'delivery'].includes(i.returnMethod) ? i.returnMethod : 'self';
  const legs = legsOf(handover, returnMethod);
  const out = { bill: null, needsLocation: false, voucherAvailable: (user.vouchers || 0) > 0, locationError: null };
  if (!svc) return out;

  let distanceKm = 0;
  if (legs > 0) {
    if (!hasCoords(i.address)) {
      out.needsLocation = true;
    } else {
      const errs = {};
      const r = resolveDistance(i.address, settings, errs);
      if (r) distanceKm = r.km;
      else out.locationError = errs.address || null;
    }
  }
  let est = null;
  if (i.estimatedWeight !== '' && i.estimatedWeight != null) {
    const w = Number(i.estimatedWeight);
    if (Number.isFinite(w) && w > 0 && w <= 100) est = round2(w);
  }
  const voucherUsed = !!i.useVoucher && svc.id === settings.loyalty.rewardServiceId && (user.vouchers || 0) > 0;
  out.bill = computeBill({
    rates: ratesFor(svc, settings), handover, returnMethod, distanceKm,
    voucherUsed, estimatedWeight: est, actualWeight: null,
  });
  return out;
}

function createOrder(db, user, v, settings, now = new Date()) {
  const order = {
    id: nextOrderId(db, now),
    userId: user.id, customerName: user.name, customerPhone: user.phone,
    serviceId: v.svc.id, serviceName: v.svc.name, finish: v.svc.finish,
    rates: ratesFor(v.svc, settings),
    garments: v.garments, estimatedWeight: v.estimatedWeight, actualWeight: null,
    handover: v.handover, returnMethod: v.returnMethod,
    address: v.address, distanceKm: v.distanceKm, notes: v.notes, voucherUsed: v.useVoucher,
    status: 'received',
    payment: { status: 'unpaid', method: null, paidAt: null, ref: null },
    stamp: { processed: false, awarded: false, note: null },
    log: [], createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
  addLog(order, {
    kind: 'status', status: 'received', label: STATUS_LABEL.received, by: 'pelanggan',
    note: v.handover === 'pickup' ? pickupNote(settings.delivery, now) : 'Menunggu pakaian diantar ke outlet.',
  }, now);
  if (v.useVoucher) {
    user.vouchers -= 1;
    logLoyalty(user, 'redeem', order.id, 'Voucher gratis Wash & Fold dipakai', now);
    addLog(order, { kind: 'info', label: 'Voucher dipakai', note: `Gratis Wash & Fold maksimal ${order.rates.rewardMaxKg} kg.`, by: 'sistem' }, now);
  }
  db.orders.push(order);
  return order;
}

// ───────────────────────── operasi pesanan ─────────────────────────
function assertOpen(order) {
  if (order.status === 'cancelled') throw new HttpError(409, 'Pesanan ini sudah dibatalkan.');
  if (order.status === 'done') throw new HttpError(409, 'Pesanan ini sudah selesai.');
}

function setWeight(db, order, weight, by = 'admin', now = new Date()) {
  assertOpen(order);
  if (order.payment.status === 'paid') throw new HttpError(409, 'Tagihan sudah dibayar, berat tidak bisa diubah.');
  const w = Number(weight);
  if (!Number.isFinite(w) || w < 0.1 || w > 100) throw new HttpError(422, 'Berat aktual harus antara 0,1 dan 100 kg.', { weight: 'Masukkan berat 0,1–100 kg.' });
  const cur = flowIndex(order, order.status);
  if (order.handover === 'pickup' && cur < flowIndex(order, 'pickup')) {
    throw new HttpError(409, 'Pakaian belum dijemput. Ubah status ke "Dijemput kurir" dulu, baru timbang.');
  }
  order.actualWeight = round2(w);
  const bill = computeBill(order);
  addLog(order, {
    kind: 'info', label: 'Berat aktual dicatat', by,
    note: `${String(order.actualWeight).replace('.', ',')} kg. Tagihan final Rp${bill.total.toLocaleString('id-ID')}.`,
  }, now);
  if (cur < flowIndex(order, 'weighed')) {
    order.status = 'weighed';
    addLog(order, { kind: 'status', status: 'weighed', label: STATUS_LABEL.weighed, by, note: 'Tagihan final sudah bisa dibayar.' }, now);
  }
  return order;
}

function setStatus(db, order, status, note, by = 'admin', now = new Date()) {
  assertOpen(order);
  const flow = buildFlow(order);
  const idx = flow.findIndex((s) => s.key === status);
  if (idx < 0) throw new HttpError(422, 'Status tidak tersedia untuk pesanan ini.');
  if (status === order.status) throw new HttpError(409, 'Pesanan sudah berada di status tersebut.');
  if (idx >= flowIndex(order, 'weighed') && order.actualWeight == null) {
    throw new HttpError(409, 'Masukkan berat aktual dulu sebelum melanjutkan ke tahap pencucian.');
  }
  order.status = status;
  addLog(order, { kind: 'status', status, label: flow[idx].label, note: cleanStr(note, 300), by }, now);
  const award = maybeAwardStamp(db, order, now);
  return { order, award };
}

function markPaid(db, order, method, by, now = new Date(), simulated = false) {
  if (order.status === 'cancelled') throw new HttpError(409, 'Pesanan ini sudah dibatalkan.');
  if (order.actualWeight == null) throw new HttpError(409, 'Tagihan belum final. Tunggu pakaian ditimbang di outlet.');
  if (order.payment.status === 'paid') throw new HttpError(409, 'Tagihan ini sudah lunas.');
  order.payment = {
    status: 'paid', method, paidAt: now.toISOString(),
    ref: simulated ? `SIM-${crypto.randomBytes(4).toString('hex').toUpperCase()}` : null,
  };
  addLog(order, { kind: 'payment', label: 'Pembayaran lunas', by, note: `Metode: ${method}${simulated ? ' (simulasi)' : ''}.` }, now);
  const award = maybeAwardStamp(db, order, now);
  return { order, award };
}

function chooseCash(order, now = new Date()) {
  if (order.actualWeight == null) throw new HttpError(409, 'Tagihan belum final. Tunggu pakaian ditimbang di outlet.');
  if (order.status === 'cancelled') throw new HttpError(409, 'Pesanan ini sudah dibatalkan.');
  if (order.payment.status === 'paid') throw new HttpError(409, 'Tagihan ini sudah lunas.');
  order.payment.method = 'cash';
  addLog(order, { kind: 'payment', label: 'Bayar tunai dipilih', by: 'pelanggan', note: 'Pembayaran dilakukan di outlet atau ke kurir, lalu dikonfirmasi admin.' }, now);
  return order;
}

function cancelOrder(db, order, by, note, now = new Date()) {
  assertOpen(order);
  order.status = 'cancelled';
  const user = db.users.find((u) => u.id === order.userId);
  if (order.voucherUsed && user) {
    user.vouchers += 1;
    logLoyalty(user, 'refund', order.id, 'Voucher dikembalikan karena pesanan dibatalkan', now);
  }
  let extra = '';
  if (order.payment.status === 'paid') { order.payment.status = 'refunded'; extra = ' Dana dikembalikan (simulasi).'; }
  addLog(order, { kind: 'status', status: 'cancelled', label: STATUS_LABEL.cancelled, by, note: (cleanStr(note, 300) + extra).trim() }, now);
  return order;
}

/**
 * Stamp diberikan sekali per pesanan, ketika pesanan SELESAI dan LUNAS, bila total ≥ minimal transaksi.
 * Setiap kelipatan `stampsForReward` stamp otomatis menjadi 1 voucher gratis Wash & Fold.
 */
function maybeAwardStamp(db, order, now = new Date()) {
  if (order.stamp.processed) return null;
  if (order.status !== 'done' || order.payment.status !== 'paid') return null;
  order.stamp.processed = true;
  const bill = computeBill(order);
  if (!bill.earnsStamp) {
    order.stamp.note = `Total di bawah Rp${bill.minStamp.toLocaleString('id-ID')}, belum mendapat stamp.`;
    addLog(order, { kind: 'info', label: 'Tanpa stamp', note: order.stamp.note }, now);
    return { awarded: false };
  }
  const user = db.users.find((u) => u.id === order.userId);
  if (!user) return null;
  const need = (db.settings && db.settings.loyalty.stampsForReward) || 10;
  user.stamps = (user.stamps || 0) + 1;
  user.totalStamps = (user.totalStamps || 0) + 1;
  order.stamp.awarded = true;
  order.stamp.note = 'Stamp +1';
  logLoyalty(user, 'stamp', order.id, 'Stamp +1', now);
  let reward = false;
  if (user.stamps >= need) {
    user.stamps -= need;
    user.vouchers = (user.vouchers || 0) + 1;
    reward = true;
    logLoyalty(user, 'reward', order.id, `${need} stamp terkumpul: voucher gratis Wash & Fold`, now);
  }
  addLog(order, {
    kind: 'info', label: reward ? 'Stamp +1 dan voucher baru' : 'Stamp +1',
    note: reward ? 'Stamp penuh! Voucher gratis Wash & Fold masuk ke akunmu.' : `Stamp kamu sekarang ${user.stamps} dari ${need}.`,
  }, now);
  return { awarded: true, reward, stamps: user.stamps };
}

// ───────────────────────── presentasi ─────────────────────────
function presentOrder(order) {
  const flow = buildFlow(order);
  const idx = flow.findIndex((s) => s.key === order.status);
  const reached = {};
  for (const e of order.log) if (e.kind === 'status' && e.status) reached[e.status] = e.at;
  const cancelled = order.status === 'cancelled';
  const done = order.status === 'done';
  return {
    id: order.id, customerName: order.customerName, customerPhone: order.customerPhone,
    serviceId: order.serviceId, serviceName: order.serviceName,
    garments: order.garments, estimatedWeight: order.estimatedWeight, actualWeight: order.actualWeight,
    handover: order.handover, returnMethod: order.returnMethod,
    address: order.address, distanceKm: order.distanceKm, notes: order.notes, voucherUsed: order.voucherUsed,
    status: order.status,
    statusLabel: cancelled ? STATUS_LABEL.cancelled : (flow[idx] ? flow[idx].label : order.status),
    group: statusGroup(order.status),
    payment: order.payment, stamp: order.stamp,
    createdAt: order.createdAt, updatedAt: order.updatedAt,
    billing: computeBill(order),
    flow: flow.map((s, i) => ({
      ...s,
      state: done ? 'done' : cancelled ? (reached[s.key] ? 'done' : 'todo') : i < idx ? 'done' : i === idx ? 'current' : 'todo',
      at: reached[s.key] || null,
    })),
    currentIndex: idx,
    log: order.log,
    canCancel: order.status === 'received' && order.payment.status === 'unpaid',
  };
}

module.exports = {
  HttpError, round1, round2, cleanStr, normalizePhone, isValidPhone, haversineKm, jakartaYmd, nextOrderId,
  computeBill, ratesFor, legsOf, STATUS_LABEL, buildFlow, flowIndex, statusGroup, addLog, logLoyalty,
  validateOrderInput, quoteOrder, createOrder, setWeight, setStatus, markPaid, chooseCash, cancelOrder,
  maybeAwardStamp, presentOrder, TIME_RE, courierStatus,
};
