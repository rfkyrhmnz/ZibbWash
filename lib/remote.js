'use strict';
/**
 * Penyimpanan jarak jauh: salinan database di Upstash Redis (lewat REST, tanpa dependensi).
 *
 * Untuk hosting yang disknya tidak permanen (mis. Render gratis: berkas hilang tiap restart atau saat tidur).
 * Berkas db.json lokal tetap dipakai sebagai cache kerja; sumber kebenarannya ada di Upstash.
 *   - Saat start: snapshot diambil dari Upstash dan ditulis ke berkas lokal, baru kemudian Store memuatnya.
 *   - Tiap Store.save(): snapshot dikirim ke Upstash (ditunda ±1,5 detik agar perubahan beruntun jadi satu kiriman).
 *   - Saat SIGTERM: sisa perubahan dikirim dulu (flush) sebelum proses keluar.
 *
 * Pengaman:
 *   - Jika Upstash tidak terjangkau saat start, server TIDAK jalan. Memulai dengan database kosong lalu menimpa
 *     data asli adalah kegagalan terburuk, jadi lebih baik berhenti dan mencoba lagi.
 *   - Penulisan memakai pengecekan versi (rev) lewat skrip Lua atomik: bila ada instance lain yang sudah menulis
 *     lebih baru (mis. dua instance berjalan bersamaan saat deploy), kiriman ditolak dan proses berhenti
 *     supaya platform menyalakannya ulang dari data terbaru. Tidak ada saling timpa.
 *   - Upstash gratis mengarsipkan database yang tidak disentuh ≥14 hari, jadi ada tulis berkala (keep-alive).
 *
 * Variabel lingkungan: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN (keduanya dari konsol Upstash > REST API),
 * REMOTE_DB_KEY (opsional, awalan kunci, bawaan "zibbwash").
 */
const fs = require('fs');
const path = require('path');

