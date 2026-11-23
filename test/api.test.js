'use strict';
/**
 * Uji alur API secara black box (hanya lewat HTTP): jalankan dengan `npm test`.
 * Setiap berkas uji memakai database sementara, jadi data/db.json asli tidak tersentuh.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createApp } = require('../server');

let base;
let server;
let tmp;

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zibbwash-'));
  const app = createApp({ dbFile: path.join(tmp, 'db.json'), adminPassword: 'admin123' });
  server = app.server;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Klien kecil yang menyimpan cookie sesi.
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].startsWith('zw_sid=') && set.split(';')[0] !== 'zw_sid=' ? set.split(';')[0] : '';
    let json = null;
    try { json = await res.json(); } catch { /* bukan JSON */ }
    return { status: res.status, json };
  };
}

const admin = client();
const cust = client();
const other = client();
let orderId;

test('konfigurasi publik tersedia tanpa login', async () => {
  const c = client();
  const r = await c('GET', '/api/config');
  assert.equal(r.status, 200);
  assert.equal(r.json.services.length, 4);
  assert.equal(r.json.delivery.freeKm, 3);
  assert.equal(r.json.delivery.perKm, 3000);
  assert.equal(r.json.loyalty.stampsForReward, 10);
});

test('endpoint terlindungi menolak tamu (401) dan pelanggan di rute admin (403)', async () => {
  const guest = client();
  assert.equal((await guest('GET', '/api/orders')).status, 401);
  assert.equal((await guest('GET', '/api/admin/orders')).status, 401);

  const r = await cust('POST', '/api/auth/register', { name: 'Tester Satu', phone: '+62 812-3456-7000', password: 'rahasia1' });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.phone, '081234567000');
  assert.equal(r.json.user.role, 'customer');
  assert.equal((await cust('GET', '/api/admin/orders')).status, 403);
});

test('registrasi: validasi dan nomor ganda', async () => {
  const c = client();
  const bad = await c('POST', '/api/auth/register', { name: 'A', phone: '123', password: '1' });
  assert.equal(bad.status, 422);
  assert.ok(bad.json.fields.name && bad.json.fields.phone && bad.json.fields.password);
  const dup = await c('POST', '/api/auth/register', { name: 'Tester Dua', phone: '081234567000', password: 'rahasia1' });
  assert.equal(dup.status, 409);
});

test('login dibedakan per role: admin tidak bisa masuk lewat tab pelanggan dan sebaliknya', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { role: 'customer', identifier: 'admin', password: 'admin123' })).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { role: 'admin', identifier: '081234567000', password: 'rahasia1' })).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { role: 'admin', identifier: 'admin', password: 'salah' })).status, 401);
  const ok = await admin('POST', '/api/auth/login', { role: 'admin', identifier: 'admin', password: 'admin123' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.role, 'admin');
});

test('form pesanan: data tidak lengkap ditolak, antar-jemput wajib lokasi', async () => {
  const empty = await cust('POST', '/api/orders', {});
  assert.equal(empty.status, 422);
  const noLoc = await cust('POST', '/api/orders', {
    serviceId: 'wash-fold', garments: [{ type: 'Pakaian harian', qty: 5 }], handover: 'pickup', returnMethod: 'self',
  });
  assert.equal(noLoc.status, 422);
  assert.ok(noLoc.json.fields.address);
  const far = await cust('POST', '/api/orders', {
    serviceId: 'wash-fold', garments: [{ type: 'Pakaian harian', qty: 5 }], handover: 'pickup', returnMethod: 'self',
    address: { text: 'Jauh sekali dari outlet', lat: -6.2, lng: 106.8 },
  });
  assert.equal(far.status, 422);
  assert.match(far.json.fields.address, /jangkauan/);
});

