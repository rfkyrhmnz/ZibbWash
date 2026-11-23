'use strict';
/**
 * Penyimpanan data: satu berkas JSON (data/db.json) sebagai "database".
 * - Dimuat ke memori saat server start, ditulis ulang secara atomik (tulis ke file sementara lalu rename)
 *   setiap kali ada perubahan.
 * - Jika berkas belum ada, dibuat otomatis berisi pengaturan bawaan + satu akun admin.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hashPassword } = require('./auth');

function defaultSettings() {
  return {
    business: {
      name: 'ZibbWash Laundry',
      phone: '085737694109',
      whatsapp: '6285737694109',
      // GANTI lewat Admin > Tarif & pengaturan: titik awal peta & dasar perhitungan jarak antar-jemput.
      address: 'Alamat outlet belum diatur (Admin > Tarif & pengaturan)',
      lat: -7.9826,
      lng: 112.6308,
    },
    maps: { apiKey: '' },
    // Tarif di bawah adalah nilai awal; ubah lewat Admin > Tarif & pengaturan.
    services: [
      { id: 'regular', name: 'Regular Laundry', desc: 'Cuci dan kering, dikemas rapi per kilo.', eta: '2–3 hari', pricePerKg: 6000, finish: 'dikemas' },
      { id: 'express', name: 'Express Laundry', desc: 'Antrean didahulukan, cuci kering lipat dalam hitungan jam.', eta: '6–8 jam', pricePerKg: 10000, finish: 'dilipat' },
      { id: 'wash-fold', name: 'Wash & Fold', desc: 'Cuci, kering, lalu dilipat rapi.', eta: '1–2 hari', pricePerKg: 7000, finish: 'dilipat' },
      { id: 'wash-iron', name: 'Wash & Iron', desc: 'Cuci, kering, lalu disetrika licin.', eta: '2–3 hari', pricePerKg: 9000, finish: 'disetrika' },
    ],
    garmentTypes: [
      'Pakaian harian',
      'Kemeja / batik',
      'Celana jeans',
      'Jaket / hoodie',
      'Seragam',
      'Handuk',
      'Seprai & sarung bantal',
      'Selimut / bedcover',
    ],
    delivery: { freeKm: 3, perKm: 3000, chargePerLeg: true, maxKm: 20 },
    loyalty: { minTransaction: 30000, stampsForReward: 10, rewardServiceId: 'wash-fold', rewardMaxKg: 3 },
    paymentMethods: [
      { id: 'qris', name: 'QRIS' },
      { id: 'va', name: 'Transfer bank (Virtual Account)' },
      { id: 'ewallet', name: 'E-wallet (GoPay, OVO, DANA)' },
      { id: 'cash', name: 'Tunai di outlet atau ke kurir' },
    ],
  };
}

function nowIso() { return new Date().toISOString(); }

function createAdminUser(password) {
  const { salt, hash } = hashPassword(password);
  return {
    id: crypto.randomUUID(), role: 'admin', username: 'admin', name: 'Admin ZibbWash',
    salt, hash, createdAt: nowIso(),
  };
}

function createDefaultDb(adminPassword) {
  return { version: 1, settings: defaultSettings(), users: [createAdminUser(adminPassword)], sessions: [], orders: [] };
}

// Gabungkan pengaturan tersimpan dengan bawaan agar berkas lama tetap kompatibel saat ada kunci baru.
function mergeDefaults(target, defaults) {
  for (const [k, v] of Object.entries(defaults)) {
    if (target[k] === undefined) target[k] = JSON.parse(JSON.stringify(v));
    else if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') mergeDefaults(target[k], v);
  }
  return target;
}

class Store {
  constructor(file, { adminPassword = 'admin123' } = {}) {
    this.file = file;
    this.adminPassword = adminPassword;
    this.db = null;
    this.load();
  }

  load() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) {
      this.db = createDefaultDb(this.adminPassword);
      this.save();
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      throw new Error(`Berkas database tidak bisa dibaca (${this.file}): ${e.message}. Perbaiki JSON-nya atau pindahkan berkasnya agar dibuat ulang.`);
    }
    parsed.settings = mergeDefaults(parsed.settings || {}, defaultSettings());
    parsed.users = parsed.users || [];
    parsed.sessions = parsed.sessions || [];
    parsed.orders = parsed.orders || [];
    if (!parsed.users.some((u) => u.role === 'admin')) parsed.users.push(createAdminUser(this.adminPassword));
    this.db = parsed;
    const before = parsed.sessions.length;
    const now = Date.now();
    parsed.sessions = parsed.sessions.filter((s) => s.expires > now);
    if (parsed.sessions.length !== before) this.save();
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store, defaultSettings, createDefaultDb, createAdminUser, mergeDefaults };
