'use strict';

const crypto = require('node:crypto');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored).split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(password, salt, 64);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isStrongPassword(password) {
  return typeof password === 'string' && password.length >= 12;
}

// --- Sessions -------------------------------------------------------------

function createSession(db, userId) {
  const rawToken = randomToken(32);
  const id = sha256(rawToken);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  db.prepare(
    'INSERT INTO sessions (id, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)'
  ).run(id, userId, csrfToken, expiresAt);

  return { rawToken, csrfToken, expiresAt };
}

function getSession(db, rawToken) {
  if (!rawToken) return null;
  const id = sha256(rawToken);
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return null;
  }
  return row;
}

function destroySession(db, rawToken) {
  if (!rawToken) return;
  const id = sha256(rawToken);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

function destroyAllSessionsForUser(db, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// --- Rate limiting ----------------------------------------------------------

function checkRateLimit(db, key) {
  const row = db.prepare('SELECT * FROM attempts WHERE key = ?').get(key);
  if (!row) return { allowed: true };

  if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
    return { allowed: false, lockedUntil: row.locked_until };
  }

  const windowStart = new Date(row.first_attempt_at).getTime();
  if (Date.now() - windowStart > ATTEMPT_WINDOW_MS) {
    db.prepare('DELETE FROM attempts WHERE key = ?').run(key);
    return { allowed: true };
  }

  return { allowed: true };
}

function recordFailedAttempt(db, key) {
  const row = db.prepare('SELECT * FROM attempts WHERE key = ?').get(key);
  const now = new Date().toISOString();

  if (!row) {
    db.prepare(
      'INSERT INTO attempts (key, count, first_attempt_at) VALUES (?, 1, ?)'
    ).run(key, now);
    return;
  }

  const windowStart = new Date(row.first_attempt_at).getTime();
  if (Date.now() - windowStart > ATTEMPT_WINDOW_MS) {
    db.prepare(
      'UPDATE attempts SET count = 1, first_attempt_at = ?, locked_until = NULL WHERE key = ?'
    ).run(now, key);
    return;
  }

  const count = row.count + 1;
  if (count >= MAX_ATTEMPTS) {
    const lockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString();
    db.prepare(
      'UPDATE attempts SET count = ?, locked_until = ? WHERE key = ?'
    ).run(count, lockedUntil, key);
  } else {
    db.prepare('UPDATE attempts SET count = ? WHERE key = ?').run(count, key);
  }
}

function clearAttempts(db, key) {
  db.prepare('DELETE FROM attempts WHERE key = ?').run(key);
}

module.exports = {
  hashPassword,
  verifyPassword,
  randomToken,
  sha256,
  isStrongPassword,
  createSession,
  getSession,
  destroySession,
  destroyAllSessionsForUser,
  checkRateLimit,
  recordFailedAttempt,
  clearAttempts
};
