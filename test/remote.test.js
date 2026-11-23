'use strict';
/**
 * Uji penyimpanan jarak jauh (Upstash) memakai server Upstash tiruan di memori.
 * Skrip Lua pengecekan versi diperagakan ulang oleh tiruan ini; perilaku aslinya sudah dicoba juga di redis-server sungguhan.
 * Jalankan dengan `npm test`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createApp } = require('../server');
const { RemoteStore, CAS_SCRIPT } = require('../lib/remote');

const cleanups = [];
test.after(async () => { for (const fn of cleanups.reverse()) await fn(); });

const quiet = { warn() {}, error() {}, log() {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'zibbwash-remote-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

// Upstash tiruan: POST / dengan larik JSON. Mendukung MGET, GET, SET, dan EVAL untuk CAS_SCRIPT.
async function fakeUpstash(token = 'rahasia') {
  const kv = new Map();
  const ctl = { failNext: 0, failStatus: 503, dropResponseNext: 0, commands: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end('{"error":"Unauthorized"}'); }
      if (ctl.failNext > 0) { ctl.failNext--; res.writeHead(ctl.failStatus); return res.end('{"error":"unavailable"}'); }
      const cmd = JSON.parse(body);
      const name = String(cmd[0]).toUpperCase();
      ctl.commands.push(name);
      let result;
      if (name === 'MGET') result = cmd.slice(1).map((k) => (kv.has(k) ? kv.get(k) : null));
      else if (name === 'GET') result = kv.has(cmd[1]) ? kv.get(cmd[1]) : null;
      else if (name === 'SET') { kv.set(cmd[1], String(cmd[2])); result = 'OK'; }
      else if (name === 'EVAL') {
        assert.equal(cmd[1], CAS_SCRIPT, 'skrip tak dikenal');
        const [kRev, kDb, expected, next, data] = cmd.slice(3);
        const cur = kv.has(kRev) ? kv.get(kRev) : '0';
        if (cur !== expected) result = [0, cur];
        else { kv.set(kDb, data); kv.set(kRev, next); result = [1, next]; }
      } else { res.writeHead(400); return res.end('{"error":"ERR unknown command"}'); }
      if (ctl.dropResponseNext > 0) { ctl.dropResponseNext--; return req.socket.destroy(); } // diterapkan, balasan hilang
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { kv, ctl, url: `http://127.0.0.1:${server.address().port}`, token };
}

const mkRemote = (up, extra = {}) => {
  const r = new RemoteStore({
    url: up.url, token: up.token, log: quiet,
    debounceMs: 20, pullRetryMs: [10, 10], pushRetryMs: [20, 20, 20], keepAliveMs: 0, ...extra,
  });
  cleanups.push(() => r.stop());
  return r;
};

async function boot(up, { dir = tmpDir(), remoteOpts, appOpts } = {}) {
  const file = path.join(dir, 'db.json');
  const remote = mkRemote(up, remoteOpts);
  const restored = await remote.restore(file);
  const app = createApp({ dbFile: file, remote, adminPassword: 'admin123', ...appOpts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  cleanups.push(async () => { app.closeLive(); app.server.closeAllConnections?.(); await new Promise((r) => app.server.close(r)); });
  return { ...app, remote, restored, base, file };
}

async function post(base, url, body) {
  const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* bukan JSON */ }
  return { status: res.status, json };
}

test('Upstash kosong: database awal dikirim, rev = 1', async () => {
  const up = await fakeUpstash();
  const a = await boot(up);
  assert.equal(a.restored, false);
  assert.ok(await a.remote.flush(2000));
  assert.equal(up.kv.get('zibbwash:rev'), '1');
  const saved = JSON.parse(up.kv.get('zibbwash:db'));
  assert.ok(saved.users.some((u) => u.role === 'admin'));
});

test('disk hilang: server baru di folder kosong memulihkan pelanggan dari Upstash', async () => {
  const up = await fakeUpstash();
  const a = await boot(up);
  const reg = await post(a.base, '/api/auth/register', { name: 'Budi Uji', phone: '081200000010', password: 'rahasia1' });
  assert.equal(reg.status, 200);
  assert.ok(await a.remote.flush(2000));
  // "restart" di mesin baru: folder lain, remote baru, tanpa berkas lama
  const b = await boot(up);
  assert.equal(b.restored, true);
  const login = await post(b.base, '/api/auth/login', { role: 'customer', identifier: '081200000010', password: 'rahasia1' });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.name, 'Budi Uji');
});