test('quote: ongkir gratis ≤ 3 km, lalu Rp3.000/km (dibulatkan ke atas), per arah', async () => {
  const cfg = (await client()('GET', '/api/config')).json;
  const { lat, lng } = cfg.business;
  const near = await cust('POST', '/api/quote', {
    serviceId: 'regular', estimatedWeight: 5, handover: 'pickup', returnMethod: 'delivery',
    address: { lat: lat + 0.01, lng, distanceKm: 1.2 }, // ±1,1 km lurus
  });
  assert.equal(near.json.bill.shippingFee, 0);
  assert.equal(near.json.bill.serviceTotal, 30000);
  assert.equal(near.json.bill.total, 30000);

  // ±5,5 km lurus → jarak peta 6,0 km → 3 km kelebihan × 3000 × 2 arah = 18.000
  const far = await cust('POST', '/api/quote', {
    serviceId: 'regular', estimatedWeight: 5, handover: 'pickup', returnMethod: 'delivery',
    address: { lat: lat + 0.05, lng, distanceKm: 6.0 },
  });
  assert.equal(far.json.bill.extraKm, 3);
  assert.equal(far.json.bill.shippingFee, 18000);
  assert.equal(far.json.bill.total, 48000);

  // Satu arah saja → 9.000
  const one = await cust('POST', '/api/quote', {
    serviceId: 'regular', estimatedWeight: 5, handover: 'dropoff', returnMethod: 'delivery',
    address: { lat: lat + 0.05, lng, distanceKm: 6.0 },
  });
  assert.equal(one.json.bill.shippingFee, 9000);

  // Jarak dari klien yang dipalsukan lebih kecil dari garis lurus tidak diterima.
  const cheat = await cust('POST', '/api/quote', {
    serviceId: 'regular', estimatedWeight: 5, handover: 'dropoff', returnMethod: 'delivery',
    address: { lat: lat + 0.05, lng, distanceKm: 0.1 },
  });
  assert.ok(cheat.json.bill.distanceKm >= 5.4);
});

