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

const STATUSES = ['new', 'demo_needed', 'demo_ready', 'called', 'callback', 'booked', 'call2', 'won', 'lost', 'dnc'];
const BOARD_STAGES = [['new', 'New', ['new', 'demo_needed', 'demo_ready']], ['called', 'Contacted', ['called']], ['callback', 'Callback', ['callback']], ['booked', 'Audit booked', ['booked']], ['call2', 'Call 2', ['call2']], ['won', 'Won', ['won']], ['lost', 'Lost', ['lost']]];
const OPEN_STATUSES = ['new', 'demo_needed', 'demo_ready', 'called', 'callback', 'booked', 'call2'];
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
const DEAL_COLUMNS = { package: 'TEXT', created_by: 'INTEGER', mrr_cents: 'INTEGER NOT NULL DEFAULT 0' };
const TRACKER_COLUMNS = { texts: 'INTEGER NOT NULL DEFAULT 0', dms: 'INTEGER NOT NULL DEFAULT 0', posts: 'INTEGER NOT NULL DEFAULT 0', refs: 'INTEGER NOT NULL DEFAULT 0' };
// Stage 3 columns added to leads (only if missing — never drops data).
const LEAD_COLUMNS = { email_step: 'INTEGER', email_status: 'TEXT', email_next_at: 'TEXT', email_last_at: 'TEXT', place_id: 'TEXT', reviews: 'INTEGER', tags: 'TEXT', next_action_at: 'TEXT', next_action: 'TEXT', source: 'TEXT', email: 'TEXT', website: 'TEXT', address: 'TEXT', rating: 'TEXT', heat: "TEXT DEFAULT 'cold'", emailed_at: 'TEXT', demo_views: 'INTEGER NOT NULL DEFAULT 0', demo_viewed_at: 'TEXT', call_notes: 'TEXT', instagram: 'TEXT', ig_checked_at: 'TEXT' };

// Stage 4 columns added to users: a daily goal (calls/day for reps, demos/day for devs).
const USER_COLUMNS = { daily_goal: 'INTEGER NOT NULL DEFAULT 0' };

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
  const newEmailCols = !lcols.has('email_status');
  for (const [name, type] of Object.entries(LEAD_COLUMNS)) {
    if (!lcols.has(name)) {
      try { await env.DB.prepare(`ALTER TABLE leads ADD COLUMN ${name} ${type}`).run(); }
      catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; }
    }
  }
  const ucols = new Set((await env.DB.prepare('PRAGMA table_info(users)').all()).results.map((c) => c.name));
  for (const [name, type] of Object.entries(USER_COLUMNS)) {
    if (!ucols.has(name)) {
      try { await env.DB.prepare(`ALTER TABLE users ADD COLUMN ${name} ${type}`).run(); }
      catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; }
    }
  }
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS demos_creator ON demos(created_by, created_at)').run();
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS ingest_log (id INTEGER PRIMARY KEY AUTOINCREMENT, key_id INTEGER, batch_id INTEGER, received INTEGER NOT NULL DEFAULT 0,
      inserted INTEGER NOT NULL DEFAULT 0, duplicates INTEGER NOT NULL DEFAULT 0, dnc INTEGER NOT NULL DEFAULT 0, invalid INTEGER NOT NULL DEFAULT 0,
      has_site INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS ingest_key_time ON ingest_log(key_id, created_at)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS saved_views (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, filters TEXT NOT NULL, created_at TEXT NOT NULL)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS leads_next ON leads(next_action_at)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS studio_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, lead_id INTEGER, theme TEXT, data TEXT NOT NULL DEFAULT '{}',
      messages TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS drafts_user ON studio_drafts(user_id, updated_at)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS finder_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, query TEXT, results INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS finder_time ON finder_log(created_at)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS cal_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'event',
      starts_at TEXT NOT NULL, ends_at TEXT, notes TEXT, lead_id INTEGER, link TEXT, created_at TEXT NOT NULL)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS cal_time ON cal_events(starts_at)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS demo_images (id TEXT PRIMARY KEY, user_id INTEGER, mime TEXT NOT NULL, data BLOB NOT NULL, prompt TEXT, created_at TEXT NOT NULL)`),
  ]);
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS leads_heat ON leads(heat)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS leads_email ON leads(email)').run();
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS email_log (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, step INTEGER, kind TEXT NOT NULL,
      subject TEXT, detail TEXT, created_at TEXT NOT NULL)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS email_log_time ON email_log(created_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS email_log_lead ON email_log(lead_id)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS leads_email_seq ON leads(email_status, email_next_at)'),
  ]);
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS dial_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, user_id INTEGER, to_number TEXT,
      call_sid TEXT, status TEXT NOT NULL DEFAULT 'started', duration INTEGER, recording_sid TEXT, recording_url TEXT, recording_seconds INTEGER, created_at TEXT NOT NULL, ended_at TEXT)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS dial_lead ON dial_calls(lead_id, id)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS dial_user ON dial_calls(user_id, id)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS cards_log (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, qty INTEGER NOT NULL, price_cents INTEGER NOT NULL DEFAULT 0, business TEXT, note TEXT, created_at TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS content_log (day TEXT NOT NULL, platform TEXT NOT NULL, type TEXT, created_at TEXT, PRIMARY KEY (day, platform))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS content_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, day TEXT NOT NULL, platform TEXT NOT NULL, format TEXT NOT NULL, topic TEXT, title TEXT, cal_id INTEGER, created_at TEXT)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS content_posts_day ON content_posts(day, id)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tracker_days (user_id INTEGER NOT NULL, day TEXT NOT NULL, blocks TEXT NOT NULL DEFAULT '[]',
      dials INTEGER NOT NULL DEFAULT 0, talks INTEGER NOT NULL DEFAULT 0, demos INTEGER NOT NULL DEFAULT 0, note TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, day))`),
  ]);
  try { await env.DB.prepare('ALTER TABLE finder_log ADD COLUMN provider TEXT').run(); }
  catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; }
  const tcols = new Set((await env.DB.prepare('PRAGMA table_info(tracker_days)').all()).results.map((c) => c.name));
  for (const [name, type] of Object.entries(TRACKER_COLUMNS)) {
    if (!tcols.has(name)) {
      try { await env.DB.prepare(`ALTER TABLE tracker_days ADD COLUMN ${name} ${type}`).run(); }
      catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; }
    }
  }
  if (newEmailCols) {
    // leads the first robot already emailed join the sequence at step 1, so they get follow-ups
    await env.DB.prepare(`UPDATE leads SET email_step = 1, email_last_at = emailed_at,
      email_status = CASE WHEN tags LIKE '%,opted-out,%' THEN 'opted_out' WHEN tags LIKE '%,replied,%' THEN 'replied' ELSE 'active' END,
      email_next_at = CASE WHEN tags LIKE '%,opted-out,%' OR tags LIKE '%,replied,%' THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', emailed_at, '+3 days') END
      WHERE emailed_at IS NOT NULL`).run();
  }
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

/* -------- personal tracker -------- */
const TRK_BLOCKS = ['pray', 'gym', 'reset', 'mind', 'prep', 'c1', 'rep', 'c2', 'lunch', 'c3', 'brk', 'aud', 'cont', 'close'];
const TRK_WINS = ['pray', 'gym', 'mind'];
function trkShift(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function trkDow(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function trkRow(r, day) {
  let blocks = [];
  try { blocks = JSON.parse(r && r.blocks || '[]').filter((b) => TRK_BLOCKS.includes(b)); } catch { /* keep empty */ }
  return { day, blocks, dials: r ? r.dials : 0, talks: r ? r.talks : 0, demos: r ? r.demos : 0, texts: r && r.texts || 0, dms: r && r.dms || 0, posts: r && r.posts || 0, refs: r && r.refs || 0, note: r && r.note || '' };
}
const trkKept = (r, goal) => !!r && r.dials >= goal && TRK_WINS.every((w) => r.blocks.includes(w));
// Sundays are the day off, so they never break a streak
function trkStreak(byDay, goal, today) {
  let streak = 0, d = today;
  for (let i = 0; i < 120; i++, d = trkShift(d, -1)) {
    if (trkDow(d) === 0) continue;
    if (trkKept(byDay.get(d), goal)) streak++;
    else if (d !== today) break;
  }
  return streak;
}
async function trkGoal(env) {
  const v = parseInt(await getSetting(env, 'tracker_goal'), 10);
  return v >= 1 && v <= 2000 ? v : 200;
}
async function trkLoad(env, userId, today) {
  const rows = (await env.DB.prepare('SELECT * FROM tracker_days WHERE user_id = ? AND day >= ? ORDER BY day').bind(userId, trkShift(today, -120)).all()).results;
  return new Map(rows.map((r) => [r.day, trkRow(r, r.day)]));
}

// add to today's tracker counters (used when a call outcome is logged in the CRM)
async function trkBump(env, userId, add) {
  const day = ptParts().date;
  await env.DB.prepare(`INSERT INTO tracker_days (user_id, day, blocks, dials, talks, demos, updated_at) VALUES (?,?,'[]',?,?,?,?)
    ON CONFLICT(user_id, day) DO UPDATE SET dials = dials + excluded.dials, talks = talks + excluded.talks, demos = demos + excluded.demos, updated_at = excluded.updated_at`)
    .bind(userId, day, add.dials || 0, add.talks || 0, add.demos || 0, now()).run();
}
const FOCUS_DEFAULT = 'med spa';
async function focusTerms(env) {
  const raw = (await getSetting(env, 'focus_niche')) ?? FOCUS_DEFAULT;
  const base = String(raw).toLowerCase().trim();
  if (!base) return [];
  const terms = new Set([base, base.replace(/\s+/g, '')]);
  if (/med(ical|i)?\s*spa/.test(base)) ['med spa', 'medspa', 'medical spa', 'medi spa', 'aesthetic', 'botox', 'injector', 'laser'].forEach((t) => terms.add(t));
  return [...terms].map((t) => t.replace(/[%_]/g, '')).filter(Boolean).slice(0, 12);
}
function focusSql(terms) {
  if (!terms.length) return { sql: '0', args: [] };
  const parts = [], args = [];
  for (const t of terms) { parts.push('(LOWER(COALESCE(l.category,\'\')) LIKE ? OR LOWER(l.business) LIKE ?)'); args.push('%' + t + '%', '%' + t + '%'); }
  return { sql: '(' + parts.join(' OR ') + ')', args };
}

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


/* ---- Lead Finder helpers ---- */

// Stays inside Google's free monthly allowance (1,000 Enterprise searches) with room to spare.
const FINDER_LIMITS = { day: 30, month: 900 };
// TomTom free tier: 2,500 requests a month. Each search uses 2 (find the city, then the businesses).
const TOMTOM_LIMITS = { day: 40, month: 1100 };
const bothKeys = (env) => !!(env.GOOGLE_PLACES_KEY && env.TOMTOM_KEY);
const finderProvider = (env) => (env.GOOGLE_PLACES_KEY ? 'google' : env.TOMTOM_KEY ? 'tomtom' : '');
// With both keys set, Google is used until it gets close to its free limit (switch at 850 of 1,000), then TomTom takes over.
const GOOGLE_SWITCH_AT = 850;
const finderBase = (env) => bothKeys(env) ? { day: FINDER_LIMITS.day + TOMTOM_LIMITS.day, month: GOOGLE_SWITCH_AT + TOMTOM_LIMITS.month }
  : (finderProvider(env) === 'tomtom' ? TOMTOM_LIMITS : FINDER_LIMITS);
// which provider the next search should use
function pickProvider(env, usage) {
  if (!bothKeys(env)) return finderProvider(env);
  return (usage.google || 0) >= GOOGLE_SWITCH_AT ? 'tomtom' : 'google';
}
// the monthly cap is the real guard (you can raise it in the bot settings); the daily cap just stops runaway loops
async function finderCaps(env) {
  const base = finderBase(env); let m = 0;
  try { m = parseInt(await getSetting(env, 'finder_month_cap'), 10) || 0; } catch { m = 0; }
  const month = m > 0 ? m : base.month;
  return { day: Math.max(base.day, 150), month, base_month: base.month };
}
const usPhone = (p) => { const d = normPhone(p); const t = d.length === 11 && d[0] === '1' ? d.slice(1) : d; return t.length === 10 ? `(${t.slice(0, 3)}) ${t.slice(3, 6)}-${t.slice(6)}` : String(p || ''); };
// Search TomTom and return results shaped like Google's, so the rest of the finder works the same.
async function tomtomSearch(env, what, where, offset) {
  const key = env.TOMTOM_KEY;
  let lat, lon;
  if (env.FINDER_FAKE === '1') { lat = 33.96; lon = -118.35; }
  else {
    const gr = await fetch('https://api.tomtom.com/search/2/geocode/' + encodeURIComponent(where) + '.json?limit=1&countrySet=US&key=' + encodeURIComponent(key));
    if (gr.status === 401 || gr.status === 403) throw new HttpError(400, 'TomTom rejected the key. Check TOMTOM_KEY in Cloudflare.');
    if (gr.status === 429) throw new HttpError(429, 'TomTom says too many requests. Try again in a minute.');
    const g = await gr.json().catch(() => ({}));
    const pos = g.results && g.results[0] && g.results[0].position;
    if (!pos) throw new HttpError(400, `Couldn't find "${where}". Try "City, CA".`);
    lat = pos.lat; lon = pos.lon;
  }
  let j;
  if (env.FINDER_FAKE === '1') {
    const mk = (i, name, url, phone, cat) => ({ id: 'TT' + i + 'o' + offset, poi: { name: name + (offset ? ' ' + offset : ''), phone, url, categories: [cat] }, address: { freeformAddress: (200 + i) + ' S Market St, Inglewood, CA 90301', streetNumber: String(200 + i), streetName: 'S Market St', municipality: 'Inglewood' } });
    j = { summary: { totalResults: 80 }, results: [mk(1, 'Paw Spa Mobile', undefined, '+1 310-555-0151', 'pet care'), mk(2, 'Lux Lashes LA', 'www.instagram.com/luxlashesla', '+1 310-555-0152', 'beauty salon'), mk(3, 'Big Real Site Co', 'www.bigrealsite.com', '+1 310-555-0153', 'barber'), mk(4, 'No Phone Nails', undefined, undefined, 'nail salon')] };
  } else {
    const r = await fetch('https://api.tomtom.com/search/2/poiSearch/' + encodeURIComponent(what) + '.json?limit=40&ofs=' + (offset || 0) + '&countrySet=US&radius=16000&lat=' + lat + '&lon=' + lon + '&key=' + encodeURIComponent(key));
    if (r.status === 401 || r.status === 403) throw new HttpError(400, 'TomTom rejected the key. Check TOMTOM_KEY in Cloudflare.');
    if (r.status === 429) throw new HttpError(429, 'TomTom says too many requests. Try again in a minute.');
    if (!r.ok) throw new HttpError(502, 'TomTom said ' + r.status);
    j = await r.json();
  }
  const places = (j.results || []).filter((x) => x.poi && x.poi.name).map((x) => {
    const a = x.address || {};
    let site = x.poi.url || '';
    if (site && !/^https?:\/\//i.test(site)) site = 'https://' + site;
    return {
      id: 'tt:' + x.id, displayName: { text: x.poi.name }, formattedAddress: a.freeformAddress || '',
      shortFormattedAddress: [[a.streetNumber, a.streetName].filter(Boolean).join(' '), a.municipality].filter(Boolean).join(', '),
      nationalPhoneNumber: x.poi.phone ? usPhone(x.poi.phone) : '', websiteUri: site, rating: null, userRatingCount: null,
      googleMapsUri: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(x.poi.name + ' ' + (a.freeformAddress || '')),
      primaryTypeDisplayName: { text: ((x.poi.categories || [])[0] || '').replace(/\b\w/g, (c) => c.toUpperCase()) },
    };
  });
  const total = (j.summary && j.summary.totalResults) || 0;
  const next = (offset || 0) + 40 < Math.min(total, 1000) ? String((offset || 0) + 40) : null;
  return { places, next };
}
async function finderUsage(env) {
  const d = new Date();
  const la = new Date(d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const dayStart = new Date(d.getTime() - ((la.getHours() * 60 + la.getMinutes()) * 60 + la.getSeconds()) * 1000).toISOString();
  const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  const r = await env.DB.prepare("SELECT SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS today, COUNT(*) AS month, SUM(CASE WHEN COALESCE(provider,'google')='google' THEN 1 ELSE 0 END) AS google, SUM(CASE WHEN provider='tomtom' THEN 1 ELSE 0 END) AS tomtom FROM finder_log WHERE created_at >= ?").bind(dayStart, monthStart).first();
  return { today: r.today || 0, month: r.month || 0, google: r.google || 0, tomtom: r.tomtom || 0 };
}
// Try the obvious web addresses for a business Google says has no website.
async function guessSite(name) {
  const words = String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length) return null;
  const full = words.join('');
  if (full.length < 4 || full.length > 40) return null;
  const key = words.find((w) => w.length >= 4 && !/^(the|and|shop|salon|studio|spa|llc|inc)$/.test(w)) || words[0];
  for (const domain of [full + '.com']) {
    try {
      const r = await fetch('https://' + domain, { redirect: 'follow', signal: AbortSignal.timeout(3500), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReekonCheck/1.0)' } });
      if (!r.ok) continue;
      const text = (await r.text()).slice(0, 60000).toLowerCase();
      if (/(domain|this website) (is|may be) for sale|buy this domain|parked free|domain parking|godaddy\.com\/domainsearch|sedo|hugedomains|dan\.com/.test(text)) continue;
      if (text.includes(key)) return 'https://' + domain;
    } catch { /* no site there */ }
  }
  return null;
}

// Find a business's Instagram from the links on its own website (no Instagram access needed).
const IG_RESERVED = /^(p|reel|reels|explore|accounts|tv|stories|share|about|legal|developer|direct|directory|web|privacy|terms|instagram|sharer)$/i;
function pickInstagram(html) {
  const seen = new Map();
  for (const m of String(html).matchAll(/instagram\.com\/(?:@)?([A-Za-z0-9._]{2,30})(?=[\/?"'#\s<)]|$)/gi)) {
    const h = m[1].replace(/\.+$/, '');
    if (!h || IG_RESERVED.test(h)) continue;
    seen.set(h.toLowerCase(), (seen.get(h.toLowerCase()) || 0) + 1);
  }
  let best = null; for (const [h, n] of seen) if (!best || n > best[1]) best = [h, n];
  return best ? best[0] : null;
}
async function enrichInstagram(env, limit = 20) {
  const rows = (await env.DB.prepare(`SELECT id, website FROM leads WHERE instagram IS NULL AND ig_checked_at IS NULL AND website IS NOT NULL AND website != ''
      AND website NOT LIKE '%facebook.com%' AND website NOT LIKE '%instagram.com%' ORDER BY id DESC LIMIT ?`).bind(limit).all()).results;
  let found = 0;
  for (const r of rows) {
    let handle = null;
    try {
      const u = /^https?:\/\//i.test(r.website) ? r.website : 'https://' + r.website;
      const res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(4000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReekonCheck/1.0)' } });
      if (res.ok) handle = pickInstagram((await res.text()).slice(0, 400000));
    } catch { /* site down or slow: skip */ }
    await env.DB.prepare('UPDATE leads SET instagram = ?, ig_checked_at = ? WHERE id = ?').bind(handle ? 'https://instagram.com/' + handle : null, now(), r.id).run();
    if (handle) found++;
  }
  return { checked: rows.length, found };
}

// Local testing only (FINDER_FAKE=1): a Google-shaped answer.
function fakePlaces(page) {
  const mk = (i, name, site, rating, n, phone, type) => ({ id: 'fake' + i + (page ? 'b' : ''), displayName: { text: name + (page ? ' II' : '') }, formattedAddress: (100 + i) + ' W Manchester Blvd, Inglewood, CA 90301, USA', shortFormattedAddress: (100 + i) + ' W Manchester Blvd, Inglewood',
    nationalPhoneNumber: phone, websiteUri: site, rating, userRatingCount: n, googleMapsUri: 'https://maps.google.com/?cid=' + i, primaryTypeDisplayName: { text: type }, businessStatus: 'OPERATIONAL' });
  const places = [
    mk(1, 'Kings Cutz', undefined, 4.9, 14, '(310) 555-0141', 'Barber shop'),
    mk(2, 'Big Al Barbers', 'https://www.instagram.com/bigal', 4.6, 38, '(310) 555-0142', 'Barber shop'),
    mk(3, 'Supreme Fades Lounge', 'https://supremefades.com', 4.8, 412, '(310) 555-0143', 'Barber shop'),
    mk(4, 'Fresh Cutz Barbershop', undefined, 4.8, 213, '(310) 555-0101', 'Barber shop'),
    mk(5, 'Line Up Kings', undefined, 5.0, 6, '(424) 555-0145', 'Barber shop'),
    mk(6, 'Old School Shave', undefined, 4.2, 22, undefined, 'Barber shop'),
  ];
  return { ok: true, status: 200, json: async () => ({ places, ...(page ? {} : { nextPageToken: 'page2' }) }) };
}

/* ---- shared lead import (CSV upload + scraper/n8n endpoint) ---- */
async function importRows(env, { batchId, rows, startStatus, assign, skipWithSite, source }) {
  rows = Array.isArray(rows) ? rows.slice(0, 500) : [];
  startStatus = startStatus === 'new' ? 'new' : 'demo_needed';
  skipWithSite = skipWithSite !== false;
  let loads = null, fixedRep = null;
  if (assign === 'auto') loads = await repLoads(env);
  else if (assign && assign !== 'none') {
    const r = await env.DB.prepare(`SELECT id FROM users WHERE id=? AND role IN ('rep','admin') AND active=1`).bind(+assign).first();
    if (!r) bad('That rep was not found');
    fixedRep = r.id;
  }
  const phones = rows.map((r) => normPhone(r && r.phone)).filter(Boolean);
  const emails = rows.map((r) => cleanEmail(r && r.email)).filter(Boolean);
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
    if (!r || typeof r !== 'object') { invalid++; continue; }
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
      `INSERT INTO leads (batch_id,business,owner,phone,phone_norm,city,category,link,status,assigned_to,created_at,updated_at,email,website,address,rating,heat,source,place_id,reviews)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'cold',?,?,?)`
    ).bind(batchId, business, str(r.owner, 120), str(r.phone, 40), pn, str(r.city, 80), str(r.category, 80), cleanUrl(r.link), startStatus, rep, t, t, em || null, site || null, str(r.address, 200) || null, str(r.rating, 20) || null, source || 'csv',
      str(r.place_id, 200) || null, r.reviews != null && r.reviews !== '' && Number.isFinite(+r.reviews) ? Math.round(+r.reviews) : null));
    inserted++;
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return { inserted, duplicates: dup, dnc: dncSkipped, invalid, hasSite };
}

// Scraper / n8n rows come with all kinds of column names. Map the common ones.
const INGEST_ALIASES = {
  business: ['business', 'businessname', 'name', 'title', 'company', 'companyname', 'place', 'placename'],
  owner: ['owner', 'ownername', 'contact', 'contactname'],
  phone: ['phone', 'phonenumber', 'telephone', 'tel', 'mobile', 'phoneunformatted', 'internationalphonenumber'],
  email: ['email', 'emailaddress', 'emails', 'mail'],
  website: ['website', 'site', 'web', 'websiteurl', 'domain'],
  address: ['address', 'street', 'fulladdress', 'streetaddress', 'formattedaddress'],
  city: ['city', 'town', 'locality'],
  category: ['category', 'categoryname', 'type', 'industry', 'niche', 'categories'],
  rating: ['rating', 'stars', 'totalscore', 'score'],
  link: ['link', 'url', 'mapsurl', 'googlemapsurl', 'placeurl', 'maps', 'googleurl'],
};
function normalizeIngestRow(r) {
  if (!r || typeof r !== 'object') return null;
  const flat = {};
  for (const [k, v] of Object.entries(r)) {
    let val = v;
    if (Array.isArray(val)) val = val[0];
    if (val && typeof val === 'object') continue;
    if (val === null || val === undefined) continue;
    flat[String(k).toLowerCase().replace(/[^a-z]/g, '')] = String(val);
  }
  const out = {};
  for (const [field, names] of Object.entries(INGEST_ALIASES)) for (const n of names) if (flat[n] && !out[field]) out[field] = flat[n];
  if (out.link && !/google\.|goo\.gl|maps\.app/i.test(out.link) && !out.website) { out.website = out.link; delete out.link; }
  return out;
}

async function sha256Hex(s) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))); }

/* ---- Email robot (Google Apps Script on the owner's Gmail) ----
   GET  /api/outreach/batch?limit=40  → leads with an email that were never emailed
   POST /api/outreach/sent    {ids}    → mark them emailed
   POST /api/outreach/replies {yes:[emails], no:[emails]} → yes = hot lead, no = never email again */
// a Facebook / Instagram / booking page doesn't count as a website
const SOCIAL_SQL = "(" + ['facebook.', 'fb.com', 'instagram.', 'linktr', 'yelp.', 'booksy.', 'vagaro.', 'styleseat.', 'square.site', 'squareup.', 'tiktok.', 'fresha.', 'glossgenius.', 'google.', 'g.page', 'business.site']
  .map((d) => "website LIKE '%" + d + "%'").join(' OR ') + ")";
async function keyAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const key = (/^Bearer\s+(\S+)$/i.exec(auth) || [])[1] || request.headers.get('X-Api-Key') || '';
  if (!/^rk_[a-f0-9]{40}$/.test(key)) throw new HttpError(401, 'Missing or invalid API key');
  const k = await env.DB.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL').bind(await sha256Hex(key)).first();
  if (!k) throw new HttpError(401, 'Missing or invalid API key');
  await env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(now(), k.id).run();
  return k;
}
// one Lead Finder search: used by the Lead Finder page and the auto lead bot
async function finderSearch(env, actorId, what, where, pageToken, siteChecks = 20) {
  const provider = pickProvider(env, await finderUsage(env));
  // a page token from the other provider can't be used here: start that search's first page instead
  if (provider === 'google' && pageToken && /^\d+$/.test(String(pageToken))) pageToken = undefined;
  let g = {};
  if (provider === 'tomtom') {
    await env.DB.prepare('INSERT INTO finder_log (user_id, query, results, created_at, provider) VALUES (?,?,?,?,?)').bind(actorId, what + ' | ' + where, 0, now(), 'tomtom').run();
    const t = await tomtomSearch(env, what, where, parseInt(pageToken, 10) || 0);
    g = { places: t.places, nextPageToken: t.next };
  } else {
  const r = env.FINDER_FAKE === '1' ? fakePlaces(pageToken) : await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': env.GOOGLE_PLACES_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.shortFormattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.googleMapsUri,places.primaryTypeDisplayName,places.businessStatus,nextPageToken' },
    body: JSON.stringify({ textQuery: what + ' in ' + where, pageSize: 20, ...(pageToken ? { pageToken } : {}) }),
  });
  await env.DB.prepare('INSERT INTO finder_log (user_id, query, results, created_at, provider) VALUES (?,?,?,?,?)').bind(actorId, what + ' | ' + where, 0, now(), 'google').run();
  try { g = await r.json(); } catch { g = {}; }
  if (!r.ok) {
    const msg = (g.error && g.error.message) || ('Google said ' + r.status);
    bad(/API key|not authorized|PERMISSION|billing/i.test(msg) ? 'Google rejected the key: ' + msg.slice(0, 160) + '. Check the setup steps.' : msg.slice(0, 200));
  }
  }
  const places = (g.places || []).filter((p) => !p.businessStatus || p.businessStatus === 'OPERATIONAL');
  // what's already in the CRM / on the Do Not Call list
  const phones = places.map((p) => normPhone(p.nationalPhoneNumber)).filter(Boolean);
  const ids = places.map((p) => p.id).filter(Boolean);
  const inCrm = new Set(), dnc = new Set(), idSeen = new Set();
  if (phones.length) {
    const q = phones.map(() => '?').join(',');
    (await env.DB.prepare(`SELECT phone_norm FROM leads WHERE phone_norm IN (${q})`).bind(...phones).all()).results.forEach((x) => inCrm.add(x.phone_norm));
    (await env.DB.prepare(`SELECT phone_norm FROM dnc WHERE phone_norm IN (${q})`).bind(...phones).all()).results.forEach((x) => dnc.add(x.phone_norm));
  }
  if (ids.length) (await env.DB.prepare(`SELECT place_id FROM leads WHERE place_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results.forEach((x) => idSeen.add(x.place_id));
  const out = places.map((p) => {
    const site = p.websiteUri || '';
    const pn = normPhone(p.nationalPhoneNumber);
    return {
      place_id: p.id, business: (p.displayName && p.displayName.text) || '', phone: p.nationalPhoneNumber || '', address: p.formattedAddress || '',
      short_address: p.shortFormattedAddress || '', category: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || '', rating: p.rating || null,
      reviews: p.userRatingCount == null ? null : p.userRatingCount, link: p.googleMapsUri || '', website: site,
      site_status: !site ? 'none' : NOT_A_SITE.test(site) ? 'social' : 'site',
      in_crm: (pn && inCrm.has(pn)) || idSeen.has(p.id), dnc: !!(pn && dnc.has(pn)),
    };
  });
  // double-check "no website" ones: try the obvious domain names
  const toCheck = out.filter((x) => x.site_status !== 'site' && !x.in_crm).slice(0, siteChecks);
  await Promise.all(toCheck.map(async (x) => { const f = await guessSite(x.business); if (f) { x.site_status = 'found'; x.found_site = f; } }));
  return { results: out, next: g.nextPageToken || null, provider };
}

/* ---- Auto lead bot: runs Lead Finder searches on its own every night ---- */
const AUTO_DEFAULTS = { enabled: false, niches: ['med spa', 'medical spa', 'botox clinic', 'aesthetics clinic', 'laser hair removal'], cities: ['Los Angeles, CA', 'Beverly Hills, CA', 'Santa Monica, CA', 'West Hollywood, CA', 'Culver City, CA', 'Pasadena, CA', 'Glendale, CA', 'Burbank, CA', 'Sherman Oaks, CA', 'Encino, CA', 'Woodland Hills, CA', 'Torrance, CA', 'Manhattan Beach, CA', 'Long Beach, CA', 'Irvine, CA'], per_night: 60, max_reviews: 5000, include_social: true, any_site: true, target_ready: 200, expand: true, purge_nonfocus: false };
async function autoConfig(env) {
  let c = {}; try { c = JSON.parse((await getSetting(env, 'auto_finder')) || '{}'); } catch { c = {}; }
  return { ...AUTO_DEFAULTS, ...c };
}
async function autoState(env) {
  let st = {}; try { st = JSON.parse((await getSetting(env, 'auto_finder_state')) || '{}'); } catch { st = {}; }
  return { i: 0, pages: {}, night: '', done_tonight: 0, runs: [], ...st };
}

// Cities the bot moves into on its own when the ones you picked run dry: LA area first, then the rest of California, then big metros in other states.
const EXPAND_CITIES = ['Hollywood, CA','Studio City, CA','Van Nuys, CA','Calabasas, CA','Malibu, CA','Marina del Rey, CA','El Segundo, CA','Redondo Beach, CA','Santa Clarita, CA','Pacific Palisades, CA','Brentwood, CA','Century City, CA','Downtown Los Angeles, CA','Inglewood, CA','Whittier, CA','Pomona, CA','West Covina, CA','Alhambra, CA','Arcadia, CA','Palmdale, CA','Lancaster, CA','Thousand Oaks, CA','Ventura, CA','Newport Beach, CA','Costa Mesa, CA','Huntington Beach, CA','Anaheim, CA','Orange, CA','Laguna Beach, CA','Mission Viejo, CA','Riverside, CA','Temecula, CA','Palm Springs, CA','San Diego, CA','La Jolla, CA','Carlsbad, CA','Encinitas, CA','Santa Barbara, CA','Bakersfield, CA','Fresno, CA','Sacramento, CA','San Jose, CA','San Francisco, CA','Oakland, CA','Walnut Creek, CA','Las Vegas, NV','Henderson, NV','Phoenix, AZ','Scottsdale, AZ','Tempe, AZ','Houston, TX','Dallas, TX','Austin, TX','San Antonio, TX','Plano, TX','Frisco, TX','Miami, FL','Fort Lauderdale, FL','Boca Raton, FL','Orlando, FL','Tampa, FL','Jacksonville, FL','Atlanta, GA','Charlotte, NC','Raleigh, NC','Nashville, TN','New York, NY','Brooklyn, NY','Long Island, NY','Newark, NJ','Philadelphia, PA','Boston, MA','Washington, DC','Chicago, IL','Denver, CO','Seattle, WA','Portland, OR','Salt Lake City, UT','Minneapolis, MN','Detroit, MI','Columbus, OH','Indianapolis, IN','Kansas City, MO','St. Louis, MO','Baltimore, MD','Oklahoma City, OK','New Orleans, LA','Louisville, KY','Memphis, TN','Birmingham, AL'];
const READY_STATUS = "('new','demo_needed','demo_ready')";
// fresh med-spa (focus) leads nobody has called yet: the stock the bot keeps topped up
async function readyStock(env) {
  const fx = focusSql(await focusTerms(env));
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM leads l WHERE ${fx.sql} AND l.status IN ${READY_STATUS} AND l.attempts = 0 AND COALESCE(l.phone_norm,'') != ''`).bind(...fx.args).first();
  return r.n || 0;
}
// leads outside the focus niche that nobody has touched: safe to delete
const PURGE_WHERE = (fxsql) => `NOT ${fxsql} AND l.status IN ${READY_STATUS} AND l.attempts = 0 AND l.callback_at IS NULL AND l.booked_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.lead_id = l.id) AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.lead_id = l.id)
  AND NOT EXISTS (SELECT 1 FROM demos m WHERE m.lead_id = l.id) AND COALESCE(l.call_notes,'') = '' AND COALESCE(l.instagram,'') = ''`;