test('perubahan beruntun digabung: satu kiriman, bukan satu per perubahan', async () => {
  const up = await fakeUpstash();
  const a = await boot(up, { remoteOpts: { debounceMs: 80 } });
  assert.ok(await a.remote.flush(2000));
  up.ctl.commands.length = 0;
  for (let i = 0; i < 6; i++) { a.store.db.orders.push({ id: `T${i}` }); a.store.save(); }
  assert.ok(await a.remote.flush(2000));
  assert.equal(up.ctl.commands.filter((c) => c === 'EVAL').length, 1);
  assert.equal(JSON.parse(up.kv.get('zibbwash:db')).orders.length, 6);
});

test('flush() mengirim sisa perubahan segera, tanpa menunggu jeda', async () => {
  const up = await fakeUpstash();
  const a = await boot(up, { remoteOpts: { debounceMs: 60000 } });
  a.store.db.orders.push({ id: 'AKHIR' });
  a.store.save();
  assert.equal(a.remote.dirty, true);
  assert.ok(await a.remote.flush(2000));
  assert.ok(JSON.parse(up.kv.get('zibbwash:db')).orders.some((o) => o.id === 'AKHIR'));
});

test('Upstash mati saat start: server tidak jalan dan berkas lokal tidak dibuat', async () => {
  const up = await fakeUpstash();
  up.ctl.failNext = 99;
  const file = path.join(tmpDir(), 'db.json');
  const remote = mkRemote(up);
  await assert.rejects(remote.restore(file), /Tidak bisa membaca database dari Upstash/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(up.kv.size, 0, 'tidak boleh menulis apa pun');
});

test('Upstash pulih pada percobaan ulang saat start', async () => {
  const up = await fakeUpstash();
  const first = await boot(up);
  assert.ok(await first.remote.flush(2000));
  up.ctl.failNext = 2; // dua percobaan gagal, ketiga berhasil (jeda ulang disetel 2 kali)
  const file = path.join(tmpDir(), 'db.json');
  const remote = mkRemote(up);
  assert.equal(await remote.restore(file), true);
  assert.ok(fs.existsSync(file));
});

test('token salah: gagal cepat dengan pesan jelas', async () => {
  const up = await fakeUpstash();
  const remote = new RemoteStore({ url: up.url, token: 'salah', log: quiet, pullRetryMs: [5000, 5000] });
  const t0 = Date.now();
  await assert.rejects(remote.pull(), /token/i);
  assert.ok(Date.now() - t0 < 1000, 'tidak boleh mengulang berkali-kali untuk token salah');
});

test('gagal kirim sementara: data tetap aman lokal, lalu terkirim sendiri saat Upstash pulih', async () => {
  const up = await fakeUpstash();
  const a = await boot(up);
  assert.ok(await a.remote.flush(2000));
  up.ctl.failNext = 2;
  a.store.db.orders.push({ id: 'SEMENTARA' });
  a.store.save();
  await wait(60);
  assert.equal(a.remote.dirty, true);
  assert.equal(a.remote.status().failing, true);
  for (let i = 0; i < 40 && a.remote.dirty; i++) await wait(25);
  assert.equal(a.remote.dirty, false);
  assert.equal(a.remote.status().failing, false);
  assert.ok(JSON.parse(up.kv.get('zibbwash:db')).orders.some((o) => o.id === 'SEMENTARA'));
});

test('balasan hilang padahal kiriman sudah masuk: bukan dianggap konflik', async () => {
  const up = await fakeUpstash();
  const a = await boot(up);
  assert.ok(await a.remote.flush(2000));
  let conflicted = false;
  a.remote.onConflict = () => { conflicted = true; };
  up.ctl.dropResponseNext = 1;
  a.store.db.orders.push({ id: 'SATU' });
  a.store.save();
  await wait(60);
  a.store.db.orders.push({ id: 'DUA' }); // perubahan lagi sebelum percobaan ulang
  a.store.save();
  assert.ok(await a.remote.flush(3000));
  assert.equal(conflicted, false);
  const saved = JSON.parse(up.kv.get('zibbwash:db'));
  assert.deepEqual(saved.orders.map((o) => o.id), ['SATU', 'DUA']);
});

test('dua instance: yang basi ditolak dan tidak menimpa data yang lebih baru', async () => {
  const up = await fakeUpstash();
  const a = await boot(up);
  assert.ok(await a.remote.flush(2000));
  const b = await boot(up); // memulihkan keadaan yang sama
  let conflicts = 0;
  b.remote.onConflict = () => { conflicts++; };
  assert.ok(await b.remote.flush(2000));
  a.store.db.orders.push({ id: 'DARI-A' });
  a.store.save();
  assert.ok(await a.remote.flush(2000));
  b.store.db.orders.push({ id: 'DARI-B-BASI' });
  b.store.save();
  await b.remote.flush(2000);
  assert.equal(conflicts, 1);
  const saved = JSON.parse(up.kv.get('zibbwash:db'));
  assert.ok(saved.orders.some((o) => o.id === 'DARI-A'));
  assert.ok(!saved.orders.some((o) => o.id === 'DARI-B-BASI'));
  assert.equal(b.remote.status().dirty, false);
});

test('keep-alive: menulis berkala walau tak ada perubahan (mencegah Upstash gratis diarsipkan)', async () => {
  const up = await fakeUpstash();
  const a = await boot(up, { remoteOpts: { keepAliveMs: 60 } });
  assert.ok(await a.remote.flush(2000));
  const rev1 = Number(up.kv.get('zibbwash:rev'));
  await wait(250);
  assert.ok(Number(up.kv.get('zibbwash:rev')) > rev1);
});

test('/healthz menampilkan status penyimpanan tanpa membocorkan rahasia', async () => {
  const up = await fakeUpstash();
  const a = await boot(up);
  assert.ok(await a.remote.flush(2000));
  const res = await fetch(a.base + '/healthz');
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.store.type, 'upstash');
  assert.equal(json.store.dirty, false);
  assert.equal(json.store.failing, false);
  assert.ok(json.store.lastSyncAt);
  const text = JSON.stringify(json);
  assert.ok(!text.includes(up.token) && !text.includes(up.url));
});

