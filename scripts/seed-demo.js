'use strict';
/**
 * Mengisi database dengan data contoh agar tampilan admin/pelanggan langsung terlihat hidup.
 *   npm run seed            → membuat data/db.json baru (batal bila sudah ada isinya)
 *   npm run seed -- --force → menimpa data/db.json yang ada
 *
 * Akun contoh:
 *   Admin     : admin / admin123
 *   Pelanggan : 081234567890 / demo123   (Rina, 7 stamp)
 *   Pelanggan : 081298765432 / demo123   (Budi)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store, createDefaultDb } = require('../lib/store');
const auth = require('../lib/auth');
const L = require('../lib/logic');

const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'db.json');
const force = process.argv.includes('--force');

if (fs.existsSync(file) && !force) {
  const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  if ((cur.orders || []).length || (cur.users || []).some((u) => u.role === 'customer')) {
    console.error(`Database ${file} sudah berisi data. Jalankan dengan --force bila ingin menimpanya.`);
    process.exit(1);
  }
}
if (fs.existsSync(file)) fs.unlinkSync(file);

const store = new Store(file, { adminPassword: process.env.ADMIN_PASSWORD || 'admin123' });
const db = store.db;
const settings = db.settings;

const minutesAgo = (m) => new Date(Date.now() - m * 60000);
const DAY = 1440;

function makeCustomer(name, phone) {
  const { salt, hash } = auth.hashPassword('demo123');
  const u = {
    id: crypto.randomUUID(), role: 'customer', name, phone, salt, hash,
    stamps: 0, vouchers: 0, totalStamps: 0, loyaltyLog: [], createdAt: minutesAgo(40 * DAY).toISOString(),
  };
  db.users.push(u);
  return u;
}

function place(user, input, when) {
  const v = L.validateOrderInput(input, settings, user);
  return L.createOrder(db, user, v, settings, when);
}

const rina = makeCustomer('Rina Wulandari', '081234567890');
const budi = makeCustomer('Budi Santoso', '081298765432');

// Tujuh pesanan lama yang sudah selesai dan lunas, menghasilkan 7 stamp untuk Rina.
const history = [
  ['regular', 6], ['wash-fold', 5], ['express', 4], ['wash-iron', 4], ['regular', 7], ['wash-fold', 6], ['express', 3.5],
];
history.forEach(([serviceId, kg], i) => {
  const t0 = 38 * DAY - i * 5 * DAY;
  const o = place(rina, {
    serviceId, garments: [{ type: 'Pakaian harian', qty: 12 }], estimatedWeight: kg, handover: 'dropoff', returnMethod: 'self',
  }, minutesAgo(t0));
  L.setWeight(db, o, kg, 'admin', minutesAgo(t0 - 90));
  for (const [i2, st] of ['washing', 'drying', 'finishing', 'ready'].entries()) {
    L.setStatus(db, o, st, '', 'admin', minutesAgo(t0 - 120 - i2 * 180));
  }
  L.markPaid(db, o, 'qris', 'pelanggan', minutesAgo(t0 - 700), true);
  L.setStatus(db, o, 'done', 'Diambil pelanggan.', 'admin', minutesAgo(t0 - 800));
});

// 1) Antar-jemput, sedang dicuci, belum dibayar.
const o1 = place(rina, {
  serviceId: 'wash-iron', garments: [{ type: 'Kemeja / batik', qty: 6 }, { type: 'Celana jeans', qty: 3 }],
  estimatedWeight: 4, handover: 'pickup', returnMethod: 'delivery',
  address: { text: 'Jl. Contoh No. 12, Surabaya (pagar hitam, sebelah toko buku)', lat: -7.246905, lng: 112.772658 },
  notes: 'Tolong kemeja putih dipisah.',
}, minutesAgo(5 * 60));
L.setStatus(db, o1, 'pickup', 'Kurir menjemput di lokasi.', 'admin', minutesAgo(4.5 * 60));
L.setWeight(db, o1, 4.2, 'admin', minutesAgo(3.5 * 60));
L.setStatus(db, o1, 'washing', 'Mulai dicuci.', 'admin', minutesAgo(2 * 60));

// 2) Pesanan baru, menunggu diproses admin.
place(rina, {
  serviceId: 'express', garments: [{ type: 'Seragam', qty: 4 }, { type: 'Pakaian harian', qty: 5 }],
  estimatedWeight: 3, handover: 'dropoff', returnMethod: 'self',
}, minutesAgo(25));

// 3) Budi: ditimbang, tagihan siap dibayar.
const o3 = place(budi, {
  serviceId: 'regular', garments: [{ type: 'Pakaian harian', qty: 20 }, { type: 'Handuk', qty: 3 }],
  estimatedWeight: 8, handover: 'pickup', returnMethod: 'self',
  address: { text: 'Jl. Contoh No. 8, Surabaya', lat: -7.282205, lng: 112.778458 },
}, minutesAgo(9 * 60));
L.setStatus(db, o3, 'pickup', '', 'admin', minutesAgo(8 * 60));
L.setWeight(db, o3, 8.6, 'admin', minutesAgo(7 * 60));

// 4) Budi: antar sendiri, siap diambil, sudah lunas.
const o4 = place(budi, {
  serviceId: 'wash-fold', garments: [{ type: 'Pakaian harian', qty: 10 }], estimatedWeight: 3,
  handover: 'dropoff', returnMethod: 'self',
}, minutesAgo(30 * 60));
L.setWeight(db, o4, 3.4, 'admin', minutesAgo(29 * 60));
for (const [i, st] of ['washing', 'drying', 'finishing', 'ready'].entries()) L.setStatus(db, o4, st, '', 'admin', minutesAgo((28 - i * 4) * 60));
L.markPaid(db, o4, 'ewallet', 'pelanggan', minutesAgo(10 * 60), true);

store.save();
console.log(`Data contoh dibuat di ${file}`);
console.log('  Admin     : admin / admin123');
console.log('  Pelanggan : 081234567890 / demo123  (Rina, 7 stamp)');
console.log('  Pelanggan : 081298765432 / demo123  (Budi)');
