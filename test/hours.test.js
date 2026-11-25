'use strict';
/**
 * Jam pengiriman dan media sosial.
 * Aturan waktu diuji dengan waktu yang disuntikkan (nilai batas), jadi hasilnya sama kapan pun tes dijalankan.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createApp } = require('../server');
const L = require('../lib/logic');
const { defaultSettings, createDefaultDb } = require('../lib/store');

const wib = (hm, day = '25') => new Date(`2026-11-${day}T${hm}:00+07:00`);
const CASES = [
  // [jam WIB, buka?, buka berikutnya besok?]
  ['00:00', false, false],
  ['05:59', false, false],
  ['06:00', true, false],
  ['06:01', true, false],
  ['12:00', true, false],
  ['17:59', true, false],
  ['18:00', false, true],
  ['18:01', false, true],
  ['23:59', false, true],
];

test('nilai batas jam pengiriman 06.00–18.00 WIB', () => {
  const { delivery } = defaultSettings();
  for (const [hm, open, nextDay] of CASES) {
    assert.deepEqual(L.courierStatus(delivery, wib(hm)), { open, nextDay }, hm);
  }
});

test('perhitungan di browser sama dengan di server', async () => {
  // util.js adalah modul ES di proyek CommonJS, jadi diimpor lewat data URL.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'util.js'), 'utf8');
  const web = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  const { delivery } = defaultSettings();
  for (const [hm] of CASES) {
    assert.deepEqual(web.courierStatus(delivery, wib(hm)), L.courierStatus(delivery, wib(hm)), hm);
  }
});

test('catatan pesanan jemput mengikuti jam pemesanan', () => {
  const settings = defaultSettings();
  const place = (hm, handover = 'pickup') => {
    const db = createDefaultDb('admin123');
    const user = { id: 'u1', name: 'Uji', phone: '081200000000', vouchers: 0 };
    const v = L.validateOrderInput({
      serviceId: 'regular', garments: [{ type: 'Pakaian harian', qty: 1 }], handover, returnMethod: 'self',
      address: { text: 'Jl. Uji No. 1', lat: settings.business.lat, lng: settings.business.lng },
    }, settings, user);
    return L.createOrder(db, user, v, settings, wib(hm)).log[0].note;
  };
  assert.equal(place('10:00'), 'Menunggu kurir menjemput.');
  assert.match(place('05:00'), /25 November mulai pukul 06\.00 WIB/);
  assert.match(place('22:00'), /26 November mulai pukul 06\.00 WIB/);
  assert.equal(place('22:00', 'dropoff'), 'Menunggu pakaian diantar ke outlet.');
});

test('database lama otomatis mendapat jam pengiriman dan medsos', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-old-'));
  const file = path.join(tmp, 'db.json');
  const old = createDefaultDb('admin123');
  delete old.settings.delivery.openTime;
  delete old.settings.delivery.closeTime;
  delete old.settings.business.instagram;
  delete old.settings.business.email;
  old.settings.delivery.perKm = 4500;
  fs.writeFileSync(file, JSON.stringify(old));
  const { store } = createApp({ dbFile: file });
  const s = store.db.settings;
  assert.equal(s.delivery.openTime, '06:00');
  assert.equal(s.delivery.closeTime, '18:00');
  assert.equal(s.delivery.perKm, 4500); // pengaturan lama tidak tertimpa
  assert.ok(s.business.instagram && s.business.email);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('pengaturan: validasi jam dan medsos lewat HTTP', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-hours-'));
  const { server } = createApp({ dbFile: path.join(tmp, 'db.json'), adminPassword: 'admin123' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'admin', identifier: 'admin', password: 'admin123' }),
  });
  const Cookie = login.headers.get('set-cookie').split(';')[0];
  const put = async (body) => {
    const r = await fetch(`${base}/api/admin/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  const config = async () => (await fetch(`${base}/api/config`)).json();
  const delivery = { freeKm: 3, perKm: 3000, maxKm: 20, chargePerLeg: true };
  const business = { name: 'ZibbWash Laundry', phone: '085737694109', address: 'Jl. Uji', lat: -7.27, lng: 112.79 };

  const first = await config();
  assert.equal(first.delivery.openTime, '06:00');
  assert.equal(first.delivery.closeTime, '18:00');
  assert.equal(first.business.instagram, 'zibbwash.laundry');
  assert.equal(first.business.email, 'halo@zibbwash.example');

  for (const [openTime, closeTime, field] of [
    ['18:00', '06:00', 'delivery.closeTime'],
    ['06:00', '06:00', 'delivery.closeTime'],
    ['25:00', '18:00', 'delivery.openTime'],
    ['06:00', '', 'delivery.closeTime'],
    ['6 pagi', '18:00', 'delivery.openTime'],
  ]) {
    const r = await put({ delivery: { ...delivery, openTime, closeTime } });
    assert.equal(r.status, 422, `${openTime}-${closeTime}`);
    assert.ok(r.json.fields[field], `${openTime}-${closeTime}`);
  }
  for (const [key, value] of [['instagram', 'ada spasi'], ['instagram', 'a'.repeat(31)], ['email', 'bukan-email'], ['email', 'a@b']]) {
    const r = await put({ business: { ...business, [key]: value } });
    assert.equal(r.status, 422, value);
    assert.ok(r.json.fields[`business.${key}`], value);
  }

  assert.equal((await put({ delivery: { ...delivery, openTime: '07:30', closeTime: '17:00' }, business: { ...business, instagram: '@toko.uji', email: 'uji@example.com' } })).status, 200);
  const changed = await config();
  assert.equal(changed.delivery.openTime, '07:30');
  assert.equal(changed.business.instagram, 'toko.uji');
  assert.equal(changed.business.email, 'uji@example.com');

  // Kolom yang tidak dikirim dipertahankan; string kosong mengosongkan.
  assert.equal((await put({ delivery, business })).status, 200);
  assert.equal((await config()).delivery.openTime, '07:30');
  assert.equal((await config()).business.instagram, 'toko.uji');
  assert.equal((await put({ business: { ...business, instagram: '', email: '' } })).status, 200);
  assert.equal((await config()).business.email, '');
});
