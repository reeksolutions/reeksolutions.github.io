/* =====================================================================
   Reekon Systems — Sales Portal backend (Cloudflare Pages, _worker.js)
   Stage 1: logins, users, batches, leads, call check-off, notes, DNC,
            callbacks, demo queue.
   Stage 2: call script, dashboard, leaderboard, deals + commission tracker.
            Upgrading from Stage 1 only ADDS things — no table is dropped
            or rewritten, so every lead, note and login carries over.
   Needs:  D1 binding named  DB
           Secret named      SETUP_CODE  (only used to create the first admin)
   Tables are created automatically on first use.
   ===================================================================== */

const SESSION_DAYS = 30;
const PBKDF2_ITER = 60000;
const MAX_FAILED = 5;          // failed logins before a 15-minute lock
const LOCK_MINUTES = 15;

const STATUSES = ['new', 'demo_needed', 'demo_ready', 'called', 'callback', 'booked', 'won', 'lost', 'dnc'];
const OPEN_STATUSES = ['new', 'demo_needed', 'demo_ready', 'called', 'callback', 'booked'];
const OUTCOMES = ['no_answer', 'voicemail', 'gatekeeper', 'not_interested', 'callback', 'demo_sent', 'booked', 'dnc'];
const ROLES = ['admin', 'rep', 'dev'];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     email TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('admin','rep','dev')),
     pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, pass_iter INTEGER NOT NULL,
     active INTEGER NOT NULL DEFAULT 1,
     failed INTEGER NOT NULL DEFAULT 0, locked_until TEXT,
     commission_pct REAL,
     created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
     expires_at TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS batches (
     id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
     created_by INTEGER, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS leads (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     batch_id INTEGER, business TEXT NOT NULL, owner TEXT, phone TEXT, phone_norm TEXT,
     city TEXT, category TEXT, link TEXT,
     status TEXT NOT NULL DEFAULT 'new',
     assigned_to INTEGER, demo_url TEXT, demo_sent INTEGER NOT NULL DEFAULT 0,
     callback_at TEXT, booked_at TEXT, last_call_at TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS leads_status ON leads(status)`,
  `CREATE INDEX IF NOT EXISTS leads_assigned ON leads(assigned_to, status)`,
  `CREATE INDEX IF NOT EXISTS leads_batch ON leads(batch_id)`,
  `CREATE INDEX IF NOT EXISTS leads_phone ON leads(phone_norm)`,
  `CREATE INDEX IF NOT EXISTS leads_callback ON leads(callback_at)`,
  `CREATE TABLE IF NOT EXISTS calls (
     id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
     outcome TEXT NOT NULL, from_status TEXT, to_status TEXT, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS calls_lead ON calls(lead_id)`,
  `CREATE INDEX IF NOT EXISTS calls_time ON calls(created_at)`,
  `CREATE TABLE IF NOT EXISTS notes (
     id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
     body TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS notes_lead ON notes(lead_id)`,
  `CREATE TABLE IF NOT EXISTS dnc (
     phone_norm TEXT PRIMARY KEY, lead_id INTEGER, user_id INTEGER, created_at TEXT NOT NULL)`,
  // Stage 2 tables (created now so nothing needs migrating later)
  `CREATE TABLE IF NOT EXISTS deals (
     id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, rep_id INTEGER,
     amount_cents INTEGER NOT NULL DEFAULT 0, commission_pct REAL NOT NULL DEFAULT 0,
     paid INTEGER NOT NULL DEFAULT 0, paid_at TEXT, note TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE INDEX IF NOT EXISTS calls_user_time ON calls(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS deals_rep ON deals(rep_id, paid)`,
  `CREATE INDEX IF NOT EXISTS deals_lead ON deals(lead_id)`,
  `CREATE INDEX IF NOT EXISTS deals_time ON deals(created_at)`,
];

// Stage 2 columns added to the existing deals table. Only added if missing — never drops data.
const DEAL_COLUMNS = { package: 'TEXT', created_by: 'INTEGER' };

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  const cols = new Set((await env.DB.prepare('PRAGMA table_info(deals)').all()).results.map((c) => c.name));
  for (const [name, type] of Object.entries(DEAL_COLUMNS)) {
    if (!cols.has(name)) {
      try { await env.DB.prepare(`ALTER TABLE deals ADD COLUMN ${name} ${type}`).run(); }
      catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; }
    }
  }
  schemaReady = true;
}

/* -------- Stage 2: defaults -------- */
const CALL_OUTCOMES_SQL = OUTCOMES.map((o) => `'${o}'`).join(',');   // real dials only (not status edits)
const DEFAULT_COMMISSION_PCT = 20;
const PACKAGES = [
  { key: 'website', name: 'Website', amount: 497 },
  { key: 'website-pro', name: 'Website Pro', amount: 997 },
  { key: 'website-ai', name: 'Website + AI', amount: 1497 },
  { key: 'custom', name: 'Custom — Full Automation', amount: 5000 },
  // Upsells / add-ons (log each as its own deal on the client's lead page)
  { key: 'addon-ai-chat', name: 'Add-on — AI chat', amount: 997 },
  { key: 'addon-receptionist', name: 'Add-on — AI Receptionist', amount: 1997 },
  { key: 'addon-automation', name: 'Add-on — Extra automation', amount: 997 },
  { key: 'addon-channel', name: 'Add-on — Extra chat channel', amount: 497 },
];

const DEFAULT_SCRIPT = [
  { kind: 'step', title: 'Opener', body:
`Hey, is this {owner_first}?

[If yes] Hey {owner_first}, this is {rep_first} with Reekon Systems, here in LA. I'll be quick, I know you're busy running {business}.

[If gatekeeper] Hey! Quick one: who's the best person to talk to about the website and getting more customers for {business}? … Is {owner_first} around?` },
  { kind: 'step', title: 'The hook (free demo)', body:
`So here's why I'm calling. We actually went ahead and built a free website preview for {business}. No cost, no catch. We do it for a few {category} spots around {city} every week.

Can I text it to this number so you can take a look?

[Demo link] {demo_link}` },
  { kind: 'step', title: 'Quick questions', body:
`While you pull it up, can I ask two quick things?

- When someone calls or DMs you after hours, what happens? Do they get a reply?
- How do people book with you right now: call, text, Instagram, walk-in?
- Roughly how many calls or messages do you think you miss in a week?

[Listen. Write what they say in Notes.]` },
  { kind: 'step', title: 'What we do', body:
`That's exactly what we fix. We build you a clean website that shows up when people Google you, works on phones, and lets customers book you right from the site. We host it, keep it updated, and handle any changes, so you never have to touch it.

If you're missing calls or DMs, we can also add an AI assistant that answers questions and books people for you, day or night.` },
  { kind: 'step', title: 'Book the call', body:
`The best next step is a quick 20-minute call with Marquise, our founder. He'll walk you through the demo and show you what it'd look like for {business}. No pressure.

Does tomorrow morning or tomorrow afternoon work better?

[Lock a day and time → tap Booked and put the time in.]` },
  { kind: 'objection', title: '"How much is it?"', body:
`Totally fair. Websites start at $497 to set up, plus a small monthly for hosting, updates and support. Exact price depends on what you need, and Marquise lays it all out on the call so there are no surprises.

Want me to grab you a time?` },
  { kind: 'objection', title: '"I already have a website"', body:
`Love that. Is it getting you booked? Ours is built to show up on Google and get people to book, and we handle every update for you. Take a look at the preview we made and compare. Worth 20 minutes?` },
  { kind: 'objection', title: '"Just send me info"', body:
`For sure, I'll text you the demo right now. The info only makes sense once you see it set up for {business}, so let's put 20 minutes on the calendar too. What's better, morning or afternoon?` },
  { kind: 'objection', title: '"I\'m busy right now"', body:
`Totally get it. When's a better time for a 2-minute call back, later today or tomorrow?

[Tap Callback and set the time.]` },
  { kind: 'objection', title: '"Not interested"', body:
`No problem at all. Can I ask: is it the timing, or you just don't see a need for it? … [If timing → offer a callback. If no need → thank them, tap Not interested.]` },
  { kind: 'objection', title: '"Is this a robot?"', body:
`Ha, I'm a real person! The website is built by our team. If you add the AI assistant later, it only handles the repetitive stuff like "are you open?" and booking, and anything important comes straight to you.` },
  { kind: 'step', title: 'Voicemail', body:
`Hey {owner_first}, it's {rep_first} with Reekon Systems. We built a free website preview for {business} and I'd love to send it over. I'll shoot you a text with the link. Talk soon!

[Then tap Voicemail, and text the demo.]` },
];

async function getSetting(env, key) {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return r ? r.value : null;
}
async function setSetting(env, key, value) {
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
}
async function defaultPct(env) {
  const v = parseFloat(await getSetting(env, 'default_commission_pct'));
  return isFinite(v) ? v : DEFAULT_COMMISSION_PCT;
}
function pctVal(v) {
  if (v === null || v === '' || v === undefined) return null;
  const n = Math.round(parseFloat(v) * 100) / 100;
  if (!isFinite(n) || n < 0 || n > 100) bad('Commission % must be between 0 and 100');
  return n;
}
function centsVal(v) {
  const n = parseFloat(String(v ?? '').replace(/[$,\s]/g, ''));
  if (!isFinite(n) || n < 0 || n > 10_000_000) bad('Enter a deal amount in dollars');
  return Math.round(n * 100);
}
const commissionCents = (d) => Math.round((d.amount_cents || 0) * (d.commission_pct || 0) / 100);

/* ---------------- helpers ---------------- */
const now = () => new Date().toISOString();
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => { throw new HttpError(400, msg); };

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function str(v, max = 300) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d;
}

function validIso(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) bad('Invalid date/time');
  return d.toISOString();
}

function cleanUrl(u) {
  u = str(u, 500);
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { const x = new URL(u); if (!/^https?:$/.test(x.protocol)) return ''; return x.toString(); } catch { return ''; }
}

async function hashPassword(password, saltB64, iter = PBKDF2_ITER) {
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return { hash: b64(bits), salt: b64(salt), iter };
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function sha256(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) bad('Password must be at least 8 characters');
  if (pw.length > 200) bad('Password is too long');
}

function cookie(token, maxAge) {
  return `rs_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function createSession(env, userId) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)')
    .bind(await sha256(token), userId, exp, now()).run();
  return cookie(token, SESSION_DAYS * 86400);
}

async function getUser(request, env) {
  const m = /(?:^|;\s*)rs_session=([a-f0-9]{64})/.exec(request.headers.get('Cookie') || '');
  if (!m) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`
  ).bind(await sha256(m[1]), now()).first();
  if (row) row.tokenHash = await sha256(m[1]);
  return row;
}

function need(user, ...roles) {
  if (!user) throw new HttpError(401, 'Please log in');
  if (roles.length && !roles.includes(user.role)) throw new HttpError(403, "You don't have access to that");
}

/* -------- lead access -------- */
async function loadLead(env, user, id) {
  const lead = await env.DB.prepare(
    `SELECT l.*, u.name AS rep_name, b.name AS batch_name FROM leads l
     LEFT JOIN users u ON u.id = l.assigned_to LEFT JOIN batches b ON b.id = l.batch_id WHERE l.id = ?`
  ).bind(id).first();
  if (!lead) throw new HttpError(404, 'Lead not found');
  if (user.role === 'rep' && (lead.assigned_to !== user.id || lead.status === 'dnc')) throw new HttpError(404, 'Lead not found');
  if (user.role === 'dev' && !['demo_needed', 'demo_ready', 'new'].includes(lead.status)) throw new HttpError(404, 'Lead not found');
  return lead;
}

/* -------- call outcome → status -------- */
function nextStatus(current, outcome) {
  const early = ['new', 'demo_needed', 'demo_ready', 'called'];
  switch (outcome) {
    case 'no_answer': case 'voicemail': case 'gatekeeper': case 'demo_sent':
      return early.includes(current) ? 'called' : current;
    case 'not_interested': return 'lost';
    case 'callback': return 'callback';
    case 'booked': return 'booked';
    case 'dnc': return 'dnc';
  }
  return current;
}

/* -------- auto-assign: spread evenly across active reps -------- */
async function repLoads(env) {
  const { results } = await env.DB.prepare(
    `SELECT u.id, (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id AND l.status IN (${OPEN_STATUSES.map(() => '?').join(',')})) AS open
     FROM users u WHERE u.role = 'rep' AND u.active = 1`
  ).bind(...OPEN_STATUSES).all();
  return results;
}
function pickRep(loads) {
  if (!loads.length) return null;
  let best = loads[0];
  for (const r of loads) if (r.open < best.open) best = r;
  best.open++;
  return best.id;
}

/* ---------------- API routes ---------------- */
async function api(request, env, url) {
  const path = url.pathname.replace(/^\/api/, '');
  const method = request.method;

  // Basic CSRF guard: every write must carry our custom header (browsers block it cross-site).
  if (method !== 'GET' && request.headers.get('X-Portal') !== '1') throw new HttpError(403, 'Bad request origin');

  let body = {};
  if (method !== 'GET') {
    const text = await request.text();
    if (text.length > 2_000_000) bad('Upload too large — split it into smaller files');
    try { body = text ? JSON.parse(text) : {}; } catch { bad('Bad JSON'); }
  }

  /* ---- setup + auth (no login needed) ---- */
  if (path === '/setup-status' && method === 'GET') {
    const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    return json({ needsSetup: c.n === 0, setupCodeSet: !!env.SETUP_CODE });
  }

  if (path === '/setup' && method === 'POST') {
    const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    if (c.n > 0) throw new HttpError(403, 'Setup is already done');
    if (!env.SETUP_CODE) bad('SETUP_CODE is not set in Cloudflare yet');
    if (!safeEqual(str(body.code, 200), String(env.SETUP_CODE))) throw new HttpError(403, 'Wrong setup code');
    const name = str(body.name, 80), email = str(body.email, 200).toLowerCase();
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) bad('Name and a valid email are required');
    checkPassword(body.password);
    const h = await hashPassword(body.password);
    const r = await env.DB.prepare(
      'INSERT INTO users (email,name,role,pass_hash,pass_salt,pass_iter,created_at) VALUES (?,?,?,?,?,?,?)'
    ).bind(email, name, 'admin', h.hash, h.salt, h.iter, now()).run();
    return json({ ok: true }, 200, { 'Set-Cookie': await createSession(env, r.meta.last_row_id) });
  }

  if (path === '/login' && method === 'POST') {
    const email = str(body.email, 200).toLowerCase();
    const pw = String(body.password || '');
    const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    const fail = () => new HttpError(401, 'Wrong email or password');
    if (!u || !u.active) { await hashPassword(pw || 'x'); throw fail(); }   // same timing either way
    if (u.locked_until && u.locked_until > now()) throw new HttpError(429, 'Too many tries. Wait 15 minutes and try again.');
    const h = await hashPassword(pw, u.pass_salt, u.pass_iter);
    if (!safeEqual(h.hash, u.pass_hash)) {
      const failed = u.failed + 1;
      const lock = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 6e4).toISOString() : null;
      await env.DB.prepare('UPDATE users SET failed = ?, locked_until = ? WHERE id = ?').bind(lock ? 0 : failed, lock, u.id).run();
      throw fail();
    }
    await env.DB.prepare('UPDATE users SET failed = 0, locked_until = NULL WHERE id = ?').bind(u.id).run();
    await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now()).run();
    return json({ ok: true }, 200, { 'Set-Cookie': await createSession(env, u.id) });
  }

  const user = await getUser(request, env);

  if (path === '/logout' && method === 'POST') {
    if (user) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(user.tokenHash).run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
  }

  need(user);

  if (path === '/me' && method === 'GET') {
    return json({ id: user.id, name: user.name, email: user.email, role: user.role });
  }

  if (path === '/password' && method === 'POST') {
    const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
    const h0 = await hashPassword(String(body.current || ''), u.pass_salt, u.pass_iter);
    if (!safeEqual(h0.hash, u.pass_hash)) bad('Current password is wrong');
    checkPassword(body.next);
    const h = await hashPassword(body.next);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET pass_hash=?, pass_salt=?, pass_iter=? WHERE id=?').bind(h.hash, h.salt, h.iter, user.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, user.tokenHash),
    ]);
    return json({ ok: true });
  }

  /* ---- users (admin) ---- */
  if (path === '/users' && method === 'GET') {
    need(user, 'admin');
    const { results } = await env.DB.prepare(
      `SELECT u.id, u.name, u.email, u.role, u.active, u.created_at, u.commission_pct,
        (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id AND l.status IN ('new','demo_needed','demo_ready','called','callback','booked')) AS open_leads
       FROM users u ORDER BY u.active DESC, u.role, u.name`
    ).all();
    return json(results);
  }

  if (path === '/users' && method === 'POST') {
    need(user, 'admin');
    const name = str(body.name, 80), email = str(body.email, 200).toLowerCase(), role = str(body.role, 10);
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) bad('Name and a valid email are required');
    if (!ROLES.includes(role)) bad('Pick a role');
    checkPassword(body.password);
    const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (exists) bad('Someone already uses that email');
    const h = await hashPassword(body.password);
    await env.DB.prepare('INSERT INTO users (email,name,role,pass_hash,pass_salt,pass_iter,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(email, name, role, h.hash, h.salt, h.iter, now()).run();
    return json({ ok: true });
  }

  let m;
  if ((m = path.match(/^\/users\/(\d+)$/)) && method === 'PATCH') {
    need(user, 'admin');
    const id = +m[1];
    const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    if (!target) throw new HttpError(404, 'User not found');
    const stmts = [];
    if (body.name !== undefined) { const n = str(body.name, 80); if (!n) bad('Name required'); stmts.push(env.DB.prepare('UPDATE users SET name=? WHERE id=?').bind(n, id)); }
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role)) bad('Bad role');
      if (id === user.id && body.role !== 'admin') bad("You can't remove your own admin role");
      stmts.push(env.DB.prepare('UPDATE users SET role=? WHERE id=?').bind(body.role, id));
    }
    if (body.active !== undefined) {
      if (id === user.id) bad("You can't deactivate yourself");
      stmts.push(env.DB.prepare('UPDATE users SET active=? WHERE id=?').bind(body.active ? 1 : 0, id));
      if (!body.active) stmts.push(env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id));
    }
    if (body.password !== undefined) {
      checkPassword(body.password);
      const h = await hashPassword(body.password);
      stmts.push(env.DB.prepare('UPDATE users SET pass_hash=?, pass_salt=?, pass_iter=?, failed=0, locked_until=NULL WHERE id=?').bind(h.hash, h.salt, h.iter, id));
      stmts.push(env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id));
    }
    if (body.commission_pct !== undefined) {
      stmts.push(env.DB.prepare('UPDATE users SET commission_pct=? WHERE id=?').bind(pctVal(body.commission_pct), id));
    }
    if (body.unassign === true) {
      stmts.push(env.DB.prepare(`UPDATE leads SET assigned_to=NULL, updated_at=? WHERE assigned_to=? AND status IN ('new','demo_needed','demo_ready','called','callback')`).bind(now(), id));
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true });
  }

  /* ---- filter options ---- */
  if (path === '/options' && method === 'GET') {
    need(user, 'admin', 'rep');
    const reps = user.role === 'admin'
      ? (await env.DB.prepare(`SELECT id, name, active FROM users WHERE role IN ('rep','admin') ORDER BY active DESC, name`).all()).results
      : [];
    const batches = user.role === 'admin'
      ? (await env.DB.prepare('SELECT id, name FROM batches ORDER BY id DESC').all()).results : [];
    const cities = user.role === 'admin'
      ? (await env.DB.prepare(`SELECT DISTINCT city FROM leads WHERE city != '' ORDER BY city`).all()).results
      : (await env.DB.prepare(`SELECT DISTINCT city FROM leads WHERE assigned_to = ? AND status != 'dnc' AND city != '' ORDER BY city`).bind(user.id).all()).results;
    return json({ reps, batches, cities: cities.map((c) => c.city) });
  }

  /* ---- batches (admin) ---- */
  if (path === '/batches' && method === 'GET') {
    need(user, 'admin');
    const { results } = await env.DB.prepare(
      `SELECT b.id, b.name, b.created_at, COUNT(l.id) AS total,
        SUM(CASE WHEN l.status IN ('new','demo_needed') THEN 1 ELSE 0 END) AS need_demo,
        SUM(CASE WHEN l.status = 'demo_ready' THEN 1 ELSE 0 END) AS ready,
        SUM(CASE WHEN l.status IN ('called','callback') THEN 1 ELSE 0 END) AS working,
        SUM(CASE WHEN l.status = 'booked' THEN 1 ELSE 0 END) AS booked,
        SUM(CASE WHEN l.status = 'won' THEN 1 ELSE 0 END) AS won,
        SUM(CASE WHEN l.assigned_to IS NULL AND l.status NOT IN ('won','lost','dnc') THEN 1 ELSE 0 END) AS unassigned
       FROM batches b LEFT JOIN leads l ON l.batch_id = b.id GROUP BY b.id ORDER BY b.id DESC`
    ).all();
    return json(results);
  }

  if (path === '/batches' && method === 'POST') {
    need(user, 'admin');
    const name = str(body.name, 100) || 'Batch ' + new Date().toLocaleDateString('en-US');
    const r = await env.DB.prepare('INSERT INTO batches (name, created_by, created_at) VALUES (?,?,?)').bind(name, user.id, now()).run();
    return json({ id: r.meta.last_row_id, name });
  }

  if ((m = path.match(/^\/batches\/(\d+)\/leads$/)) && method === 'POST') {
    need(user, 'admin');
    const batchId = +m[1];
    const batch = await env.DB.prepare('SELECT id FROM batches WHERE id=?').bind(batchId).first();
    if (!batch) throw new HttpError(404, 'Batch not found');
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, 500) : [];
    const startStatus = body.startStatus === 'new' ? 'new' : 'demo_needed';
    const assign = body.assign; // 'auto' | 'none' | rep id
    let loads = null, fixedRep = null;
    if (assign === 'auto') loads = await repLoads(env);
    else if (assign && assign !== 'none') {
      const r = await env.DB.prepare(`SELECT id FROM users WHERE id=? AND role IN ('rep','admin') AND active=1`).bind(+assign).first();
      if (!r) bad('That rep was not found');
      fixedRep = r.id;
    }
    // existing phones + DNC phones, to skip duplicates
    const phones = rows.map((r) => normPhone(r.phone)).filter(Boolean);
    const seen = new Set(), dncSet = new Set();
    for (let i = 0; i < phones.length; i += 90) {
      const chunk = phones.slice(i, i + 90);
      const q = chunk.map(() => '?').join(',');
      (await env.DB.prepare(`SELECT phone_norm FROM leads WHERE phone_norm IN (${q})`).bind(...chunk).all()).results.forEach((r) => seen.add(r.phone_norm));
      (await env.DB.prepare(`SELECT phone_norm FROM dnc WHERE phone_norm IN (${q})`).bind(...chunk).all()).results.forEach((r) => dncSet.add(r.phone_norm));
    }
    let inserted = 0, dup = 0, dncSkipped = 0, invalid = 0;
    const stmts = [], t = now();
    for (const r of rows) {
      const business = str(r.business, 200);
      if (!business) { invalid++; continue; }
      const pn = normPhone(r.phone);
      if (pn && dncSet.has(pn)) { dncSkipped++; continue; }
      if (pn && seen.has(pn)) { dup++; continue; }
      if (pn) seen.add(pn);
      const rep = loads ? pickRep(loads) : fixedRep;
      stmts.push(env.DB.prepare(
        `INSERT INTO leads (batch_id,business,owner,phone,phone_norm,city,category,link,status,assigned_to,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(batchId, business, str(r.owner, 120), str(r.phone, 40), pn, str(r.city, 80), str(r.category, 80), cleanUrl(r.link), startStatus, rep, t, t));
      inserted++;
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ inserted, duplicates: dup, dnc: dncSkipped, invalid });
  }

  /* ---- leads ---- */
  if (path === '/leads' && method === 'GET') {
    need(user, 'admin', 'rep');
    const p = url.searchParams;
    const where = [], args = [];
    if (user.role === 'rep') { where.push('l.assigned_to = ?', "l.status != 'dnc'"); args.push(user.id); }
    const status = p.get('status');
    if (status === 'open') { where.push(`l.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`); args.push(...OPEN_STATUSES); }
    else if (status && STATUSES.includes(status)) { where.push('l.status = ?'); args.push(status); }
    else if (!(user.role === 'admin' && status === 'all')) { where.push("l.status != 'dnc'"); }
    if (user.role === 'admin' && p.get('rep')) {
      if (p.get('rep') === 'none') where.push('l.assigned_to IS NULL');
      else { where.push('l.assigned_to = ?'); args.push(+p.get('rep')); }
    }
    if (user.role === 'admin' && p.get('batch')) { where.push('l.batch_id = ?'); args.push(+p.get('batch')); }
    if (p.get('city')) { where.push('l.city = ?'); args.push(p.get('city')); }
    const q = str(p.get('q'), 80);
    if (q) {
      where.push('(l.business LIKE ? OR l.owner LIKE ? OR l.phone_norm LIKE ? OR l.category LIKE ?)');
      const like = '%' + q.replace(/[%_]/g, '') + '%';
      const digits = normPhone(q);
      args.push(like, like, digits.length >= 4 ? '%' + digits + '%' : '§none§', like);
    }
    const limit = Math.min(+p.get('limit') || 50, 200), offset = Math.max(+p.get('offset') || 0, 0);
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const order = `ORDER BY CASE l.status WHEN 'callback' THEN 0 WHEN 'demo_ready' THEN 1 WHEN 'booked' THEN 2 WHEN 'called' THEN 3 ELSE 4 END, COALESCE(l.callback_at, l.updated_at) ASC, l.id ASC`;
    const { results } = await env.DB.prepare(
      `SELECT l.id, l.business, l.owner, l.phone, l.city, l.category, l.status, l.callback_at, l.booked_at,
              l.attempts, l.last_call_at, l.demo_url, l.demo_sent, l.assigned_to, u.name AS rep_name
       FROM leads l LEFT JOIN users u ON u.id = l.assigned_to ${w} ${order} LIMIT ? OFFSET ?`
    ).bind(...args, limit + 1, offset).all();
    const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM leads l ${w}`).bind(...args).first();
    return json({ leads: results.slice(0, limit), more: results.length > limit, total: total.n });
  }

  if (path === '/callbacks' && method === 'GET') {
    need(user, 'admin', 'rep');
    // from/until = start and end of the caller's local "today" (sent by the app)
    const until = validIso(url.searchParams.get('until')) || new Date(Date.now() + 864e5).toISOString();
    const from = validIso(url.searchParams.get('from')) || new Date(Date.now() - 864e5).toISOString();
    const args = [until, from, until];
    let extra = '';
    if (user.role === 'rep') { extra = 'AND l.assigned_to = ?'; args.push(user.id); }
    const { results } = await env.DB.prepare(
      `SELECT l.id, l.business, l.owner, l.phone, l.city, l.status, l.callback_at, l.booked_at, u.name AS rep_name
       FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
       WHERE ((l.status = 'callback' AND l.callback_at <= ?) OR (l.status = 'booked' AND l.booked_at >= ? AND l.booked_at <= ?)) ${extra}
       ORDER BY COALESCE(l.callback_at, l.booked_at) ASC LIMIT 200`
    ).bind(...args).all();
    return json(results);
  }

  if ((m = path.match(/^\/leads\/(\d+)$/)) && method === 'GET') {
    need(user, 'admin', 'rep', 'dev');
    const lead = await loadLead(env, user, +m[1]);
    if (user.role === 'dev') return json({ lead, calls: [], notes: [] });
    const calls = (await env.DB.prepare(
      `SELECT c.id, c.outcome, c.from_status, c.to_status, c.created_at, u.name AS user_name FROM calls c LEFT JOIN users u ON u.id = c.user_id WHERE c.lead_id = ? ORDER BY c.id DESC LIMIT 100`
    ).bind(lead.id).all()).results;
    const notes = (await env.DB.prepare(
      `SELECT n.id, n.body, n.created_at, u.name AS user_name FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.lead_id = ? ORDER BY n.id DESC LIMIT 200`
    ).bind(lead.id).all()).results;
    const deals = (await env.DB.prepare(
      `SELECT d.*, u.name AS rep_name FROM deals d LEFT JOIN users u ON u.id = d.rep_id
       WHERE d.lead_id = ? ${user.role === 'rep' ? 'AND d.rep_id = ?' : ''} ORDER BY d.id DESC`
    ).bind(...(user.role === 'rep' ? [lead.id, user.id] : [lead.id])).all()).results
      .map((d) => ({ ...d, commission_cents: commissionCents(d) }));
    return json({ lead, calls, notes, deals });
  }

  if ((m = path.match(/^\/leads\/(\d+)$/)) && method === 'PATCH') {
    need(user, 'admin');
    const lead = await loadLead(env, user, +m[1]);
    const sets = [], args = [];
    const fields = { business: 200, owner: 120, phone: 40, city: 80, category: 80 };
    for (const [k, max] of Object.entries(fields)) if (body[k] !== undefined) { sets.push(`${k} = ?`); args.push(str(body[k], max)); }
    if (body.business !== undefined && !str(body.business)) bad('Business name is required');
    if (body.phone !== undefined) { sets.push('phone_norm = ?'); args.push(normPhone(body.phone)); }
    if (body.link !== undefined) { sets.push('link = ?'); args.push(cleanUrl(body.link)); }
    if (body.demo_url !== undefined) { sets.push('demo_url = ?'); args.push(cleanUrl(body.demo_url)); }
    if (body.assigned_to !== undefined) {
      if (body.assigned_to === null || body.assigned_to === '') { sets.push('assigned_to = NULL'); }
      else {
        const r = await env.DB.prepare(`SELECT id FROM users WHERE id=? AND role IN ('rep','admin') AND active=1`).bind(+body.assigned_to).first();
        if (!r) bad('That rep was not found');
        sets.push('assigned_to = ?'); args.push(r.id);
      }
    }
    if (body.callback_at !== undefined) { sets.push('callback_at = ?'); args.push(validIso(body.callback_at)); }
    if (body.booked_at !== undefined) { sets.push('booked_at = ?'); args.push(validIso(body.booked_at)); }
    const stmts = [];
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) bad('Bad status');
      sets.push('status = ?'); args.push(body.status);
      if (body.status === 'dnc' && lead.phone_norm) stmts.push(env.DB.prepare('INSERT OR IGNORE INTO dnc (phone_norm, lead_id, user_id, created_at) VALUES (?,?,?,?)').bind(lead.phone_norm, lead.id, user.id, now()));
      if (lead.status === 'dnc' && body.status !== 'dnc' && lead.phone_norm) stmts.push(env.DB.prepare('DELETE FROM dnc WHERE phone_norm = ?').bind(lead.phone_norm));
      stmts.push(env.DB.prepare('INSERT INTO calls (lead_id,user_id,outcome,from_status,to_status,created_at) VALUES (?,?,?,?,?,?)').bind(lead.id, user.id, 'status_change', lead.status, body.status, now()));
    }
    if (!sets.length && !stmts.length) return json({ ok: true });
    sets.push('updated_at = ?'); args.push(now());
    await env.DB.batch([env.DB.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).bind(...args, lead.id), ...stmts]);
    return json({ ok: true });
  }

  if (path === '/leads/bulk' && method === 'POST') {
    need(user, 'admin');
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Boolean).slice(0, 500);
    if (!ids.length) bad('Select some leads first');
    const action = body.action, t = now(), stmts = [];
    if (action === 'assign') {
      let loads = null, rep = null;
      if (body.rep === 'auto') loads = await repLoads(env);
      else if (body.rep === 'none') rep = null;
      else {
        const r = await env.DB.prepare(`SELECT id FROM users WHERE id=? AND role IN ('rep','admin') AND active=1`).bind(+body.rep).first();
        if (!r) bad('That rep was not found');
        rep = r.id;
      }
      if (loads && !loads.length) bad('No active reps to assign to yet');
      for (const id of ids) stmts.push(env.DB.prepare('UPDATE leads SET assigned_to=?, updated_at=? WHERE id=?').bind(loads ? pickRep(loads) : rep, t, id));
    } else if (action === 'demo_needed') {
      for (const id of ids) stmts.push(env.DB.prepare(`UPDATE leads SET status='demo_needed', updated_at=? WHERE id=? AND status='new'`).bind(t, id));
    } else bad('Unknown action');
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    return json({ ok: true, count: ids.length });
  }

  if ((m = path.match(/^\/leads\/(\d+)\/calls$/)) && method === 'POST') {
    need(user, 'admin', 'rep');
    const lead = await loadLead(env, user, +m[1]);
    const outcome = body.outcome;
    if (!OUTCOMES.includes(outcome)) bad('Pick an outcome');
    if (['won', 'lost', 'dnc'].includes(lead.status) && user.role !== 'admin') bad('This lead is closed');
    const to = nextStatus(lead.status, outcome), t = now();
    const sets = ['status = ?', 'attempts = attempts + 1', 'last_call_at = ?', 'updated_at = ?'];
    const args = [to, t, t];
    if (outcome === 'callback') {
      const cb = validIso(body.callback_at);
      if (!cb) bad('Pick a callback date and time');
      sets.push('callback_at = ?'); args.push(cb);
    } else if (['not_interested', 'booked', 'dnc'].includes(outcome)) { sets.push('callback_at = NULL'); }
    if (outcome === 'booked') { sets.push('booked_at = ?'); args.push(validIso(body.booked_at)); }
    if (outcome === 'demo_sent') sets.push('demo_sent = 1');
    const stmts = [
      env.DB.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).bind(...args, lead.id),
      env.DB.prepare('INSERT INTO calls (lead_id,user_id,outcome,from_status,to_status,created_at) VALUES (?,?,?,?,?,?)').bind(lead.id, user.id, outcome, lead.status, to, t),
    ];
    const note = str(body.note, 4000);
    if (note) stmts.push(env.DB.prepare('INSERT INTO notes (lead_id,user_id,body,created_at) VALUES (?,?,?,?)').bind(lead.id, user.id, note, t));
    if (outcome === 'dnc' && lead.phone_norm) stmts.push(env.DB.prepare('INSERT OR IGNORE INTO dnc (phone_norm, lead_id, user_id, created_at) VALUES (?,?,?,?)').bind(lead.phone_norm, lead.id, user.id, t));
    await env.DB.batch(stmts);
    return json({ ok: true, status: to });
  }

  if ((m = path.match(/^\/leads\/(\d+)\/notes$/)) && method === 'POST') {
    need(user, 'admin', 'rep');
    const lead = await loadLead(env, user, +m[1]);
    const note = str(body.body, 4000);
    if (!note) bad('Write a note first');
    await env.DB.prepare('INSERT INTO notes (lead_id,user_id,body,created_at) VALUES (?,?,?,?)').bind(lead.id, user.id, note, now()).run();
    return json({ ok: true });
  }

  /* ---- demo queue (devs + admin) ---- */
  if (path === '/demos' && method === 'GET') {
    need(user, 'admin', 'dev');
    const which = url.searchParams.get('which') === 'ready' ? 'demo_ready' : 'demo_needed';
    const { results } = await env.DB.prepare(
      `SELECT l.id, l.business, l.owner, l.city, l.category, l.link, l.demo_url, l.status, l.updated_at, b.name AS batch_name
       FROM leads l LEFT JOIN batches b ON b.id = l.batch_id WHERE l.status = ?
       ORDER BY ${which === 'demo_ready' ? 'l.updated_at DESC' : 'l.id ASC'} LIMIT 200`
    ).bind(which).all();
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM leads WHERE status = 'demo_needed'`).first();
    return json({ leads: results, needed: count.n });
  }

  if ((m = path.match(/^\/leads\/(\d+)\/demo$/)) && method === 'POST') {
    need(user, 'admin', 'dev');
    const lead = await loadLead(env, user, +m[1]);
    const demo = cleanUrl(body.demo_url);
    if (!demo) bad('Paste a valid demo link (https://…)');
    const ready = body.ready !== false;
    const to = ready && ['new', 'demo_needed'].includes(lead.status) ? 'demo_ready' : lead.status;
    const t = now();
    const stmts = [env.DB.prepare('UPDATE leads SET demo_url=?, status=?, updated_at=? WHERE id=?').bind(demo, to, t, lead.id)];
    if (to !== lead.status) stmts.push(env.DB.prepare('INSERT INTO calls (lead_id,user_id,outcome,from_status,to_status,created_at) VALUES (?,?,?,?,?,?)').bind(lead.id, user.id, 'demo_ready', lead.status, to, t));
    await env.DB.batch(stmts);
    return json({ ok: true, status: to });
  }

  /* ================= Stage 2 ================= */

  /* ---- call script ---- */
  if (path === '/script' && method === 'GET') {
    need(user, 'admin', 'rep');
    let sections = null, custom = false;
    try { const raw = await getSetting(env, 'call_script'); if (raw) { sections = JSON.parse(raw); custom = true; } } catch { sections = null; }
    if (!Array.isArray(sections) || !sections.length) { sections = DEFAULT_SCRIPT; custom = false; }
    return json({ sections, custom });
  }

  if (path === '/script' && method === 'PUT') {
    need(user, 'admin');
    if (body.reset === true) { await env.DB.prepare(`DELETE FROM settings WHERE key = 'call_script'`).run(); return json({ ok: true }); }
    const list = Array.isArray(body.sections) ? body.sections.slice(0, 40) : [];
    const clean = list.map((s) => ({ kind: s && s.kind === 'objection' ? 'objection' : 'step', title: str(s && s.title, 80), body: str(s && s.body, 4000) }))
      .filter((s) => s.title || s.body);
    if (!clean.length) bad('The script needs at least one section');
    clean.forEach((s) => { if (!s.title) bad('Every section needs a title'); });
    await setSetting(env, 'call_script', JSON.stringify(clean));
    return json({ ok: true });
  }

  /* ---- settings (admin) ---- */
  if (path === '/settings' && method === 'GET') {
    need(user, 'admin');
    return json({ default_commission_pct: await defaultPct(env), packages: PACKAGES });
  }
  if (path === '/settings' && method === 'PUT') {
    need(user, 'admin');
    if (body.default_commission_pct !== undefined) {
      const v = pctVal(body.default_commission_pct);
      if (v === null) bad('Enter a commission %');
      await setSetting(env, 'default_commission_pct', String(v));
    }
    return json({ ok: true });
  }

  /* ---- dashboard + leaderboard ---- */
  if (path === '/dashboard' && method === 'GET') {
    need(user, 'admin', 'rep');
    const p = url.searchParams;
    const until = validIso(p.get('until')) || now();
    const from = validIso(p.get('from')) || new Date(Date.now() - 864e5).toISOString();
    const since = validIso(p.get('since')) || new Date(Date.now() - 7 * 864e5).toISOString();
    const tz = Math.max(-840, Math.min(840, parseInt(p.get('tz'), 10) || 0));   // minutes east of UTC
    const shift = (tz >= 0 ? '+' : '') + tz + ' minutes';
    const isAdmin = user.role === 'admin';
    const mine = isAdmin ? '' : ' AND c.user_id = ?';
    const mineD = isAdmin ? '' : ' AND d.rep_id = ?';
    const me = isAdmin ? [] : [user.id];

    const [callsRow, dealsRow, board, days, pipe, owed] = await Promise.all([
      env.DB.prepare(
        `SELECT SUM(CASE WHEN c.outcome IN (${CALL_OUTCOMES_SQL}) THEN 1 ELSE 0 END) AS calls,
                COUNT(DISTINCT CASE WHEN c.outcome = 'booked' THEN c.lead_id END) AS booked
         FROM calls c WHERE c.created_at >= ? AND c.created_at < ?${mine}`
      ).bind(from, until, ...me).first(),
      env.DB.prepare(
        `SELECT COUNT(*) AS closes, COALESCE(SUM(d.amount_cents),0) AS revenue_cents,
                COALESCE(SUM(ROUND(d.amount_cents * d.commission_pct / 100.0)),0) AS commission_cents
         FROM deals d WHERE d.created_at >= ? AND d.created_at < ?${mineD}`
      ).bind(from, until, ...me).first(),
      env.DB.prepare(
        `SELECT u.id, u.name, u.role, u.active,
           (SELECT COUNT(*) FROM calls c WHERE c.user_id = u.id AND c.outcome IN (${CALL_OUTCOMES_SQL}) AND c.created_at >= ?1 AND c.created_at < ?2) AS calls,
           (SELECT COUNT(DISTINCT c.lead_id) FROM calls c WHERE c.user_id = u.id AND c.outcome = 'booked' AND c.created_at >= ?1 AND c.created_at < ?2) AS booked,
           (SELECT COUNT(*) FROM deals d WHERE d.rep_id = u.id AND d.created_at >= ?1 AND d.created_at < ?2) AS closes,
           (SELECT COALESCE(SUM(d.amount_cents),0) FROM deals d WHERE d.rep_id = u.id AND d.created_at >= ?1 AND d.created_at < ?2) AS revenue_cents
         FROM users u WHERE u.role IN ('rep','admin')`
      ).bind(from, until).all(),
      env.DB.prepare(
        `SELECT date(c.created_at, ?) AS day,
                SUM(CASE WHEN c.outcome IN (${CALL_OUTCOMES_SQL}) THEN 1 ELSE 0 END) AS calls,
                SUM(CASE WHEN c.outcome = 'booked' THEN 1 ELSE 0 END) AS booked
         FROM calls c WHERE c.created_at >= ?${mine} GROUP BY day ORDER BY day`
      ).bind(shift, since, ...me).all(),
      env.DB.prepare(
        `SELECT
           SUM(CASE WHEN status IN ('new','demo_needed') THEN 1 ELSE 0 END) AS need_demo,
           SUM(CASE WHEN status = 'demo_ready' THEN 1 ELSE 0 END) AS demo_ready,
           SUM(CASE WHEN status = 'called' THEN 1 ELSE 0 END) AS called,
           SUM(CASE WHEN status = 'callback' THEN 1 ELSE 0 END) AS callback,
           SUM(CASE WHEN status = 'callback' AND callback_at < ? THEN 1 ELSE 0 END) AS callbacks_due,
           SUM(CASE WHEN status = 'booked' THEN 1 ELSE 0 END) AS booked,
           SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) AS won
         FROM leads WHERE status != 'dnc'${isAdmin ? '' : ' AND assigned_to = ?'}`
      ).bind(until, ...me).first(),
      env.DB.prepare(
        `SELECT COALESCE(SUM(ROUND(d.amount_cents * d.commission_pct / 100.0)),0) AS owed_cents, COUNT(*) AS n
         FROM deals d WHERE d.paid = 0${mineD}`
      ).bind(...me).first(),
    ]);

    const leaderboard = board.results
      .filter((r) => (r.role === 'rep' && r.active) || r.calls || r.booked || r.closes)
      .map((r) => ({ id: r.id, name: r.name, calls: r.calls, booked: r.booked, closes: r.closes, ...(isAdmin ? { revenue_cents: r.revenue_cents } : {}), me: r.id === user.id }))
      .sort((a, b) => b.closes - a.closes || b.booked - a.booked || b.calls - a.calls || a.name.localeCompare(b.name));

    return json({
      scope: isAdmin ? 'team' : 'me',
      totals: {
        calls: callsRow.calls || 0, booked: callsRow.booked || 0, closes: dealsRow.closes || 0,
        ...(isAdmin ? { revenue_cents: dealsRow.revenue_cents } : { commission_cents: dealsRow.commission_cents }),
      },
      leaderboard,
      days: days.results,
      pipeline: Object.fromEntries(Object.entries(pipe || {}).map(([k, v]) => [k, v || 0])),
      owed_cents: owed.owed_cents || 0, owed_deals: owed.n || 0,
    });
  }

  /* ---- deals + commissions ---- */
  if (path === '/deals' && method === 'GET') {
    need(user, 'admin', 'rep');
    const p = url.searchParams;
    const where = [], args = [];
    if (user.role === 'rep') { where.push('d.rep_id = ?'); args.push(user.id); }
    else if (p.get('rep')) { where.push('d.rep_id = ?'); args.push(+p.get('rep')); }
    if (p.get('paid') === '0') where.push('d.paid = 0');
    if (p.get('paid') === '1') where.push('d.paid = 1');
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const deals = (await env.DB.prepare(
      `SELECT d.id, d.lead_id, d.rep_id, d.amount_cents, d.commission_pct, d.paid, d.paid_at, d.note, d.package, d.created_at,
              l.business, l.owner, l.city, u.name AS rep_name
       FROM deals d LEFT JOIN leads l ON l.id = d.lead_id LEFT JOIN users u ON u.id = d.rep_id
       ${w} ORDER BY d.paid ASC, d.created_at DESC LIMIT 500`
    ).bind(...args).all()).results.map((d) => ({ ...d, commission_cents: commissionCents(d) }));

    // per-rep summary (all deals, ignoring the paid filter)
    const sumWhere = user.role === 'rep' ? 'WHERE d.rep_id = ?' : '';
    const summary = (await env.DB.prepare(
      `SELECT d.rep_id, u.name AS rep_name, COUNT(*) AS deals, COALESCE(SUM(d.amount_cents),0) AS revenue_cents,
              COALESCE(SUM(ROUND(d.amount_cents * d.commission_pct / 100.0)),0) AS earned_cents,
              COALESCE(SUM(CASE WHEN d.paid = 1 THEN ROUND(d.amount_cents * d.commission_pct / 100.0) ELSE 0 END),0) AS paid_cents,
              COALESCE(SUM(CASE WHEN d.paid = 0 THEN ROUND(d.amount_cents * d.commission_pct / 100.0) ELSE 0 END),0) AS owed_cents,
              SUM(CASE WHEN d.paid = 0 THEN 1 ELSE 0 END) AS unpaid
       FROM deals d LEFT JOIN users u ON u.id = d.rep_id ${sumWhere} GROUP BY d.rep_id ORDER BY owed_cents DESC, revenue_cents DESC`
    ).bind(...(user.role === 'rep' ? [user.id] : [])).all()).results;

    let toClose = [], missing = [];
    if (user.role === 'admin') {
      toClose = (await env.DB.prepare(
        `SELECT l.id, l.business, l.owner, l.city, l.booked_at, l.assigned_to, u.name AS rep_name FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
         WHERE l.status = 'booked' ORDER BY COALESCE(l.booked_at, l.updated_at) ASC LIMIT 100`
      ).all()).results;
      missing = (await env.DB.prepare(
        `SELECT l.id, l.business, l.owner, l.city, l.assigned_to, u.name AS rep_name FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
         WHERE l.status = 'won' AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.lead_id = l.id) ORDER BY l.updated_at DESC LIMIT 100`
      ).all()).results;
    }
    return json({ deals, summary, toClose, missing });
  }

  if (path === '/deals' && method === 'POST') {
    need(user, 'admin');
    const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(+body.lead_id).first();
    if (!lead) bad('Pick the lead this deal is for');
    const repId = body.rep_id ? +body.rep_id : null;
    let rep = null;
    if (repId) {
      rep = await env.DB.prepare(`SELECT id, commission_pct FROM users WHERE id = ? AND role IN ('rep','admin')`).bind(repId).first();
      if (!rep) bad('That rep was not found');
    }
    const amount = centsVal(body.amount);
    let pct = pctVal(body.commission_pct);
    if (pct === null) pct = rep ? (rep.commission_pct ?? await defaultPct(env)) : 0;
    if (!rep) pct = 0;
    const paid = body.paid ? 1 : 0, t = now();
    const stmts = [
      env.DB.prepare(`INSERT INTO deals (lead_id, rep_id, amount_cents, commission_pct, paid, paid_at, note, package, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(lead.id, rep ? rep.id : null, amount, pct, paid, paid ? t : null, str(body.note, 1000), str(body.package, 60), user.id, t),
    ];
    if (lead.status !== 'won') {
      stmts.push(env.DB.prepare(`UPDATE leads SET status = 'won', callback_at = NULL, updated_at = ? WHERE id = ?`).bind(t, lead.id));
      stmts.push(env.DB.prepare('INSERT INTO calls (lead_id,user_id,outcome,from_status,to_status,created_at) VALUES (?,?,?,?,?,?)').bind(lead.id, user.id, 'closed_won', lead.status, 'won', t));
      if (lead.status === 'dnc' && lead.phone_norm) stmts.push(env.DB.prepare('DELETE FROM dnc WHERE phone_norm = ?').bind(lead.phone_norm));
    }
    await env.DB.batch(stmts);
    return json({ ok: true });
  }

  if (path === '/deals/pay' && method === 'POST') {
    need(user, 'admin');
    const t = now();
    if (Array.isArray(body.ids) && body.ids.length) {
      const ids = body.ids.map(Number).filter(Boolean).slice(0, 500);
      const stmts = ids.map((id) => env.DB.prepare('UPDATE deals SET paid = 1, paid_at = ? WHERE id = ? AND paid = 0').bind(t, id));
      for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
      return json({ ok: true, count: ids.length });
    }
    if (body.rep_id === undefined) bad('Pick a rep');
    const r = body.rep_id === null
      ? await env.DB.prepare('UPDATE deals SET paid = 1, paid_at = ? WHERE rep_id IS NULL AND paid = 0').bind(t).run()
      : await env.DB.prepare('UPDATE deals SET paid = 1, paid_at = ? WHERE rep_id = ? AND paid = 0').bind(t, +body.rep_id).run();
    return json({ ok: true, count: r.meta.changes });
  }

  if ((m = path.match(/^\/deals\/(\d+)$/)) && (method === 'PATCH' || method === 'DELETE')) {
    need(user, 'admin');
    const deal = await env.DB.prepare('SELECT * FROM deals WHERE id = ?').bind(+m[1]).first();
    if (!deal) throw new HttpError(404, 'Deal not found');
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM deals WHERE id = ?').bind(deal.id).run();
      return json({ ok: true });
    }
    const sets = [], args = [];
    if (body.amount !== undefined) { sets.push('amount_cents = ?'); args.push(centsVal(body.amount)); }
    if (body.commission_pct !== undefined) { const v = pctVal(body.commission_pct); sets.push('commission_pct = ?'); args.push(v ?? 0); }
    if (body.rep_id !== undefined) {
      if (body.rep_id === null || body.rep_id === '') { sets.push('rep_id = NULL'); }
      else {
        const r = await env.DB.prepare(`SELECT id FROM users WHERE id = ? AND role IN ('rep','admin')`).bind(+body.rep_id).first();
        if (!r) bad('That rep was not found');
        sets.push('rep_id = ?'); args.push(r.id);
      }
    }
    if (body.note !== undefined) { sets.push('note = ?'); args.push(str(body.note, 1000)); }
    if (body.package !== undefined) { sets.push('package = ?'); args.push(str(body.package, 60)); }
    if (body.paid !== undefined) {
      sets.push('paid = ?', 'paid_at = ?'); args.push(body.paid ? 1 : 0, body.paid ? (deal.paid_at || now()) : null);
    }
    if (sets.length) await env.DB.prepare(`UPDATE deals SET ${sets.join(', ')} WHERE id = ?`).bind(...args, deal.id).run();
    return json({ ok: true });
  }

  throw new HttpError(404, 'Not found');
}

/* ---------------- entry ---------------- */
const SECURITY_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000',
};

function withHeaders(res) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v);
  return r;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        if (!env.DB) throw new HttpError(500, 'Database not connected. Add the D1 binding named DB in Cloudflare, then redeploy.');
        await ensureSchema(env);
        return withHeaders(await api(request, env, url));
      } catch (e) {
        if (e instanceof HttpError) return withHeaders(json({ error: e.message }, e.status));
        console.error(e);
        return withHeaders(json({ error: 'Something went wrong on the server. Try again.' }, 500));
      }
    }
    return withHeaders(await env.ASSETS.fetch(request));
  },
};
