/* =====================================================================
   Reekon Systems — Sales Portal backend (Cloudflare Pages, _worker.js)
   Stage 1: logins, users, batches, leads, call check-off, notes, DNC,
            callbacks, demo queue.
   Stage 2: call script, dashboard, leaderboard, deals + commission tracker.
   Stage 3: lead heat (hot/warm/cold/dead), email-first outreach, smart
            import (Instant Data Scraper CSVs), demo site generator with
            public /d/<slug> pages and view tracking.
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
const OUTCOMES = ['no_answer', 'voicemail', 'gatekeeper', 'not_interested', 'callback', 'demo_sent', 'booked', 'dnc', 'emailed'];
const DIAL_OUTCOMES = OUTCOMES.filter((o) => o !== 'emailed');
const HEATS = ['hot', 'warm', 'cold', 'dead'];
const NOT_A_SITE = /^https?:\/\/([a-z0-9-]+\.)*(facebook|fb|instagram|linktr|linktree|yelp|booksy|vagaro|styleseat|square|squareup|tiktok|twitter|x|google|goo|business\.site|g\.page|maps\.app|fresha|glossgenius|beacons|taplink|carrd)\.[a-z.]+(\/|$)/i;
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
  // Stage 3
  `CREATE TABLE IF NOT EXISTS demos (
     id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, lead_id INTEGER,
     theme TEXT NOT NULL DEFAULT 'noir', data TEXT NOT NULL DEFAULT '{}',
     views INTEGER NOT NULL DEFAULT 0, last_viewed_at TEXT,
     created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS demos_lead ON demos(lead_id)`,
];

// Stage 2 columns added to the existing deals table. Only added if missing — never drops data.
const DEAL_COLUMNS = { package: 'TEXT', created_by: 'INTEGER' };
// Stage 3 columns added to leads (only if missing — never drops data).
const LEAD_COLUMNS = { email: 'TEXT', website: 'TEXT', address: 'TEXT', rating: 'TEXT', heat: "TEXT DEFAULT 'cold'", emailed_at: 'TEXT', demo_views: 'INTEGER NOT NULL DEFAULT 0', demo_viewed_at: 'TEXT' };

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
  const lcols = new Set((await env.DB.prepare('PRAGMA table_info(leads)').all()).results.map((c) => c.name));
  for (const [name, type] of Object.entries(LEAD_COLUMNS)) {
    if (!lcols.has(name)) {
      try { await env.DB.prepare(`ALTER TABLE leads ADD COLUMN ${name} ${type}`).run(); }
      catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; }
    }
  }
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS leads_heat ON leads(heat)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS leads_email ON leads(email)').run();
  schemaReady = true;
}

/* -------- Stage 2: defaults -------- */
const CALL_OUTCOMES_SQL = DIAL_OUTCOMES.map((o) => `'${o}'`).join(',');   // real dials only (not status edits)
const DEFAULT_COMMISSION_PCT = 20;
const PACKAGES = [
  { key: 'website', name: 'Website (base)', amount: 997 },
  { key: 'website-founding', name: 'Website — founding', amount: 497 },
  { key: 'website-ai', name: 'Website + AI', amount: 2997 },
  { key: 'website-ai-founding', name: 'Website + AI — founding', amount: 1497 },
  { key: 'custom-quote', name: 'Custom quote (type the amount)', amount: null },
  { key: 'custom', name: 'Custom — Full Automation', amount: 5000 },
  // Upsells / add-ons (log each as its own deal on the client's lead page)
  { key: 'addon-ai', name: 'Add-on — Add AI to their site', amount: 1997 },
  { key: 'addon-receptionist', name: 'Add-on — AI Receptionist', amount: 1997 },
  { key: 'addon-automation', name: 'Add-on — Extra automation', amount: 997 },
  { key: 'addon-channel', name: 'Add-on — Extra chat channel', amount: 497 },
];

