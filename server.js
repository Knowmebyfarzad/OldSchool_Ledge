'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { openDatabase, emptyWorkspaceData } = require('./lib/db');
const auth = require('./lib/auth');
const csvLib = require('./lib/csv');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || '').trim().replace(/\/$/, '');
const DATA_DIR = path.resolve(process.env.LEDGER_DATA_DIR || '.data');
const HTTPS_MODE = PUBLIC_ORIGIN.length > 0;
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = openDatabase(DATA_DIR);

// In-memory cache of validated CSV import previews, keyed by a random
// token and scoped to the session that created them. Nothing here is
// written to the database until the user explicitly commits the import.
const importCache = new Map();
const IMPORT_TTL_MS = 30 * 60 * 1000;

function pruneImportCache() {
  const now = Date.now();
  for (const [token, entry] of importCache) {
    if (entry.expiresAt < now) importCache.delete(token);
  }
}
setInterval(pruneImportCache, 5 * 60 * 1000).unref();

// --- Setup code -------------------------------------------------------------

const SETUP_CODE_PATH = path.join(DATA_DIR, 'setup-code.txt');

function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

function ensureSetupCode() {
  if (userCount() > 0) {
    if (fs.existsSync(SETUP_CODE_PATH)) fs.rmSync(SETUP_CODE_PATH);
    return;
  }
  if (!fs.existsSync(SETUP_CODE_PATH)) {
    const code = auth.randomToken(16);
    fs.writeFileSync(SETUP_CODE_PATH, code + '\n', { mode: 0o600 });
  }
}
ensureSetupCode();

function isSetupMode() {
  return userCount() === 0;
}

// --- Small helpers ----------------------------------------------------------

function readJsonBody(req, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function setSessionCookie(res, token, expiresAt) {
  const attrs = [
    `session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(expiresAt).toUTCString()}`
  ];
  if (HTTPS_MODE) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  const attrs = [
    'session=',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
  ];
  if (HTTPS_MODE) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function getWorkspace(userId) {
  const row = db.prepare('SELECT * FROM workspaces WHERE user_id = ?').get(userId);
  if (!row) {
    const data = emptyWorkspaceData();
    db.prepare('INSERT INTO workspaces (user_id, data, version) VALUES (?, ?, 1)').run(
      userId,
      JSON.stringify(data)
    );
    return { userId, data, version: 1 };
  }
  return { userId, data: JSON.parse(row.data), version: row.version };
}

function saveWorkspace(userId, data, expectedVersion) {
  const result = db
    .prepare('UPDATE workspaces SET data = ?, version = version + 1, updated_at = datetime(\'now\') WHERE user_id = ? AND version = ?')
    .run(JSON.stringify(data), userId, expectedVersion);
  if (result.changes === 0) {
    return { ok: false };
  }
  const row = db.prepare('SELECT version FROM workspaces WHERE user_id = ?').get(userId);
  return { ok: true, version: row.version };
}

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    disabled: !!row.disabled,
    mustChangePassword: !!row.must_change_password,
    createdAt: row.created_at
  };
}

// --- Request context: auth + origin/CSRF checks ----------------------------

function checkOrigin(req) {
  if (!HTTPS_MODE) return true;
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin navigations may omit Origin
  return origin.replace(/\/$/, '') === PUBLIC_ORIGIN;
}

function getCurrentUser(req) {
  const cookies = parseCookies(req);
  const session = auth.getSession(db, cookies.session);
  if (!session) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
  if (!user || user.disabled) return null;
  return { user, session };
}

// --- Static file serving -----------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function serveStatic(req, res, pathname) {
  let relPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, relPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      // SPA fallback for any non-file route.
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, indexContent) => {
        if (err2) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const headers = { 'Content-Type': MIME['.html'] };
        if (HTTPS_MODE) headers['Strict-Transport-Security'] = 'max-age=31536000';
        res.writeHead(200, headers);
        res.end(indexContent);
      });
      return;
    }
    const ext = path.extname(filePath);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (HTTPS_MODE) headers['Strict-Transport-Security'] = 'max-age=31536000';
    res.writeHead(200, headers);
    res.end(content);
  });
}