test('fromEnv: kosong = nonaktif, setengah terisi = error, alamat tanpa skema dilengkapi', () => {
  assert.equal(RemoteStore.fromEnv({}), null);
  assert.throws(() => RemoteStore.fromEnv({ UPSTASH_REDIS_REST_URL: 'https://x.upstash.io' }), /keduanya/);
  assert.throws(() => RemoteStore.fromEnv({ UPSTASH_REDIS_REST_TOKEN: 't' }), /keduanya/);
  const r = RemoteStore.fromEnv({ UPSTASH_REDIS_REST_URL: 'abc-123.upstash.io/', UPSTASH_REDIS_REST_TOKEN: ' t ', REMOTE_DB_KEY: 'laundry' });
  assert.equal(r.url, 'https://abc-123.upstash.io');
  assert.equal(r.token, 't');
  assert.equal(r.keyDb, 'laundry:db');
});

test('fromEnv: toleran terhadap tempelan dari tab .env (tanda kutip, awalan NAMA=, spasi)', () => {
  const a = RemoteStore.fromEnv({ UPSTASH_REDIS_REST_URL: '"https://abc.upstash.io"', UPSTASH_REDIS_REST_TOKEN: '"tokenku=="\n' });
  assert.equal(a.url, 'https://abc.upstash.io');
  assert.equal(a.token, 'tokenku==');
  const b = RemoteStore.fromEnv({ UPSTASH_REDIS_REST_URL: 'UPSTASH_REDIS_REST_URL="https://abc.upstash.io/"', UPSTASH_REDIS_REST_TOKEN: " UPSTASH_REDIS_REST_TOKEN='rahasia' " });
  assert.equal(b.url, 'https://abc.upstash.io');
  assert.equal(b.token, 'rahasia');
  assert.throws(() => RemoteStore.fromEnv({ UPSTASH_REDIS_REST_URL: '""', UPSTASH_REDIS_REST_TOKEN: 't' }), /harus diisi/);
});