// Tulis hanya bila rev di server masih sama dengan yang terakhir kita lihat (KEYS[1]=rev, KEYS[2]=data).
// Balasan: {1, revBaru} bila berhasil, {0, revDiServer} bila ada penulis lain.
const CAS_SCRIPT = [
  "local cur = redis.call('GET', KEYS[1]) or '0'",
  'if cur ~= ARGV[1] then return {0, cur} end',
  "redis.call('SET', KEYS[2], ARGV[3])",
  "redis.call('SET', KEYS[1], ARGV[2])",
  'return {1, ARGV[2]}',
].join('\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WARN_BYTES = 8 * 1024 * 1024; // batas permintaan Upstash gratis 10 MB

class RemoteError extends Error {
  constructor(message, { status = 0, fatal = false } = {}) {
    super(message);
    this.name = 'RemoteError';
    this.status = status;
    this.fatal = fatal;
  }
}

class RemoteStore {
  constructor({
    url, token, key = 'zibbwash', fetchImpl, log = console,
    debounceMs = 1500, keepAliveMs = 12 * 3600 * 1000, timeoutMs = 10000,
    pullRetryMs = [1000, 3000, 8000, 15000], pushRetryMs = [2000, 5000, 15000, 30000, 60000],
    onConflict = null,
  } = {}) {
    if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL dan UPSTASH_REDIS_REST_TOKEN harus diisi.');
    let u = String(url).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    this.url = u;
    this.token = String(token).trim();
    this.keyRev = `${key}:rev`;
    this.keyDb = `${key}:db`;
    this.fetch = fetchImpl || globalThis.fetch;
    this.log = log;
    this.debounceMs = debounceMs;
    this.keepAliveMs = keepAliveMs;
    this.timeoutMs = timeoutMs;
    this.pullRetryMs = pullRetryMs;
    this.pushRetryMs = pushRetryMs;
    this.onConflict = onConflict;

    this.store = null;
    this.rev = 0;
    this.remoteJson = null;
    this.dirty = false;
    this.force = false;
    this.generation = 0;
    this.timer = null;
    this.keepTimer = null;
    this.inflight = null;
    this.failures = 0;
    this.lastError = null;
    this.lastSyncAt = null;
    this.unconfirmed = []; // isi kiriman yang hasilnya tak diketahui (jaringan putus sebelum balasan)
    this.conflicted = false;
    this.warnedSize = false;
  }

  static fromEnv(env = process.env, opts = {}) {
    const url = env.UPSTASH_REDIS_REST_URL;
    const token = env.UPSTASH_REDIS_REST_TOKEN;
    if (!url && !token) return null;
    if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL dan UPSTASH_REDIS_REST_TOKEN harus diisi keduanya.');
    return new RemoteStore({ url, token, key: env.REMOTE_DB_KEY || 'zibbwash', ...opts });
  }

  // Satu perintah Redis lewat REST: POST dengan larik JSON, balasan { result } atau { error }.
  async command(args) {
    let res;
    try {
      res = await this.fetch(this.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new RemoteError(`tidak terhubung ke Upstash (${e.cause?.code || e.name || 'jaringan'}: ${e.message})`);
    }
    let data = null;
    try { data = await res.json(); } catch { /* bukan JSON */ }
    if (res.status === 401 || res.status === 403) {
      throw new RemoteError('Upstash menolak token (UPSTASH_REDIS_REST_TOKEN salah atau sudah dicabut)', { status: res.status, fatal: true });
    }
    if (!res.ok || !data || data.error) {
      throw new RemoteError(`Upstash membalas ${res.status}${data && data.error ? `: ${data.error}` : ''}`, { status: res.status });
    }
    return data.result;
  }

  async _withRetry(fn, delays) {
    let lastErr;
    for (let i = 0; i <= delays.length; i++) {
      try { return await fn(); } catch (e) {
        lastErr = e;
        if (e.fatal || i === delays.length) break;
        this.log.warn(`[PENYIMPANAN] ${e.message}. Mencoba lagi dalam ${Math.round(delays[i] / 100) / 10} detik...`);
        await sleep(delays[i]);
      }
    }
    throw lastErr;
  }

  // Ambil snapshot terbaru. Gagal (setelah beberapa percobaan) = lempar error; jangan lanjut dengan data kosong.
  async pull() {
    const [rev, json] = await this._withRetry(() => this.command(['MGET', this.keyRev, this.keyDb]), this.pullRetryMs)
      .catch((e) => { throw new Error(`Tidak bisa membaca database dari Upstash: ${e.message}. Server dihentikan supaya data asli tidak tertimpa. Periksa UPSTASH_REDIS_REST_URL dan UPSTASH_REDIS_REST_TOKEN.`); });
    this.rev = Number(rev || 0);
    this.remoteJson = typeof json === 'string' ? json : null;
    return { rev: this.rev, json: this.remoteJson };
  }

  // Tarik snapshot lalu tulis ke berkas lokal (atomik) sebelum Store dibuat. Mengembalikan true bila ada data jarak jauh.
  async restore(file) {
    const { json } = await this.pull();
    if (json === null) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.restore`;
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, file);
    return true;
  }

  // Pasang ke Store: setiap save() menandai data kotor. Kirim awal bila Upstash masih kosong atau isinya berbeda.
  attach(store) {
    this.store = store;
    store.afterSave = () => this.markDirty();
    const same = this.remoteJson !== null && JSON.stringify(store.db) === this.remoteJson;
    this.remoteJson = null;
    if (!same) this.markDirty();
    if (this.keepAliveMs > 0) {
      this.keepTimer = setInterval(() => { this.force = true; this._schedule(0); }, this.keepAliveMs);
      this.keepTimer.unref();
    }
  }

  markDirty() {
    if (this.conflicted) return;
    this.dirty = true;
    this.generation++;
    this._schedule(this.debounceMs);
  }

  _schedule(ms) {
    if (this.timer || this.conflicted) return;
    this.timer = setTimeout(() => { this.timer = null; this._run(); }, ms);
    this.timer.unref();
  }

  _run() {
    if (!this.inflight) this.inflight = this._drain().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async _drain() {
    while ((this.dirty || this.force) && !this.conflicted) {
      const gen = this.generation;
      this.force = false;
      try {
        await this._pushOnce();
        if (this.generation === gen) this.dirty = false;
      } catch (e) {
        if (e.conflict) { this._conflict(e); return; }
        this.lastError = e.message;
        const wait = this.pushRetryMs[Math.min(this.failures++, this.pushRetryMs.length - 1)];
        this.log.error(`[PENYIMPANAN] Gagal menyimpan ke Upstash: ${e.message}. Data aman di server ini, dicoba lagi dalam ${Math.round(wait / 100) / 10} detik.`);
        this.dirty = true;
        this._schedule(wait);
        return;
      }
    }
  }

  async _pushOnce(retried = false) {
    const body = JSON.stringify(this.store.db);
    if (body.length > WARN_BYTES && !this.warnedSize) {
      this.warnedSize = true;
      this.log.warn('[PENYIMPANAN] Database mendekati batas 10 MB per kiriman Upstash gratis. Pertimbangkan membersihkan pesanan lama atau pindah ke disk permanen.');
    }
    const next = this.rev + 1;
    let res;
    try {
      res = await this.command(['EVAL', CAS_SCRIPT, 2, this.keyRev, this.keyDb, String(this.rev), String(next), body]);
    } catch (e) {
      // Bisa jadi kiriman ini sudah diterapkan server padahal balasannya hilang. Catat isinya untuk pengecekan nanti.
      this.unconfirmed.push(body);
      if (this.unconfirmed.length > 3) this.unconfirmed.shift();
      throw e;
    }
    if (!Array.isArray(res)) throw new RemoteError('balasan tak terduga dari Upstash');
    if (Number(res[0]) === 1) {
      this.rev = next;
      this.unconfirmed = [];
      this.lastSyncAt = Date.now();
      this.lastError = null;
      this.failures = 0;
      return;
    }
    // Ditolak. Mungkin kiriman kita sebelumnya sebenarnya sudah masuk tetapi balasannya hilang di jalan:
    // kalau isi di server sama persis dengan salah satu kiriman kita, itu penulisan kita sendiri, bukan instance lain.
    const remoteRev = Number(res[1]);
    if (!retried && this.unconfirmed.length && remoteRev === this.rev + 1) {
      const cur = await this.command(['GET', this.keyDb]);
      if (this.unconfirmed.includes(cur)) {
        this.rev = remoteRev;
        this.unconfirmed = [];
        return this._pushOnce(true);
      }
    }
    const err = new RemoteError(`versi di Upstash (${remoteRev}) lebih baru dari milik instance ini (${this.rev})`);
    err.conflict = true;
    err.remoteRev = remoteRev;
    throw err;
  }

  _conflict(e) {
    this.conflicted = true;
    this.dirty = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.log.error(`[FATAL] Ada instance lain yang menulis ke database yang sama (${e.message}). Instance ini berhenti supaya tidak menimpa data; platform akan menyalakannya lagi dari data terbaru.`);
    if (this.onConflict) this.onConflict(e);
  }

  // Kirim sisa perubahan sekarang juga (dipanggil saat SIGTERM). Mengembalikan true bila semua sudah tersimpan.
  async flush(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    clearTimeout(this.timer);
    this.timer = null;
    while ((this.dirty || this.inflight) && !this.conflicted && Date.now() < deadline) {
      await Promise.race([this._run(), sleep(Math.max(0, deadline - Date.now()))]);
      if (this.dirty && !this.conflicted) { // gagal: _drain menjadwalkan percobaan ulang; di sini coba lagi segera
        clearTimeout(this.timer);
        this.timer = null;
        await sleep(Math.min(300, Math.max(0, deadline - Date.now())));
      }
    }
    return !this.dirty && !this.conflicted;
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.keepTimer);
    this.timer = null;
    this.keepTimer = null;
  }

  // Ringkasan untuk /healthz. Tanpa teks error agar tidak membocorkan alamat atau token.
  status() {
    return {
      type: 'upstash',
      dirty: this.dirty,
      failing: !!this.lastError,
      lastSyncAt: this.lastSyncAt ? new Date(this.lastSyncAt).toISOString() : null,
    };
  }
}

module.exports = { RemoteStore, RemoteError, CAS_SCRIPT };