// --- Route handlers -----------------------------------------------------------

async function handleApi(req, res, url) {
  if (HTTPS_MODE && !checkOrigin(req)) {
    return sendJson(res, 403, { error: 'Origin not allowed' });
  }
  if (HTTPS_MODE) {
    const proto = req.headers['x-forwarded-proto'];
    if (proto && proto !== 'https') {
      return sendJson(res, 400, { error: 'HTTPS is required' });
    }
  }

  const { pathname } = url;
  const method = req.method;

  // ---- Status / setup ----
  if (pathname === '/api/status' && method === 'GET') {
    return sendJson(res, 200, { needsSetup: isSetupMode(), httpsMode: HTTPS_MODE });
  }

  if (pathname === '/api/setup' && method === 'POST') {
    if (!isSetupMode()) return sendJson(res, 409, { error: 'Setup already completed' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'Invalid request body' });
    }
    const { code, name, email, password } = body;
    if (!fs.existsSync(SETUP_CODE_PATH)) {
      return sendJson(res, 400, { error: 'No setup code is available' });
    }
    const expected = fs.readFileSync(SETUP_CODE_PATH, 'utf-8').trim();
    if (!code || code.trim() !== expected) {
      return sendJson(res, 401, { error: 'Incorrect setup code' });
    }
    if (!name || !email || !auth.isStrongPassword(password)) {
      return sendJson(res, 400, {
        error: 'Name, email, and a password of at least 12 characters are required'
      });
    }

    const passwordHash = auth.hashPassword(password);
    const info = db
      .prepare(
        'INSERT INTO users (name, email, password_hash, role, disabled, must_change_password) VALUES (?, ?, ?, \'admin\', 0, 0)'
      )
      .run(name, email.toLowerCase().trim(), passwordHash);

    fs.rmSync(SETUP_CODE_PATH, { force: true });

    const { rawToken, expiresAt } = auth.createSession(db, info.lastInsertRowid);
    setSessionCookie(res, rawToken, expiresAt);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    return sendJson(res, 201, { user: publicUser(user) });
  }

  // ---- Login / logout ----
  if (pathname === '/api/login' && method === 'POST') {
    if (isSetupMode()) return sendJson(res, 409, { error: 'Setup has not been completed' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'Invalid request body' });
    }
    const email = (body.email || '').toLowerCase().trim();
    const password = body.password || '';
    const rateKey = `login:${email}`;

    const rate = auth.checkRateLimit(db, rateKey);
    if (!rate.allowed) {
      return sendJson(res, 429, {
        error: 'Too many attempts. Try again later.',
        lockedUntil: rate.lockedUntil
      });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || user.disabled || !auth.verifyPassword(password, user.password_hash)) {
      auth.recordFailedAttempt(db, rateKey);
      return sendJson(res, 401, { error: 'Incorrect email or password' });
    }

    auth.clearAttempts(db, rateKey);
    const { rawToken, expiresAt } = auth.createSession(db, user.id);
    setSessionCookie(res, rawToken, expiresAt);
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const cookies = parseCookies(req);
    auth.destroySession(db, cookies.session);
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  // ---- Everything below requires a session ----
  const ctx = getCurrentUser(req);
  if (!ctx) return sendJson(res, 401, { error: 'Sign in required' });
  const { user, session } = ctx;

  // CSRF check for mutating requests.
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    const csrfHeader = req.headers['x-csrf-token'];
    if (!csrfHeader || csrfHeader !== session.csrf_token) {
      return sendJson(res, 403, { error: 'Missing or invalid CSRF token' });
    }
  }

  if (pathname === '/api/me' && method === 'GET') {
    return sendJson(res, 200, { user: publicUser(user), csrfToken: session.csrf_token });
  }

  if (pathname === '/api/account/change-password' && method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'Invalid request body' });
    }
    if (!auth.verifyPassword(body.currentPassword || '', user.password_hash)) {
      return sendJson(res, 401, { error: 'Current password is incorrect' });
    }
    if (!auth.isStrongPassword(body.newPassword)) {
      return sendJson(res, 400, { error: 'New password must be at least 12 characters' });
    }
    const newHash = auth.hashPassword(body.newPassword);
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(
      newHash,
      user.id
    );
    // Keep the current session alive but revoke other sessions.
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(
      user.id,
      auth.sha256(parseCookies(req).session)
    );
    return sendJson(res, 200, { ok: true });
  }

  // ---- User management (admin only) ----
  if (pathname === '/api/users' && method === 'GET') {
    if (user.role !== 'admin') return sendJson(res, 403, { error: 'Admin role required' });
    const rows = db.prepare('SELECT * FROM users ORDER BY created_at').all();
    return sendJson(res, 200, { users: rows.map(publicUser) });
  }

  if (pathname === '/api/users' && method === 'POST') {
    if (user.role !== 'admin') return sendJson(res, 403, { error: 'Admin role required' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'Invalid request body' });
    }
    const { name, email, role, tempPassword } = body;
    if (!name || !email || !['admin', 'member'].includes(role)) {
      return sendJson(res, 400, { error: 'Name, email, and a valid role are required' });
    }
    if (!auth.isStrongPassword(tempPassword)) {
      return sendJson(res, 400, { error: 'Temporary password must be at least 12 characters' });
    }
    try {
      const passwordHash = auth.hashPassword(tempPassword);
      const info = db
        .prepare(
          'INSERT INTO users (name, email, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, 1)'
        )
        .run(name, email.toLowerCase().trim(), passwordHash, role);
      const newUser = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
      return sendJson(res, 201, { user: publicUser(newUser) });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return sendJson(res, 409, { error: 'A user with that email already exists' });
      }
      throw err;
    }
  }

  const userActionMatch = pathname.match(/^\/api\/users\/(\d+)\/(disable|enable|reset-password)$/);
  if (userActionMatch && method === 'POST') {
    if (user.role !== 'admin') return sendJson(res, 403, { error: 'Admin role required' });
    const targetId = Number(userActionMatch[1]);
    const action = userActionMatch[2];
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!target) return sendJson(res, 404, { error: 'User not found' });

    if (action === 'disable') {
      db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(targetId);
      auth.destroyAllSessionsForUser(db, targetId);
      return sendJson(res, 200, { ok: true });
    }
    if (action === 'enable') {
      db.prepare('UPDATE users SET disabled = 0 WHERE id = ?').run(targetId);
      return sendJson(res, 200, { ok: true });
    }
    if (action === 'reset-password') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { error: 'Invalid request body' });
      }
      if (!auth.isStrongPassword(body.tempPassword)) {
        return sendJson(res, 400, { error: 'Temporary password must be at least 12 characters' });
      }
      const newHash = auth.hashPassword(body.tempPassword);
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(
        newHash,
        targetId
      );
      auth.destroyAllSessionsForUser(db, targetId);
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- Workspace / dashboard ----
  if (pathname === '/api/workspace' && method === 'GET') {
    const ws = getWorkspace(user.id);
    return sendJson(res, 200, {
      currency: ws.data.currency,
      openingBalance: ws.data.openingBalance,
      version: ws.version,
      transactionCount: ws.data.transactions.length
    });
  }

  if (pathname === '/api/workspace' && method === 'PUT') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'Invalid request body' });
    }
    const ws = getWorkspace(user.id);
    if (body.version !== ws.version) {
      return sendJson(res, 409, { error: 'Records changed elsewhere. Reload and try again.' });
    }
    if (body.currency !== undefined) {
      if (ws.data.transactions.length > 0 && body.currency !== ws.data.currency) {
        return sendJson(res, 400, {
          error: 'Export a backup and clear your books before changing currency.'
        });
      }
      ws.data.currency = body.currency;
    }
    if (body.openingBalance !== undefined) {
      const value = Number(body.openingBalance);
      if (!Number.isFinite(value)) return sendJson(res, 400, { error: 'Invalid opening balance' });
      ws.data.openingBalance = value;
    }
    const saved = saveWorkspace(user.id, ws.data, ws.version);
    if (!saved.ok) return sendJson(res, 409, { error: 'Records changed elsewhere. Reload and try again.' });
    return sendJson(res, 200, { version: saved.version });
  }

  if (pathname === '/api/workspace/clear' && method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      body = {};
    }
    const ws = getWorkspace(user.id);
    if (body.version !== ws.version) {
      return sendJson(res, 409, { error: 'Records changed elsewhere. Reload and try again.' });
    }
    const data = emptyWorkspaceData();
    if (body.currency) data.currency = body.currency;
    const saved = saveWorkspace(user.id, data, ws.version);
    if (!saved.ok) return sendJson(res, 409, { error: 'Records changed elsewhere. Reload and try again.' });
    return sendJson(res, 200, { version: saved.version });
  }

  if (pathname === '/api/dashboard' && method === 'GET') {
    const ws = getWorkspace(user.id);
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const monthEnd = nextMonth.toISOString().slice(0, 10);

    let cashBalance = ws.data.openingBalance;
    let monthIncome = 0;
    let monthExpense = 0;
    const byDay = {};
    const byCategory = {};

    for (const t of ws.data.transactions) {
      const signed = t.type === 'income' ? t.price : -t.price;
      cashBalance += signed;

      if (t.date >= monthStart && t.date < monthEnd) {
        if (t.type === 'income') monthIncome += t.price;
        else monthExpense += t.price;

        byDay[t.date] = (byDay[t.date] || 0) + signed;

        if (t.type === 'expense') {
          const cat = t.category || 'Other';
          byCategory[cat] = (byCategory[cat] || 0) + t.price;
        }
      }
    }

    const cashFlow = Object.keys(byDay)
      .sort()
      .map((date) => ({ date, net: Math.round(byDay[date] * 100) / 100 }));
    const spendingBreakdown = Object.entries(byCategory)
      .map(([category, amount]) => ({ category, amount: Math.round(amount * 100) / 100 }))
      .sort((a, b) => b.amount - a.amount);

    return sendJson(res, 200, {
      currency: ws.data.currency,
      cashBalance: Math.round(cashBalance * 100) / 100,
      monthIncome: Math.round(monthIncome * 100) / 100,
      monthExpense: Math.round(monthExpense * 100) / 100,
      monthNet: Math.round((monthIncome - monthExpense) * 100) / 100,
      cashFlow,
      spendingBreakdown
    });
  }

  // ---- Transactions ----
  if (pathname === '/api/transactions' && method === 'GET') {
    const ws = getWorkspace(user.id);
    const q = (url.searchParams.get('q') || '').toLowerCase().trim();
    const from = url.searchParams.get('from') || '';
    const to = url.searchParams.get('to') || '';
    const category = url.searchParams.get('category') || '';

    let items = ws.data.transactions;
    if (q) {
      items = items.filter((t) =>
        [t.recipient, t.description, t.bank, t.category, t.code]
          .filter(Boolean)
          .some((f) => f.toLowerCase().includes(q))
      );
    }
    if (from) items = items.filter((t) => t.date >= from);
    if (to) items = items.filter((t) => t.date <= to);
    if (category) items = items.filter((t) => t.category === category);

    items = [...items].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    return sendJson(res, 200, { transactions: items, version: ws.version, currency: ws.data.currency });
  }

  if (pathname === '/api/transactions' && method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'Invalid request body' });
    }
    const ws = getWorkspace(user.id);
    if (body.version !== ws.version) {
      return sendJson(res, 409, { error: 'Records changed elsewhere. Reload and try again.' });
    }
    const record = normalizeManualTransaction(body.transaction);
    if (!record.ok) return sendJson(res, 400, { error: record.error });

    record.value.id = crypto.randomUUID();
    ws.data.transactions.push(record.value);
    const saved = saveWorkspace(user.id, ws.data, ws.version);
    if (!saved.ok) return sendJson(res, 409, { error: 'Records changed elsewhere. Reload and try again.' });
    return sendJson(res, 201, { transaction: record.value, version: saved.version });
  }

  const txnMatch = pathname.match(/^\/api\/transactions\/([\w-]+)$/);
  if (txnMatch && (method === 'PUT' || method === 'DELETE')) {
    const id = txnMatch[1];
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'Invalid request body' });
    }
    const ws = getWorkspace(user.id);
    if (body.version !== ws.version) {
      return sendJson(res, 409, { error: 'Records changed elsewhere. Reload and try again.' });
    }
    const idx = ws.data.transactions.findIndex((t) => t.id === id);
    if (idx === -1) return sendJson(res, 404, { error: 'Transaction not found' });

    if (method === 'DELETE') {
      ws.data.transactions.splice(idx, 1);
    } else {
      const record = normalizeManualTransaction(body.transaction);
      if (!record.ok) return sendJson(res, 400, { error: record.error });
      record.value.id = id;
      ws.data.transactions[idx] = record.value;
    }

    const saved = saveWorkspace(user.id, ws.data, ws.version);
    if (!saved.ok) return sendJson(res, 409, { error: 'Records changed elsewhere. Reload and try again.' });
    return sendJson(res, 200, { version: saved.version });
  }

  // ---- CSV import ----
  if (pathname === '/api/import/csv/preview' && method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req, csvLib.MAX_BYTES + 1024 * 1024);
    } catch {
      return sendJson(res, 400, { error: 'Invalid request body' });
    }
    return handleImportPreview(res, user, body);
  }

  if (pathname === '/api/import/csv/commit' && method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'Invalid request body' });
    }
    return handleImportCommit(res, user, body);
  }

  if (pathname.startsWith('/api/import/csv/report/') && method === 'GET') {
    const token = pathname.slice('/api/import/csv/report/'.length);
    const entry = importCache.get(token);
    if (!entry || entry.userId !== user.id) return sendJson(res, 404, { error: 'Report not found or expired' });
    const reportCsv = buildValidationReport(entry.records);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="validation-report.csv"'
    });
    return res.end(reportCsv);
  }

  // ---- Export / backup ----
  if (pathname === '/api/export/csv' && method === 'GET') {
    const ws = getWorkspace(user.id);
    const csvText = buildExportCsv(ws.data.transactions);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="transactions.csv"'
    });
    return res.end(csvText);
  }

  if (pathname === '/api/export/json' && method === 'GET') {
    const ws = getWorkspace(user.id);
    const backup = {
      exportedAt: new Date().toISOString(),
      user: { name: user.name, email: user.email },
      currency: ws.data.currency,
      openingBalance: ws.data.openingBalance,
      transactions: ws.data.transactions
    };
    const payload = JSON.stringify(backup, null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="ledger-backup.json"'
    });
    return res.end(payload);
  }

  if (pathname === '/api/import/json' && method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req, 20 * 1024 * 1024);
    } catch {
      return sendJson(res, 400, { error: 'Invalid request body' });
    }
    const ws = getWorkspace(user.id);
    if (ws.data.transactions.length > 0) {
      return sendJson(res, 409, { error: 'Restoring a backup requires empty books. Clear your books first.' });
    }
    const backup = body.backup;
    if (!backup || !Array.isArray(backup.transactions)) {
      return sendJson(res, 400, { error: 'That file does not look like a Ledger JSON backup.' });
    }
    for (const t of backup.transactions) {
      const check = normalizeManualTransaction(t, { keepId: true });
      if (!check.ok) {
        return sendJson(res, 400, { error: `Backup failed validation: ${check.error}` });
      }
    }
    const data = emptyWorkspaceData();
    data.currency = backup.currency || 'USD';
    data.openingBalance = Number(backup.openingBalance) || 0;
    data.transactions = backup.transactions.map((t) => normalizeManualTransaction(t, { keepId: true }).value);

    const saved = saveWorkspace(user.id, data, ws.version);
    if (!saved.ok) return sendJson(res, 409, { error: 'Records changed elsewhere. Reload and try again.' });
    return sendJson(res, 200, { version: saved.version, imported: data.transactions.length });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