test('alur lengkap: pesan → timbang → tracking → bayar → selesai → stamp', async () => {
  const cfg = (await client()('GET', '/api/config')).json;
  const { lat, lng } = cfg.business;
  const created = await cust('POST', '/api/orders', {
    serviceId: 'wash-fold', garments: [{ type: 'Pakaian harian', qty: 10 }, { type: 'Handuk', qty: 2 }],
    estimatedWeight: 4, handover: 'pickup', returnMethod: 'delivery', notes: '<b>hati-hati</b>',
    address: { text: 'Jl. Contoh No. 1, Malang', lat: lat + 0.05, lng, distanceKm: 6.0 },
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const o = created.json.order;
  orderId = o.id;
  assert.match(orderId, /^ZW-\d{6}-001$/);
  assert.equal(o.status, 'received');
  assert.equal(o.billing.isFinal, false);
  assert.deepEqual(o.flow.map((s) => s.key), ['received', 'pickup', 'weighed', 'washing', 'drying', 'finishing', 'ready', 'delivering', 'done']);

  // Pelanggan lain tidak boleh melihat pesanan ini.
  await other('POST', '/api/auth/register', { name: 'Orang Lain', phone: '081234567111', password: 'rahasia1' });
  assert.equal((await other('GET', `/api/orders/${orderId}`)).status, 404);
  assert.equal((await other('POST', `/api/orders/${orderId}/cancel`)).status, 404);

  // Admin melihat pesanan di daftar.
  const list = await admin('GET', '/api/admin/orders');
  assert.ok(list.json.orders.some((x) => x.id === orderId));
  const search = await admin('GET', '/api/admin/orders?q=tester');
  assert.ok(search.json.orders.length >= 1);

  // Belum dijemput → tidak boleh menimbang.
  assert.equal((await admin('POST', `/api/admin/orders/${orderId}/weight`, { weight: 4.2 })).status, 409);
  // Belum ada berat → tidak boleh ke tahap cuci.
  assert.equal((await admin('POST', `/api/admin/orders/${orderId}/status`, { status: 'washing' })).status, 409);
  // Status asing ditolak.
  assert.equal((await admin('POST', `/api/admin/orders/${orderId}/status`, { status: 'terbang' })).status, 422);

  assert.equal((await admin('POST', `/api/admin/orders/${orderId}/status`, { status: 'pickup', note: 'Kurir berangkat' })).status, 200);
  assert.equal((await admin('POST', `/api/admin/orders/${orderId}/weight`, { weight: 0 })).status, 422);
  const w = await admin('POST', `/api/admin/orders/${orderId}/weight`, { weight: 4.2 });
  assert.equal(w.status, 200);
  assert.equal(w.json.order.status, 'weighed');
  assert.equal(w.json.order.billing.isFinal, true);
  assert.equal(w.json.order.billing.serviceTotal, 29400); // 4,2 × 7.000
  assert.equal(w.json.order.billing.shippingFee, 18000);
  assert.equal(w.json.order.billing.total, 47400);

  // Pelanggan memantau status.
  const seen = await cust('GET', `/api/orders/${orderId}`);
  assert.equal(seen.json.order.status, 'weighed');
  assert.equal(seen.json.order.flow.find((s) => s.key === 'weighed').state, 'current');

  // Pelanggan tidak bisa membatalkan setelah diproses.
  assert.equal((await cust('POST', `/api/orders/${orderId}/cancel`)).status, 409);

  for (const st of ['washing', 'drying', 'finishing', 'ready', 'delivering']) {
    const r = await admin('POST', `/api/admin/orders/${orderId}/status`, { status: st });
    assert.equal(r.status, 200, st);
  }

  // Bayar (simulasi); metode tak dikenal ditolak.
  assert.equal((await cust('POST', `/api/orders/${orderId}/pay`, { method: 'bitcoin' })).status, 422);
  const pay = await cust('POST', `/api/orders/${orderId}/pay`, { method: 'qris' });
  assert.equal(pay.status, 200);
  assert.equal(pay.json.order.payment.status, 'paid');
  assert.match(pay.json.order.payment.ref, /^SIM-/);
  assert.equal((await cust('POST', `/api/orders/${orderId}/pay`, { method: 'qris' })).status, 409);
  // Berat terkunci setelah lunas.
  assert.equal((await admin('POST', `/api/admin/orders/${orderId}/weight`, { weight: 5 })).status, 409);

  // Selesai → stamp +1 (total 47.400 ≥ 30.000).
  const done = await admin('POST', `/api/admin/orders/${orderId}/status`, { status: 'done' });
  assert.equal(done.status, 200);
  assert.equal(done.json.award.awarded, true);
  const loy = await cust('GET', '/api/loyalty');
  assert.equal(loy.json.user.stamps, 1);

  // Pesanan selesai tidak bisa diubah lagi.
  assert.equal((await admin('POST', `/api/admin/orders/${orderId}/status`, { status: 'washing' })).status, 409);
});

test('stamp: transaksi di bawah Rp30.000 tidak dapat stamp; 10 stamp jadi voucher gratis Wash & Fold maks 3 kg', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { name: 'Kolektor Stamp', phone: '081234567222', password: 'rahasia1' });

  const run = async (serviceId, kg, extra = {}) => {
    const cr = await c('POST', '/api/orders', {
      serviceId, garments: [{ type: 'Pakaian harian', qty: 3 }], estimatedWeight: kg, handover: 'dropoff', returnMethod: 'self', ...extra,
    });
    assert.equal(cr.status, 200, JSON.stringify(cr.json));
    const id = cr.json.order.id;
    assert.equal((await admin('POST', `/api/admin/orders/${id}/weight`, { weight: kg })).status, 200);
    assert.equal((await admin('POST', `/api/admin/orders/${id}/payment`, { method: 'cash' })).status, 200);
    return (await admin('POST', `/api/admin/orders/${id}/status`, { status: 'done' })).json;
  };

  // 2 kg regular = 12.000 → tanpa stamp
  const small = await run('regular', 2);
  assert.equal(small.award.awarded, false);
  assert.equal((await c('GET', '/api/loyalty')).json.user.stamps, 0);

  // 10 transaksi layak stamp
  let last;
  for (let i = 0; i < 10; i += 1) last = await run('regular', 5); // 30.000 pas → layak
  assert.equal(last.award.reward, true);
  const loy = (await c('GET', '/api/loyalty')).json;
  assert.equal(loy.user.stamps, 0);
  assert.equal(loy.user.vouchers, 1);

  // Voucher hanya untuk Wash & Fold.
  const wrong = await c('POST', '/api/orders', {
    serviceId: 'regular', garments: [{ type: 'Pakaian harian', qty: 3 }], estimatedWeight: 5, handover: 'dropoff', returnMethod: 'self', useVoucher: true,
  });
  assert.equal(wrong.status, 422);

  // 5 kg Wash & Fold dengan voucher: diskon hanya 3 kg × 7.000 = 21.000
  const v = await c('POST', '/api/orders', {
    serviceId: 'wash-fold', garments: [{ type: 'Pakaian harian', qty: 3 }], estimatedWeight: 5, handover: 'dropoff', returnMethod: 'self', useVoucher: true,
  });
  assert.equal(v.status, 200);
  assert.equal(v.json.order.billing.serviceTotal, 35000);
  assert.equal(v.json.order.billing.discount, 21000);
  assert.equal(v.json.order.billing.total, 14000);
  assert.equal((await c('GET', '/api/loyalty')).json.user.vouchers, 0);

  // Batal sebelum diproses → voucher kembali.
  const cancel = await c('POST', `/api/orders/${v.json.order.id}/cancel`);
  assert.equal(cancel.status, 200);
  assert.equal(cancel.json.order.status, 'cancelled');
  assert.equal((await c('GET', '/api/loyalty')).json.user.vouchers, 1);
});