async function purgeNonFocus(env, { dry } = {}) {
  const terms = await focusTerms(env);
  if (!terms.length) return { count: 0, sample: [], kept_touched: 0, removed: 0 };
  const fx = focusSql(terms);
  const cnt = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM leads l WHERE ${PURGE_WHERE(fx.sql)}`).bind(...fx.args).first()).n || 0;
  const all = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM leads l WHERE NOT ${fx.sql}`).bind(...fx.args).first()).n || 0;
  const sample = (await env.DB.prepare(`SELECT l.business, l.city, l.category FROM leads l WHERE ${PURGE_WHERE(fx.sql)} ORDER BY l.id DESC LIMIT 8`).bind(...fx.args).all()).results;
  if (dry) return { count: cnt, sample, kept_touched: Math.max(0, all - cnt), removed: 0 };
  let removed = 0;
  for (let i = 0; i < 40 && removed < cnt; i++) {
    const ids = (await env.DB.prepare(`SELECT l.id FROM leads l WHERE ${PURGE_WHERE(fx.sql)} LIMIT 80`).bind(...fx.args).all()).results.map((x) => x.id);
    if (!ids.length) break;
    const q = ids.map(() => '?').join(',');
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM calls WHERE lead_id IN (${q})`).bind(...ids),
      env.DB.prepare(`DELETE FROM email_log WHERE lead_id IN (${q})`).bind(...ids),
      env.DB.prepare(`DELETE FROM studio_drafts WHERE lead_id IN (${q})`).bind(...ids),
      env.DB.prepare(`DELETE FROM leads WHERE id IN (${q})`).bind(...ids),
    ]);
    removed += ids.length;
  }
  return { count: cnt, sample, kept_touched: Math.max(0, all - cnt), removed };
}
// run one search for the next niche + city in the rotation, add the good ones to the CRM
async function autoStep(env, { manual } = {}) {
  const cfg = await autoConfig(env), st = await autoState(env);
  st.expanded = Array.isArray(st.expanded) ? st.expanded : [];
  const cityList = [...new Set([...cfg.cities, ...st.expanded])];
  const combos = []; for (const c of cityList) for (const n of cfg.niches) combos.push([n, c]);
  if (!combos.length) return { skipped: 'Add at least one type of business and one city' };
  if (!finderProvider(env)) return { skipped: 'Lead Finder is not connected yet' };
  const night = ptParts().date;
  if (st.night !== night) { st.night = night; st.done_tonight = 0; }
  if (!manual && st.done_tonight >= cfg.per_night) return { skipped: 'done for tonight' };
  const LIM = await finderCaps(env), u = await finderUsage(env);
  // leave a few searches a day for you to use by hand
  if (u.today >= LIM.day - (manual ? 0 : 5) || u.month >= LIM.month) return { skipped: 'Free search limit reached for now' };
  // find the next combo that still has results
  let pick = null;
  for (let k = 0; k < combos.length; k++) {
    const idx = (st.i + k) % combos.length, key = combos[idx].join(' | ');
    if (st.pages[key] !== 'done') { pick = { idx, key, what: combos[idx][0], where: combos[idx][1] }; break; }
  }
  if (!pick) {
    // every search in these cities is used up: move into new cities by itself, or start another pass if there are none left
    const fresh = cfg.expand ? EXPAND_CITIES.filter((c) => !cityList.includes(c)).slice(0, 4) : [];
    if (fresh.length) {
      st.expanded.push(...fresh);
      const first = [cfg.niches[0], fresh[0]];
      st.i = combos.length;
      pick = { idx: combos.length, key: first.join(' | '), what: first[0], where: first[1] };
      combos.push(...fresh.flatMap((c) => cfg.niches.map((n) => [n, c])));
    } else { st.pages = {}; pick = { idx: 0, key: combos[0].join(' | '), what: combos[0][0], where: combos[0][1] }; }
  }
  const run = { at: now(), search: pick.what + ' in ' + pick.where, checked: 0, added: 0, error: null };
  try {
    const f = await finderSearch(env, 1, pick.what, pick.where, st.pages[pick.key] || undefined, cfg.any_site ? 0 : 6);
    run.checked = f.results.length;
    // any_site (med spas, gyms, insurance): keep businesses that already have a website, whatever their review count
    const keep = f.results.filter((x) => !x.in_crm && !x.dnc && x.phone && (cfg.any_site || x.site_status === 'none' || (cfg.include_social && x.site_status === 'social'))
      && (cfg.any_site || x.reviews == null || x.reviews <= cfg.max_reviews));
    if (keep.length) {
      const name = 'Auto lead bot · ' + new Date().toLocaleDateString('en-US', { timeZone: BOT_TZ, month: 'short', day: 'numeric' });
      let b = await env.DB.prepare('SELECT id FROM batches WHERE name = ? ORDER BY id DESC LIMIT 1').bind(name).first();
      if (!b) { const r = await env.DB.prepare('INSERT INTO batches (name, created_by, created_at) VALUES (?,?,?)').bind(name, 1, now()).run(); b = { id: r.meta.last_row_id }; }
      const city = pick.where.split(',')[0].trim();
      const rows = keep.map((p) => ({ business: p.business, phone: p.phone, address: p.address, city, category: p.category, rating: p.rating == null ? '' : String(p.rating),
        link: p.link, website: p.website, place_id: p.place_id, reviews: p.reviews }));
      const res = await importRows(env, { batchId: b.id, rows, startStatus: cfg.any_site ? 'new' : 'demo_needed', assign: 'auto', skipWithSite: false, source: 'finder' });
      run.added = res.inserted || 0;
    }
    st.pages[pick.key] = f.next || 'done';
    if (!f.next) st.i = (pick.idx + 1) % combos.length;
  } catch (e) {
    run.error = e instanceof HttpError ? e.message : 'Something went wrong';
    if (!(e instanceof HttpError)) console.error(e);
    st.i = (pick.idx + 1) % combos.length;
  }
  st.done_tonight++;
  st.runs = [run, ...(st.runs || [])].slice(0, 30);
  await setSetting(env, 'auto_finder_state', JSON.stringify(st));
  return { run };
}

// keep searching until enough fresh leads are ready (or a limit is hit)
async function autoFill(env, maxSteps = 3) {
  const cfg = await autoConfig(env);
  let stock = await readyStock(env), steps = 0, added = 0;
  while (steps < maxSteps && stock < cfg.target_ready) {
    const r = await autoStep(env);
    steps++;
    if (!r.run || r.skipped || r.run.error) break;
    stock += r.run.added; added += r.run.added;
  }
  return { stock, steps, added };
}

/* ================= Dialer (Twilio) =================
   The browser gets a short-lived token, Twilio asks /voice/twiml how to place
   the call, plays a recording notice to the person who answers, records both
   sides, and tells us when the call and recording are done. */
const dialerReady = (env) => !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_API_KEY && env.TWILIO_API_SECRET && env.TWILIO_TWIML_APP_SID && env.TWILIO_NUMBER);
const b64url = (bytes) => btoa(String.fromCharCode(...(bytes instanceof Uint8Array ? bytes : enc.encode(bytes)))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
async function twilioToken(env, identity) {
  const t = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' };
  const payload = { jti: env.TWILIO_API_KEY + '-' + t, iss: env.TWILIO_API_KEY, sub: env.TWILIO_ACCOUNT_SID, nbf: t - 5, exp: t + 3600,
    grants: { identity, voice: { outgoing: { application_sid: env.TWILIO_TWIML_APP_SID } } } };
  const data = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey('raw', enc.encode(env.TWILIO_API_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return data + '.' + b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data))));
}
// Twilio signs every webhook with your Auth Token; anything unsigned is rejected
async function twilioSigned(request, env, params) {
  const sig = request.headers.get('X-Twilio-Signature') || '';
  if (!sig || !env.TWILIO_AUTH_TOKEN) return false;
  const data = request.url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const key = await crypto.subtle.importKey('raw', enc.encode(env.TWILIO_AUTH_TOKEN), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const want = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)))));
  return safeEqual(want, sig);
}
const xml = (s) => new Response('<?xml version="1.0" encoding="UTF-8"?><Response>' + s + '</Response>', { headers: { 'Content-Type': 'text/xml; charset=utf-8' } });
const xmlEsc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const US_E164 = (p) => { const d = normPhone(p); return d.length === 10 && /^[2-9]/.test(d) ? '+1' + d : null; };
const RECORD_NOTICE = 'Hi, just so you know, this call may be recorded for quality and training.';
async function handleVoice(request, env, url) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!dialerReady(env)) return xml('<Say>The dialer is not set up yet.</Say><Hangup/>');
  const form = await request.formData(), params = {};
  for (const [k, v] of form.entries()) params[k] = String(v);
  if (!(await twilioSigned(request, env, params))) return new Response('Forbidden', { status: 403 });
  const path = url.pathname, origin = url.origin;
  if (path === '/voice/twiml') {
    const uid = +((/^client:user-(\d+)$/.exec(params.From || '') || [])[1]);
    const to = US_E164(params.To), leadId = +params.lead_id || null;
    if (!uid || !to) return xml('<Say>That number cannot be called from here.</Say><Hangup/>');
    const user = await env.DB.prepare("SELECT id, name, email, role FROM users WHERE id = ? AND active = 1 AND role IN ('admin','rep')").bind(uid).first();
    if (!user) return xml('<Hangup/>');
    if (leadId) {
      const lead = await env.DB.prepare('SELECT id, assigned_to, phone_norm FROM leads WHERE id = ?').bind(leadId).first();
      if (!lead || (user.role === 'rep' && lead.assigned_to !== user.id)) return xml('<Say>You do not have access to that lead.</Say><Hangup/>');
      if (await env.DB.prepare('SELECT 1 FROM dnc WHERE phone_norm = ?').bind(normPhone(to)).first()) return xml('<Say>This number is on your Do Not Call list.</Say><Hangup/>');
    }
    const r = await env.DB.prepare('INSERT INTO dial_calls (lead_id, user_id, to_number, call_sid, status, created_at) VALUES (?,?,?,?,?,?)').bind(leadId, uid, to, params.CallSid || null, 'ringing', now()).run();
    const id = r.meta.last_row_id;
    return xml(`<Dial callerId="${xmlEsc(env.TWILIO_NUMBER)}" timeout="30" answerOnBridge="true" record="record-from-answer-dual" recordingStatusCallback="${xmlEsc(origin + '/voice/recording?c=' + id)}" recordingStatusCallbackEvent="completed" action="${xmlEsc(origin + '/voice/done?c=' + id)}"><Number url="${xmlEsc(origin + '/voice/notice')}">${xmlEsc(to)}</Number></Dial>`);
  }
  if (path === '/voice/notice') return xml('<Say>' + xmlEsc(RECORD_NOTICE) + '</Say>');
  const cid = +url.searchParams.get('c');
  if (path === '/voice/done') {
    const st = str(params.DialCallStatus, 20) || 'completed';
    await env.DB.prepare('UPDATE dial_calls SET status = ?, duration = ?, ended_at = ? WHERE id = ?').bind(st, parseInt(params.DialCallDuration, 10) || 0, now(), cid).run();
    const c = await env.DB.prepare('SELECT lead_id FROM dial_calls WHERE id = ?').bind(cid).first();
    if (c && c.lead_id) await env.DB.prepare('UPDATE leads SET last_call_at = ?, updated_at = ? WHERE id = ?').bind(now(), now(), c.lead_id).run();
    return xml('');
  }
  if (path === '/voice/recording') {
    if (params.RecordingStatus && params.RecordingStatus !== 'completed') return xml('');
    await env.DB.prepare('UPDATE dial_calls SET recording_sid = ?, recording_url = ?, recording_seconds = ? WHERE id = ?')
      .bind(str(params.RecordingSid, 64), str(params.RecordingUrl, 300), parseInt(params.RecordingDuration, 10) || 0, cid).run();
    return xml('');
  }
  return new Response('Not found', { status: 404 });
}

/* ================= Email bot =================
   The CRM decides who gets emailed, what it says and when. A tiny Google
   Apps Script on the owner's Gmail asks /api/outreach/today every 30 min,
   sends what it's handed, reports back, and forwards new replies. */
const BOT_TZ = 'America/Los_Angeles';
const BOT_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const BOT_DEFAULTS = {
  enabled: false, daily_cap: 40, per_run: 8, days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], start_hour: 6, end_hour: 10,
  from_name: 'Marquise', company: 'Reekon Systems', address: '',
  steps: [
    { wait_days: 0, subject: 'Quick question about {business}',
      body: "Hey {first_name},\n\nI came across {business} and noticed you don't have a website yet. I build sites for local businesses in {city}, and I'd like to make you a free preview. No cost, no catch.\n\nI already started one for you here: {demo_link}\n\nIf you like it, we hop on a quick 20-minute call. If not, you'll never hear from me again.\n\nWant me to finish it up?" },
    { wait_days: 3, subject: 'Re: Quick question about {business}',
      body: "Hey {first_name}, bumping this up in case it got buried. I'm still happy to build {business} a free website preview.\n\nHere's the one I started: {demo_link}\n\nWant me to send the finished version?" },
    { wait_days: 4, subject: 'Re: Quick question about {business}',
      body: "Last one from me, {first_name}. If a website isn't a priority right now, no worries at all. If it ever is, just reply and I'll build your free preview." },
  ],
};
const NO_WORDS = /\b(stop|unsubscribe|remove me|take me off|not interested|no thanks|no thank you|don'?t (email|contact)|do not (email|contact)|leave me alone|wrong (person|email))\b/i;

async function botConfig(env) {
  let c = {};
  try { c = JSON.parse((await getSetting(env, 'email_bot')) || '{}'); } catch { c = {}; }
  const out = { ...BOT_DEFAULTS, ...c };
  out.steps = Array.isArray(c.steps) && c.steps.length ? c.steps : BOT_DEFAULTS.steps;
  return out;
}
function cleanBotConfig(b, cur) {
  const n = (v, lo, hi, d) => { const x = parseInt(v, 10); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; };
  const out = { ...cur };
  if (b.enabled !== undefined) out.enabled = !!b.enabled;
  if (b.daily_cap !== undefined) out.daily_cap = n(b.daily_cap, 1, 90, cur.daily_cap);
  if (b.per_run !== undefined) out.per_run = n(b.per_run, 1, 20, cur.per_run);
  if (b.start_hour !== undefined) out.start_hour = n(b.start_hour, 0, 23, cur.start_hour);
  if (b.end_hour !== undefined) out.end_hour = n(b.end_hour, 1, 24, cur.end_hour);
  if (out.end_hour <= out.start_hour) bad('The sending window has to end after it starts');
  if (Array.isArray(b.days)) { out.days = BOT_DAYS.filter((d) => b.days.includes(d)); if (!out.days.length) bad('Pick at least one day'); }
  if (b.from_name !== undefined) out.from_name = str(b.from_name, 60) || 'Marquise';
  if (b.company !== undefined) out.company = str(b.company, 80);
  if (b.address !== undefined) out.address = str(b.address, 200);
  if (Array.isArray(b.steps)) {
    const steps = b.steps.slice(0, 5).map((x, i) => ({
      wait_days: i === 0 ? 0 : n(x && x.wait_days, 1, 30, 3),
      subject: str(x && x.subject, 150), body: str(x && x.body, 4000),
    }));
    steps.forEach((x, i) => { if (!x.subject || !x.body) bad('Email ' + (i + 1) + ' needs a subject and a message'); });
    out.steps = steps;
  }
  if (out.enabled && !str(out.address)) bad('Add your mailing address first. The law requires it on cold emails.');
  return out;
}
function ptParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: BOT_TZ, weekday: 'short', hour: 'numeric', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { day: p.weekday.toLowerCase().slice(0, 3), hour: +p.hour % 24, date: `${p.year}-${p.month}-${p.day}` };
}
// UTC instant of midnight today in Pacific time
function ptMidnightIso() {
  const t = Date.now(), { date } = ptParts();
  for (let back = 0; back <= 26; back++) {
    const d = new Date(t - back * 3600e3); d.setUTCMinutes(0, 0, 0);
    if (ptParts(d).date !== date) return new Date(d.getTime() + 3600e3).toISOString();
  }
  return new Date(t - 864e5).toISOString();
}
function firstName(owner, business) {
  const o = str(owner, 80);
  if (!o || o.toLowerCase() === str(business, 200).toLowerCase() || /\b(llc|inc|shop|salon|studio|barber|nails|auto|detail)/i.test(o)) return 'there';
  const f = o.split(/\s+/)[0].replace(/[^A-Za-z'-]/g, '');
  return f ? f[0].toUpperCase() + f.slice(1).toLowerCase() : 'there';
}
function renderBotEmail(cfg, lead, stepIdx) {
  const st = cfg.steps[stepIdx];
  const vars = {
    business: lead.business || 'your business', first_name: firstName(lead.owner, lead.business), city: lead.city || 'your area',
    category: (lead.category || 'business').toLowerCase(), demo_link: lead.demo_url || '', my_name: cfg.from_name, company: cfg.company,
  };
  const fill = (t) => t.replace(/\{(\w+)\}/g, (all, k) => (k in vars ? vars[k] : all));
  // with no demo yet, drop any line that points to the demo link
  let body = st.body.split('\n').filter((line) => vars.demo_link || !line.includes('{demo_link}')).join('\n').replace(/\n{3,}/g, '\n\n');
  body = fill(body).trim();
  const sig = [cfg.from_name, cfg.company, cfg.address].filter(Boolean).join('\n');
  return { subject: fill(st.subject).trim(), body: body + '\n\n' + sig + '\n\nNot interested? Reply "stop" and I won\'t email you again.' };
}
// leads that can still be emailed at all
const BOT_ELIGIBLE = `l.email IS NOT NULL AND l.email != '' AND l.status NOT IN ('dnc','lost','won') AND COALESCE(l.heat,'cold') != 'dead'
  AND (l.tags IS NULL OR (l.tags NOT LIKE '%,opted-out,%' AND l.tags NOT LIKE '%,bounced,%'))`;
async function botQueue(env, cfg, limit, at = now()) {
  if (limit <= 0) return [];
  const site = SOCIAL_SQL.replace(/website/g, 'l.website');
  const cols = 'l.id, l.business, l.owner, l.email, l.city, l.category, l.demo_url, l.email_step, l.email_status';
  const queued = (await env.DB.prepare(`SELECT ${cols} FROM leads l WHERE ${BOT_ELIGIBLE} AND l.email_status = 'queued' ORDER BY l.updated_at ASC LIMIT ?`).bind(limit).all()).results;
  const follow = (await env.DB.prepare(`SELECT ${cols} FROM leads l WHERE ${BOT_ELIGIBLE} AND l.email_status = 'active'
    AND l.email_next_at IS NOT NULL AND l.email_next_at <= ? AND COALESCE(l.email_step,0) < ? ORDER BY l.email_next_at ASC LIMIT ?`).bind(at, cfg.steps.length, limit).all()).results;
  const fresh = (await env.DB.prepare(`SELECT ${cols} FROM leads l WHERE ${BOT_ELIGIBLE} AND l.emailed_at IS NULL AND (l.email_status IS NULL OR l.email_status = '')
    AND (l.website IS NULL OR l.website = '' OR ${site}) ORDER BY (l.demo_url IS NOT NULL AND l.demo_url != '') DESC, l.id ASC LIMIT ?`).bind(limit).all()).results;
  const seen = new Set(), out = [];
  for (const l of [...queued, ...follow, ...fresh]) {
    if (seen.has(l.email) || out.length >= limit) continue;
    seen.add(l.email);
    const step = Math.min(cfg.steps.length - 1, l.email_status === 'active' ? (l.email_step || 1) : 0);
    out.push({ ...l, step });
  }
  return out;
}
async function sentToday(env) {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM email_log WHERE kind = 'sent' AND created_at >= ?").bind(ptMidnightIso()).first()).n;
}
async function botMarkSent(env, leadId, stepIdx, subject, cfg) {
  const t = now(), next = stepIdx + 1;
  const done = next >= cfg.steps.length;
  const nextAt = done ? null : new Date(Date.now() + cfg.steps[next].wait_days * 864e5).toISOString();
  return [
    env.DB.prepare(`UPDATE leads SET email_step = ?, email_status = ?, email_next_at = ?, email_last_at = ?, emailed_at = COALESCE(emailed_at, ?), updated_at = ? WHERE id = ?`)
      .bind(next, done ? 'done' : 'active', nextAt, t, t, t, leadId),
    env.DB.prepare('INSERT INTO email_log (lead_id, step, kind, subject, created_at) VALUES (?,?,?,?,?)').bind(leadId, next, 'sent', str(subject, 150), t),
    env.DB.prepare("INSERT INTO calls (lead_id,user_id,outcome,from_status,to_status,created_at) SELECT id, 1, 'emailed', status, status, ? FROM leads WHERE id = ?").bind(t, leadId),
  ];
}
async function botHandleReplies(env, msgs, actor) {
  const t = now(), stmts = [], out = { hot: 0, opted_out: 0, bounced: 0, ignored: 0 };
  for (const mm of (Array.isArray(msgs) ? msgs : []).slice(0, 100)) {
    const isBounce = !!(mm && mm.bounce);
    const addr = cleanEmail(isBounce ? mm.bounce_for : mm && mm.from);
    if (!addr) { out.ignored++; continue; }
    const lead = await env.DB.prepare('SELECT id, email_status FROM leads WHERE email = ? AND emailed_at IS NOT NULL ORDER BY id DESC LIMIT 1').bind(addr).first();
    if (!lead) { out.ignored++; continue; }
    const text = str(mm.snippet, 600);
    if (isBounce) {
      out.bounced++;
      stmts.push(env.DB.prepare(`UPDATE leads SET email_status = 'bounced', email_next_at = NULL,
        tags = CASE WHEN tags IS NULL OR tags = '' THEN ',bounced,' WHEN tags LIKE '%,bounced,%' THEN tags ELSE tags || 'bounced,' END, updated_at = ? WHERE id = ?`).bind(t, lead.id));
      stmts.push(env.DB.prepare('INSERT INTO email_log (lead_id, kind, detail, created_at) VALUES (?,?,?,?)').bind(lead.id, 'bounced', 'Email address doesn\'t work', t));
      continue;
    }
    if (lead.email_status === 'replied' || lead.email_status === 'opted_out') { out.ignored++; continue; }
    const no = NO_WORDS.test(text) || NO_WORDS.test(str(mm.subject, 200));
    if (no) {
      out.opted_out++;
      stmts.push(env.DB.prepare(`UPDATE leads SET email_status = 'opted_out', email_next_at = NULL, heat = 'dead', status = CASE WHEN status IN ('won','dnc') THEN status ELSE 'lost' END,
        tags = CASE WHEN tags IS NULL OR tags = '' THEN ',opted-out,' WHEN tags LIKE '%,opted-out,%' THEN tags ELSE tags || 'opted-out,' END, updated_at = ? WHERE id = ?`).bind(t, lead.id));
    } else {
      out.hot++;
      stmts.push(env.DB.prepare(`UPDATE leads SET email_status = 'replied', email_next_at = NULL, heat = 'hot', next_action_at = ?, next_action = 'They replied to the email. Read it and send their demo or book the call',
        tags = CASE WHEN tags IS NULL OR tags = '' THEN ',replied,' WHEN tags LIKE '%,replied,%' THEN tags ELSE tags || 'replied,' END, updated_at = ? WHERE id = ?`).bind(t, t, lead.id));
    }
    stmts.push(env.DB.prepare('INSERT INTO email_log (lead_id, kind, subject, detail, created_at) VALUES (?,?,?,?,?)').bind(lead.id, no ? 'opted_out' : 'replied', str(mm.subject, 150), text, t));
    stmts.push(env.DB.prepare('INSERT INTO notes (lead_id,user_id,body,created_at) VALUES (?,?,?,?)').bind(lead.id, actor, (no ? 'Email reply (opted out): ' : 'Email reply: ') + (text || '(no text)'), t));
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return out;
}

async function handleOutreach(request, env, url) {
  const k = await keyAuth(request, env);
  const path = url.pathname.replace(/^\/api\/outreach/, '');
  const actor = k.created_by || 1;
  let body = {};
  if (request.method === 'POST') { try { body = JSON.parse((await request.text()) || '{}'); } catch { throw new HttpError(400, 'Body must be JSON'); } }
  if (path === '/today' && request.method === 'GET') {
    const cfg = await botConfig(env), pt = ptParts();
    await setSetting(env, 'email_bot_seen', now());
    const base = { enabled: cfg.enabled, from_name: cfg.from_name, messages: [] };
    if (!cfg.enabled) return json({ ...base, reason: 'paused' });
    if (!cfg.days.includes(pt.day)) return json({ ...base, reason: 'not a sending day' });
    if (pt.hour < cfg.start_hour || pt.hour >= cfg.end_hour) return json({ ...base, reason: 'outside the sending window' });
    const left = cfg.daily_cap - (await sentToday(env));
    if (left <= 0) return json({ ...base, reason: 'daily limit reached' });
    const runsLeft = Math.max(1, (cfg.end_hour - pt.hour) * 2);
    const n = Math.min(left, cfg.per_run, Math.max(1, Math.ceil(left / runsLeft) + 2));
    const list = await botQueue(env, cfg, n);
    return json({ ...base, messages: list.map((l) => ({ lead_id: l.id, step: l.step, to: l.email, ...renderBotEmail(cfg, l, l.step) })) });
  }
  if (path === '/done' && request.method === 'POST') {
    const cfg = await botConfig(env), items = (Array.isArray(body.items) ? body.items : []).slice(0, 50);
    let stmts = [], ok = 0, failed = 0;
    for (const it of items) {
      const id = +it.lead_id, step = Math.max(0, Math.min(cfg.steps.length - 1, +it.step || 0));
      if (!id) continue;
      if (it.ok) { ok++; stmts = stmts.concat(await botMarkSent(env, id, step, it.subject, cfg)); }
      else { failed++; stmts.push(env.DB.prepare('INSERT INTO email_log (lead_id, step, kind, detail, created_at) VALUES (?,?,?,?,?)').bind(id, step + 1, 'failed', str(it.error, 300) || 'Gmail could not send it', now())); }
    }
    for (let i = 0; i < stmts.length; i += 99) await env.DB.batch(stmts.slice(i, i + 99));
    return json({ ok: true, sent: ok, failed });
  }
  if (path === '/inbox' && request.method === 'POST') {
    return json({ ok: true, ...(await botHandleReplies(env, body.messages, actor)) });
  }
  if (path === '/batch' && request.method === 'GET') {
    // the new email bot replaces the first robot: once it's connected, the old one gets nothing
    const bot = await env.DB.prepare("SELECT id FROM api_keys WHERE name = 'Email bot' AND revoked_at IS NULL LIMIT 1").first();
    if (bot) return json({ leads: [], note: 'The Email bot in your CRM handles sending now. Delete this old script.' });
    const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit'), 10) || 40));
    const { results } = await env.DB.prepare(
      `SELECT id, business, owner, email, city, category FROM leads
       WHERE email IS NOT NULL AND email != '' AND emailed_at IS NULL
         AND status NOT IN ('dnc','lost','won') AND COALESCE(heat,'cold') != 'dead'
         AND (tags IS NULL OR tags NOT LIKE '%,opted-out,%')
         AND (website IS NULL OR website = '' OR ${SOCIAL_SQL})
       ORDER BY id ASC LIMIT ?`).bind(limit).all();
    return json({ leads: results });
  }
  if (path === '/sent' && request.method === 'POST') {
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Boolean).slice(0, 100);
    const t = now(), stmts = [];
    for (const id of ids) {
      stmts.push(env.DB.prepare("UPDATE leads SET emailed_at = ?, email_step = 1, email_status = 'active', email_last_at = ?, email_next_at = ?, updated_at = ? WHERE id = ? AND emailed_at IS NULL").bind(t, t, new Date(Date.now() + 3 * 864e5).toISOString(), t, id));
      stmts.push(env.DB.prepare("INSERT INTO calls (lead_id,user_id,outcome,from_status,to_status,created_at) SELECT id, ?, 'emailed', status, status, ? FROM leads WHERE id = ?").bind(actor, t, id));
    }
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    return json({ ok: true, marked: ids.length });
  }
  if (path === '/replies' && request.method === 'POST') {
    const clean = (a) => [...new Set((Array.isArray(a) ? a : []).map(cleanEmail).filter(Boolean))].slice(0, 200);
    const yes = clean(body.yes), no = clean(body.no), t = now(), stmts = [];
    for (const e of no) stmts.push(env.DB.prepare(`UPDATE leads SET heat = 'dead', status = CASE WHEN status IN ('won','dnc') THEN status ELSE 'lost' END,
      tags = CASE WHEN tags IS NULL OR tags = '' THEN ',opted-out,' WHEN tags LIKE '%,opted-out,%' THEN tags ELSE tags || 'opted-out,' END, email_status = 'opted_out', email_next_at = NULL, updated_at = ? WHERE email = ?`).bind(t, e));
    for (const e of yes) stmts.push(env.DB.prepare(`UPDATE leads SET heat = 'hot', next_action_at = ?, next_action = 'They replied to the email: send their demo / book the call',
      tags = CASE WHEN tags IS NULL OR tags = '' THEN ',replied,' WHEN tags LIKE '%,replied,%' THEN tags ELSE tags || 'replied,' END, email_status = 'replied', email_next_at = NULL, updated_at = ? WHERE email = ? AND COALESCE(heat,'cold') != 'dead'`).bind(t, t, e));
    for (const e of [...yes, ...no]) stmts.push(env.DB.prepare("INSERT INTO notes (lead_id,user_id,body,created_at) SELECT id, ?, ?, ? FROM leads WHERE email = ?").bind(actor, no.includes(e) ? 'Replied to the email: not interested. Will not be emailed again.' : 'Replied to the email. Check Gmail and follow up.', t, e));
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    return json({ ok: true, hot: yes.length, opted_out: no.length });
  }
  throw new HttpError(404, 'Not found');
}

async function handleIngest(request, env) {
  if (request.method !== 'POST') throw new HttpError(405, 'Send leads with POST');
  const auth = request.headers.get('Authorization') || '';
  const key = (/^Bearer\s+(\S+)$/i.exec(auth) || [])[1] || request.headers.get('X-Api-Key') || '';
  if (!/^rk_[a-f0-9]{40}$/.test(key)) throw new HttpError(401, 'Missing or invalid API key');
  const k = await env.DB.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL').bind(await sha256Hex(key)).first();
  if (!k) throw new HttpError(401, 'Missing or invalid API key');
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM ingest_log WHERE key_id = ? AND created_at > ?').bind(k.id, new Date(Date.now() - 3600e3).toISOString()).first();
  if (recent.n >= 120) throw new HttpError(429, 'Too many requests. Max 120 per hour per key.');
  const text = await request.text();
  if (text.length > 2_000_000) throw new HttpError(413, 'Too much data in one request. Send 500 leads or fewer at a time.');
  let body;
  try { body = JSON.parse(text); } catch { throw new HttpError(400, 'Body must be JSON'); }
  const list = Array.isArray(body) ? body : Array.isArray(body.leads) ? body.leads : Array.isArray(body.rows) ? body.rows : body && typeof body === 'object' && !Array.isArray(body) && (body.business || body.name || body.title) ? [body] : null;
  if (!list) throw new HttpError(400, 'Send {"leads": [ ... ]} or a list of leads');
  if (list.length > 500) throw new HttpError(413, 'Send 500 leads or fewer at a time');
  const opts = Array.isArray(body) ? {} : body;
  const day = new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric' });
  const batchName = str(opts.batch, 100) || (k.name + ' · ' + day);
  let batch = await env.DB.prepare('SELECT id FROM batches WHERE name = ? ORDER BY id DESC LIMIT 1').bind(batchName).first();
  if (!batch) {
    const r = await env.DB.prepare('INSERT INTO batches (name, created_by, created_at) VALUES (?,?,?)').bind(batchName, k.created_by, now()).run();
    batch = { id: r.meta.last_row_id };
  }
  const rows = list.map(normalizeIngestRow);
  const assign = opts.assign === 'none' ? 'none' : 'auto';
  let res, err = null;
  try {
    res = await importRows(env, { batchId: batch.id, rows, startStatus: opts.start_status === 'new' ? 'new' : 'demo_needed', assign, skipWithSite: opts.skip_with_site !== false, source: 'api' });
  } catch (e) { err = e instanceof HttpError ? e.message : 'Server error'; res = { inserted: 0, duplicates: 0, dnc: 0, invalid: 0, hasSite: 0 }; if (!(e instanceof HttpError)) console.error(e); }
  const t = now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO ingest_log (key_id, batch_id, received, inserted, duplicates, dnc, invalid, has_site, error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(k.id, batch.id, list.length, res.inserted, res.duplicates, res.dnc, res.invalid, res.hasSite, err, t),
    env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(t, k.id),
  ]);
  if (err) throw new HttpError(400, err);
  return json({ ok: true, batch: batchName, batch_id: batch.id, received: list.length, added: res.inserted, duplicates: res.duplicates, do_not_call: res.dnc, has_website: res.hasSite, invalid: res.invalid });
}

// shared lead filters (list + export)
function leadFilter(p, user) {
  const where = [], args = [];
  if (user.role === 'rep') { where.push('l.assigned_to = ?', "l.status != 'dnc'"); args.push(user.id); }
  const status = p.get('status');
  if (status === 'open') { where.push(`l.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`); args.push(...OPEN_STATUSES); }
  else if (status && STATUSES.includes(status)) { where.push('l.status = ?'); args.push(status); }
  else if (status && status.includes(',')) {
    const list = status.split(',').filter((x) => STATUSES.includes(x) && (user.role === 'admin' || x !== 'dnc'));
    if (!list.length) bad('Bad status');
    where.push(`l.status IN (${list.map(() => '?').join(',')})`); args.push(...list);
  }
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
  const tag = cleanTag(p.get('tag'));
  if (tag) { where.push('l.tags LIKE ?'); args.push('%,' + tag + ',%'); }
  if (p.get('due') === '1') { where.push('l.next_action_at IS NOT NULL AND l.next_action_at < ?'); args.push(validIso(p.get('due_before')) || now()); }
  if (['api', 'csv', 'finder'].includes(p.get('source'))) { where.push("COALESCE(l.source,'csv') = ?"); args.push(p.get('source')); }
  const q = str(p.get('q'), 80);
  if (q) {
    where.push('(l.business LIKE ? OR l.owner LIKE ? OR l.phone_norm LIKE ? OR l.category LIKE ? OR l.email LIKE ? OR l.tags LIKE ?)');
    const like = '%' + q.replace(/[%_]/g, '') + '%';
    const digits = normPhone(q);
    args.push(like, like, digits.length >= 4 ? '%' + digits + '%' : '§none§', like, like, like.toLowerCase());
  }
  return { w: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}
function cleanTag(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim().replace(/\s+/g, '-').slice(0, 30); }
function tagsToDb(list) {
  const tags = [...new Set((Array.isArray(list) ? list : []).map(cleanTag).filter(Boolean))].slice(0, 12);
  return tags.length ? ',' + tags.join(',') + ',' : null;
}
const tagsFromDb = (s) => String(s || '').split(',').filter(Boolean);
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
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
    const g = await env.DB.prepare('SELECT daily_goal FROM users WHERE id = ?').bind(user.id).first();
    return json({ id: user.id, name: user.name, email: user.email, role: user.role, daily_goal: (g && g.daily_goal) || 0 });
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
      `SELECT u.id, u.name, u.email, u.role, u.active, u.created_at, u.commission_pct, u.daily_goal,
        (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id AND l.status IN ('new','demo_needed','demo_ready','called','callback','booked','call2')) AS open_leads
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
    if (body.daily_goal !== undefined) {
      const g = Math.round(Number(body.daily_goal));
      if (!Number.isFinite(g) || g < 0 || g > 1000) bad('Daily goal must be a number from 0 to 1000');
      stmts.push(env.DB.prepare('UPDATE users SET daily_goal=? WHERE id=?').bind(g, id));
    }
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
    const tagRows = (await env.DB.prepare(`SELECT tags FROM leads WHERE tags IS NOT NULL${user.role === 'admin' ? '' : ' AND assigned_to = ?'} LIMIT 5000`).bind(...(user.role === 'admin' ? [] : [user.id])).all()).results;
    const tags = [...new Set(tagRows.flatMap((r) => tagsFromDb(r.tags)))].sort();
    return json({ reps, batches, cities: cities.map((c) => c.city), tags });
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
    const batch = await env.DB.prepare('SELECT id FROM batches WHERE id=?').bind(+m[1]).first();
    if (!batch) throw new HttpError(404, 'Batch not found');
    return json(await importRows(env, { batchId: batch.id, rows: body.rows, startStatus: body.startStatus, assign: body.assign, skipWithSite: body.skipWithSite, source: 'csv' }));
  }

  /* ---- leads ---- */
  if (path === '/leads' && method === 'GET') {
    need(user, 'admin', 'rep');
    const p = url.searchParams;
    let { w, args } = leadFilter(p, user);
    const fx = focusSql(await focusTerms(env));
    if (p.get('focus') === '1') { w = (w ? w + ' AND ' : 'WHERE ') + fx.sql; args = [...args, ...fx.args]; }
    const limit = Math.min(+p.get('limit') || 50, 200), offset = Math.max(+p.get('offset') || 0, 0);
    const SORTS = { business: 'l.business COLLATE NOCASE', city: 'l.city COLLATE NOCASE', status: 'l.status', last_call: 'l.last_call_at', next: 'l.next_action_at', added: 'l.id', rep: 'u.name' };
    const sortKey = SORTS[p.get('sort')], dir = p.get('dir') === 'desc' ? 'DESC' : 'ASC';
    const order = sortKey ? `ORDER BY ${sortKey} IS NULL, ${sortKey} ${dir}, l.id DESC` : `ORDER BY CASE WHEN ${fx.sql} THEN 0 ELSE 1 END, CASE COALESCE(l.heat,'cold') WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 WHEN 'cold' THEN 2 ELSE 3 END, CASE l.status WHEN 'callback' THEN 0 WHEN 'demo_ready' THEN 1 WHEN 'booked' THEN 2 WHEN 'called' THEN 3 ELSE 4 END, COALESCE(l.callback_at, l.updated_at) ASC, l.id ASC`;
    const orderArgs = sortKey ? [] : fx.args;
    const { results } = await env.DB.prepare(
      `SELECT l.id, l.business, l.owner, l.phone, l.city, l.category, l.status, l.callback_at, l.booked_at,
              l.attempts, l.last_call_at, l.demo_url, l.demo_sent, l.assigned_to, u.name AS rep_name,
              l.email, COALESCE(l.heat,'cold') AS heat, l.emailed_at, l.demo_views, l.demo_viewed_at, l.tags, l.next_action_at, l.next_action,
              l.rating, l.reviews, l.link, l.place_id, l.website, l.address, (${fx.sql}) AS focus
       FROM leads l LEFT JOIN users u ON u.id = l.assigned_to ${w} ${order} LIMIT ? OFFSET ?`
    ).bind(...fx.args, ...args, ...orderArgs, limit + 1, offset).all();
    const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM leads l ${w}`).bind(...args).first();
    return json({ leads: results.slice(0, limit).map((l) => ({ ...l, tags: tagsFromDb(l.tags) })), more: results.length > limit, total: total.n });
  }

  if (path === '/leads/board' && method === 'GET') {
    need(user, 'admin', 'rep');
    const p = new URLSearchParams(url.searchParams); p.set('status', 'all_board');
    const { w, args } = leadFilter(p, user);
    const base = w ? w + ' AND' : 'WHERE';
    const per = Math.min(+url.searchParams.get('per') || 40, 100);
    const fx = focusSql(await focusTerms(env));
    const out = [];
    for (const [key, label, list] of BOARD_STAGES) {
      const inList = `l.status IN (${list.map(() => '?').join(',')})`;
      const [rows, cnt] = await Promise.all([
        env.DB.prepare(`SELECT l.id, l.business, l.owner, l.phone, l.city, l.category, l.status, l.callback_at, l.booked_at, l.attempts, l.last_call_at, l.demo_url,
            l.assigned_to, u.name AS rep_name, l.email, COALESCE(l.heat,'cold') AS heat, l.emailed_at, l.next_action_at, l.next_action, l.updated_at,
            l.rating, l.reviews, l.link, l.place_id, l.address, (${fx.sql}) AS focus
          FROM leads l LEFT JOIN users u ON u.id = l.assigned_to ${base} ${inList}
          ORDER BY CASE WHEN ${fx.sql} THEN 0 ELSE 1 END, CASE COALESCE(l.heat,'cold') WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 WHEN 'cold' THEN 2 ELSE 3 END, COALESCE(l.callback_at, l.booked_at, l.updated_at) ${key === 'callback' || key === 'booked' ? 'ASC' : 'DESC'} LIMIT ?`)
          .bind(...fx.args, ...args, ...list, ...fx.args, per).all(),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM leads l ${base} ${inList}`).bind(...args, ...list).first(),
      ]);
      out.push({ key, label, count: cnt.n, leads: rows.results });
    }
    return json({ stages: out });
  }

  if (path === '/leads/export' && method === 'GET') {
    need(user, 'admin');
    const { w, args } = leadFilter(url.searchParams, user);
    const { results } = await env.DB.prepare(
      `SELECT l.id, l.business, l.owner, l.phone, l.email, l.website, l.address, l.city, l.category, l.rating, l.status, COALESCE(l.heat,'cold') AS heat, l.tags,
              u.name AS rep, l.attempts, l.last_call_at, l.next_action_at, l.next_action, l.demo_url, l.demo_views, l.emailed_at, l.link, b.name AS batch, COALESCE(l.source,'csv') AS source, l.created_at
       FROM leads l LEFT JOIN users u ON u.id = l.assigned_to LEFT JOIN batches b ON b.id = l.batch_id ${w} ORDER BY l.id LIMIT 20000`
    ).bind(...args).all();
    const cols = ['id', 'business', 'owner', 'phone', 'email', 'website', 'address', 'city', 'category', 'rating', 'status', 'heat', 'tags', 'rep', 'attempts', 'last_call_at', 'next_action_at', 'next_action', 'demo_url', 'demo_views', 'emailed_at', 'link', 'batch', 'source', 'created_at'];
    const lines = [cols.join(',')].concat(results.map((r) => cols.map((c) => csvCell(c === 'tags' ? tagsFromDb(r.tags).join(' ') : r[c])).join(',')));
    return new Response('\ufeff' + lines.join('\r\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="reekon-leads-' + now().slice(0, 10) + '.csv"', 'Cache-Control': 'no-store' } });
  }

  /* ---- saved views (per person) ---- */
  if (path === '/views' && method === 'GET') {
    need(user, 'admin', 'rep');
    const { results } = await env.DB.prepare('SELECT id, name, filters FROM saved_views WHERE user_id = ? ORDER BY id').bind(user.id).all();
    return json(results.map((v) => { let f = {}; try { f = JSON.parse(v.filters); } catch { /* ignore */ } return { id: v.id, name: v.name, filters: f }; }));
  }
  if (path === '/views' && method === 'POST') {
    need(user, 'admin', 'rep');
    const name = str(body.name, 40);
    if (!name) bad('Give the view a name');
    const allowed = ['status', 'rep', 'batch', 'city', 'q', 'heat', 'contact', 'tag', 'due', 'source'];
    const f = Object.fromEntries(allowed.filter((k) => body.filters && body.filters[k] !== undefined && body.filters[k] !== '').map((k) => [k, str(body.filters[k], 80)]));
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM saved_views WHERE user_id = ?').bind(user.id).first();
    if (n.n >= 20) bad('You can save up to 20 views');
    const r = await env.DB.prepare('INSERT INTO saved_views (user_id, name, filters, created_at) VALUES (?,?,?,?)').bind(user.id, name, JSON.stringify(f), now()).run();
    return json({ id: r.meta.last_row_id, name, filters: f });
  }
  if ((m = path.match(/^\/views\/(\d+)$/)) && method === 'DELETE') {
    need(user, 'admin', 'rep');
    await env.DB.prepare('DELETE FROM saved_views WHERE id = ? AND user_id = ?').bind(+m[1], user.id).run();
    return json({ ok: true });
  }

  /* ---- tags + next action (admin and the lead's rep) ---- */
  if ((m = path.match(/^\/leads\/(\d+)\/meta$/)) && method === 'POST') {
    need(user, 'admin', 'rep');
    const lead = await loadLead(env, user, +m[1]);
    const sets = [], args = [];
    if (body.tags !== undefined) { sets.push('tags = ?'); args.push(tagsToDb(body.tags)); }
    if (body.next_action_at !== undefined) {
      const v = body.next_action_at ? validIso(body.next_action_at) : null;
      if (body.next_action_at && !v) bad('Pick a valid date');
      sets.push('next_action_at = ?'); args.push(v);
    }
    if (body.next_action !== undefined) { sets.push('next_action = ?'); args.push(str(body.next_action, 140) || null); }
    if (body.instagram !== undefined) {
      let v = str(body.instagram, 200).trim();
      if (v) { v = v.replace(/^@/, ''); const m = v.match(/instagram\.com\/([A-Za-z0-9._]+)/i); v = m ? m[1] : v; if (!/^[A-Za-z0-9._]{1,30}$/.test(v)) bad('That does not look like an Instagram handle'); v = 'https://instagram.com/' + v; }
      sets.push('instagram = ?'); args.push(v || null);
    }
    if (body.call_notes !== undefined) { sets.push('call_notes = ?'); args.push(str(body.call_notes, 4000) || null); }
    if (!sets.length) return json({ ok: true });
    sets.push('updated_at = ?'); args.push(now());
    await env.DB.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).bind(...args, lead.id).run();
    return json({ ok: true });
  }

  /* ---- API keys + scraper log (admin) ---- */
  if (path === '/keys' && method === 'GET') {
    need(user, 'admin');
    const keys = (await env.DB.prepare(`SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at, u.name AS created_by_name,
        (SELECT COALESCE(SUM(inserted),0) FROM ingest_log i WHERE i.key_id = k.id) AS added
      FROM api_keys k LEFT JOIN users u ON u.id = k.created_by ORDER BY k.revoked_at IS NOT NULL, k.id DESC`).all()).results;
    const log = (await env.DB.prepare(`SELECT i.*, k.name AS key_name, b.name AS batch_name FROM ingest_log i LEFT JOIN api_keys k ON k.id = i.key_id LEFT JOIN batches b ON b.id = i.batch_id ORDER BY i.id DESC LIMIT 50`).all()).results;
    return json({ keys, log });
  }
  if (path === '/keys' && method === 'POST') {
    need(user, 'admin');
    const name = str(body.name, 40) || 'Scraper';
    const live = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL').first();
    if (live.n >= 10) bad('You have 10 active keys. Revoke one first.');
    const key = 'rk_' + hex(crypto.getRandomValues(new Uint8Array(20)));
    await env.DB.prepare('INSERT INTO api_keys (name, prefix, key_hash, created_by, created_at) VALUES (?,?,?,?,?)').bind(name, key.slice(0, 9), await sha256Hex(key), user.id, now()).run();
    return json({ name, key });
  }
  if ((m = path.match(/^\/keys\/(\d+)$/)) && method === 'DELETE') {
    need(user, 'admin');
    await env.DB.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(now(), +m[1]).run();
    return json({ ok: true });
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
    if (user.role === 'dev') return json({ lead: { ...lead, tags: tagsFromDb(lead.tags) }, calls: [], notes: [] });
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
    const demo = await env.DB.prepare('SELECT d.created_at, d.updated_at, d.views, d.theme, u.name AS by_name FROM demos d LEFT JOIN users u ON u.id = d.created_by WHERE d.lead_id = ? ORDER BY d.id DESC LIMIT 1').bind(lead.id).first();
    const dials = (await env.DB.prepare(`SELECT d.id, d.status, d.duration, d.recording_seconds, (d.recording_sid IS NOT NULL) AS has_recording, d.created_at, u.name AS rep_name
      FROM dial_calls d LEFT JOIN users u ON u.id = d.user_id WHERE d.lead_id = ? ${user.role === 'rep' ? 'AND d.user_id = ?' : ''} ORDER BY d.id DESC LIMIT 30`)
      .bind(...(user.role === 'rep' ? [lead.id, user.id] : [lead.id])).all()).results;
    return json({ lead: { ...lead, tags: tagsFromDb(lead.tags) }, calls, notes, deals, demo: demo || null, dials });
  }

  if ((m = path.match(/^\/leads\/(\d+)$/)) && method === 'PATCH') {
    need(user, 'admin', 'rep');
    const lead = await loadLead(env, user, +m[1]);
    if (user.role === 'rep') {
      const keys = Object.keys(body);
      if (keys.some((k) => k !== 'status') || !['new', 'called', 'callback', 'booked', 'call2', 'won', 'lost'].includes(body.status)) throw new HttpError(403, 'Reps can only move their leads between stages');
    }
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
    } else if (action === 'heat') {
      if (!HEATS.includes(body.heat)) bad('Pick hot, warm, cold or dead');
      for (const id of ids) stmts.push(env.DB.prepare('UPDATE leads SET heat=?, updated_at=? WHERE id=?').bind(body.heat, t, id));
    } else if (action === 'tag' || action === 'untag') {
      const tag = cleanTag(body.tag);
      if (!tag) bad('Type a tag');
      if (action === 'tag') for (const id of ids) stmts.push(env.DB.prepare(`UPDATE leads SET tags = CASE WHEN tags IS NULL OR tags = '' THEN ? WHEN tags LIKE ? THEN tags ELSE tags || ? END, updated_at=? WHERE id=?`).bind(',' + tag + ',', '%,' + tag + ',%', tag + ',', t, id));
      else for (const id of ids) stmts.push(env.DB.prepare(`UPDATE leads SET tags = NULLIF(REPLACE(tags, ?, ','), ','), updated_at=? WHERE id=?`).bind(',' + tag + ',', t, id));
    } else if (action === 'status') {
      if (!['new', 'demo_needed', 'lost'].includes(body.status)) bad('Bulk status can be New, Demo needed or Closed lost');
      for (const id of ids) stmts.push(env.DB.prepare(`UPDATE leads SET status=?, updated_at=? WHERE id=? AND status NOT IN ('won','dnc')`).bind(body.status, t, id));
    } else if (action === 'next_action') {
      const v = body.next_action_at ? validIso(body.next_action_at) : null;
      for (const id of ids) stmts.push(env.DB.prepare('UPDATE leads SET next_action_at=?, next_action=COALESCE(?, next_action), updated_at=? WHERE id=?').bind(v, str(body.next_action, 140) || null, t, id));
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
    const typed = str(body.note, 4000);
    const live = str(body.call_notes !== undefined ? body.call_notes : lead.call_notes, 4000);
    const note = [live, typed].filter(Boolean).join('\n\n');
    if (note) stmts.push(env.DB.prepare('INSERT INTO notes (lead_id,user_id,body,created_at) VALUES (?,?,?,?)').bind(lead.id, user.id, note.slice(0, 4000), t));
    if (live || lead.call_notes) stmts.push(env.DB.prepare('UPDATE leads SET call_notes = NULL WHERE id = ?').bind(lead.id));
    if (outcome === 'dnc' && lead.phone_norm) stmts.push(env.DB.prepare('INSERT OR IGNORE INTO dnc (phone_norm, lead_id, user_id, created_at) VALUES (?,?,?,?)').bind(lead.phone_norm, lead.id, user.id, t));
    await env.DB.batch(stmts);
    if (user.role === 'admin' && outcome !== 'demo_sent') {
      await trkBump(env, user.id, { dials: 1, talks: ['no_answer', 'voicemail'].includes(outcome) ? 0 : 1, demos: outcome === 'booked' ? 1 : 0 });
    }
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

  /* ---- dialer ---- */
  if (path === '/dialer' && method === 'GET') {
    need(user, 'admin', 'rep');
    return json({ ready: dialerReady(env), number: env.TWILIO_NUMBER || null });
  }
  if (path === '/dialer/token' && method === 'POST') {
    need(user, 'admin', 'rep');
    if (!dialerReady(env)) bad('The dialer is not set up yet');
    return json({ token: await twilioToken(env, 'user-' + user.id), identity: 'user-' + user.id });
  }
  if (path === '/recordings' && method === 'GET') {
    need(user, 'admin', 'rep');
    const p = url.searchParams, where = ['d.recording_sid IS NOT NULL'], args = [];
    if (user.role === 'rep') { where.push('d.user_id = ?'); args.push(user.id); }
    else if (p.get('rep')) { where.push('d.user_id = ?'); args.push(+p.get('rep')); }
    if (p.get('lead')) { where.push('d.lead_id = ?'); args.push(+p.get('lead')); }
    const { results } = await env.DB.prepare(`SELECT d.id, d.lead_id, d.user_id, d.to_number, d.status, d.duration, d.recording_seconds, d.created_at,
        l.business, l.status AS lead_status, u.name AS rep_name
      FROM dial_calls d LEFT JOIN leads l ON l.id = d.lead_id LEFT JOIN users u ON u.id = d.user_id WHERE ${where.join(' AND ')} ORDER BY d.id DESC LIMIT 100`).bind(...args).all();
    return json({ recordings: results, ready: dialerReady(env) });
  }
  if ((m = path.match(/^\/recordings\/(\d+)\/audio$/)) && method === 'GET') {
    need(user, 'admin', 'rep');
    const d = await env.DB.prepare('SELECT * FROM dial_calls WHERE id = ?').bind(+m[1]).first();
    if (!d || !d.recording_url || (user.role === 'rep' && d.user_id !== user.id)) throw new HttpError(404, 'Recording not found');
    const src = d.recording_url.replace(/\.(json|mp3|wav)$/, '') + '.mp3';
    if (!/^https:\/\/api\.twilio\.com\//.test(src)) throw new HttpError(404, 'Recording not found');
    const headers = { Authorization: 'Basic ' + btoa(env.TWILIO_ACCOUNT_SID + ':' + env.TWILIO_AUTH_TOKEN) };
    const range = request.headers.get('Range'); if (range) headers.Range = range;
    const r = await fetch(src, { headers });
    if (!r.ok && r.status !== 206) throw new HttpError(502, 'Twilio could not send the recording');
    const out = new Response(r.body, { status: r.status, headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=3600' } });
    for (const k of ['Content-Length', 'Content-Range', 'Accept-Ranges']) { const v = r.headers.get(k); if (v) out.headers.set(k, v); }
    return out;
  }

  /* ---- email bot (admin) ---- */
  if (path === '/emailbot' && method === 'GET') {
    need(user, 'admin');
    const cfg = await botConfig(env), since7 = new Date(Date.now() - 7 * 864e5).toISOString();
    const c = (sql, ...a) => env.DB.prepare(sql).bind(...a).first().then((r) => r.n);
    const [today, week, contacted, replied, opted, bounced, inSeq, ready, noEmail] = await Promise.all([
      sentToday(env),
      c("SELECT COUNT(*) AS n FROM email_log WHERE kind = 'sent' AND created_at >= ?", since7),
      c('SELECT COUNT(*) AS n FROM leads WHERE emailed_at IS NOT NULL'),
      c("SELECT COUNT(*) AS n FROM leads WHERE email_status = 'replied'"),
      c("SELECT COUNT(*) AS n FROM leads WHERE email_status = 'opted_out'"),
      c("SELECT COUNT(*) AS n FROM leads WHERE email_status = 'bounced'"),
      c("SELECT COUNT(*) AS n FROM leads WHERE email_status = 'active'"),
      c(`SELECT COUNT(*) AS n FROM leads l WHERE ${BOT_ELIGIBLE} AND l.emailed_at IS NULL AND (l.email_status IS NULL OR l.email_status IN ('','queued'))
        AND (l.email_status = 'queued' OR l.website IS NULL OR l.website = '' OR ${SOCIAL_SQL.replace(/website/g, 'l.website')})`),
      c("SELECT COUNT(*) AS n FROM leads WHERE (email IS NULL OR email = '') AND status NOT IN ('dnc','lost','won')"),
    ]);
    const next = (await botQueue(env, cfg, 12, new Date(Date.now() + 864e5).toISOString())).map((l) => ({ id: l.id, business: l.business, email: l.email, step: l.step, queued: l.email_status === 'queued', has_demo: !!l.demo_url }));
    const log = (await env.DB.prepare(`SELECT e.id, e.lead_id, e.step, e.kind, e.subject, e.detail, e.created_at, l.business FROM email_log e LEFT JOIN leads l ON l.id = e.lead_id ORDER BY e.id DESC LIMIT 40`).all()).results;
    const sample = await env.DB.prepare("SELECT id, business, owner, city, category, demo_url FROM leads WHERE email IS NOT NULL AND email != '' ORDER BY (demo_url IS NOT NULL) DESC, id DESC LIMIT 1").first();
    const key = await env.DB.prepare("SELECT name, prefix, last_used_at FROM api_keys WHERE revoked_at IS NULL AND name = 'Email bot' ORDER BY id DESC LIMIT 1").first();
    return json({ config: cfg, last_seen: await getSetting(env, 'email_bot_seen'), key: key || null, now_pt: ptParts(),
      stats: { today, week, contacted, replied, opted_out: opted, bounced, in_sequence: inSeq, ready, no_email: noEmail },
      next, log, sample: sample || { business: 'Kings Cutz', owner: 'Andre Williams', city: 'Inglewood', category: 'Barber shop', demo_url: 'https://example.com/d/kings-cutz' } });
  }
  if (path === '/emailbot' && method === 'PUT') {
    need(user, 'admin');
    const cfg = cleanBotConfig(body, await botConfig(env));
    await setSetting(env, 'email_bot', JSON.stringify(cfg));
    return json({ ok: true, config: cfg });
  }
  if (path === '/emailbot/preview' && method === 'POST') {
    need(user, 'admin');
    const cfg = cleanBotConfig({ steps: body.steps, from_name: body.from_name, company: body.company, address: body.address }, await botConfig(env));
    const lead = body.lead_id ? await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(+body.lead_id).first() : null;
    const sample = lead || { business: 'Kings Cutz', owner: 'Andre Williams', city: 'Inglewood', category: 'Barber shop', demo_url: body.no_demo ? '' : 'https://example.com/d/kings-cutz' };
    return json({ emails: cfg.steps.map((_, i) => renderBotEmail(cfg, sample, i)) });
  }
  if (path === '/emailbot/key' && method === 'POST') {
    need(user, 'admin');
    await env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE name = 'Email bot' AND revoked_at IS NULL").bind(now()).run();
    const live = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL').first();
    if (live.n >= 10) bad('You have 10 active keys. Revoke one on the Scraper & n8n page first.');
    const key = 'rk_' + hex(crypto.getRandomValues(new Uint8Array(20)));
    await env.DB.prepare('INSERT INTO api_keys (name, prefix, key_hash, created_by, created_at) VALUES (?,?,?,?,?)').bind('Email bot', key.slice(0, 9), await sha256Hex(key), user.id, now()).run();
    return json({ key, portal: url.origin });
  }
  if ((m = path.match(/^\/leads\/(\d+)\/emailbot$/)) && method === 'POST') {
    need(user, 'admin', 'rep');
    const lead = await loadLead(env, user, +m[1]);
    const t = now(), a = str(body.action, 10);
    if (a === 'queue') {
      if (!cleanEmail(lead.email)) bad('This lead has no email address');
      if (lead.email_status === 'opted_out' || /,opted-out,/.test(lead.tags || '')) bad('They asked not to be emailed');
      if (lead.email_status === 'active') await env.DB.prepare('UPDATE leads SET email_next_at = ?, updated_at = ? WHERE id = ?').bind(t, t, lead.id).run();
      else if (['done', 'replied', 'stopped', 'bounced'].includes(lead.email_status)) bad('Their emails are finished. Reach out by hand from the email box below.');
      else await env.DB.prepare("UPDATE leads SET email_status = 'queued', updated_at = ? WHERE id = ?").bind(t, lead.id).run();
    } else if (a === 'stop') {
      await env.DB.prepare("UPDATE leads SET email_status = 'stopped', email_next_at = NULL, updated_at = ? WHERE id = ?").bind(t, lead.id).run();
      await env.DB.prepare('INSERT INTO email_log (lead_id, kind, detail, created_at) VALUES (?,?,?,?)').bind(lead.id, 'stopped', 'Stopped by ' + user.name, t).run();
    } else if (a === 'resume') {
      if (lead.email_status !== 'stopped') bad('Only stopped emails can be resumed');
      const cfg = await botConfig(env), stepNext = lead.email_step || 0;
      if (!stepNext) await env.DB.prepare("UPDATE leads SET email_status = NULL, updated_at = ? WHERE id = ?").bind(t, lead.id).run();
      else if (stepNext >= cfg.steps.length) await env.DB.prepare("UPDATE leads SET email_status = 'done', updated_at = ? WHERE id = ?").bind(t, lead.id).run();
      else await env.DB.prepare("UPDATE leads SET email_status = 'active', email_next_at = ?, updated_at = ? WHERE id = ?").bind(new Date(Date.now() + 864e5).toISOString(), t, lead.id).run();
    } else bad('Unknown action');
    return json({ ok: true });
  }

  /* ---- settings (admin) ---- */
  if (path === '/settings' && method === 'GET') {
    need(user, 'admin');
    return json({ default_commission_pct: await defaultPct(env), packages: PACKAGES, focus_niche: (await getSetting(env, 'focus_niche')) ?? FOCUS_DEFAULT,
      goal: await trkGoal(env), push_start: (await getSetting(env, 'push_start')) || '2026-11-02', cards_total: parseInt(await getSetting(env, 'cards_total'), 10) || 50,
      gv_number: (await getSetting(env, 'gv_number')) || '', checklist: (await getSetting(env, 'setup_checklist')) || '{}',
      providers: { google_places: !!env.GOOGLE_PLACES_KEY, tomtom: !!env.TOMTOM_KEY, twilio: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN), finder_provider: finderProvider(env) || 'none' } });
  }
  if (path === '/settings' && method === 'PUT') {
    need(user, 'admin');
    if (body.default_commission_pct !== undefined) {
      const v = pctVal(body.default_commission_pct);
      if (v === null) bad('Enter a commission %');
      await setSetting(env, 'default_commission_pct', String(v));
    }
    if (body.focus_niche !== undefined) await setSetting(env, 'focus_niche', str(body.focus_niche, 40).toLowerCase());
    if (body.push_start !== undefined) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.push_start))) bad('Use a date like 2026-11-02'); await setSetting(env, 'push_start', String(body.push_start)); }
    if (body.cards_total !== undefined) await setSetting(env, 'cards_total', String(Math.max(0, Math.min(100000, parseInt(body.cards_total, 10) || 0))));
    if (body.gv_number !== undefined) await setSetting(env, 'gv_number', str(body.gv_number, 30));
    if (body.checklist !== undefined) await setSetting(env, 'setup_checklist', str(typeof body.checklist === 'string' ? body.checklist : JSON.stringify(body.checklist), 3000));
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

    const dfrom = validIso(p.get('dfrom')), duntil = validIso(p.get('duntil'));
    const [callsRow, dealsRow, board, days, pipe, owed, funnel, todayRow] = await Promise.all([
      env.DB.prepare(
        `SELECT SUM(CASE WHEN c.outcome IN (${CALL_OUTCOMES_SQL}) THEN 1 ELSE 0 END) AS calls,
                COUNT(DISTINCT CASE WHEN c.outcome = 'booked' THEN c.lead_id END) AS booked,
                COUNT(DISTINCT CASE WHEN c.outcome IN ('demo_sent','emailed') THEN c.lead_id END) AS demos_sent,
                SUM(CASE WHEN c.outcome = 'emailed' THEN 1 ELSE 0 END) AS emails
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
      env.DB.prepare(
        `SELECT COUNT(*) AS leads,
           SUM(CASE WHEN demo_url IS NOT NULL AND demo_url != '' THEN 1 ELSE 0 END) AS demo,
           SUM(CASE WHEN attempts > 0 OR emailed_at IS NOT NULL THEN 1 ELSE 0 END) AS contacted,
           SUM(CASE WHEN status IN ('booked','won') OR booked_at IS NOT NULL THEN 1 ELSE 0 END) AS booked,
           SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) AS won
         FROM leads WHERE status != 'dnc'${isAdmin ? '' : ' AND assigned_to = ?'}`
      ).bind(...me).first(),
      dfrom && duntil
        ? env.DB.prepare(`SELECT SUM(CASE WHEN outcome IN (${CALL_OUTCOMES_SQL}) THEN 1 ELSE 0 END) AS calls FROM calls WHERE user_id = ? AND created_at >= ? AND created_at < ?`).bind(user.id, dfrom, duntil).first()
        : null,
    ]);

    const leaderboard = board.results
      .filter((r) => (r.role === 'rep' && r.active) || r.calls || r.booked || r.closes)
      .map((r) => ({ id: r.id, name: r.name, calls: r.calls, booked: r.booked, closes: r.closes, ...(isAdmin ? { revenue_cents: r.revenue_cents } : {}), me: r.id === user.id }))
      .sort((a, b) => b.closes - a.closes || b.booked - a.booked || b.calls - a.calls || a.name.localeCompare(b.name));

    return json({
      scope: isAdmin ? 'team' : 'me',
      totals: {
        calls: callsRow.calls || 0, booked: callsRow.booked || 0, closes: dealsRow.closes || 0,
        demos_sent: callsRow.demos_sent || 0, emails: callsRow.emails || 0,
        ...(isAdmin ? { revenue_cents: dealsRow.revenue_cents } : { commission_cents: dealsRow.commission_cents }),
      },
      leaderboard,
      days: days.results,
      pipeline: Object.fromEntries(Object.entries(pipe || {}).map(([k, v]) => [k, v || 0])),
      owed_cents: owed.owed_cents || 0, owed_deals: owed.n || 0,
      funnel: Object.fromEntries(Object.entries(funnel || {}).map(([k, v]) => [k, v || 0])),
      today_calls: todayRow ? todayRow.calls || 0 : null,
    });
  }

  /* ---- Stage 4: team stats (admin) ---- */
  if (path === '/team' && method === 'GET') {
    need(user, 'admin');
    const p = url.searchParams;
    const until = validIso(p.get('until')) || now();
    const from = validIso(p.get('from')) || new Date(Date.now() - 864e5).toISOString();
    const dfrom = validIso(p.get('dfrom')) || from, duntil = validIso(p.get('duntil')) || until;
    const DIAL = `c.outcome IN (${CALL_OUTCOMES_SQL})`;
    const [users, calls, today, deals, demos] = await Promise.all([
      env.DB.prepare(`SELECT id, name, role, active, daily_goal FROM users ORDER BY name`).all(),
      env.DB.prepare(
        `SELECT c.user_id AS id, SUM(CASE WHEN ${DIAL} THEN 1 ELSE 0 END) AS calls,
           COUNT(DISTINCT CASE WHEN c.outcome = 'booked' THEN c.lead_id END) AS booked,
           SUM(CASE WHEN c.outcome = 'emailed' THEN 1 ELSE 0 END) AS emails,
           SUM(CASE WHEN c.outcome IN ('no_answer','voicemail','gatekeeper') THEN 1 ELSE 0 END) AS no_contact,
           MIN(CASE WHEN ${DIAL} THEN c.created_at END) AS first_call, MAX(CASE WHEN ${DIAL} THEN c.created_at END) AS last_call
         FROM calls c WHERE c.created_at >= ? AND c.created_at < ? GROUP BY c.user_id`).bind(from, until).all(),
      env.DB.prepare(
        `SELECT c.user_id AS id, SUM(CASE WHEN ${DIAL} THEN 1 ELSE 0 END) AS calls, MAX(CASE WHEN ${DIAL} THEN c.created_at END) AS last_call
         FROM calls c WHERE c.created_at >= ? AND c.created_at < ? GROUP BY c.user_id`).bind(dfrom, duntil).all(),
      env.DB.prepare(`SELECT rep_id AS id, COUNT(*) AS closes, COALESCE(SUM(amount_cents),0) AS revenue_cents FROM deals WHERE created_at >= ? AND created_at < ? GROUP BY rep_id`).bind(from, until).all(),
      env.DB.prepare(
        `SELECT d.created_by AS id, COUNT(*) AS demos,
           AVG((julianday(d.created_at) - julianday(l.created_at)) * 24) AS avg_hours,
           SUM(CASE WHEN d.created_at >= ? AND d.created_at < ? THEN 1 ELSE 0 END) AS demos_today
         FROM demos d LEFT JOIN leads l ON l.id = d.lead_id WHERE d.created_at >= ? AND d.created_at < ? GROUP BY d.created_by`).bind(dfrom, duntil, from, until).all(),
    ]);
    const by = (rows) => Object.fromEntries(rows.results.map((r) => [r.id, r]));
    const C = by(calls), T = by(today), D = by(deals), M = by(demos);
    const team = users.results.map((u) => {
      const c = C[u.id] || {}, t = T[u.id] || {}, d = D[u.id] || {}, m = M[u.id] || {};
      return { id: u.id, name: u.name, role: u.role, active: !!u.active, daily_goal: u.daily_goal || 0,
        calls: c.calls || 0, booked: c.booked || 0, emails: c.emails || 0, no_contact: c.no_contact || 0,
        first_call: c.first_call || null, last_call: c.last_call || null,
        closes: d.closes || 0, revenue_cents: d.revenue_cents || 0,
        today_calls: t.calls || 0, today_last_call: t.last_call || null,
        demos: m.demos || 0, demos_today: m.demos_today || 0, demo_avg_hours: m.avg_hours == null ? null : Math.round(m.avg_hours * 10) / 10 };
    }).filter((u) => u.active || u.calls || u.closes || u.demos);
    return json({ team });
  }

  if ((m = path.match(/^\/team\/(\d+)$/)) && method === 'GET') {
    need(user, 'admin');
    const p = url.searchParams;
    const until = validIso(p.get('until')) || now();
    const from = validIso(p.get('from')) || new Date(Date.now() - 864e5).toISOString();
    const since = validIso(p.get('since')) || new Date(Date.now() - 14 * 864e5).toISOString();
    const tz = Math.max(-840, Math.min(840, parseInt(p.get('tz'), 10) || 0));
    const shift = (tz >= 0 ? '+' : '') + tz + ' minutes';
    const u = await env.DB.prepare('SELECT id, name, email, role, active, daily_goal, commission_pct, created_at FROM users WHERE id = ?').bind(+m[1]).first();
    if (!u) throw new HttpError(404, 'User not found');
    const DIAL = `outcome IN (${CALL_OUTCOMES_SQL})`;
    const [daily, hourly, outcomes, deals, demos, recent, demoDaily] = await Promise.all([
      env.DB.prepare(
        `SELECT date(created_at, ?1) AS day, SUM(CASE WHEN ${DIAL} THEN 1 ELSE 0 END) AS calls,
           COUNT(DISTINCT CASE WHEN outcome = 'booked' THEN lead_id END) AS booked,
           SUM(CASE WHEN outcome = 'emailed' THEN 1 ELSE 0 END) AS emails,
           MIN(CASE WHEN ${DIAL} THEN created_at END) AS first_call, MAX(CASE WHEN ${DIAL} THEN created_at END) AS last_call
         FROM calls WHERE user_id = ?2 AND created_at >= ?3 GROUP BY day ORDER BY day`).bind(shift, u.id, since).all(),
      env.DB.prepare(
        `SELECT CAST(strftime('%H', created_at, ?1) AS INTEGER) AS hour, COUNT(*) AS calls
         FROM calls WHERE user_id = ?2 AND ${DIAL} AND created_at >= ?3 AND created_at < ?4 GROUP BY hour`).bind(shift, u.id, from, until).all(),
      env.DB.prepare(`SELECT outcome, COUNT(*) AS n FROM calls WHERE user_id = ? AND created_at >= ? AND created_at < ? AND outcome NOT IN ('status_change','demo_ready','closed_won') GROUP BY outcome ORDER BY n DESC`).bind(u.id, from, until).all(),
      env.DB.prepare(`SELECT d.id, d.amount_cents, d.commission_pct, d.paid, d.package, d.created_at, l.business, l.id AS lead_id FROM deals d LEFT JOIN leads l ON l.id = d.lead_id WHERE d.rep_id = ? AND d.created_at >= ? AND d.created_at < ? ORDER BY d.created_at DESC LIMIT 50`).bind(u.id, from, until).all(),
      env.DB.prepare(`SELECT d.slug, d.views, d.created_at, l.business, l.id AS lead_id, (julianday(d.created_at) - julianday(l.created_at)) * 24 AS hours FROM demos d LEFT JOIN leads l ON l.id = d.lead_id WHERE d.created_by = ? AND d.created_at >= ? AND d.created_at < ? ORDER BY d.created_at DESC LIMIT 50`).bind(u.id, from, until).all(),
      env.DB.prepare(`SELECT c.outcome, c.created_at, l.business, l.id AS lead_id FROM calls c LEFT JOIN leads l ON l.id = c.lead_id WHERE c.user_id = ? ORDER BY c.created_at DESC LIMIT 25`).bind(u.id).all(),
      env.DB.prepare(`SELECT date(created_at, ?1) AS day, COUNT(*) AS demos FROM demos WHERE created_by = ?2 AND created_at >= ?3 GROUP BY day`).bind(shift, u.id, since).all(),
    ]);
    return json({ user: { ...u, active: !!u.active }, daily: daily.results, hourly: hourly.results, outcomes: outcomes.results,
      deals: deals.results, demos: demos.results.map((d) => ({ ...d, hours: d.hours == null ? null : Math.round(d.hours * 10) / 10 })),
      recent: recent.results, demo_daily: demoDaily.results });
  }

  /* ---- Stage 4: live activity feed (admin) ---- */
  if (path === '/feed' && method === 'GET') {
    need(user, 'admin');
    const limit = Math.max(5, Math.min(100, parseInt(url.searchParams.get('limit'), 10) || 40));
    const { results } = await env.DB.prepare(
      `SELECT * FROM (
         SELECT 'call' AS kind, c.created_at AS t, c.outcome AS detail, u.name AS who, l.business AS biz, l.id AS lead_id FROM calls c LEFT JOIN users u ON u.id = c.user_id LEFT JOIN leads l ON l.id = c.lead_id
         UNION ALL SELECT 'note', n.created_at, substr(n.body, 1, 90), u.name, l.business, l.id FROM notes n LEFT JOIN users u ON u.id = n.user_id LEFT JOIN leads l ON l.id = n.lead_id
         UNION ALL SELECT 'deal', d.created_at, CAST(d.amount_cents AS TEXT), u.name, l.business, l.id FROM deals d LEFT JOIN users u ON u.id = d.rep_id LEFT JOIN leads l ON l.id = d.lead_id
         UNION ALL SELECT 'demo', dm.created_at, dm.theme, u.name, l.business, l.id FROM demos dm LEFT JOIN users u ON u.id = dm.created_by LEFT JOIN leads l ON l.id = dm.lead_id
         UNION ALL SELECT 'view', l.demo_viewed_at, CAST(l.demo_views AS TEXT), NULL, l.business, l.id FROM leads l WHERE l.demo_viewed_at IS NOT NULL
       ) ORDER BY t DESC LIMIT ?`
    ).bind(limit).all();
    return json({ feed: results });
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
      `SELECT d.id, d.lead_id, d.rep_id, d.amount_cents, d.commission_pct, d.paid, d.paid_at, d.note, d.package, d.created_at, d.mrr_cents,
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
      env.DB.prepare(`INSERT INTO deals (lead_id, rep_id, amount_cents, commission_pct, paid, paid_at, note, package, created_by, created_at, mrr_cents) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(lead.id, rep ? rep.id : null, amount, pct, paid, paid ? t : null, str(body.note, 1000), str(body.package, 60), user.id, t, body.mrr === undefined || body.mrr === '' || body.mrr === null ? 0 : centsVal(body.mrr)),
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
    if (body.mrr !== undefined) { sets.push('mrr_cents = ?'); args.push(body.mrr === '' || body.mrr === null ? 0 : centsVal(body.mrr)); }
    if (body.paid !== undefined) {
      sets.push('paid = ?', 'paid_at = ?'); args.push(body.paid ? 1 : 0, body.paid ? (deal.paid_at || now()) : null);
    }
    if (sets.length) await env.DB.prepare(`UPDATE deals SET ${sets.join(', ')} WHERE id = ?`).bind(...args, deal.id).run();
    return json({ ok: true });
  }

  /* ---- calendar ---- */
  const CAL_KINDS = ['event', 'audit', 'closing', 'demo', 'meeting', 'training', 'call', 'followup', 'posted'];
  if (path === '/calendar' && method === 'GET') {
    need(user, 'admin', 'rep');
    const from = validIso(url.searchParams.get('from')), until = validIso(url.searchParams.get('until'));
    if (!from || !until) bad('Missing date range');
    const ev = await env.DB.prepare(`SELECT e.id, e.title, e.kind, e.starts_at, e.ends_at, e.notes, e.lead_id, e.link, e.user_id, u.name AS owner_name, l.business AS lead_name
      FROM cal_events e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN leads l ON l.id = e.lead_id
      WHERE e.starts_at >= ? AND e.starts_at < ? ${user.role === 'rep' ? 'AND e.user_id = ?' : ''} ORDER BY e.starts_at ASC LIMIT 500`).bind(...[from, until].concat(user.role === 'rep' ? [user.id] : [])).all();
    const own = user.role === 'rep' ? 'AND l.assigned_to = ?' : '';
    const own2 = user.role === 'rep' ? [user.id] : [];
    const cb = await env.DB.prepare(`SELECT l.id, l.business, l.phone, l.status, l.callback_at AS at FROM leads l WHERE l.status = 'callback' AND l.callback_at >= ? AND l.callback_at < ? ${own} ORDER BY l.callback_at ASC LIMIT 300`).bind(from, until, ...own2).all();
    const bk = await env.DB.prepare(`SELECT l.id, l.business, l.phone, l.status, l.booked_at AS at FROM leads l WHERE l.status = 'booked' AND l.booked_at >= ? AND l.booked_at < ? ${own} ORDER BY l.booked_at ASC LIMIT 300`).bind(from, until, ...own2).all();
    return json({ events: ev.results, callbacks: cb.results, booked: bk.results });
  }
  if (path === '/calendar' && method === 'POST') {
    need(user, 'admin', 'rep');
    const title = str(body.title, 120), starts = validIso(body.starts_at);
    if (!title) bad('Give it a title');
    if (!starts) bad('Pick a date and time');
    const ends = body.ends_at ? validIso(body.ends_at) : null;
    if (body.ends_at && !ends) bad('That end time is not valid');
    if (ends && ends < starts) bad('The end is before the start');
    const kind = CAL_KINDS.includes(body.kind) ? body.kind : 'event';
    const leadId = body.lead_id ? +body.lead_id : null;
    if (leadId) await loadLead(env, user, leadId);
    const link = str(body.link, 300);
    if (link && !/^https?:\/\//i.test(link)) bad('The link must start with https://');
    const r = await env.DB.prepare('INSERT INTO cal_events (user_id, title, kind, starts_at, ends_at, notes, lead_id, link, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(user.id, title, kind, starts, ends, str(body.notes, 1000) || null, leadId, link || null, now()).run();
    return json({ ok: true, id: r.meta.last_row_id });
  }
  if ((m = path.match(/^\/calendar\/(\d+)$/)) && (method === 'PATCH' || method === 'DELETE')) {
    need(user, 'admin', 'rep');
    const ev = await env.DB.prepare('SELECT * FROM cal_events WHERE id = ?').bind(+m[1]).first();
    if (!ev || (user.role !== 'admin' && ev.user_id !== user.id)) throw new HttpError(404, 'Event not found');
    if (method === 'DELETE') { await env.DB.prepare('DELETE FROM cal_events WHERE id = ?').bind(ev.id).run(); return json({ ok: true }); }
    const sets = [], args = [];
    if (body.title !== undefined) { const t = str(body.title, 120); if (!t) bad('Give it a title'); sets.push('title = ?'); args.push(t); }
    if (body.kind !== undefined) { sets.push('kind = ?'); args.push(CAL_KINDS.includes(body.kind) ? body.kind : 'event'); }
    if (body.starts_at !== undefined) { const v = validIso(body.starts_at); if (!v) bad('Pick a date and time'); sets.push('starts_at = ?'); args.push(v); }
    if (body.ends_at !== undefined) { const v = body.ends_at ? validIso(body.ends_at) : null; if (body.ends_at && !v) bad('That end time is not valid'); sets.push('ends_at = ?'); args.push(v); }
    if (body.notes !== undefined) { sets.push('notes = ?'); args.push(str(body.notes, 1000) || null); }
    if (body.link !== undefined) { const l = str(body.link, 300); if (l && !/^https?:\/\//i.test(l)) bad('The link must start with https://'); sets.push('link = ?'); args.push(l || null); }
    if (sets.length) await env.DB.prepare(`UPDATE cal_events SET ${sets.join(', ')} WHERE id = ?`).bind(...args, ev.id).run();
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
    return json(await saveDemo(env, user, lead, body.theme, body.data || {}, url.origin));
  }

  /* ---- Lead Finder (Google Places) ---- */
  if (path === '/finder' && method === 'GET') {
    need(user, 'admin');
    { const u = await finderUsage(env); return json({ ready: !!finderProvider(env), provider: pickProvider(env, u), both: bothKeys(env), usage: u, limits: await finderCaps(env) }); }
  }
  if (path === '/finder/search' && method === 'POST') {
    need(user, 'admin');
    if (!finderProvider(env)) bad('Add your free TomTom key in Cloudflare first (see the setup steps on this page).');
    const LIM = await finderCaps(env), provider = pickProvider(env, await finderUsage(env));
    const what = str(body.what, 80), where = str(body.where, 80);
    if (!what || !where) bad('Type what kind of business and where');
    const u = await finderUsage(env);
    if (u.today >= LIM.day) bad(`You've hit today's ${LIM.day} searches. This cap keeps it free. It resets at midnight.`);
    if (u.month >= LIM.month) bad(`You've used this month's ${LIM.month} searches. It resets on the 1st (or raise the limit in the Auto lead bot settings).`);
    const f = await finderSearch(env, user.id, what, where, str(body.page_token, 600) || undefined);
    return json({ results: f.results, next_page_token: f.next, usage: await finderUsage(env), city: where, provider });
  }
  if (path === '/finder/auto' && method === 'GET') {
    need(user, 'admin');
    const cfg = await autoConfig(env), st = await autoState(env);
    const added7 = await env.DB.prepare("SELECT COUNT(*) AS n FROM leads l JOIN batches b ON b.id = l.batch_id WHERE b.name LIKE 'Auto lead bot%' AND l.created_at >= ?").bind(new Date(Date.now() - 7 * 864e5).toISOString()).first();
    return json({ config: cfg, runs: st.runs || [], done_tonight: st.night === ptParts().date ? st.done_tonight : 0, added_week: added7.n, ready: !!finderProvider(env), provider: finderProvider(env), both: bothKeys(env),
      stock: await readyStock(env), expanded: st.expanded || [], caps: await finderCaps(env), usage: await finderUsage(env) });
  }
  if (path === '/finder/auto' && method === 'PUT') {
    need(user, 'admin');
    const cur = await autoConfig(env), out = { ...cur };
    const list = (a, max) => [...new Set((Array.isArray(a) ? a : String(a || '').split(/[\n;]+/)).map((x) => str(x, 60)).filter(Boolean))].slice(0, max);
    if (body.enabled !== undefined) out.enabled = !!body.enabled;
    if (body.niches !== undefined) out.niches = list(body.niches, 15);
    if (body.cities !== undefined) out.cities = list(body.cities, 15);
    if (body.per_night !== undefined) out.per_night = Math.max(1, Math.min(150, parseInt(body.per_night, 10) || 60));
    if (body.target_ready !== undefined) out.target_ready = Math.max(10, Math.min(2000, parseInt(body.target_ready, 10) || 200));
    if (body.expand !== undefined) out.expand = !!body.expand;
    if (body.purge_nonfocus !== undefined) out.purge_nonfocus = !!body.purge_nonfocus;
    if (body.month_cap !== undefined) await setSetting(env, 'finder_month_cap', String(Math.max(0, Math.min(50000, parseInt(body.month_cap, 10) || 0))));
    if (body.max_reviews !== undefined) out.max_reviews = Math.max(0, Math.min(5000, parseInt(body.max_reviews, 10) || 50));
    if (body.include_social !== undefined) out.include_social = !!body.include_social;
    if (body.any_site !== undefined) out.any_site = !!body.any_site;
    if (out.enabled && (!out.niches.length || !out.cities.length)) bad('Add at least one type of business and one city');
    await setSetting(env, 'auto_finder', JSON.stringify(out));
    return json({ ok: true, config: out });
  }

  if (path === '/leads/cleanup' && method === 'POST') {
    need(user, 'admin');
    return json(await purgeNonFocus(env, { dry: !body.confirm }));
  }

  /* ---- next lead to dial (call mode) ---- */
  if (path === '/leads/next' && method === 'GET') {
    need(user, 'admin', 'rep');
    const cur = +url.searchParams.get('after') || 0;
    const fx = focusSql(await focusTerms(env));
    const t = now(), recent = new Date(Date.now() - 4 * 3600e3).toISOString();
    const who = user.role === 'rep' ? 'AND l.assigned_to = ?' : '';
    const row = await env.DB.prepare(
      `SELECT l.id FROM leads l WHERE l.id != ? AND l.phone_norm IS NOT NULL AND l.phone_norm != ''
         AND l.status IN ('new','demo_needed','demo_ready','called','callback') AND (l.status != 'callback' OR l.callback_at <= ?)
         AND (l.last_call_at IS NULL OR l.last_call_at < ?) ${who}
       ORDER BY CASE WHEN l.status = 'callback' THEN 0 ELSE 1 END, CASE WHEN ${fx.sql} THEN 0 ELSE 1 END,
         CASE COALESCE(l.heat,'cold') WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 WHEN 'cold' THEN 2 ELSE 3 END, l.attempts ASC, l.id ASC LIMIT 1`
    ).bind(cur, t, recent, ...(user.role === 'rep' ? [user.id] : []), ...fx.args).first();
    return json({ id: row ? row.id : null });
  }

  /* ---- everything-on-one-page overview (admin home) ---- */
  if (path === '/overview' && method === 'GET') {
    need(user, 'admin');
    const today = ptParts().date, pt = ptParts();
    const goal = await trkGoal(env), byDay = await trkLoad(env, user.id, today);
    const start = (await getSetting(env, 'push_start')) || '2026-11-02';
    const dayN = Math.max(1, Math.floor((Date.parse(today) - Date.parse(start)) / 864e5) + 1);
    const days = []; for (let i = 13; i >= 0; i--) days.push(trkShift(today, -i));
    const ptDate = (iso) => ptParts(new Date(iso)).date;
    const fx = focusSql(await focusTerms(env));
    const since14 = new Date(Date.now() - 16 * 864e5).toISOString();
    const [statusRows, focusRows, newLeads, emailRows, emailLead, dealRows, sinceCalls] = await Promise.all([
      env.DB.prepare("SELECT status, COUNT(*) AS n FROM leads GROUP BY status").all(),
      env.DB.prepare(`SELECT l.status AS status, COUNT(*) AS n FROM leads l WHERE ${fx.sql} GROUP BY l.status`).bind(...fx.args).all(),
      env.DB.prepare('SELECT created_at, source FROM leads WHERE created_at >= ?').bind(since14).all(),
      env.DB.prepare('SELECT kind, created_at FROM email_log WHERE created_at >= ?').bind(since14).all(),
      env.DB.prepare("SELECT SUM(CASE WHEN email_status = 'active' THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN email IS NOT NULL AND email != '' AND emailed_at IS NULL THEN 1 ELSE 0 END) AS unemailed, SUM(CASE WHEN email IS NOT NULL AND email != '' THEN 1 ELSE 0 END) AS with_email FROM leads").first(),
      env.DB.prepare('SELECT amount_cents, mrr_cents, created_at FROM deals').all(),
      env.DB.prepare("SELECT created_at, outcome, to_status FROM calls WHERE created_at >= ?").bind(since14).all(),
    ]);
    const st = Object.fromEntries(statusRows.results.map((r) => [r.status, r.n]));
    const fst = Object.fromEntries(focusRows.results.map((r) => [r.status, r.n]));
    const OPENF = ['new', 'demo_needed', 'demo_ready'];
    const sum = (o, keys) => keys.reduce((a, k) => a + (o[k] || 0), 0);
    // per-day series
    const series = (key) => days.map((d) => (byDay.get(d) || trkRow(null, d))[key] || 0);
    const dialsDay = series('dials'), talksDay = series('talks'), demosDay = series('demos');
    const perDay = (rows, pick) => { const m = Object.fromEntries(days.map((d) => [d, 0])); for (const r of rows) { const d = ptDate(r.created_at); if (d in m && (!pick || pick(r))) m[d]++; } return days.map((d) => m[d]); };
    const emailSeries = { sent: perDay(emailRows.results, (r) => r.kind === 'sent'), replied: perDay(emailRows.results, (r) => r.kind === 'replied'), bounced: perDay(emailRows.results, (r) => r.kind === 'bounced') };
    const eKind = (k) => emailRows.results.filter((r) => r.kind === k).length;
    const sent14 = eKind('sent'), replied14 = eKind('replied');
    const supply = perDay(newLeads.results);
    // revenue
    const monthKey = (iso) => ptDate(iso).slice(0, 7), thisMonth = today.slice(0, 7);
    const months = []; { let [y, m] = today.split('-').map(Number); for (let i = 5; i >= 0; i--) { const dt = new Date(Date.UTC(y, m - 1 - i, 1)); months.push(dt.toISOString().slice(0, 7)); } }
    const rev = Object.fromEntries(months.map((k) => [k, { setup: 0, mrr: 0 }]));
    let mrrTotal = 0, setupTotal = 0;
    for (const d of dealRows.results) {
      mrrTotal += d.mrr_cents || 0; setupTotal += d.amount_cents || 0;
      const k = monthKey(d.created_at); if (rev[k]) { rev[k].setup += d.amount_cents || 0; rev[k].mrr += d.mrr_cents || 0; }
    }
    // today / week rollups
    const tdy = byDay.get(today) || trkRow(null, today);
    const last7 = days.slice(-7), tot = (key, ds) => ds.reduce((a, d) => a + ((byDay.get(d) || {})[key] || 0), 0);
    const workDays7 = last7.filter((d) => trkDow(d) !== 0 && d <= today);
    const dials7 = tot('dials', last7), talks7 = tot('talks', last7), demos7 = tot('demos', last7);
    const avg7 = workDays7.length ? Math.round(dials7 / workDays7.length) : 0;
    const texts7 = tot('texts', last7), dms7 = tot('dms', last7), posts7 = tot('posts', last7), refs7 = tot('refs', last7);
    const hoursIn = Math.max(0, Math.min(12, pt.hour - 6)), expectedNow = trkDow(today) === 0 ? 0 : Math.round(goal * hoursIn / 12);
    const wonN = st.won || 0, focusOpen = sum(fst, OPENF), focusAll = Object.values(fst).reduce((a, b) => a + b, 0);
    const daysOfLeads = goal ? Math.floor(focusOpen / goal * 10) / 10 : 0;
    // honest reality check
    const check = [];
    const add = (level, text) => check.push({ level, text });
    if (trkDow(today) !== 0 && pt.hour >= 9 && tdy.dials < expectedNow * 0.6) add('bad', `${tdy.dials} dials so far — at this hour you should be near ${expectedNow}. You're behind pace.`);
    else if (trkDow(today) !== 0 && tdy.dials >= goal) add('good', `You hit ${goal} dials today. That's the whole game.`);
    if (workDays7.length >= 3 && avg7 < goal * 0.75) add('bad', `Your 7-day average is ${avg7} dials/day against a goal of ${goal}. The formula can't be proven at that volume.`);
    else if (workDays7.length >= 3 && avg7 >= goal) add('good', `7-day average is ${avg7} dials/day. Volume is on target.`);
    if (dayN >= 4 && demos7 === 0) add('bad', `Zero audits booked in the last 7 days. Dials without bookings means the opener or the list needs work.`);
    else if (dials7 >= 50 && talks7 > 0 && demos7 / talks7 < 0.1) add('warn', `Only ${demos7} audit${demos7 === 1 ? '' : 's'} from ${talks7} conversations (${Math.round(100 * demos7 / talks7)}%). Tighten the first 20 seconds of the call.`);
    if (dials7 >= 30 && talks7 / dials7 < 0.05) add('warn', `Pick-up rate is ${Math.round(100 * talks7 / dials7)}%. Try calling med spas 10–12 and 2–4, when the front desk is quieter.`);
    if (setupTotal === 0 && dayN >= 7) add('bad', `No revenue yet and you're on day ${dayN} of 30. Every day without a booked audit makes day 30 harder.`);
    if (focusOpen < goal * 2) add('warn', `Only ${focusOpen} fresh ${(await getSetting(env, 'focus_niche')) || FOCUS_DEFAULT} leads left — ${daysOfLeads < 1 ? 'less than a day' : 'about ' + daysOfLeads + ' days'} of dialing. Turn on the lead bot or run the Lead Finder.`);
    if (sent14 >= 20 && replied14 === 0) add('warn', `${sent14} cold emails sent in 14 days and no replies. The email isn't your channel yet — the phone is.`);
    if (posts7 === 0 && dayN >= 3) add('warn', 'No content posted in 7 days. Log your posts on the tracker so this stays honest.');
    if (!check.length) add('good', 'Nothing alarming. Keep stacking dials.');
    return json({
      today, day_n: dayN, goal, focus_niche: (await getSetting(env, 'focus_niche')) ?? FOCUS_DEFAULT,
      calls: { days, dials: dialsDay, talks: talksDay, demos: demosDay, today: tdy.dials, dials7, talks7, demos7, avg7, expected_now: expectedNow },
      funnel: { new: sum(st, OPENF), called: st.called || 0, callback: st.callback || 0, booked: st.booked || 0, call2: st.call2 || 0, won: wonN, lost: st.lost || 0, focus_open: focusOpen, focus_total: focusAll, total: Object.values(st).reduce((a, b) => a + b, 0) },
      revenue: { months, setup: months.map((k) => rev[k].setup), mrr: months.map((k) => rev[k].mrr), mrr_total: mrrTotal, setup_total: setupTotal, month_setup: rev[thisMonth] ? rev[thisMonth].setup : 0, deals: dealRows.results.length },
      email: { days, sent: emailSeries.sent, replied: emailSeries.replied, bounced: emailSeries.bounced, sent14, replied14, bounced14: eKind('bounced'), opted_out14: eKind('opted_out'), active: emailLead.active || 0, unemailed: emailLead.unemailed || 0, with_email: emailLead.with_email || 0 },
      outreach: { days, texts: series('texts'), dms: series('dms'), texts7, dms7, today_texts: tdy.texts, today_dms: tdy.dms },
      content: { days, posts: series('posts'), posts7, refs: series('refs'), refs7, today_posts: tdy.posts, today_refs: tdy.refs },
      supply: { days, added: supply, open: sum(st, OPENF), focus_open: focusOpen, days_left: daysOfLeads },
      streak: trkStreak(byDay, goal, today), check,
    });
  }


  /* ---- content system (admin) ---- */
  if (path === '/content' && method === 'GET') {
    need(user, 'admin');
    const today = ptParts().date, start = (await getSetting(env, 'push_start')) || '2026-11-02';
    const dayNum = (d) => Math.floor((Date.parse(d) - Date.parse(start)) / 864e5) + 1;
    const from = trkShift(today, -6);
    const rows = (await env.DB.prepare('SELECT day, platform FROM content_log WHERE day >= ?').bind(from).all()).results;
    const week = [];
    for (let i = 6; i >= 0; i--) {
      const d = trkShift(today, -i);
      week.push({ day: d, n: Math.max(1, dayNum(d)), today: d === today, label: new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }), done: rows.filter((r) => r.day === d).map((r) => r.platform) });
    }
    const wk = week.find((x) => x.today);
    const todayPosts = (await env.DB.prepare('SELECT id, platform, format, topic, created_at FROM content_posts WHERE day = ? ORDER BY id DESC').bind(today).all()).results;
    const recent = (await env.DB.prepare('SELECT id, day, platform, format, topic, created_at FROM content_posts ORDER BY id DESC LIMIT 60').all()).results;
    const days = (await env.DB.prepare('SELECT DISTINCT day FROM content_posts WHERE day >= ? ORDER BY day DESC').bind(trkShift(today, -60)).all()).results.map((r) => r.day);
    let streak = 0, cur = days.includes(today) ? today : trkShift(today, -1);
    while (days.includes(cur)) { streak++; cur = trkShift(cur, -1); }
    const weekPosts = (await env.DB.prepare('SELECT COUNT(*) AS n FROM content_posts WHERE day >= ?').bind(from).first()).n;
    return json({ today, day_n: Math.max(1, dayNum(today)), done_today: wk.done, week, today_posts: todayPosts, recent, streak, week_posts: weekPosts });
  }
  const PLAT_NAME = { ig: 'Instagram', fb: 'Facebook', tt: 'TikTok', yt: 'YouTube Shorts', x: 'X', li: 'LinkedIn' };
  const FMT_NAME = { post: 'post', video: 'video', face: 'face video', news: 'news post' };
  const bumpPosts = (day, d) => env.DB.prepare(`INSERT INTO tracker_days (user_id, day, blocks, posts, updated_at) VALUES (?,?,'[]',?,?)
      ON CONFLICT(user_id, day) DO UPDATE SET posts = MAX(0, posts + ?), updated_at = excluded.updated_at`).bind(user.id, day, Math.max(0, d), now(), d).run();
  if (path === '/content/posted' && method === 'POST') {
    need(user, 'admin');
    const plat = str(body.platform, 10), fmt = str(body.format, 10) || 'post';
    if (!PLAT_NAME[plat]) bad('Pick a platform: Instagram, Facebook, TikTok, YouTube Shorts, X or LinkedIn');
    if (!FMT_NAME[fmt]) bad('Pick post, video, face or news');
    const day = ptParts().date, topic = str(body.topic, 40) || null, title = 'Posted ' + FMT_NAME[fmt] + ' on ' + PLAT_NAME[plat];
    const cal = await env.DB.prepare('INSERT INTO cal_events (user_id, title, kind, starts_at, ends_at, notes, lead_id, link, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(user.id, title, 'posted', now(), null, topic ? 'Topic: ' + topic : null, null, null, now()).run();
    const r = await env.DB.prepare('INSERT INTO content_posts (user_id, day, platform, format, topic, title, cal_id, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(user.id, day, plat, fmt, topic, title, cal.meta.last_row_id, now()).run();
    await env.DB.prepare('INSERT OR IGNORE INTO content_log (day, platform, type, created_at) VALUES (?,?,?,?)').bind(day, plat, str(body.type, 20), now()).run();
    await bumpPosts(day, 1);
    return json({ ok: true, id: r.meta.last_row_id, title });
  }
  if ((m = path.match(/^\/content\/posted\/(\d+)$/)) && method === 'DELETE') {
    need(user, 'admin');
    const row = await env.DB.prepare('SELECT * FROM content_posts WHERE id = ?').bind(+m[1]).first();
    if (!row) throw new HttpError(404, 'Post not found');
    if (row.cal_id) await env.DB.prepare('DELETE FROM cal_events WHERE id = ?').bind(row.cal_id).run();
    await env.DB.prepare('DELETE FROM content_posts WHERE id = ?').bind(row.id).run();
    await bumpPosts(row.day, -1);
    const left = await env.DB.prepare('SELECT 1 AS n FROM content_posts WHERE day = ? AND platform = ?').bind(row.day, row.platform).first();
    if (!left) await env.DB.prepare('DELETE FROM content_log WHERE day = ? AND platform = ?').bind(row.day, row.platform).run();
    return json({ ok: true });
  }
  if (path === '/content/toggle' && method === 'POST') {
    need(user, 'admin');
    const today = ptParts().date, platform = str(body.platform, 10);
    if (!['ig', 'fb', 'tt', 'yt', 'x', 'li'].includes(platform)) bad('Pick a platform: Instagram, Facebook, TikTok, YouTube Shorts, X or LinkedIn');
    const had = await env.DB.prepare('SELECT 1 AS n FROM content_log WHERE day = ? AND platform = ?').bind(today, platform).first();
    if (had) await env.DB.prepare('DELETE FROM content_log WHERE day = ? AND platform = ?').bind(today, platform).run();
    else await env.DB.prepare('INSERT INTO content_log (day, platform, type, created_at) VALUES (?,?,?,?)').bind(today, platform, str(body.type, 20), now()).run();
    const d = had ? -1 : 1;
    await env.DB.prepare(`INSERT INTO tracker_days (user_id, day, blocks, posts, updated_at) VALUES (?,?,'[]',?,?)
      ON CONFLICT(user_id, day) DO UPDATE SET posts = MAX(0, posts + ?), updated_at = excluded.updated_at`).bind(user.id, today, Math.max(0, d), now(), d).run();
    return json({ ok: true, posted: !had });
  }


  /* ---- Instagram handles pulled from lead websites (admin) ---- */
  if (path === '/instagram/enrich' && method === 'POST') {
    need(user, 'admin');
    const r = await enrichInstagram(env, 15);
    const c = await env.DB.prepare("SELECT SUM(CASE WHEN instagram IS NOT NULL THEN 1 ELSE 0 END) AS have, SUM(CASE WHEN instagram IS NULL AND ig_checked_at IS NULL AND website IS NOT NULL AND website != '' THEN 1 ELSE 0 END) AS waiting, COUNT(*) AS total FROM leads").first();
    return json({ ...r, have: c.have || 0, waiting: c.waiting || 0, total: c.total });
  }
  if (path === '/instagram/stats' && method === 'GET') {
    need(user, 'admin');
    const c = await env.DB.prepare("SELECT SUM(CASE WHEN instagram IS NOT NULL THEN 1 ELSE 0 END) AS have, SUM(CASE WHEN instagram IS NULL AND ig_checked_at IS NULL AND website IS NOT NULL AND website != '' THEN 1 ELSE 0 END) AS waiting, COUNT(*) AS total FROM leads").first();
    return json({ have: c.have || 0, waiting: c.waiting || 0, total: c.total });
  }

  /* ---- review cards inventory + sales (admin) ---- */
  if (path === '/cards' && method === 'GET') {
    need(user, 'admin');
    const total = parseInt(await getSetting(env, 'cards_total'), 10) || 50;
    const rows = (await env.DB.prepare('SELECT * FROM cards_log ORDER BY id DESC LIMIT 200').all()).results;
    const sum = (k, f) => rows.filter((r) => r.kind === k).reduce((a, r) => a + f(r), 0);
    const sold = sum('sold', (r) => r.qty), given = sum('given', (r) => r.qty), lost = sum('lost', (r) => r.qty);
    const revenue = sum('sold', (r) => r.qty * r.price_cents);
    const today = ptParts().date;
    return json({ total, sold, given, lost, stock: total - sold - given - lost, revenue_cents: revenue, today_sold: rows.filter((r) => r.kind === 'sold' && ptParts(new Date(r.created_at)).date === today).reduce((a, r) => a + r.qty, 0), log: rows });
  }
  if (path === '/cards' && method === 'POST') {
    need(user, 'admin');
    const kind = ['sold', 'given', 'lost'].includes(body.kind) ? body.kind : bad('Pick sold, given away or lost');
    const qty = Math.max(1, Math.min(1000, parseInt(body.qty, 10) || 0)); if (!qty) bad('Enter how many cards');
    const price = kind === 'sold' ? centsVal(body.price === undefined || body.price === '' ? 50 : body.price) : 0;
    await env.DB.prepare('INSERT INTO cards_log (kind, qty, price_cents, business, note, created_at) VALUES (?,?,?,?,?,?)').bind(kind, qty, price, str(body.business, 120), str(body.note, 300), now()).run();
    return json({ ok: true });
  }
  if ((m = path.match(/^\/cards\/(\d+)$/)) && method === 'DELETE') {
    need(user, 'admin');
    await env.DB.prepare('DELETE FROM cards_log WHERE id = ?').bind(+m[1]).run();
    return json({ ok: true });
  }

  /* ---- end-of-day rebrief (admin) ---- */
  if (path === '/rebrief' && method === 'GET') {
    need(user, 'admin');
    const today = ptParts().date;
    let day = str(url.searchParams.get('day'), 10) || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > today) day = today;
    const dayStart = (d) => { for (let h = 6; h <= 9; h++) { const t = new Date(Date.parse(d + 'T00:00:00Z') + h * 3600e3); if (ptParts(t).date === d && ptParts(new Date(t.getTime() - 3600e3)).date !== d) return t.toISOString(); } return new Date(Date.parse(d + 'T08:00:00Z')).toISOString(); };
    const from = dayStart(day), to = dayStart(trkShift(day, 1)), nextDay = trkShift(day, 1);
    const goal = await trkGoal(env), byDay = await trkLoad(env, user.id, day);
    const t = byDay.get(day) || trkRow(null, day);
    const [outc, notesN, dealsR, cardsR, nextCb, upcoming, leftNew, postsR] = await Promise.all([
      env.DB.prepare('SELECT outcome, COUNT(*) AS n FROM calls WHERE user_id = ? AND created_at >= ? AND created_at < ? GROUP BY outcome').bind(user.id, from, to).all(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM notes WHERE user_id = ? AND created_at >= ? AND created_at < ?').bind(user.id, from, to).first(),
      env.DB.prepare('SELECT d.amount_cents, d.mrr_cents, l.business FROM deals d LEFT JOIN leads l ON l.id = d.lead_id WHERE d.created_at >= ? AND d.created_at < ?').bind(from, to).all(),
      env.DB.prepare("SELECT COALESCE(SUM(qty),0) AS n, COALESCE(SUM(qty*price_cents),0) AS c FROM cards_log WHERE kind = 'sold' AND created_at >= ? AND created_at < ?").bind(from, to).first(),
      env.DB.prepare("SELECT id, business, callback_at FROM leads WHERE status = 'callback' AND callback_at IS NOT NULL AND callback_at < ? ORDER BY callback_at LIMIT 15").bind(dayStart(trkShift(nextDay, 1))).all(),
      env.DB.prepare("SELECT id, business, booked_at, status FROM leads WHERE booked_at IS NOT NULL AND booked_at >= ? AND status IN ('booked','call2') ORDER BY booked_at LIMIT 15").bind(now()).all(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM leads WHERE status IN ('new','demo_needed','demo_ready')").first(),
      env.DB.prepare('SELECT platform FROM content_log WHERE day = ?').bind(day).all(),
    ]);
    const oc = Object.fromEntries(outc.results.map((r) => [r.outcome, r.n]));
    const wins = ['pray', 'gym', 'mind'].filter((w) => t.blocks.includes(w));
    const blocksDone = t.blocks.length, blocksTotal = TRK_BLOCKS.length;
    const posted = postsR.results.map((r) => r.platform);
    // score out of 100: dials 45, audits 20, wins 15, content 10, schedule 10
    const sDials = Math.round(45 * Math.min(1, t.dials / goal)), sAud = t.demos >= 1 ? 20 : t.talks >= 10 ? 8 : 0;
    const sWins = wins.length * 5, sContent = Math.round(10 * Math.min(1, Math.max(posted.length, Math.min(t.posts, 3)) / 3)), sSched = Math.round(10 * Math.min(1, blocksDone / blocksTotal));
    const score = sDials + sAud + sWins + sContent + sSched;
    const sunday = trkDow(day) === 0;
    const verdict = sunday ? ['rest', 'Rest day', 'Sundays are off. Recharge.'] : score >= 80 ? ['great', 'Great day', 'You did the work. Do it again tomorrow.'] : score >= 60 ? ['good', 'Solid day', 'Close. One more push on dials or content next time.'] : score >= 40 ? ['meh', 'Okay day', 'Not your best. Find the one block you skipped and protect it tomorrow.'] : ['bad', 'Rough day', 'Low output. No drama, just reset and win the first block tomorrow.'];
    const done = [], todo = [];
    done.push(`${t.dials} dials (goal ${goal})`, `${t.talks} pick-ups`, `${t.demos} audit${t.demos === 1 ? '' : 's'} booked`);
    if (notesN.n) done.push(`${notesN.n} call notes saved`);
    if (dealsR.results.length) done.push(`Closed ${dealsR.results.length} deal${dealsR.results.length === 1 ? '' : 's'}: ${dealsR.results.map((d) => d.business).join(', ')}`);
    if (cardsR.n) done.push(`Sold ${cardsR.n} review card${cardsR.n === 1 ? '' : 's'} ($${(cardsR.c / 100).toFixed(0)})`);
    if (posted.length) done.push(`Posted on ${posted.length} platform${posted.length === 1 ? '' : 's'}`);
    if (!sunday) {
      if (t.dials < goal) todo.push(`${goal - t.dials} dials short of the goal`);
      if (wins.length < 3) todo.push('Missing wins: ' + ['pray', 'gym', 'mind'].filter((w) => !wins.includes(w)).map((w) => ({ pray: 'spiritual', gym: 'physical', mind: 'mental' }[w])).join(', '));
      if (posted.length < 3 && day === today) todo.push('Post on ' + ['ig', 'fb', 'tt', 'yt', 'x', 'li'].filter((x) => !posted.includes(x)).slice(0, 3).map((x) => ({ ig: 'Instagram', fb: 'Facebook', tt: 'TikTok', yt: 'YT Shorts', x: 'X', li: 'LinkedIn' }[x])).join(', '));
      if (!t.refs) todo.push('One referral ask not logged');
    }
    return json({
      day, today, goal, is_today: day === today, sunday, score, verdict,
      breakdown: [['Dials', sDials, 45], ['Audits', sAud, 20], ['Daily wins', sWins, 15], ['Content', sContent, 10], ['Schedule', sSched, 10]],
      stats: { dials: t.dials, talks: t.talks, demos: t.demos, texts: t.texts, dms: t.dms, posts: t.posts, refs: t.refs, notes: notesN.n, wins, blocks_done: blocksDone, blocks_total: blocksTotal, outcomes: oc },
      done, todo, note: t.note || '',
      tomorrow: { callbacks: nextCb.results, booked: upcoming.results, fresh_leads: leftNew.n },
      history: Array.from({ length: 7 }, (_, i) => { const d = trkShift(day, i - 6); return { day: d, dials: (byDay.get(d) || {}).dials || 0 }; }),
    });
  }

  /* ---- personal tracker (admin) ---- */
  if (path === '/tracker' && method === 'GET') {
    need(user, 'admin');
    const today = ptParts().date, goal = await trkGoal(env), byDay = await trkLoad(env, user.id, today);
    const since = ptMidnightIso();
    const crm = await env.DB.prepare("SELECT COUNT(*) AS logged, SUM(CASE WHEN to_status = 'booked' THEN 1 ELSE 0 END) AS booked FROM calls WHERE user_id = ? AND created_at >= ?").bind(user.id, since).first();
    const history = [];
    for (let i = 13; i >= 0; i--) { const d = trkShift(today, -i); history.push({ ...(byDay.get(d) || trkRow(null, d)), kept: trkKept(byDay.get(d), goal), off: trkDow(d) === 0 }); }
    return json({ today, now_pt: ptParts(), goal, day: byDay.get(today) || trkRow(null, today), history, streak: trkStreak(byDay, goal, today),
      crm: { logged: crm.logged || 0, booked: crm.booked || 0 } });
  }
  if (path === '/tracker' && method === 'PUT') {
    need(user, 'admin');
    const today = ptParts().date, day = str(body.day, 10) || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > today || day < trkShift(today, -7)) bad('You can only edit today or the last 7 days');
    const cur = trkRow(await env.DB.prepare('SELECT * FROM tracker_days WHERE user_id = ? AND day = ?').bind(user.id, day).first(), day);
    const num = (v, old) => (v === undefined ? old : Math.max(0, Math.min(5000, parseInt(v, 10) || 0)));
    const out = { ...cur, dials: num(body.dials, cur.dials), talks: num(body.talks, cur.talks), demos: num(body.demos, cur.demos), texts: num(body.texts, cur.texts), dms: num(body.dms, cur.dms), posts: num(body.posts, cur.posts), refs: num(body.refs, cur.refs) };
    if (body.blocks !== undefined) out.blocks = [...new Set((Array.isArray(body.blocks) ? body.blocks : []).filter((b) => TRK_BLOCKS.includes(b)))];
    if (body.note !== undefined) out.note = str(body.note, 500);
    await env.DB.prepare(`INSERT INTO tracker_days (user_id, day, blocks, dials, talks, demos, texts, dms, posts, refs, note, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id, day) DO UPDATE SET blocks = excluded.blocks, dials = excluded.dials, talks = excluded.talks, demos = excluded.demos, texts = excluded.texts, dms = excluded.dms, posts = excluded.posts, refs = excluded.refs, note = excluded.note, updated_at = excluded.updated_at`)
      .bind(user.id, day, JSON.stringify(out.blocks), out.dials, out.talks, out.demos, out.texts, out.dms, out.posts, out.refs, out.note, now()).run();
    const goal = await trkGoal(env), byDay = await trkLoad(env, user.id, today);
    return json({ ok: true, day: out, streak: trkStreak(byDay, goal, today), kept: trkKept(out, goal) });
  }
  if (path === '/tracker/goal' && method === 'PUT') {
    need(user, 'admin');
    const g = parseInt(body.goal, 10);
    if (!(g >= 1 && g <= 2000)) bad('Pick a daily dial goal between 1 and 2000');
    await setSetting(env, 'tracker_goal', String(g));
    return json({ ok: true, goal: g });
  }
  if (path === '/finder/auto/run' && method === 'POST') {
    need(user, 'admin');
    return json(await autoStep(env, { manual: true }));
  }
  if (path === '/finder/add' && method === 'POST') {
    need(user, 'admin');
    const list = Array.isArray(body.places) ? body.places.slice(0, 100) : [];
    if (!list.length) bad('Pick some businesses first');
    const name = str(body.batch, 100) || 'Lead Finder · ' + new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' });
    const b = await env.DB.prepare('INSERT INTO batches (name, created_by, created_at) VALUES (?,?,?)').bind(name, user.id, now()).run();
    const rows = list.map((p) => ({ business: p.business, phone: p.phone, address: p.address, city: p.city || '', category: p.category, rating: p.rating == null ? '' : String(p.rating), link: p.link, website: p.website, place_id: p.place_id, reviews: p.reviews }));
    const res = await importRows(env, { batchId: b.meta.last_row_id, rows, startStatus: body.start_status, assign: body.assign || 'auto', skipWithSite: false, source: 'finder' });
    return json({ ...res, batch_id: b.meta.last_row_id, batch: name });
  }

  /* ---- Stage 4C: Demo Studio ---- */
  if (path === '/studio' && method === 'GET') {
    need(user, 'admin', 'rep', 'dev');
    const leadId = +url.searchParams.get('lead') || null;
    let lead = null;
    if (leadId) lead = await loadLead(env, user, leadId);
    const d = await env.DB.prepare(`SELECT * FROM studio_drafts WHERE user_id = ? AND ${lead ? 'lead_id = ?' : 'lead_id IS NULL'} ORDER BY updated_at DESC LIMIT 1`).bind(...(lead ? [user.id, lead.id] : [user.id])).first();
    const demo = lead ? await env.DB.prepare('SELECT slug, theme, data FROM demos WHERE lead_id = ? ORDER BY id DESC LIMIT 1').bind(lead.id).first() : null;
    return json({ lead: lead ? studioLead(lead) : null, draft: d ? draftOut(d) : null,
      demo: demo ? { url: url.origin + '/d/' + demo.slug, theme: demo.theme, data: JSON.parse(demo.data || '{}') } : null, engine: aiEngine(env), photos: env.PEXELS_KEY ? 'pexels' : aiImagesReady(env) ? 'ai' : '' });
  }
  if (path === '/studio/leads' && method === 'GET') {
    need(user, 'admin', 'rep', 'dev');
    const q = str(url.searchParams.get('q'), 60);
    const where = ["l.status NOT IN ('dnc','lost')"], args = [];
    if (user.role === 'rep') { where.push('l.assigned_to = ?'); args.push(user.id); }
    if (q) { where.push('(l.business LIKE ? OR l.city LIKE ? OR l.category LIKE ?)'); const like = '%' + q.replace(/[%_]/g, '') + '%'; args.push(like, like, like); }
    const { results } = await env.DB.prepare(`SELECT l.id, l.business, l.city, l.category, l.status, l.demo_url, COALESCE(l.heat,'cold') AS heat FROM leads l WHERE ${where.join(' AND ')}
      ORDER BY CASE WHEN l.demo_url IS NULL OR l.demo_url = '' THEN 0 ELSE 1 END, CASE COALESCE(l.heat,'cold') WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 ELSE 2 END, l.id DESC LIMIT 30`).bind(...args).all();
    return json(results);
  }
  if (path === '/video/edit' && method === 'POST') {
    need(user, 'admin', 'rep', 'dev');
    const instruction = str(body.instruction, 500);
    if (!instruction) bad('Tell it what to fix');
    if (!env.AI) bad('The editor is not switched on yet');
    const cur = body.current && typeof body.current === 'object' ? body.current : {};
    const sys = 'You edit a short vertical video script for a company that sells AI phone, text and review tools to med spas. The user will say what to fix. Return ONLY a JSON object containing just the fields that need to change. Allowed fields: hook, symptom, diagnosis, cost, fix, recovery, cta (each a spoken line, plain words, under 160 characters), and flow (an object that may hold: title, trigger, pain (array of exactly 3 short strings), why, lost, fix, steps (array of exactly 3 short strings), check, before, after; each under 60 characters). Rules: change only what the user asked. Never invent statistics, prices, clients or guarantees that are not in the current text, except numbers the user gives you. No hype words, no em dashes. If the user changes a spoken line that the board also shows, change the matching flow field too.';
    let text = '';
    try {
      const r = await env.AI.run(STUDIO_MODEL, { messages: [{ role: 'system', content: sys }, { role: 'user', content: 'CURRENT:\n' + JSON.stringify(cur).slice(0, 4000) + '\n\nFIX REQUEST: ' + instruction }], max_tokens: 900, temperature: 0.3 });
      text = String((r && (r.response || r.result)) || '');
    } catch (e) { console.error('vedit', e); bad('The editor is busy. Try again in a minute.'); }
    let obj = null;
    try { const m = text.match(/\{[\s\S]*\}/); obj = m ? JSON.parse(m[0]) : null; } catch { obj = null; }
    if (!obj || typeof obj !== 'object') bad('It could not work out that fix. Try saying it another way.');
    const cl = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').replace(/[\u2014\u2013]/g, ',').trim().slice(0, n);
    const patch = {};
    for (const k of ['hook', 'symptom', 'diagnosis', 'cost', 'fix', 'recovery', 'cta']) if (typeof obj[k] === 'string' && cl(obj[k], 200)) patch[k] = cl(obj[k], 200);
    if (obj.flow && typeof obj.flow === 'object') {
      const f = {};
      for (const k of ['title', 'trigger', 'why', 'lost', 'fix', 'check', 'before', 'after']) if (typeof obj.flow[k] === 'string' && cl(obj.flow[k], 70)) f[k] = cl(obj.flow[k], 70);
      for (const k of ['pain', 'steps']) if (Array.isArray(obj.flow[k]) && obj.flow[k].length === 3) f[k] = obj.flow[k].map((x) => cl(x, 50));
      if (f.fix) f.fixAI = f.fix;
      if (f.title) f.titleAI = f.title;
      if (Object.keys(f).length) patch.flow = f;
    }
    return json({ patch });
  }
  if (path === '/voice/tts' && method === 'POST') {
    need(user, 'admin', 'rep', 'dev');
    const text = str(body.text, 1800);
    if (!text) bad('No script to read');
    if (!env.AI) bad('The voice engine is not switched on yet');
    const speaker = ['luna', 'asteria', 'athena', 'hera', 'stella'].includes(body.voice) ? body.voice : 'luna';
    const b64 = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
    try {
      const r = await env.AI.run('@cf/deepgram/aura-1', { text, speaker, encoding: 'mp3' }, { returnRawResponse: true });
      const buf = await r.arrayBuffer();
      if (buf.byteLength < 2000) throw new Error('empty audio');
      return json({ audio: b64(buf), mime: 'audio/mpeg', engine: 'aura' });
    } catch (e1) {
      console.error('aura', e1);
      try {
        const r = await env.AI.run('@cf/myshell-ai/melotts', { prompt: text, lang: 'en' });
        if (!r || !r.audio) throw new Error('no audio');
        return json({ audio: r.audio, mime: 'audio/mpeg', engine: 'melo' });
      } catch (e2) { console.error('melo', e2); bad('The AI voice could not be made right now. Try again in a minute.'); }
    }
  }
  if (path === '/studio/chat' && method === 'POST') {
    need(user, 'admin', 'rep', 'dev');
    const message = str(body.message, 6000);
    if (!message) bad('Type a message first');
    let d = body.draft_id ? await env.DB.prepare('SELECT * FROM studio_drafts WHERE id = ? AND user_id = ?').bind(+body.draft_id, user.id).first() : null;
    let lead = null;
    const leadId = d ? d.lead_id : (+body.lead_id || null);
    if (leadId) lead = await loadLead(env, user, leadId);
    const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM studio_drafts WHERE user_id = ? AND updated_at > ?').bind(user.id, new Date(Date.now() - 60e3).toISOString()).first();
    if (recent.n >= 8) throw new HttpError(429, 'Slow down a little. Try again in a minute.');
    let data = d ? JSON.parse(d.data || '{}') : {}, theme = d ? d.theme : null, messages = d ? JSON.parse(d.messages || '[]') : [];
    if (!d && lead) {
      const demo = await env.DB.prepare('SELECT theme, data FROM demos WHERE lead_id = ? ORDER BY id DESC LIMIT 1').bind(lead.id).first();
      if (demo) { data = JSON.parse(demo.data || '{}'); theme = demo.theme; }
    }
    const source = [lead ? leadSource(lead) : '', d ? d.source : '', message].filter(Boolean).join('\n\n').slice(-12000);
    const out = await studioRun(env, { message, data, theme, lead, source, messages, first: !Object.keys(data).length });
    const clean = cleanDemo(factCheck(out.data, data, source), lead || {});
    // the design: invent one on the first build, then apply only the changes asked for
    const reroll = /\b(new|different|another|fresh|random)\b.{0,12}\b(design|look|style|vibe|layout)\b|\b(redesign|shuffle|surprise me|start fresh)\b/i.test(message);
    if (reroll || !clean.design) clean.design = makeDesign(clean, reroll ? {} : (out.design || {}), crypto.getRandomValues(new Uint32Array(1))[0]);
    else if (out.design && typeof out.design === 'object') clean.design = makeDesign(clean, Object.assign({}, clean.design, out.design), 'keep');
    let newTheme = DEMO_THEMES[out.theme] ? out.theme : theme || pickTheme(clean.category);
    // first build: use the look made for this kind of business, unless they asked for a style
    if (!Object.keys(data).length) newTheme = nicheFor(clean.category, clean.name).theme;
    // photos: make them on the first build, or when asked for new ones
    const wantPhotos = /\b(new|different|other|more|better|change|redo|swap)\b.{0,20}\b(photos?|pictures?|pics|images?)\b|\b(photos?|pictures?|pics|images?)\b.{0,20}\b(new|different|again|redo)\b/i.test(message);
    if ((wantPhotos || !((clean.images || []).length || (clean.stock || []).length)) && photosReady(env)) {
      const ph = await getPhotos(env, user.id, clean, clean.design ? clean.design.mode : newTheme, wantPhotos ? message : '');
      if (ph.ok) { Object.assign(clean, ph.set); if (wantPhotos) out.reply = (out.reply ? out.reply + ' ' : '') + 'Fresh photos are in.'; }
      else out.reply = (out.reply ? out.reply + ' ' : '') + "(Photos didn't work this time. Reason: " + (ph.error || 'unknown') + ')';
    }
    messages = messages.concat([{ role: 'user', text: message.slice(0, 2000) }, { role: 'ai', text: out.reply, engine: out.engine }]).slice(-30);
    const t = now();
    const newSource = [d ? d.source : '', message].filter(Boolean).join('\n\n').slice(-12000);
    if (d) {
      await env.DB.prepare('UPDATE studio_drafts SET theme = ?, data = ?, messages = ?, source = ?, updated_at = ? WHERE id = ?').bind(newTheme, JSON.stringify(clean), JSON.stringify(messages), newSource, t, d.id).run();
    } else {
      const r = await env.DB.prepare('INSERT INTO studio_drafts (user_id, lead_id, theme, data, messages, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').bind(user.id, lead ? lead.id : null, newTheme, JSON.stringify(clean), JSON.stringify(messages), newSource, t, t).run();
      d = { id: r.meta.last_row_id };
    }
    return json({ draft_id: d.id, theme: newTheme, data: clean, reply: out.reply, engine: out.engine, messages });
  }
  if ((m = path.match(/^\/studio\/(\d+)$/)) && method === 'PATCH') {
    need(user, 'admin', 'rep', 'dev');
    const d = await env.DB.prepare('SELECT * FROM studio_drafts WHERE id = ? AND user_id = ?').bind(+m[1], user.id).first();
    if (!d) throw new HttpError(404, 'Draft not found');
    const data = JSON.parse(d.data || '{}');
    if (body.accent !== undefined) data.accent = /^#[0-9a-f]{6}$/i.test(String(body.accent)) ? body.accent : '';
    if (body.shuffle) { data.design = makeDesign(data, body.mode ? { mode: body.mode } : {}, crypto.getRandomValues(new Uint32Array(1))[0]); data.accent = ''; }
    else if (body.mode === 'dark' || body.mode === 'light') { data.design = makeDesign(data, Object.assign({}, data.design || {}, { mode: body.mode }), 'mode'); data.accent = ''; }
    const theme = DEMO_THEMES[body.theme] ? body.theme : d.theme;
    let leadId = d.lead_id;
    if (body.lead_id) { const lead = await loadLead(env, user, +body.lead_id); leadId = lead.id; }
    if (body.reset) {
      // clear every draft for the same lead (or every lead-less draft) so an older one doesn't pop back up
      if (d.lead_id) await env.DB.prepare('DELETE FROM studio_drafts WHERE user_id = ? AND lead_id = ?').bind(user.id, d.lead_id).run();
      else await env.DB.prepare('DELETE FROM studio_drafts WHERE user_id = ? AND lead_id IS NULL').bind(user.id).run();
      return json({ ok: true });
    }
    await env.DB.prepare('UPDATE studio_drafts SET theme = ?, data = ?, lead_id = ?, updated_at = ? WHERE id = ?').bind(theme, JSON.stringify(data), leadId, now(), d.id).run();
    return json({ ok: true, theme, data, lead_id: leadId });
  }
  if ((m = path.match(/^\/studio\/(\d+)\/photos$/)) && method === 'POST') {
    need(user, 'admin', 'rep', 'dev');
    const d = await env.DB.prepare('SELECT * FROM studio_drafts WHERE id = ? AND user_id = ?').bind(+m[1], user.id).first();
    if (!d) throw new HttpError(404, 'Draft not found');
    if (!photosReady(env)) bad('Photos are not set up yet. Add the free Pexels key in Cloudflare (PEXELS_KEY).');
    const data = JSON.parse(d.data || '{}');
    const ph = await getPhotos(env, user.id, data, data.design ? data.design.mode : d.theme, str(body.hint, 200) || 'new photos');
    if (!ph.ok) bad("Couldn't get photos. Reason: " + (ph.error || 'unknown') + '. Send Claude a screenshot of this.');
    Object.assign(data, ph.set);
    await env.DB.prepare('UPDATE studio_drafts SET data = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(data), now(), d.id).run();
    return json({ ok: true, data });
  }
  if ((m = path.match(/^\/studio\/(\d+)\/save$/)) && method === 'POST') {
    need(user, 'admin', 'rep', 'dev');
    const d = await env.DB.prepare('SELECT * FROM studio_drafts WHERE id = ? AND user_id = ?').bind(+m[1], user.id).first();
    if (!d) throw new HttpError(404, 'Draft not found');
    const leadId = +body.lead_id || d.lead_id;
    if (!leadId) bad('Pick which lead this demo is for');
    const lead = await loadLead(env, user, leadId);
    const res = await saveDemo(env, user, lead, d.theme, JSON.parse(d.data || '{}'), url.origin);
    await env.DB.prepare('UPDATE studio_drafts SET lead_id = ?, updated_at = ? WHERE id = ?').bind(lead.id, now(), d.id).run();
    return json({ ...res, lead_id: lead.id, business: lead.business });
  }

  throw new HttpError(404, 'Not found');
}

async function saveDemo(env, user, lead, themeIn, dataIn, origin) {
  {
    const theme = DEMO_THEMES[themeIn] ? themeIn : pickTheme(lead.category);
    const prev = await env.DB.prepare('SELECT data FROM demos WHERE lead_id = ? ORDER BY id DESC LIMIT 1').bind(lead.id).first();
    const prevData = prev ? JSON.parse(prev.data || '{}') : {};
    const data = cleanDemo(Object.assign({}, dataIn || {}, {
      design: (dataIn && dataIn.design) || prevData.design,
      images: dataIn && Array.isArray(dataIn.images) && dataIn.images.length ? dataIn.images : prevData.images,
      stock: dataIn && Array.isArray(dataIn.stock) && dataIn.stock.length ? dataIn.stock : (dataIn && Array.isArray(dataIn.images) && dataIn.images.length ? [] : prevData.stock),
    }), lead);
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
    const demoUrl = origin + '/d/' + slug;
    const to = ['new', 'demo_needed'].includes(lead.status) ? 'demo_ready' : lead.status;
    const stmts = [env.DB.prepare('UPDATE leads SET demo_url = ?, status = ?, updated_at = ? WHERE id = ?').bind(demoUrl, to, t, lead.id)];
    if (to !== lead.status) stmts.push(env.DB.prepare('INSERT INTO calls (lead_id,user_id,outcome,from_status,to_status,created_at) VALUES (?,?,?,?,?,?)').bind(lead.id, user.id, 'demo_ready', lead.status, to, t));
    await env.DB.batch(stmts);
    return { ok: true, url: demoUrl, slug, status: to };
  }
}

/* ================= Unique site designs (design DNA) =================
   Every demo gets its own design: palette, fonts, hero, section styles,
   order, shapes, texture and motion. The AI suggests it; anything missing
   or invalid is filled in at random (biased by the kind of business). */

const DFONTS = {
  anton: { q: 'family=Anton', css: "'Anton', Impact, sans-serif", upper: true, w: 400, k: 0.5 },
  bebas: { q: 'family=Bebas+Neue', css: "'Bebas Neue', Impact, sans-serif", upper: true, w: 400, k: 0.44 },
  archivo: { q: 'family=Archivo+Black', css: "'Archivo Black', 'Arial Black', sans-serif", upper: true, w: 400, k: 0.8 },
  oswald: { q: 'family=Oswald:wght@600;700', css: "'Oswald', 'Arial Narrow', sans-serif", upper: true, w: 700, k: 0.52 },
  fraunces: { q: 'family=Fraunces:ital,opsz,wght@1,9..144,600;1,9..144,800', css: "'Fraunces', Georgia, serif", italic: true, w: 700, k: 0.58 },
  playfair: { q: 'family=Playfair+Display:ital,wght@0,800;1,700', css: "'Playfair Display', Georgia, serif", w: 800, k: 0.6 },
  dmserif: { q: 'family=DM+Serif+Display:ital@0;1', css: "'DM Serif Display', Georgia, serif", w: 400, k: 0.54 },
  cormorant: { q: 'family=Cormorant+Garamond:ital,wght@1,600;1,700', css: "'Cormorant Garamond', Georgia, serif", italic: true, w: 700, k: 0.5 },
  abril: { q: 'family=Abril+Fatface', css: "'Abril Fatface', Georgia, serif", w: 400, k: 0.64 },
  syne: { q: 'family=Syne:wght@700;800', css: "'Syne', 'Trebuchet MS', sans-serif", w: 800, k: 0.72 },
  spacegrotesk: { q: 'family=Space+Grotesk:wght@600;700', css: "'Space Grotesk', 'Trebuchet MS', sans-serif", w: 700, k: 0.62 },
  bricolage: { q: 'family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800', css: "'Bricolage Grotesque', 'Trebuchet MS', sans-serif", w: 800, k: 0.62 },
  unbounded: { q: 'family=Unbounded:wght@600;800', css: "'Unbounded', 'Arial Black', sans-serif", w: 800, k: 0.84 },
  outfit: { q: 'family=Outfit:wght@700;800', css: "'Outfit', 'Trebuchet MS', sans-serif", w: 800, k: 0.6 },
  sora: { q: 'family=Sora:wght@700;800', css: "'Sora', 'Trebuchet MS', sans-serif", w: 800, k: 0.68 },
  chakra: { q: 'family=Chakra+Petch:wght@600;700', css: "'Chakra Petch', 'Trebuchet MS', sans-serif", upper: true, w: 700, k: 0.64 },
  righteous: { q: 'family=Righteous', css: "'Righteous', 'Trebuchet MS', sans-serif", w: 400, k: 0.62 },
  rubik: { q: 'family=Rubik:wght@800;900', css: "'Rubik', 'Trebuchet MS', sans-serif", w: 900, k: 0.64 },
};
const DBODY = {
  manrope: { q: 'family=Manrope:wght@400;500;600;700;800', css: "'Manrope', system-ui, sans-serif" },
  inter: { q: 'family=Inter:wght@400;500;600;700;800', css: "'Inter', system-ui, sans-serif" },
  dmsans: { q: 'family=DM+Sans:wght@400;500;600;700', css: "'DM Sans', system-ui, sans-serif" },
  jakarta: { q: 'family=Plus+Jakarta+Sans:wght@400;500;600;700;800', css: "'Plus Jakarta Sans', system-ui, sans-serif" },
  karla: { q: 'family=Karla:wght@400;500;600;700;800', css: "'Karla', system-ui, sans-serif" },
  outfitb: { q: 'family=Outfit:wght@400;500;600;700', css: "'Outfit', system-ui, sans-serif" },
};
/* Design data adapted from UI/UX Pro Max (github.com/nextlevelbuilder/ui-ux-pro-max-skill),
   MIT License, Copyright (c) 2024 Next Level Builder.
   Pro font pairings (from the UI/UX Pro Max typography data). Weights are ones each font really has. */
const DPAIRS = {
  classic: { h: ['Playfair Display', 800], b: 'Inter', w: 800, k: 0.6, mood: 'elegant luxury beauty spa' },
  bold: { h: ['Bebas Neue', 400], b: 'Source Sans 3', upper: true, w: 400, k: 0.44, mood: 'bold dramatic sports barber' },
  wellness: { h: ['Lora', 700], b: 'Raleway', w: 700, k: 0.56, mood: 'calm wellness spa organic' },
  retro: { h: ['Abril Fatface', 400], b: 'Merriweather', w: 400, k: 0.64, mood: 'retro vintage restaurant barber' },
  geometric: { h: ['Outfit', 800], b: 'Work Sans', w: 800, k: 0.6, mood: 'modern clean general' },
  luxury: { h: ['Cormorant', 700], b: 'Montserrat', italic: true, w: 700, k: 0.5, mood: 'luxury fashion high-end' },
  playful: { h: ['Fredoka', 700], b: 'Nunito', w: 700, k: 0.62, mood: 'playful friendly kids pets' },
  soft: { h: ['Varela Round', 400], b: 'Nunito Sans', w: 400, k: 0.62, mood: 'soft rounded pets wellness' },
  fashion: { h: ['Syne', 800], b: 'Manrope', w: 800, k: 0.72, mood: 'fashion edgy creative' },
  menu: { h: ['Playfair Display SC', 700], b: 'Karla', w: 700, k: 0.7, mood: 'restaurant culinary' },
  indie: { h: ['Amatic SC', 700], b: 'Cabin', w: 700, k: 0.42, mood: 'craft handmade bakery' },
  music: { h: ['Righteous', 400], b: 'Poppins', w: 400, k: 0.62, mood: 'fun energetic food' },
  sports: { h: ['Barlow Condensed', 800], b: 'Barlow', upper: true, w: 800, k: 0.46, mood: 'sports fitness gym' },
  luxmin: { h: ['Bodoni Moda', 700], b: 'Jost', w: 700, k: 0.58, mood: 'luxury minimalist' },
  genz: { h: ['Anton', 400], b: 'Epilogue', upper: true, w: 400, k: 0.5, mood: 'loud streetwear barber tattoo' },
  startup: { h: ['Outfit', 800], b: 'Rubik', w: 800, k: 0.6, mood: 'bold modern confident' },
  techy: { h: ['Space Grotesk', 700], b: 'DM Sans', w: 700, k: 0.62, mood: 'modern techy auto' },
  estate: { h: ['Cinzel', 700], b: 'Josefin Sans', upper: true, w: 700, k: 0.72, mood: 'premium classic' },
  handwritten: { h: ['Caveat', 700], b: 'Quicksand', w: 700, k: 0.48, mood: 'personal warm cafe' },
  neubrutal: { h: ['Lexend Mega', 800], b: 'Public Sans', w: 800, k: 0.86, mood: 'loud quirky gen z' },
  clay: { h: ['Nunito', 900], b: 'DM Sans', w: 900, k: 0.6, mood: 'claymorphism bubbly playful' },
  gaming: { h: ['Russo One', 400], b: 'Chakra Petch', w: 400, k: 0.66, mood: 'action bold auto' },
};
const gq = (fam, w) => 'family=' + fam.replace(/ /g, '+') + (w ? ':wght@' + w : '');
// UI styles (from UI/UX Pro Max styles data): each changes cards, buttons, borders and shadows
const DSTYLES = ['soft', 'clay', 'glass', 'brutal', 'swiss', 'editorial', 'vibrant', 'luxury', 'organic', 'flat'];
const STYLE_MODE = { clay: 'light', brutal: 'light', luxury: 'dark', organic: 'light' };
// Palettes by business type (UI/UX Pro Max colors data): [primary, accent, background, foreground]
const CURATED = {
  pets: [['#F97316', '#2563EB', '#FFF7ED', '#9A3412'], ['#0D9488', '#EA580C', '#F0FDFA', '#134E4A']],
  nails: [['#EC4899', '#8B5CF6', '#FDF2F8', '#831843']],
  lash: [['#EC4899', '#8B5CF6', '#FDF2F8', '#831843']],
  hair: [['#EC4899', '#8B5CF6', '#FDF2F8', '#831843']],
  food: [['#DC2626', '#A16207', '#FEF2F2', '#450A0A'], ['#92400E', '#B45309', '#FEF3C7', '#78350F']],
  fitness: [['#F97316', '#22C55E', '#1F2937', '#F8FAFC']],
  auto: [['#DC2626', '#DC2626', '#0F172A', '#F8FAFC'], ['#1E293B', '#DC2626', '#F8FAFC', '#0F172A']],
  home: [['#1E40AF', '#EA580C', '#EFF6FF', '#1E3A8A']],
};
const NICHE_UI = {
  pets: { styles: ['clay', 'vibrant', 'soft', 'organic', 'flat'], pairs: ['playful', 'soft', 'clay', 'geometric', 'handwritten'] },
  barber: { styles: ['luxury', 'editorial', 'brutal', 'swiss', 'flat'], pairs: ['bold', 'genz', 'retro', 'estate', 'sports'] },
  nails: { styles: ['soft', 'glass', 'luxury', 'swiss', 'clay'], pairs: ['classic', 'luxury', 'luxmin', 'fashion', 'wellness'] },
  lash: { styles: ['soft', 'glass', 'luxury', 'swiss', 'organic'], pairs: ['luxury', 'classic', 'luxmin', 'wellness'] },
  hair: { styles: ['soft', 'glass', 'editorial', 'luxury', 'vibrant'], pairs: ['classic', 'fashion', 'luxmin', 'luxury', 'bold'] },
  tattoo: { styles: ['brutal', 'luxury', 'editorial', 'swiss'], pairs: ['genz', 'retro', 'bold', 'estate', 'neubrutal'] },
  auto: { styles: ['luxury', 'glass', 'swiss', 'vibrant', 'flat'], pairs: ['techy', 'gaming', 'sports', 'bold', 'startup'] },
  food: { styles: ['vibrant', 'clay', 'editorial', 'flat', 'organic'], pairs: ['menu', 'retro', 'music', 'indie', 'handwritten'] },
  fitness: { styles: ['vibrant', 'brutal', 'flat', 'luxury'], pairs: ['sports', 'bold', 'genz', 'startup'] },
  home: { styles: ['flat', 'swiss', 'soft', 'vibrant'], pairs: ['geometric', 'startup', 'techy', 'soft'] },
  general: { styles: DSTYLES, pairs: Object.keys(DPAIRS) },
};
const DOPTS = {
  hero: ['fullbleed', 'split', 'splitleft', 'arch', 'slant', 'tilt', 'circle', 'stack', 'poster'],
  services: ['cards', 'menu', 'rows', 'tiles'],
  why: ['numbered', 'bordered', 'quote'],
  gallery: ['mosaic', 'strip', 'polaroid'],
  texture: ['grain', 'dots', 'grid', 'blobs', 'halo', 'lines', 'rays', 'none'],
  radius: [0, 10, 22, 34],
  buttons: ['pill', 'rounded', 'square'],
  nav: ['bar', 'float'],
  motion: ['rise', 'fade', 'slide'],
};
// what tends to fit each kind of business (random picks lean this way)
const NICHE_STYLE = {
  pets: { dark: 0.15, hues: [25, 35, 160, 190, 200, 330], fonts: ['bricolage', 'outfit', 'righteous', 'rubik', 'syne', 'fraunces'] },
  barber: { dark: 0.85, hues: [30, 40, 0, 210, 150, 45], fonts: ['anton', 'bebas', 'oswald', 'archivo', 'abril', 'playfair', 'chakra'] },
  nails: { dark: 0.3, hues: [330, 340, 10, 280, 300, 20], fonts: ['fraunces', 'playfair', 'dmserif', 'cormorant', 'syne', 'abril'] },
  lash: { dark: 0.35, hues: [330, 20, 30, 280, 350], fonts: ['cormorant', 'fraunces', 'dmserif', 'playfair', 'syne'] },
  hair: { dark: 0.4, hues: [330, 20, 35, 270, 45, 160], fonts: ['playfair', 'dmserif', 'fraunces', 'abril', 'syne', 'bebas'] },
  tattoo: { dark: 0.9, hues: [0, 350, 30, 200, 120], fonts: ['anton', 'abril', 'chakra', 'bebas', 'unbounded'] },
  auto: { dark: 0.85, hues: [80, 200, 0, 25, 190, 270], fonts: ['archivo', 'chakra', 'unbounded', 'bebas', 'oswald', 'sora'] },
  food: { dark: 0.5, hues: [10, 25, 40, 120, 0, 350], fonts: ['rubik', 'righteous', 'archivo', 'bebas', 'abril', 'bricolage'] },
  fitness: { dark: 0.8, hues: [0, 25, 80, 200, 270], fonts: ['archivo', 'bebas', 'unbounded', 'anton', 'chakra'] },
  home: { dark: 0.2, hues: [200, 150, 210, 30, 120, 180], fonts: ['outfit', 'sora', 'spacegrotesk', 'bricolage', 'rubik'] },
  general: { dark: 0.5, hues: [210, 30, 160, 270, 0, 45], fonts: Object.keys(DFONTS) },
};

function seededRandom(seed) {
  let s = 0;
  for (const c of String(seed)) s = (Math.imul(s ^ c.charCodeAt(0), 2654435761) >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const pickOne = (rnd, list) => list[Math.floor(rnd() * list.length) % list.length];

// Build (or repair) a design. `want` is what the AI or the person asked for.
function makeDesign(data, want, seed) {
  want = want && typeof want === 'object' ? want : {};
  const rnd = seededRandom(seed || Math.random());
  const N0 = nicheFor(data.category, data.name);
  // a saved design keeps the business type it was made for
  const N = want.niche && NICHE_STYLE[want.niche] ? { key: want.niche } : N0;
  const st = NICHE_STYLE[N.key] || NICHE_STYLE.general;
  const ok = (k, v) => DOPTS[k].includes(v);
  const num = (v, lo, hi) => (Number.isFinite(+v) && +v >= lo && +v <= hi ? Math.round(+v) : null);
  const U = NICHE_UI[N.key] || NICHE_UI.general;
  const style = DSTYLES.includes(want.style) ? want.style : pickOne(rnd, U.styles);
  const pair = DPAIRS[want.pair] ? want.pair : pickOne(rnd, U.pairs);
  let mode = want.mode === 'dark' || want.mode === 'light' ? want.mode : (rnd() < st.dark ? 'dark' : 'light');
  if (STYLE_MODE[style] && !(want.mode && want.style === undefined)) mode = want.mode && DSTYLES.includes(want.style) ? want.mode : STYLE_MODE[style];
  const cur = CURATED[N.key] || [];
  const curated = Number.isInteger(want.curated) && cur[want.curated] ? want.curated : (want.curated === -1 ? -1 : (cur.length && rnd() < 0.45 ? Math.floor(rnd() * cur.length) : -1));
  const hue = num(want.hue, 0, 360) ?? (pickOne(rnd, st.hues) + Math.round(rnd() * 16 - 8) + 360) % 360;
  const accentHue = num(want.accent_hue, 0, 360) ?? (rnd() < 0.55 ? hue : (hue + pickOne(rnd, [30, 150, 180, 200, 330])) % 360);
  let order = Array.isArray(want.order) ? want.order.filter((x) => ['services', 'why', 'gallery', 'about'].includes(x)) : [];
  order = [...new Set(order)];
  if (order.length !== 4) {
    const rest = ['why', 'gallery', 'about'].sort(() => rnd() - 0.5);
    order = rnd() < 0.75 ? ['services', ...rest] : [rest[0], 'services', rest[1], rest[2]];
  }
  return {
    v: 2, mode, hue, accent_hue: accentHue, style, pair, curated, niche: N.key,
    sat: num(want.sat, 30, 100) ?? Math.round(55 + rnd() * 40),
    display: DFONTS[want.display] ? want.display : pickOne(rnd, st.fonts.filter((f) => DFONTS[f])),
    body: DBODY[want.body] ? want.body : pickOne(rnd, Object.keys(DBODY)),
    hero: ok('hero', want.hero) ? want.hero : pickOne(rnd, DOPTS.hero),
    services: ok('services', want.services) ? want.services : pickOne(rnd, DOPTS.services),
    why: ok('why', want.why) ? want.why : pickOne(rnd, DOPTS.why),
    gallery: ok('gallery', want.gallery) ? want.gallery : pickOne(rnd, DOPTS.gallery),
    texture: ok('texture', want.texture) ? want.texture : pickOne(rnd, DOPTS.texture),
    radius: DOPTS.radius.includes(+want.radius) ? +want.radius : pickOne(rnd, DOPTS.radius),
    buttons: ok('buttons', want.buttons) ? want.buttons : pickOne(rnd, DOPTS.buttons),
    nav: ok('nav', want.nav) ? want.nav : pickOne(rnd, DOPTS.nav),
    motion: ok('motion', want.motion) ? want.motion : pickOne(rnd, DOPTS.motion),
    marquee: typeof want.marquee === 'boolean' ? want.marquee : rnd() < 0.6,
    order,
  };
}

/* ---- color: build a palette that always passes contrast ---- */
function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((x) => Math.round(x * 255));
}
const toHex = (rgb) => '#' + rgb.map((x) => x.toString(16).padStart(2, '0')).join('');
const hsl = (h, s, l) => toHex(hslToRgb(((h % 360) + 360) % 360, s, l));
function lum(hexc) {
  const v = hexc.replace('#', '').match(/../g).map((x) => parseInt(x, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
function palette(D, accentOverride) {
  const h = D.hue, dark = D.mode === 'dark';
  const cp = D.curated >= 0 && CURATED[D.niche] && CURATED[D.niche][D.curated];
  if (cp && !accentOverride) {
    const [pri, acc, bg, fg] = cp;
    const bgDark = lum(bg) < 0.2;
    if (bgDark === dark && contrast(fg, bg) >= 7) {
      const P = { bg, ink: fg, surface: dark ? hsl(h, 16, 11) : '#ffffff', surface2: dark ? hsl(h, 16, 15) : hsl(h, 40, 93), muted: dark ? '#9ca3af' : '#4b5563' };
      // pick whichever of primary/accent stands out more on this background
      P.accent = contrast(pri, bg) >= contrast(acc, bg) ? pri : acc;
      if (contrast(P.accent, bg) < 3 || Math.max(contrast(P.accent, '#ffffff'), contrast(P.accent, '#0b0b0b')) < 4.6) P.accent = dark ? '#ffffff' : fg;
      P.onAccent = contrast(P.accent, '#ffffff') >= contrast(P.accent, '#0b0b0b') ? '#ffffff' : '#0b0b0b';
      P.line = dark ? 'rgba(255,255,255,.11)' : 'rgba(0,0,0,.09)';
      return P;
    }
  }
  const P = dark
    ? { bg: hsl(h, 22, 6), surface: hsl(h, 18, 10.5), surface2: hsl(h, 16, 14), ink: hsl(h, 25, 95), muted: hsl(h, 10, 68) }
    : { bg: hsl(h, 45, 96.5), surface: hsl(h, 60, 99.3), surface2: hsl(h, 38, 92), ink: hsl(h, 32, 11), muted: hsl(h, 12, 36) };
  let accent = /^#[0-9a-f]{6}$/i.test(accentOverride || '') ? accentOverride : null;
  if (!accent) {
    // walk lightness until the accent stands out from the background
    for (let i = 0; i < 40; i++) {
      const l = dark ? 58 + i : 46 - i;
      const c = hsl(D.accent_hue, D.sat, l);
      // must stand out from the page AND carry readable button text
      if (contrast(c, P.bg) >= 3.2 && Math.max(contrast(c, '#ffffff'), contrast(c, '#0b0b0b')) >= 4.6) { accent = c; break; }
    }
    accent = accent || (dark ? '#ffffff' : '#111111');
  }
  P.accent = accent;
  P.onAccent = contrast(accent, '#ffffff') >= contrast(accent, '#0b0b0b') ? '#ffffff' : '#0b0b0b';
  P.line = dark ? 'rgba(255,255,255,.11)' : 'rgba(0,0,0,.09)';
  return P;
}

const SITE_SCRIPT = String.raw`<script>
(function(){
  document.documentElement.classList.add('js');
  var els=document.querySelectorAll('.reveal');
  if('IntersectionObserver' in window){
    var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}});},{threshold:.12,rootMargin:'0px 0px -40px 0px'});
    els.forEach(function(el){io.observe(el);});
  } else els.forEach(function(el){el.classList.add('in');});
  function fitHero(){var h=document.querySelector('.hero h1');if(!h)return;if(h.dataset.fs===undefined)h.dataset.fs=h.style.fontSize;h.style.fontSize=h.dataset.fs;var ws=[].slice.call(h.querySelectorAll('.w')),box=h.parentElement.getBoundingClientRect().width||document.documentElement.clientWidth-44,s=parseFloat(getComputedStyle(h).fontSize),n=0;
    function widest(){return Math.max.apply(null,ws.map(function(w){return w.getBoundingClientRect().width;}).concat([0]));}
    while(widest()>box&&s>26&&n++<50){s-=2;h.style.fontSize=s+'px';}}
  fitHero();if(document.fonts&&document.fonts.ready)document.fonts.ready.then(fitHero);addEventListener('resize',fitHero);
  var list=document.getElementById('hours'); if(!list) return;
  var days=['sun','mon','tue','wed','thu','fri','sat'], now=new Date(), today=days[now.getDay()];
  function mins(t){var m=/(\d{1,2})(?::(\d{2}))?\s*(a|p)?/i.exec(t); if(!m) return null; var h=+m[1]%12, mi=+(m[2]||0); if(m[3]&&m[3].toLowerCase()==='p') h+=12; return h*60+mi;}
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
  var th=document.getElementById('todayHrs'),tl=list.querySelector('li.today');
  if(th){th.textContent=tl?tl.getAttribute('data-time'):'Closed';if(open)th.parentNode.querySelector('span').textContent='open now';}
})();
</script>`;

// Each UI style re-skins the same structure (rules from UI/UX Pro Max styles data).
function siteStyleCss(style, dark) {
  const ink = 'var(--ink)';
  switch (style) {
    case 'clay': return `.svc,.tile,.why,.card,.float,.chip,.frame,.g,.mi,.row{border:3px solid color-mix(in srgb,var(--accent) 22%,#fff)!important;border-radius:28px!important;box-shadow:inset -4px -4px 10px rgba(0,0,0,.06),inset 4px 4px 10px rgba(255,255,255,.7),0 18px 34px -18px color-mix(in srgb,var(--accent) 55%,transparent)!important}
.btn{border-radius:22px!important;box-shadow:inset -3px -3px 8px rgba(0,0,0,.15),inset 3px 3px 8px rgba(255,255,255,.35),0 12px 24px -10px var(--accent)!important;transition:transform .3s cubic-bezier(.34,1.56,.64,1)!important}
.btn:hover{transform:translateY(-3px) scale(1.03)!important}
body{background:linear-gradient(180deg,var(--bg),color-mix(in srgb,var(--accent) 6%,var(--bg)))}
.svc:hover,.tile:hover{transform:translateY(-6px) scale(1.02)!important}`;
    case 'glass': return `.svc,.tile,.why,.card,.float,.chip,.mi,.row{background:color-mix(in srgb,var(--surface) ${dark ? 45 : 55}%,transparent)!important;backdrop-filter:blur(16px) saturate(140%);-webkit-backdrop-filter:blur(16px) saturate(140%);border:1px solid ${dark ? 'rgba(255,255,255,.14)' : 'rgba(255,255,255,.7)'}!important;box-shadow:0 20px 50px -30px rgba(0,0,0,.45)!important}
section.block{position:relative;isolation:isolate}
section.block::before{content:'';position:absolute;inset:0;z-index:-1;background:radial-gradient(40% 50% at 15% 30%,color-mix(in srgb,var(--accent) 22%,transparent),transparent 70%),radial-gradient(40% 50% at 85% 70%,color-mix(in srgb,var(--accent) 14%,transparent),transparent 70%)}
section.alt{background:transparent}`;
    case 'brutal': return `.svc,.tile,.why,.card,.float,.chip,.frame,.g,.stack-photo,.poster-strip figure{border:3px solid ${ink}!important;border-radius:0!important;box-shadow:6px 6px 0 ${ink}!important}
.btn{border:3px solid ${ink}!important;border-radius:0!important;box-shadow:5px 5px 0 ${ink}!important;transition:transform .08s,box-shadow .08s!important}
.btn:hover{transform:translate(-2px,-2px)!important;box-shadow:7px 7px 0 ${ink}!important}
.btn:active{transform:translate(4px,4px)!important;box-shadow:1px 1px 0 ${ink}!important}
.btn.ghost{background:var(--surface)!important}
.svc:hover,.tile:hover{transform:translate(-3px,-3px)!important;box-shadow:9px 9px 0 ${ink}!important}
.tile.t1{background:color-mix(in srgb,var(--accent) 25%,#fff)}
.marquee,.trust{border-block:3px solid ${ink}}
.h-circle .frame{border-radius:50%!important}
nav.nav-bar{border-bottom:3px solid ${ink}}`;
    case 'swiss': return `.svc,.tile,.why,.card,.float,.frame,.g{border-radius:0!important;box-shadow:none!important}
.svc,.why,.card{border:0!important;border-top:2px solid ${ink}!important;background:transparent!important;padding-left:0!important;padding-right:0!important}
.btn{border-radius:0!important;box-shadow:none!important}
.chip{border-radius:0!important}
.head{border-bottom:1px solid var(--line);padding-bottom:24px}
.hero h1 .w:last-child>span{color:var(--ink)}.hero h1 .w:last-child>span::after{content:'.';color:var(--accent)}
.tx-glow,.tx-blob{display:none}`;
    case 'editorial': return `.svc,.why,.card{border-radius:2px!important;box-shadow:none!important}
.about p::first-letter{float:left;font-family:inherit;font-size:4.2em;line-height:.8;margin:6px 10px 0 0;color:var(--accent);font-weight:700}
.head h2{font-style:italic}
.eyebrow{border-top:2px solid var(--accent);padding-top:10px;display:inline-block}
section.block+section.block{border-top:1px solid var(--line)}
.why .num{font-size:72px!important}
.btn{border-radius:2px!important}`;
    case 'vibrant': return `section.alt{background:var(--accent)!important;color:var(--on)}
section.alt .why{background:color-mix(in srgb,var(--on) 10%,transparent)!important;border-color:color-mix(in srgb,var(--on) 25%,transparent)!important;color:var(--on)}
section.alt .why p,section.alt .head p,section.alt .whyq p{color:color-mix(in srgb,var(--on) 80%,transparent)!important}
section.alt .eyebrow,section.alt .why .num,section.alt .whyq h3::before{color:var(--on)!important}
section.alt .why .dot{background:var(--on)}
.svc,.tile{border-radius:22px!important}
.svc:hover{background:var(--accent)!important;color:var(--on)}.svc:hover p,.svc:hover .price{color:var(--on)!important}
.marquee{background:var(--accent);color:var(--on)}.marquee span::after{color:var(--on)}
section.block{padding:120px 0}`;
    case 'luxury': return `.svc,.tile,.why,.card,.float,.chip{border-radius:2px!important;border:1px solid color-mix(in srgb,var(--accent) 40%,transparent)!important;background:transparent!important;box-shadow:none!important}
.btn{border-radius:2px!important;letter-spacing:.14em;text-transform:uppercase;font-size:13px!important;font-weight:700!important}
.btn.main{box-shadow:none!important}
.eyebrow{letter-spacing:.32em}
.head h2{font-weight:400}
.frame{border-radius:2px!important;outline:1px solid color-mix(in srgb,var(--accent) 50%,transparent);outline-offset:12px}
.hero h1 .w:last-child>span{font-style:italic}`;
    case 'organic': return `.svc,.why,.card,.tile{border-radius:34px 18px 34px 18px!important;box-shadow:0 8px 32px rgba(0,0,0,.08)!important}
.frame,.g{border-radius:46% 54% 42% 58%/52% 44% 56% 48%!important}
.btn{border-radius:999px!important}
.tx-blob{opacity:.5!important}`;
    case 'flat': return `.svc,.tile,.why,.card,.float,.chip,.frame,.g{box-shadow:none!important}
.svc,.why,.card{background:var(--surface2)!important;border:0!important}
.btn.main{box-shadow:none!important}
.btn{border-radius:10px!important;transition:background .15s,transform .15s!important}
.tx-grain,.tx-halo{display:none}`;
    default: return `.svc,.why,.card,.tile{box-shadow:0 2px 4px rgba(0,0,0,.04),0 18px 40px -24px rgba(0,0,0,${dark ? '.6' : '.25'})!important}
.btn{transition:transform .25s,box-shadow .25s!important}`; // soft
  }
}

function renderSite(d, D) {
  const P = palette(D, d.accent);
  const PR = DPAIRS[D.pair];
  const F = PR ? { q: gq(PR.h[0], PR.h[1]), css: `'${PR.h[0]}', Georgia, sans-serif`, upper: PR.upper, italic: PR.italic, w: PR.w, k: PR.k } : (DFONTS[D.display] || DFONTS.anton);
  const B = PR ? { q: gq(PR.b, '400;700'), css: `'${PR.b}', system-ui, sans-serif` } : (DBODY[D.body] || DBODY.manrope);
  const dark = D.mode === 'dark';
  const name = d.name || 'Your business';
  const words = name.split(/\s+/).filter(Boolean);
  const longest = Math.max(4, ...words.map((w) => w.length));
  const N = nicheFor(d.category, d.name);
  const telHref = d.phone ? 'tel:' + String(d.phone).replace(/[^\d+]/g, '') : '';
  const book = d.booking || telHref;
  const bookLabel = d.booking ? N.book : (d.phone ? (N.key === 'food' ? 'Call to order' : N.key === 'home' ? 'Call for a quote' : 'Call to book') : 'Get in touch');
  const ext = d.booking ? ' target="_blank" rel="noopener"' : '';
  const stock = d.stock || [];
  const imgs = stock.length ? stock.map((x) => x.src).concat(d.photos || []) : (d.images || []).map((id) => '/img/' + id + '.jpg').concat(d.photos || []);
  const heroImg = imgs[0] || '';
  const gal = imgs.slice(1);
  const hero = heroImg ? D.hero : 'poster';
  const sideBySide = ['split', 'splitleft', 'arch', 'slant', 'tilt', 'circle'].includes(hero);
  const fitVw = (sideBySide ? 52 : 88) / (longest * F.k);
  const mapHref = d.address ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(name + ' ' + d.address) : '';
  const sub = [d.category, d.city].filter(Boolean).join(' · ');
  const tagline = d.tagline || (d.category && d.city ? `${d.city}'s go-to ${d.category.toLowerCase()}.` : 'Welcome in.');
  const services = d.services || [], hours = d.hours || [], hl = d.highlights || [];
  const marquee = services.length ? services.map((x) => x.name) : [d.category || 'Quality', d.city || 'Local', N.book];
  const rating = d.rating ? `<span class="chip"><b>${esc(d.rating)}</b> ★ on Google${d.reviews ? ` · ${esc(d.reviews)} reviews` : ''}</span>` : '';
  const R = D.radius, BR = D.buttons === 'pill' ? 999 : D.buttons === 'rounded' ? 14 : 3;
  const sample = (d.images && d.images.length) || stock.length ? '<small class="sample">Sample photo</small>' : '';
  const credits = stock.length ? `<p class="credit">Sample photos from <a href="https://www.pexels.com" target="_blank" rel="noopener">Pexels</a>: ${[...new Map(stock.filter((x) => x.by).map((x) => [x.by, x])).values()].map((x) => x.by_url ? `<a href="${esc(x.by_url)}" target="_blank" rel="noopener">${esc(x.by)}</a>` : esc(x.by)).join(', ')}</p>` : '';
  const btnMain = (extra) => book ? `<a class="btn main${extra || ''}" href="${esc(book)}"${ext}>${esc(bookLabel)} <span aria-hidden="true">→</span></a>` : '';
  const head = (eyebrow, title, note) => `<div class="head reveal"><div><span class="eyebrow">${esc(eyebrow)}</span><h2 class="disp">${esc(title)}</h2></div>${note ? `<p>${esc(note)}</p>` : ''}</div>`;
  const disp = `font-family:${F.css};font-weight:${F.w};${F.upper ? 'text-transform:uppercase;letter-spacing:.01em;' : 'letter-spacing:-.02em;'}${F.italic ? 'font-style:italic;' : ''}`;

  const texture = {
    grain: `<div class="tx-grain"></div><div class="tx-glow"></div>`,
    dots: `<div class="tx-dots"></div><div class="tx-glow"></div>`,
    grid: `<div class="tx-grid"></div><div class="tx-glow"></div>`,
    blobs: `<div class="tx-blob b1"></div><div class="tx-blob b2"></div><div class="tx-blob b3"></div>`,
    halo: `<div class="tx-halo"></div><div class="tx-grain"></div>`,
    lines: `<div class="tx-lines"></div><div class="tx-glow"></div>`,
    rays: `<div class="tx-rays"></div>`,
    none: `<div class="tx-glow soft"></div>`,
  }[D.texture] || '';

  const h1 = `<h1 class="disp" style="font-size:clamp(34px,min(${sideBySide ? 9 : 14}vw,${fitVw.toFixed(1)}vw),${sideBySide ? 120 : 170}px)">${words.map((w, i) => `<span class="w"><span style="--i:${i}">${esc(w)}</span></span>`).join(' ')}</h1>`;
  const copy = `<div class="hero-copy">
      <div class="meta">${sub ? `<span class="chip">${esc(sub)}</span>` : ''}${rating}</div>
      ${h1}
      <p class="lead">${esc(tagline)}</p>
      <div class="cta">${btnMain()}${mapHref ? `<a class="btn ghost" href="${esc(mapHref)}" target="_blank" rel="noopener">Get directions</a>` : ''}</div>
    </div>`;
  let heroHtml;
  if (hero === 'fullbleed') {
    heroHtml = `<header class="hero h-full" id="top"><div class="bg" aria-hidden="true"><img class="hero-photo" src="${esc(heroImg)}" alt="" fetchpriority="high"><div class="shade"></div></div><div class="wrap">${copy}</div>${sample}</header>`;
  } else if (hero === 'stack') {
    heroHtml = `<header class="hero h-stack" id="top"><div class="bg" aria-hidden="true">${texture}</div><div class="wrap">${copy}<figure class="stack-photo reveal"><img src="${esc(heroImg)}" alt="${esc(name)}" fetchpriority="high">${sample}</figure></div></header>`;
  } else if (hero === 'poster') {
    heroHtml = `<header class="hero h-poster" id="top"><div class="bg" aria-hidden="true">${texture}</div><div class="wrap">${copy}${heroImg ? `<div class="poster-strip">${imgs.slice(0, 3).map((u, i) => `<figure style="--i:${i}"><img src="${esc(u)}" alt="" ${i ? 'loading="lazy"' : 'fetchpriority="high"'}></figure>`).join('')}</div>` : ''}</div></header>`;
  } else {
    heroHtml = `<header class="hero h-side h-${hero}" id="top"><div class="bg" aria-hidden="true">${texture}</div><div class="wrap hero-grid">${copy}
      <div class="hero-art"><figure class="frame"><img src="${esc(heroImg)}" alt="${esc(name)}" fetchpriority="high"></figure>
        ${d.rating ? `<div class="float f1"><b>${esc(d.rating)} ★</b><span>on Google</span></div>` : ''}<div class="float f2"><i></i><span>${esc(N.eyebrow)}</span></div>${sample}</div></div></header>`;
  }

  const svcItems = services.map((x, i) => {
    if (D.services === 'menu') return `<div class="mi reveal" style="--i:${i % 6}"><div class="mi-top"><h3>${esc(x.name)}</h3><span class="dots"></span>${x.price ? `<b>${esc(x.price)}</b>` : ''}</div>${x.desc ? `<p>${esc(x.desc)}</p>` : ''}</div>`;
    if (D.services === 'rows') return `<div class="row reveal" style="--i:${i % 6}"><span class="no">${String(i + 1).padStart(2, '0')}</span><div><h3>${esc(x.name)}</h3>${x.desc ? `<p>${esc(x.desc)}</p>` : ''}</div>${x.price ? `<b>${esc(x.price)}</b>` : '<b></b>'}</div>`;
    if (D.services === 'tiles') return `<article class="tile reveal t${i % 4}" style="--i:${i % 6}">${x.price ? `<b>${esc(x.price)}</b>` : ''}<h3>${esc(x.name)}</h3>${x.desc ? `<p>${esc(x.desc)}</p>` : ''}</article>`;
    return `<article class="svc reveal" style="--i:${i % 6}"><div class="svc-top"><h3>${esc(x.name)}</h3>${x.price ? `<span class="price">${esc(x.price)}</span>` : ''}</div>${x.desc ? `<p>${esc(x.desc)}</p>` : ''}</article>`;
  }).join('');
  const sections = {
    services: services.length ? `<section class="block" id="services"><div class="wrap">${head(N.eyebrow, N.services, services.some((x) => x.price) ? 'Prices are a starting point. Ask about anything you don’t see.' : '')}<div class="svc-${D.services}">${svcItems}</div></div></section>` : '',
    why: hl.length ? `<section class="block alt" id="why"><div class="wrap">${D.why === 'quote'
      ? `<div class="whyq">${hl.map((x, i) => `<div class="reveal" style="--i:${i}"><h3 class="disp">${esc(x.title)}</h3>${x.text ? `<p>${esc(x.text)}</p>` : ''}</div>`).join('')}</div>`
      : `${head('Why ' + (words[0] || 'us'), 'The difference')}<div class="whys why-${D.why}">${hl.map((x, i) => `<article class="why reveal" style="--i:${i}">${D.why === 'numbered' ? `<span class="num disp">0${i + 1}</span>` : '<span class="dot"></span>'}<h3>${esc(x.title)}</h3>${x.text ? `<p>${esc(x.text)}</p>` : ''}</article>`).join('')}</div>`}</div></section>` : '',
    about: d.about ? `<section class="block" id="about"><div class="wrap about"><blockquote class="disp reveal">${esc(name)}${d.city ? `<br><em>in ${esc(d.city)}.</em>` : ''}</blockquote><p class="reveal" style="--i:1">${esc(d.about)}</p></div></section>` : '',
    gallery: gal.length ? `<section class="block" id="gallery"><div class="wrap">${head('A look inside', 'The vibe', (d.images && d.images.length) || stock.length ? 'Sample photos for this preview. We’d swap in your real ones.' : '')}
      <div class="gal-${D.gallery}">${gal.map((u, i) => `<figure class="g reveal g${i}" style="--i:${i}"><img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer"></figure>`).join('')}</div></div></section>` : '',
  };
  const hoursHtml = hours.map((h) => `<li data-day="${esc(h.day)}" data-time="${esc(h.time)}"><span>${esc(h.day)}</span><span>${esc(h.time)}</span></li>`).join('');
  const motion = { rise: 'translateY(30px)', fade: 'scale(.97)', slide: 'translateX(-30px)' }[D.motion] || 'translateY(30px)';
  const fontLinks = [F.q, B.q].map((q) => `<link href="https://fonts.googleapis.com/css2?${q}&display=swap" rel="stylesheet">`).join('');
  const open = hours.length ? 'data-hours' : '';
  const trust = [d.rating ? `<div><b>${esc(d.rating)} ★</b><span>Google rating</span></div>` : '', d.reviews ? `<div><b>${esc(d.reviews)}</b><span>reviews</span></div>` : '',
    services.length ? `<div><b>${services.length}</b><span>${esc(N.services.toLowerCase())}</span></div>` : '', hours.length ? `<div id="todayBox"><b id="todayHrs">—</b><span>today</span></div>` : '',
    d.city ? `<div><b>${esc(d.city)}</b><span>local</span></div>` : ''].filter(Boolean);
  const trustHtml = trust.length >= 2 ? `<div class="trust"><div class="wrap"><div class="trust-row">${trust.join('')}</div></div></div>` : '';
  const styleCss = siteStyleCss(D.style, dark);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="${P.bg}">
<title>${esc(name)}${sub ? ' | ' + esc(sub) : ''}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
${fontLinks}
<style>
:root{--bg:${P.bg};--surface:${P.surface};--surface2:${P.surface2};--ink:${P.ink};--muted:${P.muted};--line:${P.line};--accent:${P.accent};--on:${P.onAccent};--r:${R}px;--br:${BR}px;--body:${B.css};color-scheme:${dark ? 'dark' : 'light'}}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{background:var(--bg);color:var(--ink);font-family:var(--body);font-size:17px;line-height:1.6;-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:inherit;text-decoration:none}
img{max-width:100%;display:block}
.wrap{max-width:1180px;margin:0 auto;padding-left:max(20px,env(safe-area-inset-left));padding-right:max(20px,env(safe-area-inset-right))}
.disp{${disp}line-height:.95}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;height:54px;padding:0 26px;border-radius:var(--br);font-weight:800;font-size:16px;border:1.5px solid var(--line);transition:transform .2s,box-shadow .25s,background .2s}
.btn:hover{transform:translateY(-2px)}
.btn.main{background:var(--accent);color:var(--on);border-color:transparent;box-shadow:0 16px 40px -14px var(--accent)}
.btn.main:hover{box-shadow:0 22px 50px -12px var(--accent)}
.btn.ghost{background:color-mix(in srgb,var(--surface) 60%,transparent);color:var(--ink);backdrop-filter:blur(8px)}
.btn:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:var(--br);border:1px solid var(--line);font-size:14px;color:var(--muted);background:color-mix(in srgb,var(--surface) 75%,transparent);backdrop-filter:blur(6px)}
.chip b{color:var(--ink)}
.eyebrow{font-size:12.5px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:var(--accent)}
.ribbon{position:relative;z-index:30;background:var(--accent);color:var(--on);text-align:center;font-size:13px;font-weight:700;padding:8px 44px}
.ribbon button{position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:0;color:inherit;font-size:18px;cursor:pointer;width:30px;height:30px}
nav{position:sticky;top:0;z-index:20}
nav .in{display:flex;align-items:center;justify-content:space-between;gap:12px;height:68px}
.nav-bar{backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);background:color-mix(in srgb,var(--bg) 80%,transparent);border-bottom:1px solid var(--line)}
.nav-float{padding-top:12px}
.nav-float .in{height:58px;padding:0 10px 0 22px;border-radius:calc(var(--br) + 6px);border:1px solid var(--line);background:color-mix(in srgb,var(--surface) 82%,transparent);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);box-shadow:0 18px 40px -24px rgba(0,0,0,.5)}
nav .logo{${disp}font-size:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:56%}
nav .links{display:none;gap:28px;font-weight:600;font-size:15px;color:var(--muted)}
nav .links a:hover{color:var(--ink)}
nav .btn{height:42px;padding:0 18px;font-size:14px}
@media(min-width:860px){nav .links{display:flex}}
/* hero */
.hero{position:relative;overflow:hidden;isolation:isolate;padding:70px 0 80px}
.hero .bg{position:absolute;inset:0;z-index:-1;overflow:hidden}
.hero>.wrap{width:100%}
.hero h1{margin:18px 0 22px}
.hero h1 .w{display:inline-block;overflow:hidden;vertical-align:top;padding-bottom:.08em}
.hero h1 .w>span{display:inline-block;animation:rise 1s cubic-bezier(.2,.8,.2,1) both;animation-delay:calc(var(--i) * 90ms + 150ms)}
.hero h1 .w:last-child>span{color:var(--accent)}
.lead{font-size:clamp(18px,2.3vw,22px);color:var(--muted);max-width:36ch;animation:fade 1s .6s both}
.cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:30px;animation:fade 1s .8s both}
.meta{display:flex;flex-wrap:wrap;gap:10px;animation:fade 1s .4s both}
@keyframes rise{from{transform:translateY(105%)}to{transform:none}}
@keyframes fade{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes kb{from{transform:scale(1.1)}to{transform:scale(1)}}
.h-full{min-height:min(96svh,940px);display:flex;align-items:flex-end;padding-bottom:90px}
.h-full .hero-photo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;animation:kb 18s ease-out both}
.h-full .shade{position:absolute;inset:0;background:linear-gradient(0deg,var(--bg) 4%,color-mix(in srgb,var(--bg) 70%,transparent) 45%,color-mix(in srgb,var(--bg) 20%,transparent) 100%)}
@media(min-width:900px){.h-full .shade{background:linear-gradient(90deg,color-mix(in srgb,var(--bg) 94%,transparent),color-mix(in srgb,var(--bg) 55%,transparent) 55%,transparent),linear-gradient(0deg,var(--bg),transparent 30%)}.h-full{align-items:center}}
.h-side{min-height:min(92svh,900px);display:flex;align-items:center}
.hero-grid{display:grid;gap:46px;align-items:center}
@media(min-width:900px){.hero-grid{grid-template-columns:1.05fr .95fr}.h-splitleft .hero-art{order:-1}}
.hero-art{position:relative;animation:fade 1.2s .3s both}
.frame{position:relative;overflow:hidden;aspect-ratio:4/5;max-height:74svh;margin:0 auto;border-radius:var(--r);box-shadow:0 50px 100px -50px color-mix(in srgb,var(--accent) 80%,#000)}
.frame img{width:100%;height:100%;object-fit:cover;animation:kb 16s ease-out both}
.h-arch .frame{border-radius:999px 999px var(--r) var(--r);border:8px solid var(--surface)}
.h-slant .frame{border-radius:4px;clip-path:polygon(16% 0,100% 0,84% 100%,0 100%);aspect-ratio:5/6}
.h-slant .hero-art::before{content:'';position:absolute;inset:-14px;clip-path:polygon(16% 0,100% 0,84% 100%,0 100%);background:linear-gradient(135deg,var(--accent),transparent 60%);opacity:.75}
.h-tilt .frame{transform:rotate(2.5deg);border:10px solid var(--surface)}
.h-circle .frame{border-radius:50%;aspect-ratio:1;outline:2px dashed color-mix(in srgb,var(--accent) 60%,transparent);outline-offset:14px;max-width:480px}
.float{position:absolute;display:flex;align-items:center;gap:8px;padding:12px 16px;border-radius:calc(var(--r) * .6 + 8px);background:var(--surface);color:var(--ink);border:1px solid var(--line);box-shadow:0 20px 50px -20px rgba(0,0,0,.5);font-size:14px;animation:bob 5s ease-in-out infinite}
.float b{${disp}font-size:20px;color:var(--accent)}
.float span{color:var(--muted);font-weight:600}
.float i{width:10px;height:10px;border-radius:50%;background:var(--accent)}
.f1{left:-12px;bottom:16%}.f2{right:-8px;top:10%;animation-delay:-2.5s}
@media(max-width:899px){.f1{left:6px}.f2{right:6px}.frame{max-height:58svh}}
@keyframes bob{50%{transform:translateY(-10px)}}
.sample{position:absolute;right:12px;bottom:12px;z-index:3;font:700 10.5px/1 var(--body);letter-spacing:.08em;text-transform:uppercase;padding:6px 9px;border-radius:99px;background:rgba(0,0,0,.55);color:#fff}
.h-stack .stack-photo{position:relative;margin-top:50px;border-radius:var(--r);overflow:hidden;aspect-ratio:16/8}
.h-stack .stack-photo img{width:100%;height:100%;object-fit:cover}
@media(max-width:700px){.h-stack .stack-photo{aspect-ratio:4/3}}
.h-poster{padding-top:90px}
.h-poster .hero-copy{text-align:center;display:flex;flex-direction:column;align-items:center}
.h-poster .lead{margin:0 auto}
.h-poster .meta,.h-poster .cta{justify-content:center}
.poster-strip{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:56px}
.poster-strip figure{overflow:hidden;border-radius:var(--r);aspect-ratio:3/4;animation:fade 1s both;animation-delay:calc(var(--i) * 120ms + 500ms)}
.poster-strip figure:nth-child(2){transform:translateY(-26px)}
.poster-strip img{width:100%;height:100%;object-fit:cover}
/* textures */
.tx-glow{position:absolute;inset:-20%;background:radial-gradient(600px 380px at 15% 20%,color-mix(in srgb,var(--accent) 22%,transparent),transparent 70%),radial-gradient(520px 420px at 90% 85%,color-mix(in srgb,var(--accent) 12%,transparent),transparent 70%)}
.tx-glow.soft{opacity:.6}
.tx-grain{position:absolute;inset:0;opacity:${dark ? '.09' : '.06'};background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E")}
.tx-dots{position:absolute;inset:0;background-image:radial-gradient(color-mix(in srgb,var(--ink) 16%,transparent) 1.2px,transparent 1.5px);background-size:24px 24px;mask-image:linear-gradient(180deg,#000,transparent 75%);-webkit-mask-image:linear-gradient(180deg,#000,transparent 75%)}
.tx-grid{position:absolute;inset:-40% -10% 0;background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:56px 56px;transform:perspective(600px) rotateX(55deg);transform-origin:center bottom;animation:road 3s linear infinite;mask-image:linear-gradient(to top,#000 10%,transparent 75%);-webkit-mask-image:linear-gradient(to top,#000 10%,transparent 75%)}
@keyframes road{to{background-position:0 56px}}
.tx-blob{position:absolute;border-radius:42% 58% 63% 37%/41% 44% 56% 59%;filter:blur(${dark ? 70 : 50}px);opacity:${dark ? .45 : .6};animation:morph 16s ease-in-out infinite}
.tx-blob.b1{width:50vmax;height:50vmax;background:color-mix(in srgb,var(--accent) 60%,var(--bg));left:-14vmax;top:-16vmax}
.tx-blob.b2{width:40vmax;height:40vmax;background:color-mix(in srgb,var(--accent) 35%,#fff0);right:-12vmax;top:12vmax;animation-delay:-6s}
.tx-blob.b3{width:30vmax;height:30vmax;background:var(--surface2);left:35%;bottom:-14vmax;animation-delay:-10s}
@keyframes morph{50%{border-radius:58% 42% 38% 62%/55% 61% 39% 45%;transform:rotate(14deg) scale(1.06)}}
.tx-halo{position:absolute;width:140vmax;height:140vmax;left:50%;top:50%;translate:-50% -50%;background:conic-gradient(from 0deg,transparent 0 60%,color-mix(in srgb,var(--accent) 36%,transparent) 72%,transparent 84%);animation:spin 24s linear infinite;opacity:.5;filter:blur(40px)}
@keyframes spin{to{rotate:360deg}}
.tx-lines{position:absolute;inset:0;background:repeating-linear-gradient(115deg,transparent 0 38px,color-mix(in srgb,var(--accent) 10%,transparent) 38px 39px);mask-image:radial-gradient(70% 70% at 30% 30%,#000,transparent);-webkit-mask-image:radial-gradient(70% 70% at 30% 30%,#000,transparent)}
.tx-rays{position:absolute;inset:-30%;background:repeating-conic-gradient(from 0deg at 80% 0%,color-mix(in srgb,var(--accent) 14%,transparent) 0deg 6deg,transparent 6deg 18deg);animation:spin 80s linear infinite;mask-image:radial-gradient(closest-side,#000,transparent);-webkit-mask-image:radial-gradient(closest-side,#000,transparent)}
/* marquee */
.marquee{border-block:1px solid var(--line);overflow:hidden;padding:18px 0;background:var(--surface)}
.marquee .track{display:flex;gap:44px;width:max-content;animation:scroll 30s linear infinite}
.marquee span{${disp}font-size:clamp(22px,4vw,34px);white-space:nowrap}
.marquee span::after{content:'✦';color:var(--accent);margin-left:44px;font-style:normal}
@keyframes scroll{to{transform:translateX(-50%)}}
/* sections */
section.block{padding:100px 0}
section.alt{background:var(--surface2)}
.head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:16px;margin-bottom:40px}
.head h2{font-size:clamp(40px,7vw,78px);margin-top:10px}
.head p{color:var(--muted);max-width:40ch}
.svc-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.svc{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:26px;transition:transform .3s,border-color .3s,box-shadow .3s}
.svc:hover{transform:translateY(-6px);border-color:color-mix(in srgb,var(--accent) 60%,transparent);box-shadow:0 30px 60px -30px color-mix(in srgb,var(--accent) 60%,transparent)}
.svc-top{display:flex;justify-content:space-between;align-items:baseline;gap:14px}
.svc h3,.mi h3,.row h3,.tile h3{font-size:20px;font-weight:800;letter-spacing:-.01em}
.price{${disp}font-size:26px;color:var(--accent);white-space:nowrap}
.svc p,.mi p,.row p,.tile p{color:var(--muted);margin-top:6px;font-size:15.5px}
.svc-menu{max-width:820px;display:grid;gap:26px}
.mi-top{display:flex;align-items:baseline;gap:12px}
.mi .dots{flex:1;border-bottom:2px dotted color-mix(in srgb,var(--ink) 30%,transparent);transform:translateY(-5px)}
.mi b{${disp}font-size:24px;color:var(--accent);white-space:nowrap}
.svc-rows{border-top:1px solid var(--line)}
.row{display:grid;grid-template-columns:56px 1fr auto;gap:18px;align-items:center;padding:24px 4px;border-bottom:1px solid var(--line);transition:background .25s,padding .25s}
.row:hover{background:color-mix(in srgb,var(--accent) 7%,transparent);padding-left:14px}
.row .no{${disp}font-size:22px;color:var(--accent)}
.row b{${disp}font-size:26px;white-space:nowrap}
.svc-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
.tile{position:relative;padding:28px 24px;border-radius:var(--r);min-height:200px;display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden;background:var(--surface);border:1px solid var(--line)}
.tile.t0{background:var(--accent);color:var(--on);border-color:transparent}.tile.t0 p{color:color-mix(in srgb,var(--on) 75%,transparent)}
.tile.t2{background:var(--surface2)}
.tile b{position:absolute;top:22px;right:22px;${disp}font-size:28px}
.whys{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.why{padding:30px 26px;border-radius:var(--r);background:var(--surface);border:1px solid var(--line)}
.why-bordered .why{background:transparent;border:0;border-top:3px solid var(--accent);border-radius:0;padding:22px 0}
.why .num{font-size:50px;line-height:1;color:var(--accent)}
.why .dot{display:block;width:14px;height:14px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 6px color-mix(in srgb,var(--accent) 22%,transparent)}
.why h3{font-size:21px;font-weight:800;margin:16px 0 6px}
.why p{color:var(--muted);font-size:15.5px}
.whyq{display:grid;gap:44px}
.whyq h3{font-size:clamp(34px,6vw,64px)}
.whyq h3::before{content:'“';color:var(--accent);margin-right:.08em}
.whyq p{color:var(--muted);max-width:52ch;margin-top:10px;font-size:18px}
.about{display:grid;gap:40px;align-items:center}
@media(min-width:860px){.about{grid-template-columns:1.1fr .9fr}}
.about blockquote{font-size:clamp(32px,5vw,58px);line-height:1.02}
.about blockquote em{color:var(--accent);font-style:inherit}
.about p{color:var(--muted);font-size:18px;white-space:pre-line}
.g{overflow:hidden;border-radius:var(--r);border:1px solid var(--line)}
.g img{width:100%;height:100%;object-fit:cover;transition:transform .8s cubic-bezier(.2,.8,.2,1)}
.g:hover img{transform:scale(1.06)}
.gal-mosaic{display:grid;gap:14px;grid-template-columns:repeat(6,1fr)}
.gal-mosaic .g{grid-column:span 6;aspect-ratio:4/3}
@media(min-width:760px){.gal-mosaic .g0{grid-column:span 4;grid-row:span 2;aspect-ratio:auto}.gal-mosaic .g1,.gal-mosaic .g2{grid-column:span 2}.gal-mosaic .g3,.gal-mosaic .g4{grid-column:span 3}}
.gal-strip{display:flex;gap:14px;overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:10px;scrollbar-width:none}
.gal-strip::-webkit-scrollbar{display:none}
.gal-strip .g{flex:0 0 min(78vw,420px);aspect-ratio:3/4;scroll-snap-align:start}
.gal-polaroid{display:grid;gap:26px;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));padding:10px}
.gal-polaroid .g{background:#fff;padding:12px 12px 46px;border-radius:6px;aspect-ratio:4/5;box-shadow:0 30px 50px -30px rgba(0,0,0,.6);border:0}
.gal-polaroid .g:nth-child(odd){transform:rotate(-2.5deg)}.gal-polaroid .g:nth-child(even){transform:rotate(2deg)}
.visit{display:grid;gap:14px}
@media(min-width:860px){.visit{grid-template-columns:1fr 1fr}}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:30px}
.hours{list-style:none}
.hours li{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--line)}
.hours li:last-child{border-bottom:0}
.hours li.today{color:var(--accent);font-weight:800}
.status{display:inline-flex;align-items:center;gap:8px;font-weight:800;font-size:14px;margin-bottom:12px}
.status i{width:9px;height:9px;border-radius:50%;background:var(--muted)}
.status.open i{background:#35d07f;box-shadow:0 0 0 6px rgba(53,208,127,.18)}
.contact a{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px 0;border-bottom:1px solid var(--line);font-weight:700}
.contact a span:last-child{color:var(--muted);font-weight:500;text-align:right;overflow-wrap:anywhere}
.contact a:last-child{border-bottom:0}
.final{text-align:center;padding:130px 0;position:relative;overflow:hidden;isolation:isolate}
.final::before{content:'';position:absolute;inset:0;z-index:-1;background:radial-gradient(60% 70% at 50% 100%,color-mix(in srgb,var(--accent) 32%,transparent),transparent 70%)}
.final h2{font-size:clamp(46px,10vw,124px);margin-bottom:30px}
footer{border-top:1px solid var(--line);padding:30px 0 60px;color:var(--muted);font-size:14px}
footer .wrap{display:flex;flex-wrap:wrap;justify-content:space-between;gap:10px}
.credit{flex-basis:100%;font-size:12px;opacity:.8}.credit a{text-decoration:underline}
.js .reveal{opacity:0;transform:${motion};transition:opacity .8s cubic-bezier(.2,.8,.2,1),transform .8s cubic-bezier(.2,.8,.2,1);transition-delay:calc(var(--i,0) * 80ms)}
.js .reveal.in{opacity:1;transform:none}
.gal-polaroid .g.reveal.in:nth-child(odd){transform:rotate(-2.5deg)}.gal-polaroid .g.reveal.in:nth-child(even){transform:rotate(2deg)}
.sticky-call{position:fixed;left:16px;right:16px;bottom:calc(14px + env(safe-area-inset-bottom));z-index:25;display:flex}
.sticky-call .btn{flex:1}
@media(min-width:860px){.sticky-call{display:none}}
.trust{border-block:1px solid var(--line);background:var(--surface)}
.trust-row{display:flex;flex-wrap:wrap;justify-content:space-around;gap:10px 28px;padding:22px 0}
.trust-row div{display:flex;flex-direction:column;align-items:center;text-align:center;min-width:90px}
.trust-row b{font-family:${F.css};font-weight:${F.w};font-size:clamp(22px,3vw,30px);line-height:1.1;color:var(--ink)}
.trust-row span{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.12em;margin-top:4px}
${styleCss}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.js .reveal{opacity:1;transform:none}}
</style>
</head>
<body>
<div class="ribbon">Free website preview made for ${esc(name)}<button type="button" aria-label="Hide" onclick="this.parentNode.remove()">×</button></div>
<nav class="nav-${D.nav}"><div class="wrap"><div class="in">
  <a class="logo" href="#top">${esc(name)}</a>
  <div class="links">${services.length ? `<a href="#services">${esc(N.services)}</a>` : ''}${d.about ? '<a href="#about">About</a>' : ''}<a href="#visit">Visit</a></div>
  ${book ? `<a class="btn main" href="${esc(book)}"${ext}>${esc(bookLabel)}</a>` : ''}
</div></div></nav>
${heroHtml}
${trustHtml}
${D.marquee ? `<div class="marquee" aria-hidden="true"><div class="track">${[...marquee, ...marquee, ...marquee, ...marquee].map((x) => `<span>${esc(x)}</span>`).join('')}</div></div>` : ''}
${D.order.map((k) => sections[k] || '').join('\n')}
<section class="block" id="visit"><div class="wrap">
  ${head('Visit', 'Come through')}
  <div class="visit">
    ${hours.length ? `<div class="card reveal"><div class="status" id="status"><i></i><span>Hours</span></div><ul class="hours" id="hours">${hoursHtml}</ul></div>` : ''}
    <div class="card contact reveal" style="--i:1">
      ${d.phone ? `<a href="${esc(telHref)}"><span>Call</span><span>${esc(d.phone)}</span></a>` : ''}
      ${d.address ? `<a href="${esc(mapHref)}" target="_blank" rel="noopener"><span>Address</span><span>${esc(d.address)}</span></a>` : ''}
      ${d.email ? `<a href="mailto:${esc(d.email)}"><span>Email</span><span>${esc(d.email)}</span></a>` : ''}
      ${d.instagram ? `<a href="${esc(d.instagram)}" target="_blank" rel="noopener"><span>Instagram</span><span>Follow us →</span></a>` : ''}
      ${!d.phone && !d.address && !d.email && !d.instagram ? '<p style="color:var(--muted)">Contact details go here.</p>' : ''}
    </div>
  </div>
</div></section>
<section class="final"><div class="wrap">
  <h2 class="disp reveal">${d.cta ? esc(d.cta) : 'Ready when<br>you are.'}</h2>
  ${book ? `<div class="reveal" style="--i:1">${btnMain()}</div>` : ''}
</div></section>
<footer><div class="wrap"><span>© ${new Date().getFullYear()} ${esc(name)}</span><span>Preview site by Reekon Systems</span>${credits}</div></footer>
${book ? `<div class="sticky-call"><a class="btn main" href="${esc(book)}"${ext}>${esc(bookLabel)}</a></div>` : ''}
${SITE_SCRIPT}
</body>
</html>`;
}

function cleanDesign(x) {
  if (!x || typeof x !== 'object' || !x.v) return null;
  return makeDesign({}, x, 'repair');
}

/* ================= Demo photos =================
   First choice: real stock photos from Pexels (free, real, licensed for business use).
   Fallback: the free Cloudflare AI image model. */
const PEXELS_QUERIES = {
  pets: ['dog grooming', 'groomed dog', 'dog bath', 'pet groomer', 'fluffy dog portrait', 'small dog salon'],
  barber: ['barber haircut', 'barbershop', 'barber fade', 'barber shaving beard', 'barber chair'],
  nails: ['manicure', 'nail salon', 'nail art', 'nail polish manicure'],
  lash: ['eyelash extensions', 'beauty salon facial', 'spa treatment', 'makeup artist'],
  hair: ['hair salon', 'hairstylist', 'braids hairstyle', 'hair styling woman'],
  tattoo: ['tattoo artist', 'tattoo studio', 'tattoo arm'],
  auto: ['car detailing', 'car polishing', 'car wash foam', 'clean car interior', 'luxury car'],
  food: ['tacos', 'street food', 'restaurant food plate', 'food truck', 'burger fries'],
  fitness: ['gym workout', 'personal trainer', 'weightlifting gym', 'boxing training'],
  home: ['house cleaning', 'landscaping garden', 'plumber working', 'handyman tools', 'clean kitchen'],
  general: ['small business owner', 'local shop interior', 'storefront', 'customer service smile'],
};
function photosReady(env) { return !!env.PEXELS_KEY || aiImagesReady(env); }
async function getPhotos(env, userId, data, mode, hint) {
  if (env.PEXELS_KEY) {
    const r = await pexelsPhotos(env, data, hint);
    if (r.ok || !aiImagesReady(env)) return r;
  }
  const ids = await makeDemoPhotos(env, userId, data, mode, hint);
  return ids.length ? { ok: true, set: { images: ids, stock: [] } } : { ok: false, error: ids.error };
}
async function pexelsPhotos(env, data, hint) {
  const N = nicheFor(data.category, data.name);
  const qs = PEXELS_QUERIES[N.key] || PEXELS_QUERIES.general;
  // "new photos of huskies" → search for what they asked for
  const asked = String(hint || '').toLowerCase().replace(/\b(new|different|other|more|better|change|redo|swap|photos?|pictures?|pics|images?|please|make|give me|the|with|of|some|show|use)\b/g, ' ').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  const query = asked.length >= 3 ? asked.slice(0, 60) : qs[Math.floor(Math.random() * qs.length)];
  try {
    let j;
    if (env.PEXELS_KEY === 'fake') {
      j = { photos: Array.from({ length: 12 }, (_, i) => ({ id: 1000 + i, alt: query + ' ' + i, photographer: 'Test Photographer ' + i, photographer_url: 'https://www.pexels.com/@test' + i, url: 'https://www.pexels.com/photo/' + (1000 + i) + '/',
        src: { large2x: 'https://images.pexels.com/photos/' + (1000 + i) + '/pexels-photo.jpeg?w=1880', large: 'https://images.pexels.com/photos/' + (1000 + i) + '/pexels-photo.jpeg?w=940' } })) };
    } else {
      const page = 1 + Math.floor(Math.random() * 3);
      const r = await fetch('https://api.pexels.com/v1/search?query=' + encodeURIComponent(query) + '&per_page=30&page=' + page, { headers: { Authorization: env.PEXELS_KEY } });
      if (r.status === 401 || r.status === 403) return { ok: false, error: 'Pexels rejected the key (check PEXELS_KEY in Cloudflare)' };
      if (r.status === 429) return { ok: false, error: 'Pexels hourly limit reached, try again in a bit' };
      if (!r.ok) return { ok: false, error: 'Pexels said ' + r.status };
      j = await r.json();
      if ((!j.photos || j.photos.length < 4) && page > 1) {
        const r2 = await fetch('https://api.pexels.com/v1/search?query=' + encodeURIComponent(query) + '&per_page=30&page=1', { headers: { Authorization: env.PEXELS_KEY } });
        if (r2.ok) j = await r2.json();
      }
    }
    const list = (j.photos || []).filter((p) => p && p.src && /^https:\/\/images\.pexels\.com\//.test(p.src.large2x || ''));
    if (list.length < 2) return { ok: false, error: 'no Pexels photos found for "' + query + '"' };
    const picked = list.sort(() => Math.random() - 0.5).slice(0, 4);
    return { ok: true, query, set: { images: [], stock: picked.map((p, i) => ({ src: i ? p.src.large : p.src.large2x, alt: String(p.alt || '').slice(0, 140), by: String(p.photographer || '').slice(0, 80), by_url: p.photographer_url || '', page: p.url || '' })) } };
  } catch (e) { console.error('pexels', e); return { ok: false, error: 'could not reach Pexels' }; }
}

/* ================= Demo photos (free Cloudflare AI image model) ================= */
const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const PHOTO_MOOD = { dark: 'moody cinematic lighting, rich deep tones', light: 'bright airy natural daylight, clean and fresh', noir: 'moody warm cinematic lighting, dark rich tones', glow: 'soft airy pastel light, elegant, dreamy', drive: 'dramatic high-contrast lighting, bold, energetic', fresh: 'bright cheerful natural daylight, clean, warm and friendly' };
function aiImagesReady(env) { return !!env.AI || env.STUDIO_FAKE_AI === '1'; }
async function makeDemoPhotos(env, userId, data, theme, hint) {
  const N = nicheFor(data.category, data.name);
  const mood = PHOTO_MOOD[theme] || PHOTO_MOOD.noir;
  const extra = hint && /photo|picture|pic|image/i.test(hint) ? ' ' + String(hint).replace(/\b(new|different|other|more|better|change|redo|swap|photos?|pictures?|pics|images?|please|make|give me|the)\b/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  const prompts = N.photos.slice(0, 4).map((p) => `${p}${extra ? ', ' + extra : ''}. Professional editorial photograph, ${mood}, sharp focus, realistic, high detail. No text, no words, no letters, no logos, no watermark.`);
  const errors = [];
  const one = async (prompt, i) => {
    let stage = 'ai';
    try {
      let bytes, mime;
      if (env.STUDIO_FAKE_AI === '1') {
        mime = 'image/svg+xml';
        const hue = (i * 70 + (theme === 'glow' ? 330 : theme === 'fresh' ? 20 : 40)) % 360;
        bytes = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 1000"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},45%,28%)"/></linearGradient></defs><rect width="800" height="1000" fill="url(#g)"/><circle cx="400" cy="430" r="190" fill="rgba(255,255,255,.18)"/><text x="400" y="860" font-family="sans-serif" font-size="40" fill="#fff" text-anchor="middle">${N.key} photo ${i + 1}</text></svg>`);
      } else {
        const r = await env.AI.run(IMAGE_MODEL, { prompt, steps: 6, seed: Math.floor(Math.random() * 1e9) });
        stage = 'decode';
        if (!r || !r.image) throw new Error('the image model sent back no picture' + (r ? ' (got ' + Object.keys(r).join(',') + ')' : ''));
        const bin = atob(r.image);
        bytes = new Uint8Array(bin.length);
        for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
        mime = 'image/jpeg';
      }
      stage = 'save';
      const id = hex(crypto.getRandomValues(new Uint8Array(10)));
      await env.DB.prepare('INSERT INTO demo_images (id, user_id, mime, data, prompt, created_at) VALUES (?,?,?,?,?,?)').bind(id, userId, mime, bytes, prompt.slice(0, 600), now()).run();
      return id;
    } catch (e) { console.error('photo', stage, e); errors.push(stage + ': ' + String((e && e.message) || e).slice(0, 160)); return null; }
  };
  // two at a time, so we don't trip the AI's rate limit
  const results = [];
  for (let i = 0; i < prompts.length; i += 2) results.push(...(await Promise.all(prompts.slice(i, i + 2).map((p, j) => one(p, i + j)))));
  const ok = results.filter(Boolean);
  ok.error = errors[0] || '';
  return ok;
}

/* ================= Demo Studio AI (Stage 4C) =================
   The AI writes the content (copy, services, highlights) and picks a theme;
   the premium themes above do the design. factCheck() drops any phone, price,
   rating, hours or link the AI wrote that isn't in what the user gave it. */
const STUDIO_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
function aiEngine(env) {
  if (env.ANTHROPIC_API_KEY) return 'claude';
  if (env.AI || env.STUDIO_FAKE_AI === '1') return 'workers-ai';
  return 'basic';
}
function studioLead(l) { return { id: l.id, business: l.business, owner: l.owner, phone: l.phone, email: l.email, city: l.city, category: l.category, address: l.address, rating: l.rating, link: l.link, website: l.website, demo_url: l.demo_url }; }
function draftOut(d) { return { id: d.id, lead_id: d.lead_id, theme: d.theme, data: JSON.parse(d.data || '{}'), messages: JSON.parse(d.messages || '[]'), updated_at: d.updated_at }; }
function leadSource(l) {
  return ['Business: ' + (l.business || ''), l.category && 'Category: ' + l.category, l.city && 'City: ' + l.city, l.phone && 'Phone: ' + l.phone,
    l.email && 'Email: ' + l.email, l.address && 'Address: ' + l.address, l.rating && 'Google rating: ' + l.rating].filter(Boolean).join('\n');
}

const STUDIO_SYSTEM = `You design one-page websites for small local businesses (barbers, nail and lash studios, auto detailers, taco spots, trades...).
You only write the CONTENT as JSON. A design engine turns it into an animated premium site.

Return ONLY one JSON object, no markdown, shaped like:
{"reply":"1-2 short friendly sentences telling the user what you built or changed",
 "design":{"style":"STYLE","pair":"FONTPAIR","mode":"dark|light","hue":0-360,"accent_hue":0-360,"hero":"HERO","services":"cards|menu|rows|tiles","why":"numbered|bordered|quote","gallery":"mosaic|strip|polaroid","texture":"grain|dots|grid|blobs|halo|lines|rays|none","radius":0|10|22|34,"buttons":"pill|rounded|square","nav":"bar|float","motion":"rise|fade|slide","marquee":true|false,"order":["services","why","gallery","about"]},
 "accent":"#rrggbb or empty",
 "data":{"name":"","tagline":"","category":"","city":"","about":"","cta":"",
   "services":[{"name":"","price":"","desc":""}],
   "highlights":[{"title":"","text":""}],
   "hours":[{"day":"Monday","time":"9 AM - 7 PM"}],
   "phone":"","email":"","address":"","rating":"","reviews":"","booking":"","instagram":""}}

DESIGN: invent a look that fits THIS business's personality, so no two sites look alike. Be bold and specific.
- STYLE is one of: soft (soft UI, gentle shadows), clay (claymorphism: puffy, rounded, playful; light), glass (glassmorphism: frosted cards), brutal (neo-brutalism: thick black borders, hard shadows; light), swiss (minimal grid, no shadows), editorial (magazine, drop caps), vibrant (bold color blocks), luxury (thin gold lines, uppercase; dark), organic (natural blob shapes; light), flat (solid, no shadows).
  Good fits: pets = clay/vibrant/soft; beauty, nails, lashes = soft/glass/luxury; barbers, tattoo = luxury/editorial/brutal; food = vibrant/clay/editorial; fitness = vibrant/brutal; auto = luxury/glass/swiss; home services = flat/swiss/soft.
- FONTPAIR is one of: classic, bold, wellness, retro, geometric, luxury, playful, soft, fashion, menu, indie, music, sports, luxmin, genz, startup, techy, estate, handwritten, neubrutal, clay, gaming.
- HERO is one of: fullbleed (photo behind the name), split, splitleft, arch (arched photo), slant (angled panel), tilt (tilted photo card), circle (round photo), stack (photo under the headline), poster (centered type with 3 photos).
- hue/accent_hue are color wheel degrees (0 red, 30 orange, 50 gold, 120 green, 180 teal, 210 blue, 270 purple, 330 pink).
- On the first build, choose every design field. Later, when the user asks for a visual change ("darker", "more playful", "different font", "make it pink"), change only the design fields that need to change.
Writing: tagline max 7 words, punchy, no cliches like "Welcome to". about 2-4 short sentences, warm and plain. 3 highlights with a 2-4 word title and one sentence. Service descriptions max 12 words. cta max 5 words.
HARD RULES:
- Never invent facts. Phone, email, address, prices, hours, rating, review counts, years in business, awards, staff names, booking and instagram links must come from the BUSINESS INFO. If not given, leave them empty. Never write a made-up price.
- If no services are listed, you may list 3-5 typical services for that kind of business with an empty price.
- Highlights and about must not claim numbers or facts that are not in BUSINESS INFO.
- When the user asks for a change, change only that and return the full updated data.`;

async function studioRun(env, { message, data, theme, lead, source, messages, first }) {
  const history = messages.slice(-6).map((x) => (x.role === 'user' ? 'User: ' : 'You: ') + x.text).join('\n');
  const user = `BUSINESS INFO (source of truth):\n${source}\n\nCURRENT SITE (theme ${theme || 'not picked'}):\n${first ? '(nothing yet, build the first version)' : JSON.stringify({ theme, data })}\n\n${history ? 'RECENT CHAT:\n' + history + '\n\n' : ''}REQUEST:\n${message}`;
  let text = null, engine = aiEngine(env);
  try {
    if (engine === 'claude') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: env.ANTHROPIC_MODEL || 'claude-haiku-5-5', max_tokens: 2500, system: STUDIO_SYSTEM, messages: [{ role: 'user', content: user }] }),
      });
      if (!r.ok) throw new Error('claude ' + r.status);
      const j = await r.json();
      text = (j.content || []).map((c) => c.text || '').join('');
    } else if (engine === 'workers-ai') {
      if (env.STUDIO_FAKE_AI === '1') text = fakeAi(message, data, source);
      else {
        const run = (fmt) => env.AI.run(STUDIO_MODEL, Object.assign({ messages: [{ role: 'system', content: STUDIO_SYSTEM }, { role: 'user', content: user }], max_tokens: 2200, temperature: 0.4 }, fmt ? { response_format: { type: 'json_object' } } : {}));
        let r;
        try { r = await run(true); } catch { r = await run(false); }
        text = r && (typeof r.response === 'string' ? r.response : JSON.stringify(r.response));
      }
    }
  } catch (e) { console.error('studio ai', e); text = null; }
  const parsed = text ? parseJsonLoose(text) : null;
  if (parsed && parsed.data && typeof parsed.data === 'object') {
    return { reply: str(parsed.reply, 400) || 'Done. Take a look at the preview.', theme: parsed.theme, design: parsed.design,
      data: Object.assign({}, data, parsed.data, { photos: data.photos || [], images: data.images || [], design: data.design }), engine };
  }
  // no AI (or it failed): basic builder
  const b = basicBuild(message, data, lead, source, first);
  const m2 = message.toLowerCase();
  const want = {};
  if (/\b(dark|darker|black|moody|night)\b/.test(m2)) want.mode = 'dark';
  if (/\b(light|lighter|bright|brighter|white|airy|clean)\b/.test(m2)) want.mode = 'light';
  if (/\b(round|rounder|soft|softer|bubbly)\b/.test(m2)) want.radius = 34;
  if (/\b(sharp|sharper|square|edgy)\b/.test(m2)) { want.radius = 0; want.buttons = 'square'; }
  if (Object.keys(want).length) b.reply = 'Updated the look. ' + b.reply;
  return { ...b, design: Object.keys(want).length ? want : undefined, engine: 'basic', reply: (engine === 'basic' ? '' : "The AI didn't answer this time, so I used the basic builder. ") + b.reply };
}

function parseJsonLoose(t) {
  t = String(t).replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* ignore */ } }
  return null;
}

// Keep only facts that really appear in what the user pasted (or the lead record).
function factCheck(d, prev, source) {
  d = Object.assign({}, d || {});
  const src = String(source || '').toLowerCase();
  const digits = src.replace(/\D/g, '');
  const prevStr = JSON.stringify(prev || {}).toLowerCase();
  const has = (v) => !v || src.includes(String(v).toLowerCase()) || prevStr.includes(String(v).toLowerCase());
  const hasDigits = (v) => { const x = String(v || '').replace(/\D/g, ''); return !x || digits.includes(x) || prevStr.replace(/\D/g, '').includes(x); };
  if (d.phone && (normPhone(d.phone).length < 10 || !hasDigits(normPhone(d.phone)))) d.phone = '';
  if (d.email && !has(d.email)) d.email = '';
  if (d.rating && !has(String(d.rating))) d.rating = '';
  if (d.reviews && !hasDigits(d.reviews)) d.reviews = '';
  if (d.address) { const num = (/^\s*(\d+)/.exec(d.address) || [])[1]; if (!num || !hasDigits(num)) d.address = ''; }
  for (const k of ['booking', 'instagram']) {
    if (!d[k]) continue;
    const handle = String(d[k]).toLowerCase().replace(/^https?:\/\/(www\.)?/, '').split(/[/?#]/).filter(Boolean).pop() || '';
    if (!handle || !(src.includes(handle) || prevStr.includes(handle))) d[k] = '';
  }
  // every number in a price / hours line must appear as a whole number in the source
  const srcNums = new Set((src.match(/\d+(?:[.,]\d+)?/g) || []).map((x) => x.replace(',', '.')).concat((prevStr.match(/\d+(?:[.,]\d+)?/g) || []).map((x) => x.replace(',', '.'))));
  const numsOk = (v) => (String(v || '').replace(/(\d),(\d{3})/g, '$1$2').match(/\d+(?:[.,]\d+)?/g) || []).every((n) => srcNums.has(n.replace(',', '.')) || srcNums.has(String(parseFloat(n))));
  if (Array.isArray(d.services)) d.services = d.services.map((x) => (x && x.price && !numsOk(x.price) ? { ...x, price: '' } : x));
  if (d.reviews && !numsOk(d.reviews)) d.reviews = '';
  if (Array.isArray(d.hours)) d.hours = d.hours.filter((x) => x && /closed/i.test(x.time || '') ? /closed/.test(src) || prevStr.includes('closed') : numsOk(x && x.time));
  // marketing copy can't claim awards, rankings or years that the source doesn't mention
  const CLAIM = /\b(award|awarded|voted|best in|#\s?1|number one|no\. ?1|top[- ]rated|certified|licensed|since \d{4}|\d+\s*(?:\+\s*)?(?:years?|yrs)|\d{2,}\s*(?:\+\s*)?(?:clients|customers|cars|cuts|reviews))\b/i;
  const claimOk = (t) => { const m = CLAIM.exec(String(t || '')); return !m || src.includes(m[0].toLowerCase()); };
  const scrub = (t) => String(t || '').split(/(?<=[.!?])\s+/).filter(claimOk).join(' ');
  if (Array.isArray(d.highlights)) d.highlights = d.highlights.filter((x) => x && claimOk(x.title) && claimOk(x.text));
  for (const k of ['about', 'tagline', 'cta']) if (d[k]) d[k] = scrub(d[k]);
  if (Array.isArray(d.services)) d.services = d.services.map((x) => (x && !claimOk(x.desc) ? { ...x, desc: '' } : x));
  return d;
}

// Works with no AI at all: pulls facts out of the pasted text and handles simple tweaks.
function basicBuild(message, data, lead, source, first) {
  const d = Object.assign({}, data);
  const m = message.toLowerCase();
  let theme = null;
  const notes = [];
  if (/\b(noir|dark|gold|luxe|black)\b/.test(m)) theme = 'noir';
  if (/\b(glow|pink|soft|light|girly|elegant)\b/.test(m)) theme = 'glow';
  if (/\b(fresh|bright|friendly|cheerful|playful|cream|orange)\b/.test(m)) theme = 'fresh';
  if (/\b(drive|lime|neon|bold|loud|sporty)\b/.test(m)) theme = 'drive';
  const hexm = /#([0-9a-f]{6})\b/i.exec(message); if (hexm) d.accent = '#' + hexm[1];
  const tl = /(?:tagline|headline)\s*(?:to|:|=)?\s*["“]?([^"\n”]{3,70})/i.exec(message); if (tl) { d.tagline = tl[1].trim(); notes.push('headline'); }
  const text = message;
  const phone = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.exec(text); if (phone) d.phone = phone[0].trim();
  const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(text); if (email) d.email = email[0];
  const rating = /\b([1-5][.,]\d)\s*(?:★|stars?|\(|\s)\s*\(?([\d,]{1,6})?\)?/i.exec(text); if (rating) { d.rating = rating[1].replace(',', '.'); if (rating[2]) d.reviews = rating[2].replace(/,/g, ''); }
  const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
  const svc = [], hrs = [], about = [];
  const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const dm = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s*[:,-]?\s*(.*)$/i.exec(l);
    if (dm) { let time = dm[2]; if (!time && lines[i + 1] && /\d|closed/i.test(lines[i + 1])) time = lines[++i]; if (time) hrs.push({ day: DAYS.find((x) => x.startsWith(dm[1].toLowerCase())).replace(/^./, (c) => c.toUpperCase()), time }); continue; }
    const pm = /\$\s?\d[\d,.]*\+?/.exec(l);
    if (pm && l.length < 140) { const name = l.slice(0, pm.index).replace(/[\s.:–|-]+$/, '').trim(); const desc = l.slice(pm.index + pm[0].length).replace(/^[\s.:–|-]+/, '').trim(); if (name) svc.push({ name, price: pm[0].replace(/\s+/g, ''), desc }); continue; }
    if (!d.address && /^\d{2,6}\s+[\w .'-]+\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|way|ln|lane|pl|ct|hwy|pkwy)\b/i.test(l)) { d.address = l; continue; }
    if (l.length > 70 && !/https?:\/\//.test(l)) about.push(l);
  }
  if (svc.length) { d.services = svc.slice(0, 24); notes.push(svc.length + ' services'); }
  if (hrs.length) { d.hours = hrs; notes.push('hours'); }
  if (about.length && (first || !d.about)) d.about = about.slice(0, 2).join(' ');
  if (lead) { d.name = d.name || lead.business; d.category = d.category || lead.category; d.city = d.city || lead.city; d.phone = d.phone || lead.phone; d.address = d.address || lead.address; d.rating = d.rating || lead.rating; }
  if (!d.name) d.name = (lines[0] || 'Your business').slice(0, 80);
  if (!d.highlights || !d.highlights.length) d.highlights = [{ title: 'Real local service', text: 'A neighborhood spot that knows its regulars by name.' }, { title: 'Easy to book', text: 'Call or book online in under a minute.' }, { title: 'Done right', text: 'Clean work, fair prices, no surprises.' }];
  const reply = first ? 'Built a first version from what you pasted' + (notes.length ? ' (' + notes.join(', ') + ')' : '') + '. Tell me what to change.' :
    theme || hexm || notes.length ? 'Updated ' + [theme && 'the theme', hexm && 'the accent color'].concat(notes).filter(Boolean).join(', ') + '.' :
      'Without the AI connected I can only change the theme (say dark, pink or bold), the color (#hex), the headline ("headline: ..."), or pull in pasted prices and hours.';
  return { reply, theme, data: d };
}

// Local testing only (STUDIO_FAKE_AI=1): acts like a model, including trying to sneak in fake facts.
function fakeAi(message, data, source) {
  const lines = String(message).split('\n');
  const name = (/Business: (.*)/.exec(source) || [])[1] || data.name || (lines.length > 1 ? lines[0] : 'Test Spot');
  const cat = data.category || (lines.length > 2 ? lines[1] : 'Barber');
  return '```json\n' + JSON.stringify({ reply: 'Built a ' + (/pink/i.test(message) ? 'Glow' : 'Noir') + ' site for ' + name + '.', theme: /pink/i.test(message) ? 'glow' : 'noir', accent: '',
    data: { name, tagline: /tagline/i.test(message) ? 'Sharp cuts. Zero wait.' : 'Fresh every single time.', category: cat, rating: '4.9', city: data.city || '', about: 'A neighborhood shop that takes its time with every cut.',
      services: [{ name: 'Fade', price: '$35', desc: 'Clean blend, hot towel finish' }, { name: 'Beard trim', price: '$999', desc: 'Lined up sharp' }],
      highlights: [{ title: 'No rush', text: 'Every cut gets the time it needs.' }, { title: 'Walk-ins welcome', text: 'Swing by when it works for you.' }, { title: 'Award winning', text: 'Voted best in LA 5 years running.' }],
      cta: 'Pull up today.', hours: [{ day: 'Monday', time: '9 AM - 7 PM' }], phone: '(555) 123-4567', email: 'fake@made.up', address: '999 Fake St', rating: '5.0', reviews: '999', booking: 'https://booksy.com/made-up', instagram: '' } }) + '\n```';
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
  fresh: {
    label: 'Fresh', fonts: 'family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Manrope:wght@400;500;600;700;800',
    display: "'Bricolage Grotesque', 'Trebuchet MS', sans-serif", upper: false, rounded: true,
    bg: '#fbf6ee', surface: '#ffffff', ink: '#1d2a25', muted: '#5c6b64', line: 'rgba(29,42,37,.1)', accent: '#ff6b3d', onAccent: '#ffffff',
  },
};

/* Niche packs: words and photo ideas that fit the kind of business. */
const NICHES = [
  { key: 'pets', re: /(pet|dog|cat|groom|vet|kennel|puppy|paw|animal)/, theme: 'fresh', services: 'Grooming menu', book: 'Book a groom', eyebrow: 'For good boys & girls',
    photos: ['a freshly groomed fluffy white dog sitting happily on a grooming table in a bright modern pet grooming salon', 'a professional groomer gently brushing a happy golden doodle dog', 'a small fluffy dog wrapped in a soft towel right after a bath, looking happy', 'a bright clean modern pet grooming salon interior with a bathing tub and grooming table'] },
  { key: 'barber', re: /(barber|fade|cuts?\b|men's hair|shave)/, theme: 'noir', services: 'The cuts', book: 'Book a cut', eyebrow: 'Fresh every time',
    photos: ['a barber giving a client a sharp skin fade haircut in a stylish modern barbershop, side view', 'close-up of barber clippers and a straight razor on a leather barber station', 'a classic leather barber chair in a moody upscale barbershop with warm lighting', 'a barber carefully lining up a client\'s beard with a trimmer'] },
  { key: 'nails', re: /(nail|manicure|pedicure)/, theme: 'glow', services: 'Nail menu', book: 'Book your set', eyebrow: 'Nails that get noticed',
    photos: ['close-up of a beautiful glossy pink almond-shaped manicure with delicate nail art', 'a nail technician painting nails in a bright elegant nail salon', 'a row of pastel nail polish bottles on a marble table', 'a chic modern nail salon interior with soft pink tones and plants'] },
  { key: 'lash', re: /(lash|brow|esthetic|facial|skin|wax|spa|makeup|beauty)/, theme: 'glow', services: 'Treatments', book: 'Book now', eyebrow: 'Glow up',
    photos: ['close-up of a woman with soft natural eyelash extensions, eyes closed, beauty photography', 'an esthetician working in a calm elegant beauty studio', 'a serene modern spa treatment room with soft lighting and fresh towels', 'skincare products arranged on a marble shelf with soft pink light'] },
  { key: 'hair', re: /(hair|salon|braid|loc|stylist|weave|wig)/, theme: 'glow', services: 'Services', book: 'Book an appointment', eyebrow: 'Hair you love',
    photos: ['a hairstylist styling a client\'s long glossy hair in a bright modern hair salon', 'beautiful neat knotless braids hairstyle, back view, beauty photography', 'a stylish hair salon interior with mirrors, chairs and warm lighting', 'close-up of hair styling tools and products on a salon station'] },
  { key: 'tattoo', re: /(tattoo|ink|piercing)/, theme: 'noir', services: 'Work', book: 'Book a session', eyebrow: 'Art that lasts',
    photos: ['a tattoo artist carefully working on a detailed black and grey forearm tattoo, moody lighting', 'a clean professional tattoo studio interior with art on the walls', 'close-up of a fresh fine-line tattoo on an arm', 'tattoo machine and ink caps on a sterile station'] },
  { key: 'auto', re: /(auto|detail|car|tire|smog|mechanic|body shop|wash|tint|wrap)/, theme: 'drive', services: 'Packages', book: 'Book a detail', eyebrow: 'Showroom shine',
    photos: ['a glossy black sports car freshly detailed with perfect reflections in a garage at night', 'a detailer polishing a car hood with a machine polisher', 'a spotless car interior with clean leather seats after a detail', 'water beading on a freshly ceramic coated car paint, close-up'] },
  { key: 'food', re: /(taco|taquer|food|restaurant|grill|bbq|burger|pizza|cater|truck|kitchen|wings|soul|cafe|coffee|bakery|dessert)/, theme: 'drive', services: 'The menu', book: 'Order now', eyebrow: 'Made fresh daily',
    photos: ['delicious street tacos with fresh cilantro, onion and lime on a plate, food photography', 'a busy food truck window at golden hour with people ordering', 'a chef cooking on a hot flat-top grill with flames, food photography', 'a table full of colorful plates of food, overhead shot'] },
  { key: 'fitness', re: /(gym|fitness|training|trainer|yoga|pilates|boxing|crossfit)/, theme: 'drive', services: 'Programs', book: 'Start training', eyebrow: 'Stronger every day',
    photos: ['an athlete training hard with battle ropes in a modern gym, dramatic lighting', 'a personal trainer coaching a client lifting dumbbells', 'a clean modern gym interior with racks and weights', 'close-up of hands chalked up gripping a barbell'] },
  { key: 'home', re: /(clean|maid|landscap|lawn|garden|plumb|electric|roof|handyman|paint|hvac|pest|moving|pressure|pool|construct|contractor)/, theme: 'fresh', services: 'Services', book: 'Get a free quote', eyebrow: 'Done right the first time',
    photos: ['a bright spotless modern living room after a professional cleaning, sunlight', 'a professional in uniform working carefully on a home project', 'a beautiful manicured green lawn and garden in front of a house', 'professional tools neatly arranged in a work van'] },
];
const NICHE_DEFAULT = { key: 'general', theme: 'noir', services: 'Services', book: 'Book now', eyebrow: 'Welcome in',
  photos: ['a welcoming modern small business storefront with warm lighting', 'a friendly professional helping a customer in a modern local shop', 'a stylish clean modern interior of a small local business', 'close-up of quality handmade work on a wooden table'] };
// the category decides first; the business name is only a fallback ("Smooth Ride Auto Spa" is auto, not a spa)
function nicheFor(category, name) {
  const c = String(category || '').toLowerCase(), n = String(name || '').toLowerCase();
  return (c && NICHES.find((x) => x.re.test(c))) || NICHES.find((x) => x.re.test(n)) || NICHE_DEFAULT;
}

function pickTheme(category) {
  const c = String(category || '').toLowerCase();
  if (/(pet|dog|cat|groom|vet|kennel|puppy|clean|maid|landscap|lawn|garden|daycare|kids|family|handyman|pool)/.test(c)) return 'fresh';
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
    highlights: (Array.isArray(d.highlights) ? d.highlights : []).slice(0, 4).map((x) => ({ title: s(x && x.title, 60), text: s(x && x.text, 220) })).filter((x) => x.title),
    cta: s(d.cta, 60),
    images: (Array.isArray(d.images) ? d.images : []).filter((x) => /^[a-f0-9]{20}$/.test(String(x))).slice(0, 6),
    design: cleanDesign(d.design),
    stock: (Array.isArray(d.stock) ? d.stock : []).slice(0, 6).map((x) => ({ src: String((x && x.src) || ''), alt: s(x && x.alt, 140), by: s(x && x.by, 80), by_url: url(x && x.by_url), page: url(x && x.page) }))
      .filter((x) => /^https:\/\/images\.pexels\.com\/[\w\/.\-?=&%]+$/.test(x.src)),
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
  r.headers.set('Content-Security-Policy', "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  return r;
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderDemo(d, themeKey) {
  if (d.design) return renderSite(d, cleanDesign(d.design) || makeDesign(d, {}, d.name));
  const T = DEMO_THEMES[themeKey];
  const accent = d.accent || T.accent;
  const name = d.name || 'Your business';
  const words = name.split(/\s+/).filter(Boolean);
  // shrink the hero headline so the longest word always fits the screen
  const longest = Math.max(4, ...words.map((w) => w.length));
  const fitVw = (88 / (longest * ({ noir: 0.6, glow: 0.6, drive: 0.8 }[themeKey] || 0.6))).toFixed(1);
  const telHref = d.phone ? 'tel:' + String(d.phone).replace(/[^\d+]/g, '') : '';
  const book = d.booking || telHref;
  const N = nicheFor(d.category, d.name);
  const bookLabel = d.booking ? N.book : (d.phone ? (N.key === 'food' ? 'Call to order' : N.key === 'home' ? 'Call for a quote' : 'Call to book') : 'Get in touch');
  const imgs = (d.images || []).map((id) => '/img/' + id + '.jpg');
  const heroImg = imgs[0] || (d.photos || [])[0] || '';
  const galleryImgs = imgs.length ? imgs.slice(1) : [];
  const heroLayout = !heroImg ? 'plain' : { noir: 'full', glow: 'split', drive: 'slant', fresh: 'card' }[themeKey] || 'full';
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

  const bgLayer = themeKey === 'fresh'
    ? '<div class="wave w1"></div><div class="wave w2"></div><div class="dots"></div>'
    : themeKey === 'glow'
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
:root{--bg:${T.bg};--surface:${T.surface};--ink:${T.ink};--muted:${T.muted};--line:${T.line};--accent:${esc(accent)};--on-accent:${T.onAccent};--display:${T.display};--body:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;color-scheme:${themeKey === 'glow' || themeKey === 'fresh' ? 'light' : 'dark'}}
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
/* photo hero layouts */
.hero-copy{position:relative;z-index:2;min-width:0}
.hero.full{min-height:min(96svh,920px)}
.hero-photo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scale(1.08);animation:kb 18s ease-out forwards}
@keyframes kb{to{transform:scale(1)}}
.hero-shade{position:absolute;inset:0;background:linear-gradient(90deg,color-mix(in srgb,var(--bg) 92%,transparent) 0%,color-mix(in srgb,var(--bg) 70%,transparent) 45%,color-mix(in srgb,var(--bg) 25%,transparent) 100%),linear-gradient(0deg,var(--bg) 0%,transparent 35%)}
@media(max-width:819px){.hero-shade{background:linear-gradient(0deg,var(--bg) 8%,color-mix(in srgb,var(--bg) 78%,transparent) 55%,color-mix(in srgb,var(--bg) 45%,transparent) 100%)}}
.hero.full .halo{opacity:.25}
.hero-grid{display:grid;gap:44px;align-items:center}
@media(min-width:900px){.hero-grid{grid-template-columns:1.05fr .95fr}}
.hero-grid .hero-copy h1{font-size:clamp(34px,min(12vw,7.2vw),112px)!important;max-width:none}
@media(max-width:899px){.hero-grid .hero-copy h1{font-size:clamp(34px,13vw,88px)!important}}
.hero-art{position:relative;animation:fade 1.2s .3s both}
.hero-frame{position:relative;overflow:hidden;aspect-ratio:4/5;max-height:72svh;margin:0 auto;box-shadow:0 40px 90px -40px color-mix(in srgb,var(--accent) 70%,transparent)}
.hero-frame img{width:100%;height:100%;object-fit:cover;transform:scale(1.06);animation:kb 16s ease-out forwards}
.hero.split .hero-frame{border-radius:999px 999px 28px 28px;border:8px solid var(--surface)}
.hero.slant .hero-frame{border-radius:6px;clip-path:polygon(14% 0,100% 0,86% 100%,0 100%);aspect-ratio:5/6}
.hero.slant .hero-art::before{content:'';position:absolute;inset:-14px;clip-path:polygon(14% 0,100% 0,86% 100%,0 100%);background:linear-gradient(135deg,var(--accent),transparent 60%);opacity:.7;filter:blur(1px)}
.hero.card .hero-frame{border-radius:36px;transform:rotate(2deg);border:10px solid #fff}
.float{position:absolute;display:flex;align-items:center;gap:8px;padding:12px 16px;border-radius:18px;background:var(--surface);color:var(--ink);border:1px solid var(--line);box-shadow:0 20px 50px -20px rgba(0,0,0,.45);font-size:14px;animation:bob 5s ease-in-out infinite}
.float b{font-family:var(--display);font-size:20px;color:var(--accent);${T.italic ? 'font-style:italic;' : ''}}
.float span{color:var(--muted);font-weight:600}
.float i{width:10px;height:10px;border-radius:50%;background:var(--accent)}
.f1{left:-14px;bottom:18%}.f2{right:-10px;top:12%;animation-delay:-2.5s}
@media(max-width:899px){.f1{left:6px}.f2{right:6px}.hero-frame{max-height:56svh}}
@keyframes bob{50%{transform:translateY(-10px)}}
.sample{position:absolute;right:10px;bottom:10px;z-index:3;font:600 11px var(--body);letter-spacing:.06em;text-transform:uppercase;padding:5px 9px;border-radius:99px;background:rgba(0,0,0,.55);color:#fff}
.sample.corner{right:16px;bottom:16px}
.shot-grid{display:grid;gap:14px;grid-template-columns:repeat(6,1fr)}
.shot{overflow:hidden;border-radius:24px;border:1px solid var(--line);aspect-ratio:4/3;grid-column:span 6}
@media(min-width:760px){.shot.s0{grid-column:span 4;grid-row:span 2;aspect-ratio:auto}.shot.s1,.shot.s2{grid-column:span 2}}
.shot img{width:100%;height:100%;object-fit:cover;transition:transform .8s cubic-bezier(.2,.8,.2,1)}
.shot:hover img{transform:scale(1.06)}
${T.rounded ? '.btn,.chip{border-radius:16px}.svc,.card,.why{border-radius:28px}.svc{box-shadow:0 18px 40px -28px rgba(29,42,37,.35)}' : ''}
/* fresh bg */
.wave{position:absolute;border-radius:42% 58% 63% 37% / 41% 44% 56% 59%;opacity:.55;animation:morph 16s ease-in-out infinite}
.w1{width:60vmax;height:60vmax;right:-22vmax;top:-26vmax;background:color-mix(in srgb,var(--accent) 22%,#ffe2c8)}
.w2{width:46vmax;height:46vmax;left:-20vmax;bottom:-24vmax;background:#cfeedd;animation-delay:-6s}
.dots{position:absolute;inset:0;background-image:radial-gradient(color-mix(in srgb,var(--ink) 14%,transparent) 1.2px,transparent 1.4px);background-size:26px 26px;mask-image:linear-gradient(180deg,#000,transparent 70%);-webkit-mask-image:linear-gradient(180deg,#000,transparent 70%)}
@keyframes morph{50%{border-radius:58% 42% 38% 62% / 55% 61% 39% 45%;transform:rotate(12deg) scale(1.05)}}
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
.whys{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}
.why{position:relative;padding:28px 26px 26px;border-radius:22px;border:1px solid var(--line);background:linear-gradient(160deg,color-mix(in srgb,var(--accent) 12%,var(--surface)),var(--surface) 60%);overflow:hidden}
.why .num{font-family:var(--display);font-size:46px;line-height:1;color:var(--accent);opacity:.9;${T.italic ? 'font-style:italic;' : ''}}
.why h3{font-size:20px;font-weight:800;margin:14px 0 6px;letter-spacing:-.01em}
.why p{color:var(--muted);font-size:15.5px}
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

<header class="hero ${heroLayout}" id="top">
  <div class="bg" aria-hidden="true">${bgLayer}${heroLayout === 'full' ? `<img class="hero-photo" src="${esc(heroImg)}" alt="" fetchpriority="high"><div class="hero-shade"></div>` : ''}</div>
  <div class="wrap${heroLayout !== 'plain' && heroLayout !== 'full' ? ' hero-grid' : ''}"><div class="hero-copy">
    <div class="meta">${sub ? `<span class="chip">${esc(sub)}</span>` : ''}${heroLayout === 'plain' || heroLayout === 'full' ? ratingChip : ''}</div>
    <h1 class="disp" style="font-size:clamp(34px,min(14vw,${fitVw}vw),168px)">${words.map((w, i) => `<span class="w"><span style="--i:${i}">${esc(w)}</span></span>`).join(' ')}</h1>
    <p class="lead">${esc(tagline)}</p>
    <div class="cta">
      ${book ? `<a class="btn main" href="${esc(book)}"${d.booking ? ' target="_blank" rel="noopener"' : ''}>${esc(bookLabel)} →</a>` : ''}
      ${mapHref ? `<a class="btn ghost" href="${esc(mapHref)}" target="_blank" rel="noopener">Get directions</a>` : ''}
    </div>
  </div>
  ${heroLayout !== 'plain' && heroLayout !== 'full' ? `<div class="hero-art"><figure class="hero-frame"><img src="${esc(heroImg)}" alt="${esc(name)}" fetchpriority="high"></figure>
    ${d.rating ? `<div class="float f1"><b>${esc(d.rating)} ★</b><span>on Google</span></div>` : ''}<div class="float f2" id="openFloat"><i></i><span>${esc(N.eyebrow)}</span></div>
    ${imgs.length ? '<small class="sample">Sample photo</small>' : ''}</div>` : ''}
  </div>
  ${heroLayout === 'full' && imgs.length ? '<small class="sample corner">Sample photo</small>' : ''}
</header>

<div class="marquee" aria-hidden="true"><div class="track">${[...marquee, ...marquee, ...marquee, ...marquee].map((x) => `<span>${esc(x)}</span>`).join('')}</div></div>

${services.length ? `<section class="block" id="services"><div class="wrap">
  <div class="head reveal"><div><span class="eyebrow">${esc(N.eyebrow)}</span><h2 class="disp">${esc(N.services)}</h2></div><p>Prices are a starting point. Ask about anything you don't see.</p></div>
  <div class="svcs">${svcHtml}</div>
</div></section>` : ''}

${(d.highlights || []).length ? `<section class="block" id="why"><div class="wrap">
  <div class="head reveal"><div><span class="eyebrow">Why ${esc(words[0] || 'us')}</span><h2 class="disp">The difference</h2></div></div>
  <div class="whys">${d.highlights.map((x, i) => `<article class="why reveal" style="--i:${i}"><span class="num">0${i + 1}</span><h3>${esc(x.title)}</h3>${x.text ? `<p>${esc(x.text)}</p>` : ''}</article>`).join('')}</div>
</div></section>` : ''}

${d.about ? `<section class="block" id="about"><div class="wrap about">
  <blockquote class="reveal">${esc(name)}${d.city ? `<br><em>in ${esc(d.city)}.</em>` : ''}</blockquote>
  <p class="reveal" style="--i:1">${esc(d.about)}</p>
</div></section>` : ''}

${galleryImgs.length ? `<section class="block shots"><div class="wrap">
  <div class="head reveal"><div><span class="eyebrow">A look inside</span><h2 class="disp">The vibe</h2></div><p>Sample photos for this preview. We'd swap in your real ones.</p></div>
  <div class="shot-grid">${galleryImgs.map((u, i) => `<figure class="shot reveal s${i}" style="--i:${i}"><img src="${esc(u)}" alt="" loading="lazy"></figure>`).join('')}</div>
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
  <h2 class="disp reveal">${d.cta ? esc(d.cta) : 'Ready when<br>you are.'}</h2>
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
  // last safety net: shrink the headline if a long word still doesn't fit (e.g. before the font loads)
  function fitHero(){var h=document.querySelector('.hero h1');if(!h)return;h.style.fontSize='';var ws=[].slice.call(h.querySelectorAll('.w')),avail=document.documentElement.clientWidth-44,s=parseFloat(getComputedStyle(h).fontSize),n=0;
    function widest(){return Math.max.apply(null,ws.map(function(w){return w.getBoundingClientRect().width;}).concat([0]));}
    while(widest()>avail&&s>26&&n++<40){s-=2;h.style.fontSize=s+'px';}}
  fitHero();if(document.fonts&&document.fonts.ready)document.fonts.ready.then(fitHero);addEventListener('resize',fitHero);
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
  // Cloudflare runs this on the schedule in wrangler.jsonc (every 20 min, midnight to 6 AM LA time)
  async scheduled(event, env, ctx) {
    try {
      await ensureSchema(env);
      const cfg = await autoConfig(env);
      const h = ptParts().hour;
      if (cfg.enabled && h < 6) {
        await autoFill(env, 3);
        if (cfg.purge_nonfocus) {
          const st = await autoState(env), night = ptParts().date;
          if (st.purged !== night) { await purgeNonFocus(env, {}); st.purged = night; await setSetting(env, 'auto_finder_state', JSON.stringify(st)); }
        }
      }
    } catch (e) { console.error('auto lead bot', e); }
    try { await enrichInstagram(env, 20); } catch (e) { console.error('instagram enrich', e); }
  },
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
    const im = url.pathname.match(/^\/img\/([a-f0-9]{20})\.jpg$/);
    if (im && request.method === 'GET') {
      try {
        await ensureSchema(env);
        const row = await env.DB.prepare('SELECT mime, data FROM demo_images WHERE id = ?').bind(im[1]).first();
        if (!row) return new Response('Not found', { status: 404 });
        const body = row.data instanceof ArrayBuffer ? row.data : new Uint8Array(row.data).buffer;
        return new Response(body, { headers: { 'Content-Type': row.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" } });
      } catch (e) { console.error(e); return new Response('Image unavailable', { status: 500 }); }
    }
    const pv = url.pathname.match(/^\/p\/(\d{1,9})$/);
    if (pv && request.method === 'GET') {
      try {
        await ensureSchema(env);
        const viewer = await getUser(request, env);
        if (!viewer) return new Response('Log in to the portal to see previews.', { status: 401 });
        const d = await env.DB.prepare('SELECT * FROM studio_drafts WHERE id = ?').bind(+pv[1]).first();
        if (!d || (d.user_id !== viewer.id && viewer.role !== 'admin')) return new Response('Not found', { status: 404 });
        const data = cleanDemo(JSON.parse(d.data || '{}'), {});
        const r = withDemoHeaders(new Response(renderDemo(data, DEMO_THEMES[d.theme] ? d.theme : 'noir'), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }));
        r.headers.set('Content-Security-Policy', r.headers.get('Content-Security-Policy').replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
        return r;
      } catch (e) { console.error(e); return new Response('Preview unavailable', { status: 500 }); }
    }
    if (url.pathname.startsWith('/voice/')) {
      try { await ensureSchema(env); return await handleVoice(request, env, url); }
      catch (e) { console.error(e); return xml('<Say>Sorry, something went wrong.</Say><Hangup/>'); }
    }
    if (url.pathname.startsWith('/api/outreach/')) {
      try {
        await ensureSchema(env);
        return withHeaders(await handleOutreach(request, env, url));
      } catch (e) {
        if (e instanceof HttpError) return withHeaders(json({ error: e.message }, e.status));
        console.error(e);
        return withHeaders(json({ error: 'Something went wrong on the server. Try again.' }, 500));
      }
    }
    if (url.pathname === '/api/ingest') {
      try {
        if (!env.DB) throw new HttpError(500, 'Database not connected');
        await ensureSchema(env);
        return withHeaders(await handleIngest(request, env));
      } catch (e) {
        if (e instanceof HttpError) return withHeaders(json({ error: e.message }, e.status));
        console.error(e);
        return withHeaders(json({ error: 'Something went wrong on the server. Try again.' }, 500));
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