const DEFAULT_SCRIPT = [
  { kind: 'step', title: 'Opener', body:
`Hey, is this {owner_first}?

[If yes] Hey {owner_first}, this is {rep_first} with Reekon Systems, here in LA. I'll be quick, I know you're busy running {business}.

[If you emailed them] Hey {owner_first}, this is {rep_first} with Reekon Systems. I sent you an email {email_day} with a free website we built for {business}. Ring a bell?

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
`Totally fair. Websites start at $997 to launch, plus $79 a month for hosting, updates and support, and we have a founding offer for our first 10 clients. Exact price depends on what you want added, and Marquise lays it all out on the call so there are no surprises.

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

function cleanEmail(v) {
  const e = str(v, 200).toLowerCase().replace(/^mailto:/, '');
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e) ? e : '';
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
    const skipWithSite = body.skipWithSite !== false;
    const phones = rows.map((r) => normPhone(r.phone)).filter(Boolean);
    const emails = rows.map((r) => cleanEmail(r.email)).filter(Boolean);
    const seen = new Set(), dncSet = new Set(), seenEmail = new Set();
    for (let i = 0; i < emails.length; i += 90) {
      const chunk = emails.slice(i, i + 90);
      (await env.DB.prepare(`SELECT email FROM leads WHERE email IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all()).results.forEach((r) => seenEmail.add(r.email));
    }
    for (let i = 0; i < phones.length; i += 90) {
      const chunk = phones.slice(i, i + 90);
      const q = chunk.map(() => '?').join(',');
      (await env.DB.prepare(`SELECT phone_norm FROM leads WHERE phone_norm IN (${q})`).bind(...chunk).all()).results.forEach((r) => seen.add(r.phone_norm));
      (await env.DB.prepare(`SELECT phone_norm FROM dnc WHERE phone_norm IN (${q})`).bind(...chunk).all()).results.forEach((r) => dncSet.add(r.phone_norm));
    }
    let inserted = 0, dup = 0, dncSkipped = 0, invalid = 0, hasSite = 0;
    const stmts = [], t = now();
    for (const r of rows) {
      const business = str(r.business, 200);
      if (!business) { invalid++; continue; }
      const pn = normPhone(r.phone), em = cleanEmail(r.email), site = cleanUrl(r.website);
      if (!pn && !em) { invalid++; continue; }
      // a Facebook / Instagram / Linktree / booking page is not a real website: those are still good leads
      if (site && skipWithSite && !NOT_A_SITE.test(site)) { hasSite++; continue; }
      if (pn && dncSet.has(pn)) { dncSkipped++; continue; }
      if ((pn && seen.has(pn)) || (em && seenEmail.has(em))) { dup++; continue; }
      if (pn) seen.add(pn);
      if (em) seenEmail.add(em);
      const rep = loads ? pickRep(loads) : fixedRep;
      stmts.push(env.DB.prepare(
        `INSERT INTO leads (batch_id,business,owner,phone,phone_norm,city,category,link,status,assigned_to,created_at,updated_at,email,website,address,rating,heat)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'cold')`
      ).bind(batchId, business, str(r.owner, 120), str(r.phone, 40), pn, str(r.city, 80), str(r.category, 80), cleanUrl(r.link), startStatus, rep, t, t, em || null, site || null, str(r.address, 200) || null, str(r.rating, 20) || null));
      inserted++;
    }
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    return json({ inserted, duplicates: dup, dnc: dncSkipped, invalid, hasSite });
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
    if (p.get('heat') && HEATS.includes(p.get('heat'))) { where.push("COALESCE(l.heat,'cold') = ?"); args.push(p.get('heat')); }
    if (p.get('contact') === 'email') where.push("l.email IS NOT NULL AND l.email != ''");
    if (p.get('contact') === 'phone') where.push("l.phone_norm IS NOT NULL AND l.phone_norm != ''");
    if (p.get('contact') === 'unemailed') where.push("l.email IS NOT NULL AND l.email != '' AND l.emailed_at IS NULL");
    const q = str(p.get('q'), 80);
    if (q) {
      where.push('(l.business LIKE ? OR l.owner LIKE ? OR l.phone_norm LIKE ? OR l.category LIKE ? OR l.email LIKE ?)');
      const like = '%' + q.replace(/[%_]/g, '') + '%';
      const digits = normPhone(q);
      args.push(like, like, digits.length >= 4 ? '%' + digits + '%' : '§none§', like, like);
    }
    const limit = Math.min(+p.get('limit') || 50, 200), offset = Math.max(+p.get('offset') || 0, 0);
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const order = `ORDER BY CASE COALESCE(l.heat,'cold') WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 WHEN 'cold' THEN 2 ELSE 3 END, CASE l.status WHEN 'callback' THEN 0 WHEN 'demo_ready' THEN 1 WHEN 'booked' THEN 2 WHEN 'called' THEN 3 ELSE 4 END, COALESCE(l.callback_at, l.updated_at) ASC, l.id ASC`;
    const { results } = await env.DB.prepare(
      `SELECT l.id, l.business, l.owner, l.phone, l.city, l.category, l.status, l.callback_at, l.booked_at,
              l.attempts, l.last_call_at, l.demo_url, l.demo_sent, l.assigned_to, u.name AS rep_name,
              l.email, COALESCE(l.heat,'cold') AS heat, l.emailed_at, l.demo_views, l.demo_viewed_at
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
    if (body.email !== undefined) { const e = cleanEmail(body.email); if (str(body.email) && !e) bad('That email does not look right'); sets.push('email = ?'); args.push(e || null); }
    if (body.address !== undefined) { sets.push('address = ?'); args.push(str(body.address, 200) || null); }
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
    const t = now();
    if (outcome === 'emailed') {
      await env.DB.batch([
        env.DB.prepare('UPDATE leads SET emailed_at = ?, updated_at = ? WHERE id = ?').bind(t, t, lead.id),
        env.DB.prepare('INSERT INTO calls (lead_id,user_id,outcome,from_status,to_status,created_at) VALUES (?,?,?,?,?,?)').bind(lead.id, user.id, 'emailed', lead.status, lead.status, t),
      ]);
      return json({ ok: true, status: lead.status });
    }
    const to = nextStatus(lead.status, outcome);
    const sets = ['status = ?', 'attempts = attempts + 1', 'last_call_at = ?', 'updated_at = ?'];
    const args = [to, t, t];
    const curHeat = lead.heat || 'cold';
    const heatTo = { booked: 'hot', callback: curHeat === 'hot' ? 'hot' : 'warm', demo_sent: curHeat === 'cold' ? 'warm' : curHeat, not_interested: 'dead', dnc: 'dead' }[outcome];
    if (heatTo && heatTo !== curHeat) { sets.push('heat = ?'); args.push(heatTo); }
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

  /* ================= Stage 3 ================= */

  /* ---- lead heat ---- */
  if ((m = path.match(/^\/leads\/(\d+)\/heat$/)) && method === 'POST') {
    need(user, 'admin', 'rep');
    const lead = await loadLead(env, user, +m[1]);
    if (!HEATS.includes(body.heat)) bad('Pick hot, warm, cold or dead');
    await env.DB.prepare('UPDATE leads SET heat = ?, updated_at = ? WHERE id = ?').bind(body.heat, now(), lead.id).run();
    return json({ ok: true });
  }

  /* ---- demo sites ---- */
  if ((m = path.match(/^\/demos\/lead\/(\d+)$/)) && method === 'GET') {
    need(user, 'admin', 'rep', 'dev');
    const lead = await loadLead(env, user, +m[1]);
    const d = await env.DB.prepare('SELECT slug, theme, data, views, last_viewed_at, updated_at FROM demos WHERE lead_id = ? ORDER BY id DESC LIMIT 1').bind(lead.id).first();
    return json({
      lead: { id: lead.id, business: lead.business, owner: lead.owner, phone: lead.phone, email: lead.email, city: lead.city, category: lead.category, address: lead.address, rating: lead.rating, link: lead.link },
      demo: d ? { slug: d.slug, theme: d.theme, data: JSON.parse(d.data || '{}'), views: d.views, last_viewed_at: d.last_viewed_at, updated_at: d.updated_at, url: url.origin + '/d/' + d.slug } : null,
      themes: Object.keys(DEMO_THEMES),
    });
  }

  if (path === '/demos' && method === 'POST') {
    need(user, 'admin', 'rep', 'dev');
    const lead = await loadLead(env, user, +body.lead_id);
    const theme = DEMO_THEMES[body.theme] ? body.theme : pickTheme(lead.category);
    const data = cleanDemo(body.data || {}, lead);
    const t = now();
    const existing = await env.DB.prepare('SELECT id, slug FROM demos WHERE lead_id = ? ORDER BY id DESC LIMIT 1').bind(lead.id).first();
    let slug;
    if (existing) {
      slug = existing.slug;
      await env.DB.prepare('UPDATE demos SET theme = ?, data = ?, updated_at = ? WHERE id = ?').bind(theme, JSON.stringify(data), t, existing.id).run();
    } else {
      const base = (lead.business || 'demo').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'demo';
      slug = base + '-' + hex(crypto.getRandomValues(new Uint8Array(2)));
      await env.DB.prepare('INSERT INTO demos (slug, lead_id, theme, data, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').bind(slug, lead.id, theme, JSON.stringify(data), user.id, t, t).run();
    }
    const demoUrl = url.origin + '/d/' + slug;
    const to = ['new', 'demo_needed'].includes(lead.status) ? 'demo_ready' : lead.status;
    const stmts = [env.DB.prepare('UPDATE leads SET demo_url = ?, status = ?, updated_at = ? WHERE id = ?').bind(demoUrl, to, t, lead.id)];
    if (to !== lead.status) stmts.push(env.DB.prepare('INSERT INTO calls (lead_id,user_id,outcome,from_status,to_status,created_at) VALUES (?,?,?,?,?,?)').bind(lead.id, user.id, 'demo_ready', lead.status, to, t));
    await env.DB.batch(stmts);
    return json({ ok: true, url: demoUrl, slug, status: to });
  }

  throw new HttpError(404, 'Not found');
}

/* ================= Demo site engine (Stage 3) =================
   Three premium, animated themes rendered from one data object.
   Public at /d/<slug>. Views by logged-out visitors are counted and
   warm the lead up in the portal. */

const DEMO_THEMES = {
  noir: {
    label: 'Noir', fonts: 'family=Anton&family=Manrope:wght@400;500;600;700;800',
    display: "'Anton', Impact, 'Arial Narrow', sans-serif", upper: true,
    bg: '#0b0a09', surface: '#16130f', ink: '#f4eee3', muted: '#a89f91', line: 'rgba(244,238,227,.12)', accent: '#d8a64e', onAccent: '#140f06',
  },
  glow: {
    label: 'Glow', fonts: 'family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,700;1,9..144,500;1,9..144,700&family=Manrope:wght@400;500;600;700;800',
    display: "'Fraunces', Georgia, serif", upper: false, italic: true,
    bg: '#fff7f4', surface: '#ffffff', ink: '#2b1620', muted: '#8d727b', line: 'rgba(43,22,32,.1)', accent: '#e14f7e', onAccent: '#ffffff',
  },
  drive: {
    label: 'Drive', fonts: 'family=Archivo+Black&family=Manrope:wght@400;500;600;700;800',
    display: "'Archivo Black', 'Arial Black', sans-serif", upper: true,
    bg: '#07080b', surface: '#11141a', ink: '#eef2f7', muted: '#8e96a6', line: 'rgba(238,242,247,.1)', accent: '#c6ff2e', onAccent: '#0b0f02',
  },
};

function pickTheme(category) {
  const c = String(category || '').toLowerCase();
  if (/(nail|lash|brow|salon|spa|beauty|hair|braid|wax|esthetic|makeup|bridal|florist|bakery|cake)/.test(c)) return 'glow';
  if (/(auto|detail|car|tire|smog|mechanic|repair|body shop|gym|fitness|training|taco|food|restaurant|grill|bbq|catering|truck|moving|plumb|electric|roof|construct|clean)/.test(c)) return 'drive';
  return 'noir';
}

function cleanDemo(d, lead) {
  const s = (v, n) => str(v, n);
  const url = (v) => cleanUrl(v);
  const services = (Array.isArray(d.services) ? d.services : []).slice(0, 24)
    .map((x) => ({ name: s(x && x.name, 80), price: s(x && x.price, 24), desc: s(x && x.desc, 160) })).filter((x) => x.name);
  const hours = (Array.isArray(d.hours) ? d.hours : []).slice(0, 7)
    .map((x) => ({ day: s(x && x.day, 20), time: s(x && x.time, 40) })).filter((x) => x.day && x.time);
  const photos = (Array.isArray(d.photos) ? d.photos : []).slice(0, 8).map(url).filter(Boolean);
  const accent = /^#[0-9a-f]{6}$/i.test(String(d.accent || '')) ? String(d.accent) : '';
  return {
    name: s(d.name, 120) || lead.business || 'Your business',
    tagline: s(d.tagline, 160), category: s(d.category, 80) || lead.category || '', city: s(d.city, 80) || lead.city || '',
    about: s(d.about, 1200), phone: s(d.phone, 40) || lead.phone || '', email: cleanEmail(d.email) || lead.email || '',
    address: s(d.address, 200) || lead.address || '', rating: s(d.rating, 12) || lead.rating || '', reviews: s(d.reviews, 12),
    instagram: url(d.instagram), booking: url(d.booking), services, hours, photos, accent,
  };
}

async function demoPage(request, env, slug) {
  const row = await env.DB.prepare('SELECT id, lead_id, theme, data FROM demos WHERE slug = ?').bind(slug).first();
  if (!row) {
    return new Response('<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Preview not found</title><body style="font-family:system-ui;background:#0b0a09;color:#f4eee3;display:grid;place-items:center;min-height:100vh;margin:0"><p>This preview link has expired or does not exist.</p></body>', { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  // Count views from people who are not logged in to the portal (i.e. the business owner).
  const viewer = await getUser(request, env);
  if (!viewer) {
    const t = now();
    await env.DB.batch([
      env.DB.prepare('UPDATE demos SET views = views + 1, last_viewed_at = ? WHERE id = ?').bind(t, row.id),
      env.DB.prepare(`UPDATE leads SET demo_views = demo_views + 1, demo_viewed_at = ?, heat = CASE WHEN COALESCE(heat,'cold') = 'cold' THEN 'warm' ELSE heat END WHERE id = ?`).bind(t, row.lead_id),
    ]);
  }
  let data = {};
  try { data = JSON.parse(row.data || '{}'); } catch { data = {}; }
  return new Response(renderDemo(data, DEMO_THEMES[row.theme] ? row.theme : 'noir'), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function withDemoHeaders(res) {
  const r = new Response(res.body, res);
  r.headers.set('X-Robots-Tag', 'noindex, nofollow');
  r.headers.set('X-Content-Type-Options', 'nosniff');
  r.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  r.headers.set('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  return r;
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderDemo(d, themeKey) {
  const T = DEMO_THEMES[themeKey];
  const accent = d.accent || T.accent;
  const name = d.name || 'Your business';
  const words = name.split(/\s+/).filter(Boolean);
  const telHref = d.phone ? 'tel:' + String(d.phone).replace(/[^\d+]/g, '') : '';
  const book = d.booking || telHref;
  const bookLabel = d.booking ? 'Book now' : (d.phone ? 'Call to book' : 'Get in touch');
  const mapHref = d.address ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(name + ' ' + d.address) : '';
  const sub = [d.category, d.city].filter(Boolean).join(' · ');
  const tagline = d.tagline || (d.category && d.city ? `${d.city}'s go-to ${d.category.toLowerCase()}.` : 'Welcome in.');
  const services = d.services || [];
  const hours = d.hours || [];
  const photos = d.photos || [];
  const marquee = services.length ? services.map((x) => x.name) : [d.category || 'Quality', d.city || 'Local', 'Book today'];
  const ratingChip = d.rating ? `<span class="chip"><b>${esc(d.rating)}</b> ★ on Google${d.reviews ? ` · ${esc(d.reviews)} reviews` : ''}</span>` : '';
  const year = new Date().getFullYear();

  const svcHtml = services.map((x, i) => `
      <article class="svc reveal" style="--i:${i % 6}">
        <div class="svc-top"><h3>${esc(x.name)}</h3>${x.price ? `<span class="price">${esc(x.price)}</span>` : ''}</div>
        ${x.desc ? `<p>${esc(x.desc)}</p>` : ''}
      </article>`).join('');

  const hoursHtml = hours.map((h) => `<li data-day="${esc(h.day)}" data-time="${esc(h.time)}"><span>${esc(h.day)}</span><span>${esc(h.time)}</span></li>`).join('');
  const photoHtml = photos.map((u, i) => `<figure class="ph reveal" style="--i:${i % 4}"><img src="${esc(u)}" alt="${esc(name)} photo ${i + 1}" loading="lazy" referrerpolicy="no-referrer"></figure>`).join('');

  const bgLayer = themeKey === 'glow'
    ? '<div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>'
    : themeKey === 'drive'
      ? '<div class="grid"></div><div class="streaks"><i></i><i></i><i></i><i></i><i></i><i></i></div>'
      : '<div class="halo"></div><div class="sweep"></div><div class="grain"></div>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="${esc(T.bg)}">
<title>${esc(name)}${sub ? ' | ' + esc(sub) : ''}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?${T.fonts}&display=swap" rel="stylesheet">
<style>
:root{--bg:${T.bg};--surface:${T.surface};--ink:${T.ink};--muted:${T.muted};--line:${T.line};--accent:${esc(accent)};--on-accent:${T.onAccent};--display:${T.display};--body:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;color-scheme:${themeKey === 'glow' ? 'light' : 'dark'}}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{background:var(--bg);color:var(--ink);font-family:var(--body);font-size:17px;line-height:1.55;-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:inherit;text-decoration:none}
img{max-width:100%;display:block}
.wrap{max-width:1120px;margin:0 auto;padding-left:max(20px,env(safe-area-inset-left));padding-right:max(20px,env(safe-area-inset-right))}
.disp{font-family:var(--display);${T.upper ? 'text-transform:uppercase;letter-spacing:.01em;' : ''}${T.italic ? 'font-style:italic;font-weight:700;letter-spacing:-.02em;' : ''}line-height:.92}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;height:54px;padding:0 26px;border-radius:999px;font-weight:800;font-size:16px;border:1.5px solid var(--line);transition:transform .2s,box-shadow .2s,background .2s}
.btn:hover{transform:translateY(-2px)}
.btn.main{background:var(--accent);color:var(--on-accent);border-color:transparent;box-shadow:0 14px 40px -12px var(--accent)}
.btn.ghost{background:transparent;color:var(--ink)}
.btn:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:999px;border:1px solid var(--line);font-size:14px;color:var(--muted);background:color-mix(in srgb,var(--surface) 70%,transparent)}
.chip b{color:var(--ink)}
.eyebrow{font-size:12.5px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:var(--accent)}
/* ribbon */
.ribbon{position:relative;z-index:30;background:var(--accent);color:var(--on-accent);text-align:center;font-size:13px;font-weight:700;padding:8px 40px}
.ribbon button{position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:0;color:inherit;font-size:18px;cursor:pointer;width:30px;height:30px}
/* nav */
nav{position:sticky;top:0;z-index:20;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);background:color-mix(in srgb,var(--bg) 78%,transparent);border-bottom:1px solid var(--line)}
nav .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;height:66px}
nav .logo{font-family:var(--display);font-size:22px;${T.upper ? 'text-transform:uppercase;' : ''}${T.italic ? 'font-style:italic;font-weight:700;' : ''}white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:55%}
nav .links{display:none;gap:28px;font-weight:600;font-size:15px;color:var(--muted)}
nav .links a:hover{color:var(--ink)}
nav .btn{height:42px;padding:0 18px;font-size:14px}
@media(min-width:820px){nav .links{display:flex}}
/* hero */
.hero{position:relative;min-height:min(92svh,880px);display:flex;align-items:center;overflow:hidden;isolation:isolate;padding:80px 0 70px}
.hero .bg{position:absolute;inset:0;z-index:-1;overflow:hidden}
.hero h1{font-size:clamp(58px,14vw,168px);margin:18px 0 22px;max-width:14ch}
.hero h1 .w{display:inline-block;overflow:hidden;vertical-align:top;padding-bottom:.06em}
.hero h1 .w > span{display:inline-block;animation:rise 1s cubic-bezier(.2,.8,.2,1) both;animation-delay:calc(var(--i) * 90ms + 150ms)}
.hero h1 .w:last-child > span{color:var(--accent)}
.hero .lead{font-size:clamp(18px,2.4vw,22px);color:var(--muted);max-width:34ch;animation:fade 1s .6s both}
.hero .cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:32px;animation:fade 1s .8s both}
.hero .meta{display:flex;flex-wrap:wrap;gap:10px;animation:fade 1s .4s both}
@keyframes rise{from{transform:translateY(105%)}to{transform:none}}
@keyframes fade{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
/* noir bg */
.halo{position:absolute;width:140vmax;height:140vmax;left:50%;top:50%;translate:-50% -50%;background:conic-gradient(from 0deg,transparent 0 60%,color-mix(in srgb,var(--accent) 34%,transparent) 72%,transparent 84%);animation:spin 22s linear infinite;opacity:.55;filter:blur(40px)}
.sweep{position:absolute;inset:-20%;background:radial-gradient(600px 300px at 20% 30%,color-mix(in srgb,var(--accent) 22%,transparent),transparent 70%),radial-gradient(500px 400px at 85% 80%,rgba(255,255,255,.06),transparent 70%)}
.grain{position:absolute;inset:0;opacity:.08;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E")}
@keyframes spin{to{rotate:360deg}}
/* glow bg */
.blob{position:absolute;border-radius:50%;filter:blur(60px);opacity:.7;animation:float 14s ease-in-out infinite}
.b1{width:46vmax;height:46vmax;background:color-mix(in srgb,var(--accent) 55%,#ffd6c8);left:-12vmax;top:-10vmax}
.b2{width:38vmax;height:38vmax;background:#ffd9b8;right:-10vmax;top:10vmax;animation-delay:-5s}
.b3{width:30vmax;height:30vmax;background:color-mix(in srgb,var(--accent) 30%,#f4c6ff);left:30%;bottom:-16vmax;animation-delay:-9s}
@keyframes float{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(4vmax,-3vmax) scale(1.08)}66%{transform:translate(-3vmax,3vmax) scale(.95)}}
/* drive bg */
.grid{position:absolute;inset:-50% -10% 0;background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:56px 56px;transform:perspective(600px) rotateX(58deg);transform-origin:center bottom;animation:road 3s linear infinite;mask-image:linear-gradient(to top,#000 10%,transparent 75%);-webkit-mask-image:linear-gradient(to top,#000 10%,transparent 75%)}
@keyframes road{to{background-position:0 56px}}
.streaks i{position:absolute;height:2px;width:30vw;left:-30vw;background:linear-gradient(90deg,transparent,var(--accent));border-radius:2px;animation:streak 2.6s linear infinite;opacity:.8}
.streaks i:nth-child(1){top:18%;animation-delay:0s}.streaks i:nth-child(2){top:34%;animation-delay:.7s;width:18vw}.streaks i:nth-child(3){top:52%;animation-delay:1.3s}.streaks i:nth-child(4){top:66%;animation-delay:.3s;width:22vw}.streaks i:nth-child(5){top:80%;animation-delay:1.9s}.streaks i:nth-child(6){top:44%;animation-delay:2.2s;width:12vw}
@keyframes streak{to{transform:translateX(160vw)}}
/* marquee */
.marquee{border-block:1px solid var(--line);overflow:hidden;padding:18px 0;background:var(--surface)}
.marquee .track{display:flex;gap:44px;width:max-content;animation:scroll 28s linear infinite}
.marquee span{font-family:var(--display);font-size:clamp(22px,4vw,34px);white-space:nowrap;${T.upper ? 'text-transform:uppercase;' : ''}${T.italic ? 'font-style:italic;font-weight:700;' : ''}}
.marquee span::after{content:'✦';color:var(--accent);margin-left:44px;font-style:normal}
@keyframes scroll{to{transform:translateX(-50%)}}
/* sections */
section.block{padding:100px 0}
.head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:16px;margin-bottom:40px}
.head h2{font-size:clamp(40px,7vw,76px);margin-top:10px}
.head p{color:var(--muted);max-width:40ch}
.svcs{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.svc{background:var(--surface);border:1px solid var(--line);border-radius:22px;padding:26px;transition:transform .3s,border-color .3s,box-shadow .3s}
.svc:hover{transform:translateY(-6px);border-color:color-mix(in srgb,var(--accent) 60%,transparent);box-shadow:0 30px 60px -30px color-mix(in srgb,var(--accent) 60%,transparent)}
.svc-top{display:flex;justify-content:space-between;align-items:baseline;gap:14px}
.svc h3{font-size:20px;font-weight:800;letter-spacing:-.01em}
.price{font-family:var(--display);font-size:26px;color:var(--accent);white-space:nowrap;${T.italic ? 'font-style:italic;font-weight:700;' : ''}}
.svc p{color:var(--muted);margin-top:8px;font-size:15.5px}
.about{display:grid;gap:40px;align-items:center}
@media(min-width:860px){.about{grid-template-columns:1.1fr .9fr}}
.about blockquote{font-family:var(--display);font-size:clamp(30px,4.6vw,52px);line-height:1.05;${T.upper ? 'text-transform:uppercase;' : ''}${T.italic ? 'font-style:italic;font-weight:600;' : ''}}
.about blockquote em{color:var(--accent);font-style:inherit}
.about p{color:var(--muted);font-size:18px;white-space:pre-line}
.gallery{columns:2 220px;column-gap:12px}
.ph{break-inside:avoid;margin-bottom:12px;border-radius:18px;overflow:hidden;border:1px solid var(--line)}
.ph img{width:100%;transition:transform .6s}
.ph:hover img{transform:scale(1.05)}
.visit{display:grid;gap:14px}
@media(min-width:860px){.visit{grid-template-columns:1fr 1fr}}
.card{background:var(--surface);border:1px solid var(--line);border-radius:24px;padding:30px}
.hours{list-style:none}
.hours li{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--line);font-size:16px}
.hours li:last-child{border-bottom:0}
.hours li.today{color:var(--accent);font-weight:800}
.status{display:inline-flex;align-items:center;gap:8px;font-weight:800;font-size:14px;margin-bottom:12px}
.status i{width:9px;height:9px;border-radius:50%;background:var(--muted)}
.status.open i{background:#35d07f;box-shadow:0 0 0 6px rgba(53,208,127,.18);animation:pulse 2s infinite}
@keyframes pulse{50%{box-shadow:0 0 0 10px rgba(53,208,127,0)}}
.contact a{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px 0;border-bottom:1px solid var(--line);font-weight:700}
.contact a span:last-child{color:var(--muted);font-weight:500;text-align:right;overflow-wrap:anywhere}
.contact a:last-child{border-bottom:0}
.final{text-align:center;padding:120px 0;position:relative;overflow:hidden;isolation:isolate}
.final::before{content:'';position:absolute;inset:0;z-index:-1;background:radial-gradient(60% 70% at 50% 100%,color-mix(in srgb,var(--accent) 30%,transparent),transparent 70%)}
.final h2{font-size:clamp(48px,10vw,120px);margin-bottom:28px}
footer{border-top:1px solid var(--line);padding:30px 0 50px;color:var(--muted);font-size:14px}
footer .wrap{display:flex;flex-wrap:wrap;justify-content:space-between;gap:10px}
/* reveal */
.js .reveal{opacity:0;transform:translateY(28px);transition:opacity .8s cubic-bezier(.2,.8,.2,1),transform .8s cubic-bezier(.2,.8,.2,1);transition-delay:calc(var(--i,0) * 80ms)}
.js .reveal.in{opacity:1;transform:none}
.sticky-call{position:fixed;left:16px;right:16px;bottom:calc(14px + env(safe-area-inset-bottom));z-index:25;display:flex}
.sticky-call .btn{flex:1}
@media(min-width:820px){.sticky-call{display:none}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.js .reveal{opacity:1;transform:none}}
</style>
</head>
<body>
<div class="ribbon" id="ribbon">Free website preview made for ${esc(name)}<button type="button" aria-label="Hide" onclick="this.parentNode.remove()">×</button></div>
<nav><div class="wrap">
  <a class="logo" href="#top">${esc(name)}</a>
  <div class="links">${services.length ? '<a href="#services">Services</a>' : ''}${d.about ? '<a href="#about">About</a>' : ''}<a href="#visit">Visit</a></div>
  ${book ? `<a class="btn main" href="${esc(book)}"${d.booking ? ' target="_blank" rel="noopener"' : ''}>${esc(bookLabel)}</a>` : ''}
</div></nav>

<header class="hero" id="top">
  <div class="bg" aria-hidden="true">${bgLayer}</div>
  <div class="wrap">
    <div class="meta">${sub ? `<span class="chip">${esc(sub)}</span>` : ''}${ratingChip}</div>
    <h1 class="disp">${words.map((w, i) => `<span class="w"><span style="--i:${i}">${esc(w)}</span></span>`).join(' ')}</h1>
    <p class="lead">${esc(tagline)}</p>
    <div class="cta">
      ${book ? `<a class="btn main" href="${esc(book)}"${d.booking ? ' target="_blank" rel="noopener"' : ''}>${esc(bookLabel)} →</a>` : ''}
      ${mapHref ? `<a class="btn ghost" href="${esc(mapHref)}" target="_blank" rel="noopener">Get directions</a>` : ''}
    </div>
  </div>
</header>

<div class="marquee" aria-hidden="true"><div class="track">${[...marquee, ...marquee, ...marquee, ...marquee].map((x) => `<span>${esc(x)}</span>`).join('')}</div></div>

${services.length ? `<section class="block" id="services"><div class="wrap">
  <div class="head reveal"><div><span class="eyebrow">Services</span><h2 class="disp">What we do</h2></div><p>Prices are a starting point. Ask about anything you don't see.</p></div>
  <div class="svcs">${svcHtml}</div>
</div></section>` : ''}

${d.about ? `<section class="block" id="about"><div class="wrap about">
  <blockquote class="reveal">${esc(name)}${d.city ? `<br><em>in ${esc(d.city)}.</em>` : ''}</blockquote>
  <p class="reveal" style="--i:1">${esc(d.about)}</p>
</div></section>` : ''}

${photos.length ? `<section class="block" style="padding-top:0"><div class="wrap"><div class="gallery">${photoHtml}</div></div></section>` : ''}

<section class="block" id="visit"><div class="wrap">
  <div class="head reveal"><div><span class="eyebrow">Visit</span><h2 class="disp">Come through</h2></div></div>
  <div class="visit">
    ${hours.length ? `<div class="card reveal"><div class="status" id="status"><i></i><span>Hours</span></div><ul class="hours" id="hours">${hoursHtml}</ul></div>` : ''}
    <div class="card contact reveal" style="--i:1">
      ${d.phone ? `<a href="${esc(telHref)}"><span>Call</span><span>${esc(d.phone)}</span></a>` : ''}
      ${d.address ? `<a href="${esc(mapHref)}" target="_blank" rel="noopener"><span>Address</span><span>${esc(d.address)}</span></a>` : ''}
      ${d.email ? `<a href="mailto:${esc(d.email)}"><span>Email</span><span>${esc(d.email)}</span></a>` : ''}
      ${d.instagram ? `<a href="${esc(d.instagram)}" target="_blank" rel="noopener"><span>Instagram</span><span>Follow us →</span></a>` : ''}
    </div>
  </div>
</div></section>

<section class="final"><div class="wrap">
  <h2 class="disp reveal">Ready when<br>you are.</h2>
  ${book ? `<a class="btn main reveal" style="--i:1" href="${esc(book)}"${d.booking ? ' target="_blank" rel="noopener"' : ''}>${esc(bookLabel)} →</a>` : ''}
</div></section>

<footer><div class="wrap"><span>© ${year} ${esc(name)}</span><span>Preview site by Reekon Systems</span></div></footer>
${book ? `<div class="sticky-call"><a class="btn main" href="${esc(book)}"${d.booking ? ' target="_blank" rel="noopener"' : ''}>${esc(bookLabel)}</a></div>` : ''}

<script>
(function(){
  document.documentElement.classList.add('js');
  var els=document.querySelectorAll('.reveal');
  if('IntersectionObserver' in window){
    var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}});},{threshold:.12,rootMargin:'0px 0px -40px 0px'});
    els.forEach(function(el){io.observe(el);});
  } else els.forEach(function(el){el.classList.add('in');});
  // today's hours + open now
  var list=document.getElementById('hours'); if(!list) return;
  var days=['sun','mon','tue','wed','thu','fri','sat'], now=new Date(), today=days[now.getDay()];
  function mins(t){var m=/(\\d{1,2})(?::(\\d{2}))?\\s*(a|p)?/i.exec(t); if(!m) return null; var h=+m[1]%12, mi=+(m[2]||0); if(m[3]&&m[3].toLowerCase()==='p') h+=12; return h*60+mi;}
  var open=null;
  Array.prototype.forEach.call(list.children,function(li){
    var d=(li.getAttribute('data-day')||'').toLowerCase().slice(0,3);
    if(d!==today) return; li.classList.add('today');
    var t=li.getAttribute('data-time')||''; if(/closed/i.test(t)){open=false;return;}
    var parts=t.split(/[-–—]|to/i); if(parts.length<2) return;
    var a=mins(parts[0]), b=mins(parts[1]); if(a==null||b==null) return;
    if(!/(a|p)/i.test(parts[1])&&b<a) b+=720;
    var n=now.getHours()*60+now.getMinutes(); open=n>=a&&n<b;
  });
  var st=document.getElementById('status');
  if(st&&open!==null){st.classList.toggle('open',open);st.querySelector('span').textContent=open?'Open now':'Closed right now';}
})();
</script>
</body>
</html>`;
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
    const dm = url.pathname.match(/^\/d\/([a-z0-9-]{3,60})\/?$/);
    if (dm && request.method === 'GET') {
      try {
        if (!env.DB) throw new Error('no db');
        await ensureSchema(env);
        return withDemoHeaders(await demoPage(request, env, dm[1]));
      } catch (e) {
        console.error(e);
        return withDemoHeaders(new Response('<!doctype html><meta charset=utf-8><title>Preview unavailable</title><p style="font-family:system-ui;padding:40px">This preview is not available right now.</p>', { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
      }
    }
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