test('admin: statistik, pelanggan, dan pengaturan tarif (tidak mengubah pesanan lama)', async () => {
  const st = await admin('GET', '/api/admin/stats');
  assert.equal(st.status, 200);
  assert.ok(st.json.stats.total >= 1);
  const cs = await admin('GET', '/api/admin/customers');
  assert.ok(cs.json.customers.length >= 3);

  const bad = await admin('PUT', '/api/admin/settings', { delivery: { freeKm: -1, perKm: 3000, maxKm: 20 } });
  assert.equal(bad.status, 422);
  const ok = await admin('PUT', '/api/admin/settings', { services: [{ id: 'wash-fold', pricePerKg: 8000, eta: '1 hari' }] });
  assert.equal(ok.status, 200);
  const cfg = (await client()('GET', '/api/config')).json;
  assert.equal(cfg.services.find((s) => s.id === 'wash-fold').pricePerKg, 8000);
  // Pesanan lama tetap memakai tarif saat dibuat (7.000/kg), bukan tarif baru.
  const o = await cust('GET', `/api/orders/${orderId}`);
  assert.equal(o.json.order.billing.pricePerKg, 7000);
  assert.equal(o.json.order.billing.total, 47400);
});

test('keamanan dasar: JSON rusak, tipe konten salah, path traversal, ganti kata sandi', async () => {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{rusak' });
  assert.equal(res.status, 400);
  const res2 = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x=1' });
  assert.equal(res2.status, 415);
  const trav = await fetch(`${base}/..%2f..%2fserver.js`);
  assert.ok([400, 403, 404].includes(trav.status));
  const trav2 = await fetch(`${base}/%2e%2e/server.js`);
  assert.ok([400, 403, 404].includes(trav2.status));
  const none = await fetch(`${base}/api/tidak-ada`);
  assert.equal(none.status, 404);

  const c = client();
  await c('POST', '/api/auth/register', { name: 'Ganti Sandi', phone: '081234567333', password: 'lama123' });
  assert.equal((await c('POST', '/api/auth/password', { current: 'salah', next: 'baru1234' })).status, 422);
  assert.equal((await c('POST', '/api/auth/password', { current: 'lama123', next: 'baru1234' })).status, 200);
  const again = client();
  assert.equal((await again('POST', '/api/auth/login', { role: 'customer', identifier: '081234567333', password: 'lama123' })).status, 401);
  assert.equal((await again('POST', '/api/auth/login', { role: 'customer', identifier: '0812-3456-7333', password: 'baru1234' })).status, 200);
});

test('pembatas login: percobaan salah berulang diblokir (429)', async () => {
  const c = client();
  let last;
  for (let i = 0; i < 9; i += 1) last = await c('POST', '/api/auth/login', { role: 'customer', identifier: '081200000000', password: 'x' });
  assert.equal(last.status, 429);
});

test('logout menghapus sesi', async () => {
  const c = client();
  await c('POST', '/api/auth/login', { role: 'admin', identifier: 'admin', password: 'admin123' });
  assert.equal((await c('GET', '/api/admin/stats')).status, 200);
  await c('POST', '/api/auth/logout');
  assert.equal((await c('GET', '/api/admin/stats')).status, 401);
});
