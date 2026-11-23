'use strict';
/**
 * Autentikasi: hash password (scrypt bawaan Node), sesi berbasis cookie, dan pembatas percobaan login.
 * Tanpa dependensi eksternal.
 */
const crypto = require('crypto');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 hari
const MAX_SESSIONS_PER_USER = 5;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hashHex) {
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Dipakai agar waktu respons sama baik user ada maupun tidak (mengurangi user enumeration).
const DUMMY = hashPassword('zibbwash-dummy');
function verifyDummy(password) {
  try { verifyPassword(password, DUMMY.salt, DUMMY.hash); } catch { /* abaikan */ }
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function pruneSessions(db, now = Date.now()) {
  db.sessions = db.sessions.filter((s) => s.expires > now);
}

function createSession(db, userId, now = Date.now()) {
  pruneSessions(db, now);
  const mine = db.sessions.filter((s) => s.userId === userId);
  if (mine.length >= MAX_SESSIONS_PER_USER) {
    const drop = new Set(mine.sort((a, b) => a.expires - b.expires).slice(0, mine.length - MAX_SESSIONS_PER_USER + 1));
    db.sessions = db.sessions.filter((s) => !drop.has(s));
  }
  const token = crypto.randomBytes(32).toString('hex');
  // Yang disimpan hanya hash token, jadi bocornya db.json tidak membocorkan sesi aktif.
  db.sessions.push({ th: sha256(token), userId, expires: now + SESSION_TTL_MS });
  return token;
}

function findSession(db, token, now = Date.now()) {
  if (!token) return null;
  const th = sha256(token);
  const s = db.sessions.find((x) => x.th === th && x.expires > now);
  return s || null;
}

function destroySession(db, token) {
  if (!token) return;
  const th = sha256(token);
  db.sessions = db.sessions.filter((s) => s.th !== th);
}

function destroyUserSessions(db, userId, exceptToken) {
  const keep = exceptToken ? sha256(exceptToken) : null;
  db.sessions = db.sessions.filter((s) => s.userId !== userId || s.th === keep);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) { try { out[k] = decodeURIComponent(v); } catch { out[k] = v; } }
  }
  return out;
}

class RateLimiter {
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.map = new Map(); }
  check(key, now = Date.now()) {
    const e = this.map.get(key);
    if (!e || e.resetAt <= now) return { limited: false, retryAfterSec: 0 };
    return e.count >= this.max
      ? { limited: true, retryAfterSec: Math.ceil((e.resetAt - now) / 1000) }
      : { limited: false, retryAfterSec: 0 };
  }
  fail(key, now = Date.now()) {
    const e = this.map.get(key);
    if (!e || e.resetAt <= now) this.map.set(key, { count: 1, resetAt: now + this.windowMs });
    else e.count += 1;
    if (this.map.size > 5000) for (const [k, v] of this.map) if (v.resetAt <= now) this.map.delete(k);
  }
  reset(key) { this.map.delete(key); }
}

module.exports = {
  hashPassword, verifyPassword, verifyDummy,
  createSession, findSession, destroySession, destroyUserSessions, pruneSessions,
  parseCookies, RateLimiter, SESSION_TTL_MS,
};