// --- Transaction normalization -----------------------------------------------

function normalizeManualTransaction(input, opts = {}) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Missing transaction' };

  const price = csvLib.parseAmount(input.price, 'period');
  if (price === null || price < 0) return { ok: false, error: 'Invalid amount' };

  const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : null;
  if (!date) return { ok: false, error: 'Invalid date (expected YYYY-MM-DD)' };

  const type = input.type === 'income' || input.type === 'expense' ? input.type : null;
  if (!type) return { ok: false, error: 'Transaction type must be income or expense' };

  const recipient = (input.recipient || '').toString().trim();
  if (!recipient) return { ok: false, error: 'Recipient is required' };

  const bank = (input.bank || '').toString().trim();
  if (!bank) return { ok: false, error: 'Bank is required' };

  const value = {
    price,
    recipient,
    date,
    time: input.time || null,
    description: (input.description || '').toString().trim(),
    code: (input.code || '').toString().trim(),
    bank,
    type,
    category: (input.category || '').toString().trim(),
    currency: input.currency || 'USD'
  };
  if (opts.keepId && input.id) value.id = input.id;

  return { ok: true, value };
}

// --- CSV import handlers ------------------------------------------------------

function handleImportPreview(res, user, body) {
  const { fileBase64, encoding, separator: separatorChoice, mapping, options } = body;
  if (!fileBase64) return sendJson(res, 400, { error: 'No file provided' });

  let buffer;
  try {
    buffer = Buffer.from(fileBase64, 'base64');
  } catch {
    return sendJson(res, 400, { error: 'Could not decode uploaded file' });
  }
  if (buffer.length > csvLib.MAX_BYTES) {
    return sendJson(res, 400, { error: 'File exceeds the 5 MB limit' });
  }

  let text;
  try {
    text = csvLib.decodeBuffer(buffer, encoding || 'utf-8');
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  const separator = separatorChoice || csvLib.detectSeparator(text);
  const rows = csvLib.parseDelimited(text, separator);
  if (rows.length === 0) return sendJson(res, 400, { error: 'The file has no rows' });

  const headerRow = rows[0];
  const dataRows = rows.slice(1);
  if (dataRows.length > csvLib.MAX_ROWS) {
    return sendJson(res, 400, { error: `File exceeds the ${csvLib.MAX_ROWS}-row limit` });
  }

  if (!mapping || !options) {
    // First pass: just report headers + detected separator so the client
    // can render the mapping UI.
    return sendJson(res, 200, {
      stage: 'detected',
      separator,
      headers: headerRow,
      rowCount: dataRows.length,
      sampleRows: dataRows.slice(0, 5)
    });
  }

  const result = csvLib.validateAndMapRows(headerRow, dataRows, mapping, {
    ...options,
    currency: options.currency
  });
  if (!result.ok) return sendJson(res, 400, { error: result.error });

  const invalidCount = result.records.filter((r) => !r.valid).length;
  if (invalidCount > 0) {
    // Invalid rows block the entire import; still return a token so the
    // report can be downloaded, but mark the import as blocked.
    const token = crypto.randomUUID();
    importCache.set(token, {
      userId: user.id,
      records: result.records,
      blocked: true,
      expiresAt: Date.now() + IMPORT_TTL_MS
    });
    return sendJson(res, 200, {
      stage: 'blocked',
      token,
      totalRows: result.records.length,
      invalidCount,
      preview: result.records.slice(0, 100)
    });
  }

  const duplicateExact = result.records.filter((r) => r.duplicate === 'exact').length;
  const token = crypto.randomUUID();
  importCache.set(token, {
    userId: user.id,
    records: result.records,
    blocked: false,
    expiresAt: Date.now() + IMPORT_TTL_MS
  });

  return sendJson(res, 200, {
    stage: 'ready',
    token,
    totalRows: result.records.length,
    duplicateExact,
    willImport: result.records.length - duplicateExact,
    preview: result.records.slice(0, 100)
  });
}

function handleImportCommit(res, user, body) {
  const { token, version } = body;
  const entry = importCache.get(token);
  if (!entry || entry.userId !== user.id) {
    return sendJson(res, 404, { error: 'Import preview not found or expired. Please re-upload.' });
  }
  if (entry.blocked) {
    return sendJson(res, 400, { error: 'This import has validation errors and cannot be committed.' });
  }

  const ws = getWorkspace(user.id);
  if (version !== ws.version) {
    return sendJson(res, 409, { error: 'Records changed elsewhere. Reload and try again.' });
  }

  let added = 0;
  for (const r of entry.records) {
    if (r.duplicate === 'exact') continue;
    ws.data.transactions.push({
      id: crypto.randomUUID(),
      price: r.price,
      recipient: r.recipient,
      date: r.date,
      time: r.time,
      description: r.description,
      code: r.code,
      bank: r.bank,
      type: r.type,
      category: r.category || (r.type === 'income' ? 'Client payments' : 'Other'),
      currency: r.currency
    });
    added++;
  }

  const saved = saveWorkspace(user.id, ws.data, ws.version);
  if (!saved.ok) return sendJson(res, 409, { error: 'Records changed elsewhere. Reload and try again.' });

  importCache.delete(token);
  return sendJson(res, 200, { imported: added, version: saved.version });
}

function buildValidationReport(records) {
  const header = [
    'row', 'valid', 'errors', 'price', 'recipient', 'date', 'time',
    'description', 'code', 'bank', 'type', 'category', 'duplicate'
  ];
  const lines = [header.join(',')];
  for (const r of records) {
    const row = [
      r.rowNumber + 1,
      r.valid ? 'yes' : 'no',
      (r.errors || []).join(' | '),
      r.price ?? '',
      r.recipient ?? '',
      r.date ?? '',
      r.time ?? '',
      r.description ?? '',
      r.code ?? '',
      r.bank ?? '',
      r.type ?? '',
      r.category ?? '',
      r.duplicate ?? ''
    ].map(csvEscape);
    lines.push(row.join(','));
  }
  return lines.join('\r\n');
}

function csvEscape(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  // Prefix formula-like values for spreadsheet safety.
  if (/^[=+\-@]/.test(str)) return `'${str}`;
  return str;
}

function buildExportCsv(transactions) {
  const header = ['price', 'recipient', 'date', 'time', 'description', 'code', 'bank', 'type', 'category', 'currency'];
  const lines = [header.join(',')];
  for (const t of transactions) {
    const row = [t.price, t.recipient, t.date, t.time || '', t.description, t.code || '', t.bank, t.type, t.category, t.currency]
      .map(csvEscape);
    lines.push(row.join(','));
  }
  return lines.join('\r\n');
}

// --- HTTP server ---------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url.pathname);
    }
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Internal server error' });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const origin = HTTPS_MODE ? PUBLIC_ORIGIN : `http://localhost:${PORT}`;
  console.log(`Ledger is running at ${origin}`);
  if (isSetupMode()) {
    console.log(`First-time setup code is in ${SETUP_CODE_PATH}`);
  }
});
