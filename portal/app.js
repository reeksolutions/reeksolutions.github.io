/* Reekon Systems — Sales Portal (stage 3) */
(function () {
  'use strict';

  /* ================= basics ================= */
  const $app = document.getElementById('app');
  const S = { me: null, options: null, leadFilters: { status: 'open', rep: '', batch: '', city: '', q: '', heat: '', contact: '', tag: '', due: '', source: '' }, selected: new Set(), selecting: false,
    script: null, period: 'today', boardSort: 'closes', dealsFilter: '0' };

  const STATUS = {
    new: 'New', demo_needed: 'Demo needed', demo_ready: 'Demo ready', called: 'Called', callback: 'Callback',
    booked: 'Audit booked', call2: 'Call 2', won: 'Closed won', lost: 'Closed lost', dnc: 'Do Not Call',
  };
  const OUTCOMES = [
    ['no_answer', 'No answer'], ['voicemail', 'Voicemail'], ['gatekeeper', 'Gatekeeper'], ['not_interested', 'Not interested'],
    ['callback', 'Callback'], ['demo_sent', 'Demo sent'], ['booked', 'Audit booked'], ['dnc', 'Do Not Call'],
  ];
  const HEAT = [['hot', 'Hot', '🔥'], ['warm', 'Warm', '☀️'], ['cold', 'Cold', '🧊'], ['dead', 'Dead', '💀']];
  const HEAT_LABEL = Object.fromEntries(HEAT.map(([k, l, e]) => [k, e + ' ' + l]));
  const OUTCOME_LABEL = Object.fromEntries(OUTCOMES.concat([['emailed', 'Emailed'], ['status_change', 'Status changed'], ['demo_ready', 'Demo marked ready'], ['closed_won', 'Deal closed']]));

  // tiny element builder — everything goes through textContent, so lead data can't inject HTML
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v; // only ever used with our own static SVG strings
      else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const icon = (name) => h('span', { html: ICONS[name] || '', style: 'display:contents' });
  const ICONS = {
    leads: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
    callbacks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    demos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="13" rx="2.5"/><path d="M8 21h8M12 17.5V21" stroke-linecap="round"/></svg>',
    batches: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="9" cy="8.5" r="3.5"/><path d="M3 19.5c.8-3.3 3.2-5 6-5s5.2 1.7 6 5"/><path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M18 14.8c1.5.8 2.6 2.4 3 4.7"/></svg>',
    account: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="8.5" r="4"/><path d="M4.5 20c1-3.6 4-5.5 7.5-5.5s6.5 1.9 7.5 5.5"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 4.5 5.5a2 2 0 0 1 2-2z"/></svg>',
    sms: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17A2.5 2.5 0 0 1 4 14.5z"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M4 7l8 6 8-6"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/></svg>',
    cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
    trophy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8v6a4 4 0 0 1-8 0zM8 6H4.5a3 3 0 0 0 3.5 4M16 6h3.5a3 3 0 0 1-3.5 4M12 14v3M8.5 20.5h7M10 17h4v3.5h-4z"/></svg>',
    flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10.5L12 4l8 6.5V20"/><path d="M9.5 20v-5.5h5V20"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
    deals: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M14.8 9.2c-.5-.9-1.5-1.4-2.8-1.4-1.6 0-2.7.8-2.7 2s1 1.7 2.7 2.1 2.9.9 2.9 2.2-1.2 2.1-2.9 2.1c-1.4 0-2.5-.6-3-1.6M12 6.3v1.5M12 16.2v1.5"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5.5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="18.5" cy="12" r="1.8"/></svg>',
    script: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5h7.5L19 8v12.5H7z"/><path d="M14 3.5V8h5M10 12h6M10 15.5h6"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
    logo: '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="none" stroke="#5b8cff" stroke-opacity=".3" stroke-width="2.2"/><circle cx="16" cy="16" r="6.5" fill="none" stroke="#5b8cff" stroke-opacity=".22" stroke-width="1.6"/><circle cx="16" cy="16" r="3.2" fill="#5b8cff"/><path d="M16 4a12 12 0 0 1 12 12" fill="none" stroke="#5b8cff" stroke-width="2.6" stroke-linecap="round"/></svg>',
  };

  async function api(method, path, body) {
    const res = await fetch('/api' + path, {
      method, credentials: 'same-origin',
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Portal': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && path !== '/login' && path !== '/me') { S.me = null; render(); }
    if (!res.ok) throw new Error((data && data.error) || 'Request failed (' + res.status + ')');
    return data;
  }

  let toastTimer;
  function toast(msg, err) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), 2600);
  }
  const fail = (e) => toast(e.message || String(e), true);

  const pill = (s) => h('span', { class: 'pill s-' + s }, STATUS[s] || s);
  const fmt = (iso, opts) => iso ? new Date(iso).toLocaleString([], opts || { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const ago = (iso) => {
    if (!iso) return '';
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return fmt(iso, { month: 'short', day: 'numeric' });
  };
  const telHref = (p) => 'tel:' + String(p || '').replace(/[^\d+]/g, '');
  // Opens Google Voice with the number filled in. A community-known link, not a documented Google feature, so it can change.
  const gvHref = (p) => { let d = String(p || '').replace(/\D/g, ''); if (d.length === 10) d = '1' + d; return 'https://voice.google.com/u/0/calls?a=nc,%2B' + d; };
  const initials = (n) => String(n || '?').trim().split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();
  const dayBounds = () => { const a = new Date(); a.setHours(0, 0, 0, 0); const b = new Date(a); b.setDate(b.getDate() + 1); return [a.toISOString(), b.toISOString()]; };
  const toLocalInput = (d) => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 6e4); return z.toISOString().slice(0, 16); };
  const money = (cents) => { const v = (cents || 0) / 100; return '$' + v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }); };
  const pctTxt = (p) => (p === null || p === undefined ? '' : (+p).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%');
  const first = (n) => String(n || '').trim().split(/\s+/)[0] || '';
  // local period bounds: today / this week (Mon start) / this month
  function periodBounds(p) {
    const a = new Date(); a.setHours(0, 0, 0, 0);
    if (p === 'week') a.setDate(a.getDate() - ((a.getDay() + 6) % 7));
    if (p === 'month') a.setDate(1);
    const b = new Date(); b.setHours(0, 0, 0, 0); b.setDate(b.getDate() + 1);
    return [a.toISOString(), b.toISOString()];
  }
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
  const genPassword = () => { const c = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const a = crypto.getRandomValues(new Uint32Array(12)); return Array.from(a, (x) => c[x % c.length]).join(''); };

  /* ================= bottom sheet ================= */
  function sheet(build) {
    return new Promise((resolve) => {
      const close = (v) => { scrim.remove(); resolve(v); };
      const scrim = h('div', { class: 'scrim', onclick: (e) => { if (e.target === scrim) close(null); } });
      const box = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' });
      box.append = (...kids) => Element.prototype.append.apply(box, kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
      const onNav = () => close(null);
      window.addEventListener('hashchange', onNav, { once: true });
      build(box, (v) => { window.removeEventListener('hashchange', onNav); close(v); });
      scrim.append(box); document.body.append(scrim);
      const f = box.querySelector('input,textarea,select'); if (f) setTimeout(() => f.focus(), 50);
    });
  }
  function confirmSheet(title, text, okLabel, danger) {
    return sheet((box, close) => box.append(
      h('h2', null, title), h('p', { class: 'sub' }, text),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => close(true) }, okLabel))));
  }

  /* ================= shell + router ================= */
  // bottom tabs on phones
  function tabsFor(role) {
    if (role === 'admin') return [['home', 'Home'], ['tracker', 'Tracker'], ['leads', 'Leads'], ['callbacks', 'Callbacks'], ['more', 'More']];
    if (role === 'rep') return [['home', 'Home'], ['leads', 'My Leads'], ['callbacks', 'Callbacks'], ['calendar', 'Calendar'], ['earnings', 'Earnings']];
    return [['studio', 'Studio'], ['demos', 'Demo Queue'], ['account', 'Account']];
  }
  // sidebar on desktop: grouped
  function navFor(role) {
    if (role === 'admin') return [
      [null, [['home', 'Home'], ['tracker', 'Daily tracker'], ['rebrief', 'Daily brief'], ['leads', 'Leads'], ['callbacks', 'Callbacks'], ['calendar', 'Calendar'], ['deals', 'Deals']]],
      ['Tools', [['finder', 'Lead Finder'], ['content', 'Content'], ['cards', 'Review cards'], ['script', 'Call script']]],
      ['System', [['settings', 'Settings']]],
    ];
    if (role === 'rep') return [[null, [['home', 'Home'], ['leads', 'My leads'], ['callbacks', 'Callbacks'], ['calendar', 'Calendar'], ['earnings', 'Earnings'], ['recordings', 'My recordings']]]];
    return [[null, [['studio', 'Demo Studio'], ['demos', 'Demo queue']]]];
  }
  const home = () => (S.me.role === 'dev' ? 'studio' : 'home');
  const TAB_ICON = { calendar: 'calendar', rebrief: 'chart', cards: 'deals', settings: 'account', content: 'spark', tracker: 'flag', recordings: 'phone', emailbot: 'mail', earnings: 'deals', team: 'chart', callbacks: 'callbacks', upload: 'batches', integrations: 'bolt', studio: 'spark', finder: 'search' };
  // pages that live under the admin "More" tab on phones
  const UNDER_MORE = ['calendar', 'recordings', 'emailbot', 'batches', 'upload', 'users', 'script', 'account', 'deals', 'integrations', 'demos', 'finder', 'studio'];
  const ROLE_NAME = { admin: 'Admin', rep: 'Sales rep', dev: 'Demo builder' };


  /* ================= floating orb (look only; it roams and steps aside by itself) ================= */
  let orbEl = null, orbPos = { x: 0, y: 0 }, orbTimer = null, orbLast = 0;
  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function orbBounds() {
    const w = window.innerWidth, hgt = window.innerHeight, big = w >= 1000, size = orbEl ? orbEl.offsetWidth : 52;
    return { size, minX: (big ? 252 : 0) + 8, maxX: w - size - 8, minY: 76, maxY: hgt - size - (big ? 24 : 96) };
  }
  function moveOrb(x, y, fast) {
    if (!orbEl) return;
    orbEl.classList.toggle('dodge', !!fast);
    orbEl.style.left = Math.round(x) + 'px'; orbEl.style.top = Math.round(y) + 'px'; orbPos = { x, y };
  }
  // pick a spot that is far from where the orb is now (and from a finger or cursor, if given)
  function pickSpot(avoid) {
    const b = orbBounds(); let best = null, bestScore = -1;
    for (let k = 0; k < 10; k++) {
      const edge = Math.random() < 0.7;
      const x = edge ? (Math.random() < 0.5 ? b.minX : b.maxX) : b.minX + Math.random() * (b.maxX - b.minX);
      const y = b.minY + Math.random() * (b.maxY - b.minY);
      const dNow = Math.hypot(x - orbPos.x, y - orbPos.y);
      const dAvoid = avoid ? Math.hypot(x + b.size / 2 - avoid.x, y + b.size / 2 - avoid.y) : 999;
      const score = Math.min(dAvoid, 260) * 2 + Math.min(dNow, 260);
      if (score > bestScore) { bestScore = score; best = [x, y]; }
    }
    return best;
  }
  function wanderOrb() {
    clearTimeout(orbTimer);
    if (!reduceMotion() && !document.hidden) { const [x, y] = pickSpot(null); moveOrb(x, y, false); }
    orbTimer = setTimeout(wanderOrb, 8000 + Math.random() * 6000);
  }
  // if a finger or cursor gets close, the orb slides away so it never sits under what you are doing
  function orbDodge(e) {
    if (!orbEl || reduceMotion()) return;
    const t = e.touches && e.touches[0] ? e.touches[0] : e;
    if (t.clientX == null) return;
    const half = orbEl.offsetWidth / 2, cx = orbPos.x + half, cy = orbPos.y + half;
    if (Math.hypot(t.clientX - cx, t.clientY - cy) > half + 70) return;
    if (Date.now() - orbLast < 500) return;
    orbLast = Date.now();
    const [x, y] = pickSpot({ x: t.clientX, y: t.clientY }); moveOrb(x, y, true);
    clearTimeout(orbTimer); orbTimer = setTimeout(wanderOrb, 9000);
  }
  // the orb is archived for now: flip this to true to bring it back
  const ORB_ON = false;
  function ensureOrb() {
    if (!ORB_ON) { document.querySelectorAll('.orb').forEach((o) => o.remove()); return; }
    if (orbEl && document.body.contains(orbEl)) return;
    orbEl = h('div', { class: 'orb', 'aria-hidden': 'true' },
      h('span', { class: 'orb-core' }, h('i', { class: 'orb-blob b1' }), h('i', { class: 'orb-blob b2' }), h('i', { class: 'orb-blob b3' }), h('i', { class: 'orb-swirl' })),
      h('span', { class: 'orb-shine' }));
    document.body.append(orbEl);
    const b = orbBounds(); orbEl.style.transition = 'none'; moveOrb(b.maxX, b.minY + (b.maxY - b.minY) * 0.3); void orbEl.offsetWidth; orbEl.style.transition = '';
    document.addEventListener('pointerdown', orbDodge, { capture: true, passive: true });
    document.addEventListener('pointermove', orbDodge, { capture: true, passive: true });
    document.addEventListener('touchstart', orbDodge, { capture: true, passive: true });
    window.addEventListener('hashchange', () => { const [x, y] = pickSpot(null); moveOrb(x, y, false); });
    window.addEventListener('resize', () => { const bb = orbBounds(); moveOrb(Math.min(orbPos.x, bb.maxX), Math.min(orbPos.y, bb.maxY), true); });
    orbTimer = setTimeout(wanderOrb, 6000);
  }

  function shell(active, content) {
    const tabs = tabsFor(S.me.role);
    let tabActive = active;
    if (S.me.role === 'admin' && UNDER_MORE.includes(active)) tabActive = 'more';
    if (active === 'rep') tabActive = 'more';
    const sideActive = active === 'rep' ? 'users' : active;
    const nav = h('nav', { class: 'tabs', 'aria-label': 'Main' },
      tabs.map(([k, label]) => h('a', { href: '#/' + k, class: tabActive === k ? 'on' : null }, icon(TAB_ICON[k] || k), h('span', null, label),
        k === 'callbacks' || (k === 'more' && S.me.role === 'admin') ? h('span', { class: 'count cb-count', hidden: true }) : null)));
    const side = h('aside', { class: 'side', 'aria-label': 'Sidebar' },
      h('a', { href: '#/' + home(), class: 'logo' }, icon('logo'), h('span', null, 'Reekon ', h('em', null, 'Systems'))),
      h('div', { class: 'side-scroll' }, navFor(S.me.role).map(([group, items]) => h('div', { class: 'side-group' },
        group ? h('div', { class: 'side-label' }, group) : null,
        items.map(([k, label]) => h('a', { href: '#/' + k, class: 'side-link' + (sideActive === k ? ' on' : '') }, icon(TAB_ICON[k] || k), h('span', null, label),
          k === 'callbacks' ? h('span', { class: 'count cb-count', hidden: true }) : null))))),
      h('a', { href: '#/account', class: 'side-me' + (active === 'account' ? ' on' : '') }, h('span', { class: 'avatar' }, initials(S.me.name)),
        h('span', { class: 'who' }, h('b', null, S.me.name), h('small', null, ROLE_NAME[S.me.role] || S.me.role)), icon('chev')));
    const top = h('header', { class: 'top' },
      h('a', { href: '#/' + home(), class: 'logo' }, icon('logo'), h('span', null, 'Reekon ', h('em', null, 'Systems'))),
      h('a', { href: '#/account', class: 'me', title: S.me.name }, initials(S.me.name)));
    const main = h('main', { id: 'view', class: 'enter' }, content);
    $app.replaceChildren(side, h('div', { class: 'frame' }, top, main), nav);
    ensureOrb();
    if (S.me.role !== 'dev') refreshCallbackBadge();
    window.scrollTo(0, 0);
    return main;
  }

  async function refreshCallbackBadge() {
    try {
      const [from, until] = dayBounds();
      const list = await api('GET', '/callbacks?from=' + encodeURIComponent(from) + '&until=' + encodeURIComponent(until));
      const n = list.filter((l) => l.status === 'callback').length;
      document.querySelectorAll('.cb-count').forEach((el) => { el.textContent = n; el.hidden = !n; });
    } catch { /* ignore */ }
  }

  async function render() {
    if (!S.me) {
      try { S.me = await api('GET', '/me'); } catch { S.me = null; }
    }
    if (!S.me) return renderAuth();
    const [route, arg] = (location.hash.replace(/^#\/?/, '') || home()).split('/');
    const extra = { admin: ['calendar', 'rebrief', 'cards', 'settings', 'content', 'tracker', 'recordings', 'studio', 'emailbot', 'account', 'lead', 'upload', 'batches', 'users', 'script', 'demo', 'callbacks', 'deals', 'rep', 'integrations', 'demos', 'finder'], rep: ['lead', 'demo', 'account', 'studio', 'recordings'], dev: ['lead', 'demo'] }[S.me.role] || [];
    const allowed = tabsFor(S.me.role).map((t) => t[0]).concat(extra);
    if (!allowed.includes(route)) { location.hash = '#/' + home(); return; }
    try {
      switch (route) {
        case 'home': return await viewHome();
        case 'team': location.hash = '#/home'; return;
        case 'finder': return await viewFinder();
        case 'emailbot': return await viewEmailBot();
        case 'recordings': return await viewRecordings();
        case 'tracker': return await viewTracker();
        case 'content': return await viewContent();
        case 'rebrief': return await viewRebrief(arg);
        case 'cards': return await viewCards();
        case 'settings': return await viewSettings();
        case 'studio': return await viewStudio(+arg || null);
        case 'integrations': return await viewIntegrations();
        case 'rep': return await viewRep(+arg);
        case 'deals': return await viewDeals();
        case 'earnings': return await viewEarnings();
        case 'more': return viewMore();
        case 'script': return await viewScript();
        case 'leads': return await viewLeads();
        case 'lead': return await viewLead(+arg);
        case 'callbacks': return await viewCallbacks();
        case 'calendar': return await viewCalendar();
        case 'demos': return await viewDemos();
        case 'demo': return await viewDemoBuilder(+arg);
        case 'batches': return await viewBatches();
        case 'upload': return await viewUpload();
        case 'users': return await viewUsers();
        case 'account': return viewAccount();
      }
    } catch (e) {
      shell(route, h('div', { class: 'empty' }, h('b', null, 'Could not load this page'), e.message));
    }
  }
  let lastRoute = location.hash;
  window.addEventListener('hashchange', () => { S.cameFromList = /^#\/(leads|callbacks)/.test(lastRoute); lastRoute = location.hash; render(); });

  /* ================= login / setup ================= */
  async function renderAuth() {
    let status = { needsSetup: false };
    try { status = await api('GET', '/setup-status'); } catch (e) { status.error = e.message; }
    const err = h('p', { class: 'err-line' }, status.error || '');
    const logo = h('div', { class: 'logo' }, icon('logo'), h('span', null, 'Reekon ', h('em', null, 'Systems')));
    let form;
    if (status.needsSetup) {
      form = h('form', null,
        h('div', { class: 'field' }, h('label', { for: 'code' }, 'Setup code (the SETUP_CODE you saved in Cloudflare)'), h('input', { id: 'code', name: 'code', required: true, autocomplete: 'off' })),
        h('div', { class: 'field' }, h('label', { for: 'nm' }, 'Your name'), h('input', { id: 'nm', name: 'name', required: true, autocomplete: 'name' })),
        h('div', { class: 'field' }, h('label', { for: 'em' }, 'Email'), h('input', { id: 'em', name: 'email', type: 'email', required: true, autocomplete: 'email' })),
        h('div', { class: 'field' }, h('label', { for: 'pw' }, 'Password (8+ characters)'), h('input', { id: 'pw', name: 'password', type: 'password', required: true, minLength: 8, autocomplete: 'new-password' })),
        err, h('button', { class: 'btn primary block', type: 'submit' }, 'Create admin account'));
      form.addEventListener('submit', async (e) => {
        e.preventDefault(); err.textContent = '';
        const d = Object.fromEntries(new FormData(form));
        try { await api('POST', '/setup', d); S.me = null; location.hash = '#/home'; render(); } catch (x) { err.textContent = x.message; }
      });
    } else {
      form = h('form', null,
        h('div', { class: 'field' }, h('label', { for: 'em' }, 'Email'), h('input', { id: 'em', name: 'email', type: 'email', required: true, autocomplete: 'username' })),
        h('div', { class: 'field' }, h('label', { for: 'pw' }, 'Password'), h('input', { id: 'pw', name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
        err, h('button', { class: 'btn primary block', type: 'submit' }, 'Log in'));
      form.addEventListener('submit', async (e) => {
        e.preventDefault(); err.textContent = '';
        const btn = form.querySelector('button'); btn.disabled = true;
        try { await api('POST', '/login', Object.fromEntries(new FormData(form))); S.me = null; S.options = null; render(); }
        catch (x) { err.textContent = x.message; btn.disabled = false; }
      });
    }
    $app.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'box' }, logo,
      h('div', { class: 'card' },
        h('h1', null, status.needsSetup ? 'First-time setup' : 'Team login'),
        h('p', { class: 'sub' }, status.needsSetup ? 'Create the admin account. This screen only works once.' : 'Sales portal for the Reekon Systems team.'),
        form))));
  }

  /* ================= leads list ================= */
  async function getOptions(force) {
    if (!S.options || force) S.options = await api('GET', '/options');
    return S.options;
  }

  const STAGES = [['new', 'New'], ['called', 'Contacted'], ['callback', 'Callback'], ['booked', 'Audit booked'], ['call2', 'Call 2'], ['won', 'Won'], ['lost', 'Lost']];
  const STAGE_OF = (st) => (['new', 'demo_needed', 'demo_ready'].includes(st) ? 'new' : st);
  const STAGE_NAME = Object.fromEntries(STAGES);
  const HEAT_DOT = (k) => h('i', { class: 'hdot ' + (k || 'cold'), title: (HEAT_LABEL[k || 'cold'] || '').replace(/^\S+\s/, '') });

  async function viewLeads() {
    const isAdmin = S.me.role === 'admin';
    const opts = await getOptions(true);
    const F = S.leadFilters;
    const mode = lsGet('rs_leads_mode', 'board');
    const FKEYS = ['status', 'rep', 'batch', 'city', 'q', 'heat', 'contact', 'tag', 'due', 'source'];
    const BLANK = { status: 'open', rep: '', batch: '', city: '', q: '', heat: '', contact: '', tag: '', due: '', source: '' };
    const qsFrom = (extra) => { const qs = new URLSearchParams(extra || {}); for (const k of FKEYS) if (F[k] && k !== 'status') qs.set(k, F[k]); return qs; };
    const body = h('div', { class: 'leads-body' });
    const countEl = h('span', { class: 'count-line' });

    // ---- toolbar ----
    let tmr;
    const search = h('label', { class: 'tsearch' }, icon('search'),
      h('input', { id: 'lead-search', type: 'search', placeholder: 'Search leads', value: F.q, oninput: (e) => { clearTimeout(tmr); tmr = setTimeout(() => { F.q = e.target.value; load(); }, 300); } }));
    const QUICK = [['All', {}], ['Hot', { heat: 'hot' }], ['Due now', { due: '1' }], ['Not emailed', { contact: 'unemailed' }]];
    const sameQ = (f) => ['heat', 'due', 'contact'].every((k) => String(F[k] || '') === String(f[k] || ''));
    const quick = h('div', { class: 'qtabs', role: 'tablist' }, QUICK.map(([l, f]) => h('button', { role: 'tab', class: sameQ(f) ? 'on' : null, onclick: () => { Object.assign(F, { heat: '', due: '', contact: '' }, f); viewLeads(); } }, l)));
    const activeCount = ['rep', 'batch', 'city', 'tag', 'source', 'heat', 'contact'].filter((k) => F[k]).length + (mode === 'table' && F.status !== 'open' ? 1 : 0);
    const filterBtn = h('button', { class: 'tbtn' + (activeCount ? ' set' : ''), onclick: () => filterSheet() }, 'Filters' + (activeCount ? ' · ' + activeCount : ''));
    const seg = h('div', { class: 'vtoggle', role: 'group', 'aria-label': 'View' }, [['board', 'Board'], ['table', 'Table']].map(([k, l]) =>
      h('button', { class: mode === k ? 'on' : null, 'aria-pressed': String(mode === k), onclick: () => { lsSet('rs_leads_mode', k); viewLeads(); } }, l)));

    async function filterSheet() {
      const sel = (id, label, key, first, items) => {
        const s = h('select', { id }, first.map(([v, l]) => h('option', { value: v }, l)), items.map(([v, l]) => h('option', { value: v }, l)));
        s.value = F[key] || ''; s.onchange = () => (F[key] = s.value);
        return h('div', { class: 'field' }, h('label', { for: id }, label), s);
      };
      const done = await sheet((box, close) => box.append(h('h2', null, 'Filters'),
        mode === 'table' ? sel('f-status', 'Stage', 'status', [['open', 'All open'], ['', 'Everything']], STAGES.map(([k, l]) => [k === 'new' ? 'new,demo_needed,demo_ready' : k, l]).concat(isAdmin ? [['dnc', 'Do Not Call']] : [])) : null,
        sel('f-heat', 'Heat', 'heat', [['', 'Any']], HEAT.map(([k, l]) => [k, l])),
        isAdmin ? sel('f-rep', 'Rep', 'rep', [['', 'All reps'], ['none', 'Unassigned']], opts.reps.map((r) => [String(r.id), r.name + (r.active ? '' : ' (off)')])) : null,
        sel('f-city', 'City', 'city', [['', 'All cities']], opts.cities.map((c) => [c, c])),
        sel('f-contact', 'Contact', 'contact', [['', 'Any']], [['phone', 'Has phone'], ['email', 'Has email'], ['unemailed', 'Email not sent yet']]),
        (opts.tags || []).length ? sel('f-tag', 'Tag', 'tag', [['', 'Any tag']], opts.tags.map((t) => [t, '#' + t])) : null,
        isAdmin ? sel('f-source', 'Source', 'source', [['', 'Anywhere']], [['finder', 'Lead Finder / auto bot'], ['api', 'Scraper / n8n'], ['csv', 'CSV upload']]) : null,
        isAdmin && opts.batches.length ? sel('f-batch', 'Upload', 'batch', [['', 'All uploads']], opts.batches.map((b) => [String(b.id), b.name])) : null,
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { Object.assign(F, BLANK, { q: F.q }); close(true); } }, 'Clear all'), h('button', { class: 'btn primary', onclick: () => close(true) }, 'Show leads'))));
      if (done) viewLeads();
    }

    // ---- board ----
    async function loadBoard() {
      body.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'spinner', style: 'margin:auto' })));
      let r; try { r = await api('GET', '/leads/board?' + qsFrom({ per: 50 })); } catch (e) { body.replaceChildren(h('div', { class: 'empty' }, e.message)); return; }
      const total = r.stages.reduce((a, s) => a + s.count, 0);
      countEl.textContent = total.toLocaleString() + (total === 1 ? ' lead' : ' leads');
      if (window.matchMedia('(max-width:700px)').matches) {
        let cur = lsGet('rs_leads_stage', ''); if (!r.stages.some((x) => x.key === cur)) cur = (r.stages.find((x) => x.count) || r.stages[0]).key;
        const list = h('div', { class: 'mlist' });
        const chips = h('div', { class: 'stagetabs' });
        const draw = () => {
          const st = r.stages.find((x) => x.key === cur);
          chips.replaceChildren(...r.stages.map((x) => h('button', { class: 'stab' + (x.key === cur ? ' on' : ''), onclick: () => { cur = x.key; lsSet('rs_leads_stage', cur); draw(); } }, x.label, h('i', null, x.count.toLocaleString()))));
          list.replaceChildren(...(st.leads.length ? st.leads.map((l) => { const c = boardCard(l); c.removeAttribute('draggable'); return c; }) : [h('div', { class: 'bempty' }, 'No leads in ' + st.label)]),
            ...(st.count > st.leads.length ? [h('button', { class: 'btn block', onclick: () => { lsSet('rs_leads_mode', 'table'); F.status = st.key === 'new' ? 'new,demo_needed,demo_ready' : st.key; viewLeads(); } }, 'See all ' + st.count.toLocaleString() + ' →')] : []));
          const on = chips.querySelector('.on'); if (on && on.scrollIntoView) on.scrollIntoView({ inline: 'center', block: 'nearest' });
        };
        draw(); body.replaceChildren(chips, list); return;
      }
      const board = h('div', { class: 'kanban' }, r.stages.map((st) => {
        const col = h('div', { class: 'bcol', 'data-stage': st.key },
          h('div', { class: 'bhead' }, h('b', null, st.label), h('span', null, st.count.toLocaleString())),
          h('div', { class: 'bcards' }, st.leads.length ? st.leads.map(boardCard) : h('div', { class: 'bempty' }, 'Drop leads here')),
          st.count > st.leads.length ? h('button', { class: 'bmore', onclick: () => { lsSet('rs_leads_mode', 'table'); F.status = st.key === 'new' ? 'new,demo_needed,demo_ready' : st.key; viewLeads(); } }, 'See all ' + st.count.toLocaleString() + ' →') : null);
        col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
        col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); });
        col.addEventListener('drop', (e) => { e.preventDefault(); col.classList.remove('over'); const id = +e.dataTransfer.getData('text/plain'); if (id) moveLead(id, st.key); });
        return col;
      }));
      body.replaceChildren(board);
    }
    function boardCard(l) {
      const due = l.next_action_at && new Date(l.next_action_at) < new Date();
      const when = l.status === 'callback' && l.callback_at ? '↻ ' + fmt(l.callback_at) : l.status === 'booked' && l.booked_at ? '📅 ' + fmt(l.booked_at) : l.next_action_at ? '⏰ ' + fmt(l.next_action_at, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
      const card = h('a', { class: 'bcard', href: '#/lead/' + l.id, draggable: 'true' },
        h('div', { class: 'bc-top' }, HEAT_DOT(l.heat), h('b', null, l.business),
          h('button', { class: 'bc-move', type: 'button', 'aria-label': 'Move ' + l.business, onclick: (e) => { e.preventDefault(); e.stopPropagation(); moveSheet(l); } }, icon('more'))),
        h('div', { class: 'bc-meta' }, [l.owner, l.city].filter(Boolean).join(' · ') || l.category || '—'),
        when || (isAdmin && l.rep_name) || l.attempts ? h('div', { class: 'bc-foot' },
          when ? h('span', { class: due ? 'due' : null }, when) : null,
          l.attempts ? h('span', null, l.attempts + (l.attempts === 1 ? ' call' : ' calls')) : null,
          isAdmin ? h('span', { class: 'rep' }, l.rep_name ? first(l.rep_name) : 'Unassigned') : null) : null);
      card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(l.id)); card.classList.add('dragging'); });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
      return card;
    }
    async function moveSheet(l) {
      const to = await sheet((box, close) => box.append(h('h2', null, 'Move ' + l.business), h('p', { class: 'sub' }, 'Now in ' + STAGE_NAME[STAGE_OF(l.status)]),
        h('div', { class: 'move-list' }, STAGES.map(([k, lab]) => h('button', { class: 'btn' + (STAGE_OF(l.status) === k ? ' primary' : ''), disabled: STAGE_OF(l.status) === k, onclick: () => close(k) }, lab))),
        h('button', { class: 'btn block', style: 'margin-top:10px', onclick: () => close(null) }, 'Cancel')));
      if (to) moveLead(l.id, to);
    }
    async function moveLead(id, stage) {
      try { await api('PATCH', '/leads/' + id, { status: stage }); toast('Moved to ' + STAGE_NAME[stage]); load(); } catch (e) { fail(e); }
    }

    // ---- table ----
    let offset = 0, rows = [];
    const sort = S.leadSort || (S.leadSort = { key: '', dir: 'asc' });
    async function loadTable(more) {
      if (!more) { offset = 0; rows = []; body.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'spinner', style: 'margin:auto' }))); }
      const qs = qsFrom({ limit: 100, offset });
      if (F.status) qs.set('status', F.status); else if (isAdmin) qs.set('status', 'all');
      if (sort.key) { qs.set('sort', sort.key); qs.set('dir', sort.dir); }
      let r; try { r = await api('GET', '/leads?' + qs); } catch (e) { body.replaceChildren(h('div', { class: 'empty' }, e.message)); return; }
      rows = rows.concat(r.leads); offset += r.leads.length;
      countEl.textContent = r.total.toLocaleString() + (r.total === 1 ? ' lead' : ' leads');
      const th = (key, label, cls) => h('th', { class: cls || null }, key ? h('button', { class: 'sortbtn' + (sort.key === key ? ' on' : ''), onclick: () => { sort.dir = sort.key === key && sort.dir === 'asc' ? 'desc' : 'asc'; sort.key = key; loadTable(); } },
        label, sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '') : label);
      const stageSel = (l) => {
        const s = h('select', { class: 'stage-sel s-' + STAGE_OF(l.status), 'aria-label': 'Stage for ' + l.business, onclick: (e) => e.stopPropagation() },
          STAGES.map(([k, lab]) => h('option', { value: k }, lab)), l.status === 'dnc' ? h('option', { value: 'dnc' }, 'Do Not Call') : null);
        s.value = STAGE_OF(l.status);
        s.onchange = async () => { try { await api('PATCH', '/leads/' + l.id, { status: s.value }); l.status = s.value; s.className = 'stage-sel s-' + s.value; toast('Moved to ' + STAGE_NAME[s.value]); } catch (e) { fail(e); s.value = STAGE_OF(l.status); } };
        return s;
      };
      const tbl = h('table', { class: 'ltable' },
        h('thead', null, h('tr', null,
          isAdmin ? h('th', { class: 'ck' }, h('input', { type: 'checkbox', 'aria-label': 'Select all', onchange: (e) => { tbl.querySelectorAll('tbody input[type=checkbox]').forEach((c) => { c.checked = e.target.checked; c.checked ? S.selected.add(+c.dataset.id) : S.selected.delete(+c.dataset.id); }); renderBulk(); } })) : null,
          th('business', 'Business'), th('', 'Phone', 'hide-sm'), th('status', 'Stage'), th('city', 'City', 'hide-sm'),
          isAdmin ? th('rep', 'Rep', 'hide-sm') : null, th('last_call', 'Last call', 'hide-md'), th('next', 'Next step', 'hide-md'))),
        h('tbody', null, rows.map((l) => {
          const tr = h('tr', { onclick: (e) => { if (!e.target.closest('select,input,a,button')) openLeadDrawer(l.id); } },
            isAdmin ? h('td', { class: 'ck' }, h('input', { type: 'checkbox', 'data-id': l.id, 'aria-label': 'Select ' + l.business, checked: S.selected.has(l.id), onchange: (e) => { e.target.checked ? S.selected.add(l.id) : S.selected.delete(l.id); renderBulk(); } })) : null,
            h('td', { class: 'biz' }, h('div', { class: 'bn' }, HEAT_DOT(l.heat), h('a', { href: '#/lead/' + l.id }, l.business)), h('small', null, [l.owner, l.category].filter(Boolean).join(' · '))),
            h('td', { class: 'hide-sm mono' }, l.phone ? h('a', { href: telHref(l.phone) }, l.phone) : l.email ? h('small', null, l.email) : '—'),
            h('td', null, stageSel(l)),
            h('td', { class: 'hide-sm' }, l.city || '—'),
            isAdmin ? h('td', { class: 'hide-sm' }, l.rep_name || h('small', null, 'Unassigned')) : null,
            h('td', { class: 'hide-md' }, l.last_call_at ? ago(l.last_call_at) : h('small', null, 'Never')),
            h('td', { class: 'hide-md' }, l.next_action ? h('span', { class: l.next_action_at && new Date(l.next_action_at) < new Date() ? 'due' : null }, l.next_action) : h('small', null, '—')));
          return tr;
        })));
      body.replaceChildren(...[h('div', { class: 'twrap' }, tbl), r.more ? h('button', { class: 'btn block', style: 'margin-top:10px', onclick: () => loadTable(true) }, 'Load more') : null, bulk].filter(Boolean));
      renderBulk();
    }
    const bulk = h('div', { class: 'bulk', hidden: true });
    function renderBulk() {
      if (!isAdmin || !S.selected.size) { bulk.hidden = true; return; }
      bulk.hidden = false;
      const run = async (b, msg) => { try { await api('POST', '/leads/bulk', Object.assign({ ids: [...S.selected] }, b)); toast(msg); S.selected.clear(); loadTable(); } catch (e) { fail(e); } };
      const repSel = h('select', { 'aria-label': 'Assign to' }, h('option', { value: 'auto' }, 'Spread across reps'), h('option', { value: 'none' }, 'Unassign'), opts.reps.filter((r) => r.active).map((r) => h('option', { value: r.id }, r.name)));
      const heatSel = h('select', { 'aria-label': 'Set heat', onchange: (e) => e.target.value && run({ action: 'heat', heat: e.target.value }, 'Heat updated') }, h('option', { value: '' }, 'Set heat…'), HEAT.map(([k, l]) => h('option', { value: k }, l)));
      const tagIn = h('input', { placeholder: 'Add a tag', maxlength: 30, 'aria-label': 'Tag' });
      bulk.replaceChildren(h('b', null, S.selected.size + ' selected'), repSel, h('button', { class: 'btn small primary', onclick: () => run({ action: 'assign', rep: repSel.value }, 'Assigned') }, 'Assign'),
        heatSel, tagIn, h('button', { class: 'btn small', onclick: () => tagIn.value.trim() && run({ action: 'tag', tag: tagIn.value }, 'Tagged') }, 'Tag'),
        h('button', { class: 'btn small', onclick: () => { S.selected.clear(); loadTable(); } }, 'Clear'));
    }

    const load = () => (mode === 'board' ? loadBoard() : loadTable());
    shell('leads', [
      h('div', { class: 'lhead' },
        h('div', { class: 'lt' }, h('h1', null, isAdmin ? 'Leads' : 'My leads'), countEl),
        h('div', { class: 'row', style: 'gap:8px' }, seg,
          isAdmin ? h('button', { class: 'tbtn hide-sm', onclick: () => exportCsv(F, FKEYS) }, 'Export') : null,
          isAdmin ? h('a', { class: 'tbtn primary', href: '#/upload' }, '+ Add') : null)),
      h('div', { class: 'ltools' }, search, filterBtn),
      quick, body,
    ]);
    load();
  }

  async function exportCsv(F, keys) {
    const qs = new URLSearchParams();
    for (const k of keys) if (F[k]) qs.set(k, F[k]);
    if (F.status === '') qs.delete('status');
    try {
      toast('Preparing export…');
      const res = await fetch('/api/leads/export?' + qs, { credentials: 'same-origin' });
      if (!res.ok) { let m = 'Export failed'; try { m = (await res.json()).error || m; } catch { /* ignore */ } throw new Error(m); }
      const blob = await res.blob();
      const a = h('a', { href: URL.createObjectURL(blob), download: 'reekon-leads-' + new Date().toISOString().slice(0, 10) + '.csv' });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast('Exported ✓');
    } catch (e) { fail(e); }
  }

  /* ================= lead detail ================= */
  /* ---- lead side panel: any lead link opens the lead in a drawer instead of a new page ---- */
  let drawer = null;
  function closeDrawer() {
    if (!drawer) return;
    const d = drawer; drawer = null;
    d.root.remove(); document.body.classList.remove('has-drawer');
    document.removeEventListener('keydown', d.onKey);
    if (d.dirty && !/^#\/lead\//.test(location.hash)) render();
  }
  async function openLeadDrawer(id) {
    if (!drawer) {
      const body = h('div', { class: 'drawer-body' }, h('div', { class: 'empty-sm' }, h('div', { class: 'spinner', style: 'margin:auto' })));
      const full = h('a', { class: 'btn small', href: '#/lead/' + id, 'data-full': '1' }, 'Open full page ↗');
      const root = h('div', { class: 'drawer-root' },
        h('div', { class: 'drawer-scrim', onclick: closeDrawer }),
        h('aside', { class: 'drawer', role: 'dialog', 'aria-label': 'Lead' },
          h('div', { class: 'drawer-bar' }, h('button', { class: 'btn small', onclick: closeDrawer }, '✕ Close'), full),
          body));
      const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.scrim')) closeDrawer(); };
      document.addEventListener('keydown', onKey);
      root.addEventListener('click', (e) => {
        const a = e.target.closest('a[href^="#/"]');
        if (!a || a.dataset.full || /^#\/lead\//.test(a.getAttribute('href'))) return;
        closeDrawer();
      });
      document.body.append(root); document.body.classList.add('has-drawer');
      drawer = { root, body, full, onKey, dirty: false };
    }
    drawer.full.setAttribute('href', '#/lead/' + id);
    try { await viewLead(id, { drawer }); }
    catch (e) { drawer.body.replaceChildren(h('div', { class: 'empty' }, h('b', null, 'Could not load this lead'), e.message)); }
  }
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    const a = e.target.closest && e.target.closest('a[href^="#/lead/"]');
    if (!a || a.dataset.full || !S.me || S.me.role === 'dev') return;
    const m = a.getAttribute('href').match(/^#\/lead\/(\d+)$/);
    if (!m) return;
    e.preventDefault(); openLeadDrawer(+m[1]);
  });

  async function viewLead(id, opts) {
    const D = opts && opts.drawer;
    const openLead = (x) => { if (D) openLeadDrawer(x); else location.hash = '#/lead/' + x; };
    const isAdmin = S.me.role === 'admin';
    const [{ lead: L, calls, notes, deals = [], demo = null, dials = [] }, script, dialer] = await Promise.all([api('GET', '/leads/' + id), S.me.role === 'dev' ? null : getScript(), S.me.role === 'dev' ? null : getDialer()]);
    const reload = () => { if (D) D.dirty = true; return viewLead(id, opts); };
    const closed = ['won', 'lost', 'dnc'].includes(L.status);

    const seller = S.me.role === 'admin' || S.me.role === 'rep';

    /* ---- call mode: Google profile, live notes, Google Voice popup + call bar ---- */
    const isGoogleUrl = (u) => /^https?:\/\/([a-z0-9-]+\.)*(google\.[a-z.]+\/maps|goo\.gl|g\.page|maps\.app\.goo\.gl)/i.test(u || '');
    const profileUrl = L.link && isGoogleUrl(L.link) ? L.link
      : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([L.business, L.address || L.city].filter(Boolean).join(' ')) + (L.place_id ? '&query_place_id=' + encodeURIComponent(L.place_id) : '');
    const live = h('textarea', { class: 'live-notes', rows: 5, placeholder: 'Type while you talk: owner name, what they use now, objections, what they said about missed calls…' });
    live.value = L.call_notes || '';
    const liveState = h('small', { class: 'dim' }, 'Autosaves as you type');
    let liveT = null, livePending = false;
    const flushLive = async () => {
      clearTimeout(liveT);
      if (!livePending) return;
      livePending = false;
      try { await api('POST', '/leads/' + id + '/meta', { call_notes: live.value }); liveState.textContent = 'Saved ✓'; } catch { livePending = true; liveState.textContent = 'Not saved, check your connection'; }
    };
    live.addEventListener('input', () => { livePending = true; liveState.textContent = 'Typing…'; clearTimeout(liveT); liveT = setTimeout(flushLive, 700); });
    live.addEventListener('blur', flushLive);
    const gvBar = h('div', { class: 'gvbar', hidden: true });
    let gvTimer = null, gvStart = 0;
    function stopBar() { clearInterval(gvTimer); gvBar.hidden = true; }
    function startBar() {
      gvStart = Date.now(); gvBar.hidden = false; clearInterval(gvTimer);
      const clock = h('b', { class: 'gv-clock' }, '0:00');
      gvBar.replaceChildren(h('div', { class: 'gv-top' }, h('span', { class: 'live' }), h('span', null, 'On call · ' + L.business), clock),
        h('div', { class: 'gv-btns' }, [['no_answer', 'No answer'], ['voicemail', 'Voicemail'], ['gatekeeper', 'Gatekeeper'], ['not_interested', 'Not interested'], ['callback', 'Callback'], ['booked', 'Audit booked']]
          .map(([k, label]) => h('button', { class: 'oc' + (k === 'booked' ? ' booked' : ''), onclick: () => logCall(k) }, label))));
      gvTimer = setInterval(() => {
        if (!document.body.contains(gvBar)) { clearInterval(gvTimer); return; }
        const sec = Math.floor((Date.now() - gvStart) / 1000);
        clock.textContent = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
      }, 1000);
    }
    function gvCall() {
      const w = window.open(gvHref(L.phone), 'gvoice', 'popup=yes,width=440,height=780,left=' + Math.max(0, (screen.availWidth || 1200) - 470) + ',top=40');
      if (!w) toast('Popup blocked. Allow popups for this site, then tap Call again.', true);
      startBar();
    }
    const goNext = async () => {
      try { const r = await api('GET', '/leads/next?after=' + id); if (r.id) openLead(r.id); else toast('No more dialable leads right now', true); } catch (x) { fail(x); }
    };
    const smsBody = `Hi ${L.owner ? L.owner.split(' ')[0] : 'there'}, it's ${S.me.name.split(' ')[0]} with Reekon Systems. Here's the free website we built for ${L.business}: ${L.demo_url || ''}`;
    const actions = h('div', { class: 'actions' },
      L.phone ? (dialer && dialer.ready && seller ? h('button', { class: 'btn ok wide', onclick: () => startCall(L, () => { if (D || location.hash === '#/lead/' + L.id) reload(); }) }, icon('phone'), 'Call ' + L.phone) : h('button', { class: 'btn ok wide', onclick: gvCall }, icon('phone'), 'Call ' + L.phone + ' (Google Voice)')) : h('div', { class: 'btn wide', style: 'opacity:.5' }, 'No phone number'),
      L.phone && seller ? (dialer && dialer.ready ? h('button', { class: 'btn small', onclick: gvCall }, 'Call with Google Voice instead') : h('a', { class: 'btn small', href: telHref(L.phone) }, 'Use my phone dialer')) : null,
      L.email && seller ? h('button', { class: 'btn ' + (L.emailed_at ? '' : 'primary ') + (L.phone ? '' : 'wide'), onclick: () => emailSheet(L, reload) }, icon('mail'), L.emailed_at ? 'Email again' : 'Email first') : null,
      h('a', { class: 'btn', href: '#/studio/' + L.id }, icon('spark'), L.demo_url ? 'Edit in Studio' : 'Demo Studio'),
      L.demo_url && L.phone ? h('a', { class: 'btn primary', href: 'sms:' + String(L.phone).replace(/[^\d+]/g, '') + '?&body=' + encodeURIComponent(smsBody) }, icon('sms'), 'Text demo') : null,
      L.demo_url ? h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(L.demo_url); toast('Demo link copied'); } catch { prompt('Copy the demo link:', L.demo_url); } } }, icon('copy'), 'Copy link') : null,
      L.demo_url ? h('a', { class: 'btn', href: L.demo_url, target: '_blank', rel: 'noopener' }, icon('demos'), 'Open demo') : null,
      L.link ? h('a', { class: 'btn', href: L.link, target: '_blank', rel: 'noopener noreferrer' }, icon('link'), 'Google / social') : null);

    const info = h('div', { class: 'info' },
      [['Owner', L.owner], ['Phone', L.phone], ['Email', L.email], ['Emailed', L.emailed_at ? fmt(L.emailed_at) : (L.email ? 'Not yet' : null)], ['Address', L.address], ['Rating', L.rating], ['City', L.city], ['Category', L.category], ['Batch', L.batch_name], ['Rep', L.rep_name || 'Unassigned'],
        ['Demo', L.demo_url ? 'Ready' : 'Not ready yet'],
        L.demo_url ? ['Demo opened', L.demo_views ? L.demo_views + (L.demo_views === 1 ? ' time' : ' times') + ' · last ' + fmt(L.demo_viewed_at) : 'Not yet'] : null, ['Calls made', String(L.attempts || 0)],
        L.callback_at && L.status === 'callback' ? ['Callback', fmt(L.callback_at)] : null,
        L.booked_at && L.status === 'booked' ? ['Booked call', fmt(L.booked_at)] : null]
        .filter((x) => x && x[1]).map(([k, v]) => h('div', null, h('span', null, k), h('span', null, v))));

    const BOT_STATUS = { queued: 'Queued, goes out in the next sending window', done: 'All emails sent, no reply yet', replied: 'Replied 🔥',
      opted_out: 'Asked not to be emailed', bounced: "Bounced, the address doesn't work", stopped: 'Stopped' };
    const botText = !L.email ? null : L.email_status === 'active'
      ? 'Email ' + (L.email_step || 1) + ' sent' + (L.email_next_at ? ' · next one ' + fmt(L.email_next_at) : '')
      : BOT_STATUS[L.email_status] || (L.emailed_at ? 'Emailed ' + fmt(L.emailed_at) : 'Not emailed yet');
    const botAct = async (action, msg) => { try { await api('POST', '/leads/' + L.id + '/emailbot', { action }); toast(msg); reload(); } catch (x) { fail(x); } };
    const botBtns = !L.email || !seller ? [] : !L.email_status && !L.emailed_at ? [h('button', { class: 'btn small', onclick: () => botAct('queue', 'Queued for the email bot') }, icon('mail'), 'Email with the bot')]
      : L.email_status === 'queued' ? [h('button', { class: 'btn small', onclick: () => botAct('stop', 'Removed from the bot') }, 'Cancel')]
      : L.email_status === 'active' ? [h('button', { class: 'btn small', onclick: () => botAct('queue', 'Next email goes out in the next window') }, 'Send next one sooner'), h('button', { class: 'btn small', onclick: () => botAct('stop', 'Emails stopped') }, 'Stop emails')]
      : L.email_status === 'stopped' ? [h('button', { class: 'btn small', onclick: () => botAct('resume', 'Emails resumed') }, 'Resume emails')] : [];
    const botRow = botText ? h('div', { class: 'bot-row' }, h('div', null, h('span', { class: 'eyebrow' }, 'Email bot'), h('div', null, botText)), botBtns.length ? h('div', { class: 'row wrap' }, botBtns) : null) : null;

    async function logCall(outcome) {
      let extra = {};
      if (outcome === 'callback') {
        const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(10, 0, 0, 0);
        extra = await sheet((box, close) => {
          const when = h('input', { type: 'datetime-local', value: toLocalInput(t) });
          const note = h('textarea', { placeholder: 'Optional note — who to ask for, best time…' });
          const quick = (label, fn) => h('button', { class: 'btn small', type: 'button', onclick: () => { const d = new Date(); fn(d); when.value = toLocalInput(d); } }, label);
          box.append(h('h2', null, 'Schedule callback'), h('p', { class: 'sub' }, L.business),
            h('div', { class: 'row wrap', style: 'margin-bottom:12px' },
              quick('In 1 hour', (d) => d.setHours(d.getHours() + 1, 0, 0, 0)), quick('In 3 hours', (d) => d.setHours(d.getHours() + 3, 0, 0, 0)),
              quick('Tomorrow 10am', (d) => { d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); })),
            h('div', { class: 'field' }, h('label', null, 'Date & time'), when), h('div', { class: 'field' }, h('label', null, 'Note'), note),
            h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'),
              h('button', { class: 'btn primary', onclick: () => { if (!when.value) return toast('Pick a time', true); close({ callback_at: new Date(when.value).toISOString(), note: note.value }); } }, 'Save callback')));
        });
        if (!extra) return;
      } else if (outcome === 'booked') {
        extra = await sheet((box, close) => {
          const when = h('input', { type: 'datetime-local' });
          const note = h('textarea', { placeholder: 'What did they want? Budget, timing, decision maker…' });
          box.append(h('h2', null, 'Booked! 🎉'), h('p', { class: 'sub' }, 'When is the follow-up call with the closer?'),
            h('div', { class: 'field' }, h('label', null, 'Follow-up call (optional)'), when), h('div', { class: 'field' }, h('label', null, 'Note for the closer'), note),
            h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'),
              h('button', { class: 'btn ok', onclick: () => close({ booked_at: when.value ? new Date(when.value).toISOString() : null, note: note.value }) }, 'Save booking')));
        });
        if (!extra) return;
      } else if (outcome === 'dnc') {
        if (!(await confirmSheet('Mark Do Not Call?', 'This hides the lead from every rep for good, and blocks this number from future batches.', 'Do Not Call', true))) return;
      } else if (outcome === 'not_interested') {
        if (!(await confirmSheet('Not interested?', 'This closes the lead as lost.', 'Close as lost', true))) return;
      }
      try {
        await flushLive();
        const r = await api('POST', '/leads/' + id + '/calls', Object.assign({ outcome }, seller ? { call_notes: live.value } : {}, extra));
        stopBar();
        toast(OUTCOME_LABEL[outcome] + ' logged → ' + STATUS[r.status]);
        if (outcome === 'dnc' && S.me.role === 'rep') { if (D) closeDrawer(); else location.hash = '#/leads'; return; }
        if (seller && ['no_answer', 'voicemail', 'gatekeeper', 'not_interested', 'dnc'].includes(outcome) && lsGet('rs_autonext', '1') === '1') {
          const nx = await api('GET', '/leads/next?after=' + id).catch(() => null);
          if (nx && nx.id) { if (D) D.dirty = true; openLead(nx.id); return; }
        }
        reload();
      } catch (e) { fail(e); }
    }

    const outcomes = h('div', { class: 'outcomes' }, OUTCOMES.map(([k, label]) =>
      h('button', { class: 'oc ' + (k === 'dnc' ? 'dnc' : k === 'booked' ? 'booked' : ''), disabled: closed && !isAdmin, onclick: () => logCall(k) }, label)));

    // admin: close the deal (amount + commission) — creates a deal and marks the lead Closed won
    const closeBtn = isAdmin && !deals.length && L.status !== 'dnc'
      ? h('button', { class: 'btn ok block close-deal', onclick: async () => { if (await dealSheet({ lead: L })) reload(); } },
        icon('deals'), L.status === 'won' ? 'Add the deal amount' : 'Close deal (Closed won)')
      : null;

    const dealBox = deals.length ? h('div', { class: 'section' }, h('span', { class: 'eyebrow' }, isAdmin ? 'Deal' : 'Your commission'),
      deals.map((d) => dealCard(d, isAdmin ? async () => { if (await dealSheet({ lead: L, deal: d })) reload(); } : null)),
      isAdmin ? h('button', { class: 'btn small', style: 'margin-top:10px', onclick: async () => { if (await dealSheet({ lead: L })) reload(); } }, '+ Add another deal (upsell)') : null) : null;

    const scriptPanel = script ? scriptBox(script.sections, ctxFor(L), true) : null;
    const emailCue = L.emailed_at && seller && !closed ? h('div', { class: 'cue-box section' }, h('b', null, '✉ You emailed them ' + emailDay(L.emailed_at) + '. Open with it:'),
      h('p', null, `"Hey ${first(L.owner) || 'there'}, this is ${first(S.me.name)} with Reekon Systems. I sent you an email ${emailDay(L.emailed_at)} with a free website we built for ${L.business}. Ring a bell?"`),
      L.demo_views ? h('p', { class: 'dim' }, '👀 They opened the demo ' + L.demo_views + (L.demo_views === 1 ? ' time' : ' times') + '. Mention it: "I saw you checked it out, what did you think?"') : null) : null;
    const heatSeg = seller ? h('div', { class: 'seg heat-seg' }, HEAT.map(([k, l, e]) => h('button', { class: (L.heat || 'cold') === k ? 'on ' + k : k, onclick: async () => {
      try { await api('POST', '/leads/' + id + '/heat', { heat: k }); toast('Marked ' + l); reload(); } catch (x) { fail(x); }
    } }, e + ' ' + l))) : null;

    async function moveStage(k) {
      if (k === L.status || (k === 'new' && ['new', 'demo_needed', 'demo_ready'].includes(L.status))) return;
      await flushLive();
      try {
        if (k === 'won') {
          if (isAdmin && (await dealSheet({ lead: L }))) { toast('Deal closed 💰'); reload(); }
          return;
        }
        let body = { status: k };
        if (k === 'callback') {
          const d0 = new Date(); d0.setDate(d0.getDate() + 1); d0.setHours(10, 0, 0, 0);
          const when = await sheet((box, close) => {
            const t = h('input', { type: 'datetime-local', value: toLocalInput(d0) });
            const q = (label, fn) => h('button', { class: 'btn small', type: 'button', onclick: () => { const d = new Date(); fn(d); t.value = toLocalInput(d); } }, label);
            box.append(h('h2', null, 'Callback time'), h('p', { class: 'sub' }, L.business),
              h('div', { class: 'row wrap', style: 'margin-bottom:12px' }, q('In 1 hour', (d) => d.setHours(d.getHours() + 1, 0, 0, 0)), q('In 3 hours', (d) => d.setHours(d.getHours() + 3, 0, 0, 0)), q('Tomorrow 10am', (d) => { d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); })),
              h('div', { class: 'field' }, h('label', null, 'Date & time'), t),
              h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => close(t.value ? new Date(t.value).toISOString() : null) }, 'Save')));
          });
          if (!when) return;
          body.callback_at = when;
        }
        await api('PATCH', '/leads/' + id, body);
        toast('Moved to ' + STATUS[k]);
        reload();
      } catch (x) { fail(x); }
    }
    const STAGE_CHIPS = [['new', 'New'], ['called', 'Contacted'], ['callback', 'Callback'], ['booked', 'Audit booked'], ['call2', 'Call 2']].concat(isAdmin ? [['won', 'Won']] : []).concat([['lost', 'Lost']]);
    const curChip = ['demo_needed', 'demo_ready'].includes(L.status) ? 'new' : L.status;
    const stageRow = seller && L.status !== 'dnc' ? h('div', { class: 'callmode-stage' }, h('span', { class: 'eyebrow' }, 'Stage'),
      h('div', { class: 'stagechips' }, STAGE_CHIPS.map(([k, label]) => h('button', { class: 'schip s-' + k + (curChip === k ? ' on' : ''), 'aria-pressed': curChip === k, onclick: () => moveStage(k) }, label)))) : null;
    const gStars = L.rating ? '★ ' + L.rating + (L.reviews ? ' · ' + Number(L.reviews).toLocaleString() + ' reviews' : '') : (L.reviews ? Number(L.reviews).toLocaleString() + ' reviews' : '');
    const profileRow = seller ? h('div', { class: 'profile-row' },
      h('a', { class: 'btn primary profile-btn', href: profileUrl, target: '_blank', rel: 'noopener noreferrer' }, icon('link'), 'Open Google profile'),
      gStars ? h('span', { class: 'profile-meta' }, gStars) : null,
      L.instagram
        ? h('a', { class: 'btn small', href: L.instagram, target: '_blank', rel: 'noopener noreferrer' }, 'Instagram ↗')
        : h('a', { class: 'btn small', target: '_blank', rel: 'noopener noreferrer', href: 'https://www.google.com/search?q=' + encodeURIComponent('site:instagram.com ' + L.business + ' ' + (L.city || '')) }, 'Find on Instagram'),
      h('button', { class: 'btn small', onclick: async () => {
        const v = await sheet((box, close) => {
          const inp = h('input', { type: 'text', placeholder: '@handle or instagram.com link', value: L.instagram ? L.instagram.replace('https://instagram.com/', '@') : '' });
          box.append(h('h2', null, 'Instagram for ' + L.business), h('div', { class: 'field' }, h('label', null, 'Handle or link'), inp),
            h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => close(inp.value.trim()) }, 'Save')));
        });
        if (v === null) return;
        try { await api('POST', '/leads/' + id + '/meta', { instagram: v }); toast('Saved'); reload(); } catch (e) { fail(e); }
      } }, L.instagram ? 'Edit IG' : 'Save IG'),
      h('button', { class: 'btn small', onclick: async () => {
        try { const t = await api('GET', '/tracker'); await api('PUT', '/tracker', { dms: t.day.dms + 1 }); toast('DM logged (' + (t.day.dms + 1) + ' today)'); } catch (e) { fail(e); }
      } }, 'Sent a DM'),
      (() => { const w = L.booked_at && ['booked', 'call2'].includes(L.status) ? [L.booked_at, (L.status === 'call2' ? 'Call 2: ' : 'Free AI audit: '), 30] : L.callback_at && L.status === 'callback' ? [L.callback_at, 'Callback: ', 15] : null; return w ? h('a', { class: 'btn small', target: '_blank', rel: 'noopener', href: gcalLink({ title: w[1] + L.business, start: w[0], minutes: w[2], details: 'Phone: ' + (L.phone || '') + '\nFrom Reekon CRM' }) }, '+ Calendar') : null; })(),
      h('button', { class: 'btn small', onclick: goNext }, 'Next lead →')) : null;
    const earlier = notes.slice(0, 3);
    const liveBox = seller && L.status !== 'dnc' ? h('div', { class: 'live-box section' },
      h('div', { class: 'live-head' }, h('span', { class: 'eyebrow' }, 'Call notes'), liveState),
      live,
      earlier.length ? h('div', { class: 'earlier' }, earlier.map((n) => h('div', null, h('small', null, fmt(n.created_at, { month: 'short', day: 'numeric' }) + ' · '), n.body.length > 160 ? n.body.slice(0, 160) + '…' : n.body))) : null,
      h('label', { class: 'autonext' }, h('input', { type: 'checkbox', checked: lsGet('rs_autonext', '1') === '1', onchange: (e) => lsSet('rs_autonext', e.target.checked ? '1' : '0') }),
        'After a miss (no answer, voicemail, gatekeeper, not interested) jump to the next lead')) : null;

    const noteBox = h('textarea', { placeholder: 'Notes from this call…' });
    const saveNote = h('button', { class: 'btn primary block', style: 'margin-top:8px', onclick: async () => {
      if (!noteBox.value.trim()) return toast('Write a note first', true);
      saveNote.disabled = true;
      try { await api('POST', '/leads/' + id + '/notes', { body: noteBox.value }); toast('Note saved'); reload(); } catch (e) { fail(e); saveNote.disabled = false; }
    } }, 'Save note');

    const hist = [...calls.map((c) => ({ t: c.created_at, kind: 'call', c })), ...notes.map((n) => ({ t: n.created_at, kind: 'note', n })),
      ...deals.map((d) => ({ t: d.created_at, kind: 'deal', d })),
      demo ? { t: demo.created_at, kind: 'demo', d: demo } : null,
      L.demo_viewed_at ? { t: L.demo_viewed_at, kind: 'view' } : null,
      L.created_at ? { t: L.created_at, kind: 'added' } : null].filter(Boolean)
      .sort((a, b) => (a.t < b.t ? 1 : -1));
    const li = (cls, title, rest, when, extra) => h('li', { class: cls }, h('b', null, title), rest || null, h('div', { class: 'when' }, when), extra || null);
    const timeline = hist.length ? h('ul', { class: 'timeline' }, hist.map((x) => {
      if (x.kind === 'note') return li('note', x.n.user_name || 'Someone', ' added a note', fmt(x.t), h('div', { class: 'text' }, x.n.body));
      if (x.kind === 'deal') return li('deal', 'Deal closed · ' + money(x.d.amount_cents), x.d.package ? h('span', { class: 'muted' }, ' · ' + x.d.package) : null, (x.d.rep_name || '') + ' · ' + fmt(x.t));
      if (x.kind === 'demo') return li('demo', 'Demo built', h('span', { class: 'muted' }, ' · ' + (x.d.theme || '') + ' theme'), (x.d.by_name || '') + ' · ' + fmt(x.t) + (x.d.updated_at && x.d.updated_at !== x.d.created_at ? ' · edited ' + fmt(x.d.updated_at) : ''));
      if (x.kind === 'view') return li('view', 'They opened the demo', h('span', { class: 'muted' }, ' · ' + (L.demo_views || 1) + (L.demo_views === 1 ? ' time' : ' times') + ' total'), 'last ' + fmt(x.t));
      if (x.kind === 'added') return li('added', 'Lead added', h('span', { class: 'muted' }, L.source === 'api' ? ' by the scraper' : ' from CSV upload'), (L.batch_name ? L.batch_name + ' · ' : '') + fmt(x.t));
      return li(x.c.outcome === 'booked' ? 'ok' : x.c.outcome === 'emailed' ? 'demo' : '', OUTCOME_LABEL[x.c.outcome] || x.c.outcome,
        x.c.to_status && x.c.to_status !== x.c.from_status ? h('span', { class: 'muted' }, ' → ' + (STATUS[x.c.to_status] || x.c.to_status)) : null,
        (x.c.user_name || '') + ' · ' + fmt(x.t));
    })) : h('p', { class: 'dim' }, 'No activity yet.');

    // tags + next step (admin and the lead's rep)
    const canEdit = S.me.role === 'admin' || S.me.role === 'rep';
    const saveMeta = async (body, msg) => { try { await api('POST', '/leads/' + id + '/meta', body); toast(msg); reload(); } catch (x) { fail(x); } };
    const tagRow = h('div', { class: 'tag-row' },
      (L.tags || []).map((t) => h('span', { class: 'tchip' }, '#' + t, canEdit ? h('button', { 'aria-label': 'Remove tag ' + t, onclick: () => saveMeta({ tags: L.tags.filter((x) => x !== t) }, 'Tag removed') }, '×') : null)),
      canEdit ? h('button', { class: 'tchip add', onclick: async () => {
        const opts2 = await getOptions();
        const tag = await sheet((box, close) => {
          const inp = h('input', { placeholder: 'e.g. spanish, follow-up, big-shop', maxlength: 30 });
          const sugg = (opts2.tags || []).filter((t) => !(L.tags || []).includes(t)).slice(0, 12);
          box.append(h('h2', null, 'Add a tag'), h('p', { class: 'sub' }, 'Short labels you can filter by later.'),
            h('div', { class: 'field' }, h('label', null, 'Tag'), inp),
            sugg.length ? h('div', { class: 'row wrap', style: 'margin-bottom:12px' }, sugg.map((t) => h('button', { class: 'btn small', type: 'button', onclick: () => close(t) }, '#' + t))) : null,
            h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => close(inp.value.trim() || null) }, 'Add tag')));
          setTimeout(() => inp.focus(), 50);
        });
        if (tag) saveMeta({ tags: (L.tags || []).concat(tag) }, 'Tag added');
      } }, '+ Tag') : null);

    const nextDue = L.next_action_at && new Date(L.next_action_at) < new Date();
    const setNext = async () => {
      const t0 = L.next_action_at ? new Date(L.next_action_at) : (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); return d; })();
      const v = await sheet((box, close) => {
        const what = h('input', { placeholder: 'e.g. Call back about pricing', value: L.next_action || '', maxlength: 140 });
        const when = h('input', { type: 'datetime-local', value: toLocalInput(t0) });
        const quick = (label, fn) => h('button', { class: 'btn small', type: 'button', onclick: () => { const d = new Date(); fn(d); when.value = toLocalInput(d); } }, label);
        box.append(h('h2', null, 'Next step'), h('p', { class: 'sub' }, 'What happens next with ' + L.business + ', and when.'),
          h('div', { class: 'field' }, h('label', null, 'What'), what),
          h('div', { class: 'row wrap', style: 'margin-bottom:10px' },
            quick('In 2 hours', (d) => d.setHours(d.getHours() + 2, 0, 0, 0)), quick('Tomorrow 10am', (d) => { d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); }),
            quick('In 3 days', (d) => { d.setDate(d.getDate() + 3); d.setHours(10, 0, 0, 0); }), quick('Next week', (d) => { d.setDate(d.getDate() + 7); d.setHours(10, 0, 0, 0); })),
          h('div', { class: 'field' }, h('label', null, 'When'), when),
          h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'),
            h('button', { class: 'btn primary', onclick: () => { if (!when.value) return toast('Pick a time', true); close({ next_action_at: new Date(when.value).toISOString(), next_action: what.value }); } }, 'Save')));
      });
      if (v) saveMeta(v, 'Next step saved');
    };
    const nextBox = canEdit ? h('div', { class: 'next-box' + (nextDue ? ' due' : '') + (L.next_action_at ? '' : ' empty') },
      h('span', { class: 'kic' }, icon('cal')),
      h('div', { class: 'nb-body' }, L.next_action_at
        ? [h('b', null, L.next_action || 'Follow up'), h('div', { class: 'sub' }, (nextDue ? 'Overdue · ' : '') + fmt(L.next_action_at, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))]
        : [h('b', null, 'No next step set'), h('div', { class: 'sub' }, 'Every open lead should have one.')]),
      h('div', { class: 'row' }, L.next_action_at ? h('button', { class: 'btn small', onclick: () => saveMeta({ next_action_at: null, next_action: null }, 'Cleared') }, 'Done') : null,
        h('button', { class: 'btn small ' + (L.next_action_at ? '' : 'primary'), onclick: setNext }, L.next_action_at ? 'Change' : 'Set'))) : null;

    // admin: quick reassign right in the header
    let repQuick = null;
    if (isAdmin) {
      const o = await getOptions();
      const rs = h('select', { class: 'rep-quick', 'aria-label': 'Assigned rep' }, h('option', { value: '' }, 'Unassigned'), o.reps.filter((r) => r.active || r.id === L.assigned_to).map((r) => h('option', { value: r.id }, r.name)));
      rs.value = L.assigned_to || '';
      rs.onchange = async () => { try { await api('PATCH', '/leads/' + id, { assigned_to: rs.value ? +rs.value : null }); toast(rs.value ? 'Assigned to ' + rs.selectedOptions[0].textContent : 'Unassigned'); reload(); } catch (x) { fail(x); } };
      repQuick = h('label', { class: 'rep-pick' }, h('span', null, 'Rep'), rs);
    }

    let adminPanel = null;
    if (isAdmin) {
      const opts = await getOptions();
      const f = (label, name, value, type) => h('div', { class: 'field' }, h('label', null, label), h('input', { name, value: value || '', type: type || 'text' }));
      const repSel = h('select', { name: 'assigned_to' }, h('option', { value: '' }, 'Unassigned'), opts.reps.filter((r) => r.active || r.id === L.assigned_to).map((r) => h('option', { value: r.id }, r.name)));
      repSel.value = L.assigned_to || '';
      const stSel = h('select', { name: 'status' }, Object.entries(STATUS).map(([k, v]) => h('option', { value: k }, v)));
      stSel.value = L.status;
      const form = h('form', null,
        h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', null, 'Rep'), repSel), h('div', { class: 'field' }, h('label', null, 'Status'), stSel)),
        f('Demo link', 'demo_url', L.demo_url, 'url'),
        f('Business', 'business', L.business), h('div', { class: 'grid2' }, f('Owner', 'owner', L.owner), f('Phone', 'phone', L.phone, 'tel')),
        h('div', { class: 'grid2' }, f('City', 'city', L.city), f('Category', 'category', L.category)),
        h('div', { class: 'grid2' }, f('Email', 'email', L.email, 'email'), f('Address', 'address', L.address)),
        f('Google / social link', 'link', L.link, 'url'),
        h('button', { class: 'btn primary block', type: 'submit' }, 'Save changes'));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(form));
        if (d.status === L.status) delete d.status;
        if (d.status === 'dnc' && !(await confirmSheet('Mark Do Not Call?', 'Hides this lead from reps and blocks the number from future batches.', 'Do Not Call', true))) return;
        d.assigned_to = d.assigned_to ? +d.assigned_to : null;
        // Closed won goes through the deal sheet so every close has an amount + commission
        const toWon = d.status === 'won' && !deals.length;
        if (toWon) delete d.status;
        try {
          await api('PATCH', '/leads/' + id, d);
          if (toWon) { if (await dealSheet({ lead: Object.assign({}, L, { assigned_to: d.assigned_to }) })) toast('Deal closed 💰'); else toast('Saved (status not changed)'); }
          else toast('Saved');
          reload();
        } catch (x) { fail(x); }
      });
      adminPanel = h('details', { class: 'admin' }, h('summary', null, 'Admin: edit, assign, close', h('span', { class: 'dim' }, '▾')), h('div', { class: 'card' }, form));
    }

    const page = [
      D ? null : h('a', { class: 'back', href: '#/leads', onclick: (e) => { if (S.cameFromList) { e.preventDefault(); window.history.back(); } } }, icon('back'), 'Back'),
      h('div', { class: 'detail-head' }, h('div', { class: 'row wrap', style: 'gap:8px;margin-bottom:8px' }, pill(L.status), L.demo_sent ? h('span', { class: 'tag good' }, 'Demo sent') : null,
        L.demo_views ? h('span', { class: 'tag hot' }, '👀 viewed ' + L.demo_views + 'x') : null),
        h('h1', null, L.business), h('div', { class: 'detail-meta' }, repQuick, tagRow)),
      profileRow,
      actions,
      liveBox,
      stageRow,
      heatSeg,
      nextBox,
      emailCue,
      scriptPanel,
      h('div', { class: 'card section' }, info, botRow),
      dials.length ? h('div', { class: 'section' }, h('span', { class: 'eyebrow' }, 'Call recordings'), h('div', { class: 'card' }, dials.map(dialRow))) : null,
      dealBox,
      h('div', { class: 'section' }, h('span', { class: 'eyebrow' }, 'Log this call'), outcomes, closeBtn),
      h('div', { class: 'section' }, h('span', { class: 'eyebrow' }, 'Notes'), noteBox, saveNote),
      h('div', { class: 'section' }, h('span', { class: 'eyebrow' }, 'History'), h('div', { class: 'card' }, timeline)),
      adminPanel,
      gvBar,
    ];
    if (D) { D.body.replaceChildren(...page.filter(Boolean)); D.body.scrollTop = 0; }
    else shell(S.me.role === 'admin' || S.me.role === 'rep' ? 'leads' : 'demos', page);
  }

  /* ================= email first ================= */
  function emailDay(iso) {
    if (!iso) return '';
    const d = new Date(iso), t = new Date();
    const days = Math.round((new Date(t.toDateString()) - new Date(d.toDateString())) / 864e5);
    if (days <= 0) return 'earlier today';
    if (days === 1) return 'yesterday';
    if (days < 7) return 'on ' + d.toLocaleDateString(undefined, { weekday: 'long' });
    return 'last week';
  }
  const DEFAULT_SIG = (name) => `${name}\nReekon Systems · Los Angeles, CA\n\nIf you'd rather not hear from us, just reply "no thanks" and I won't email again.`;
  function emailSheet(L, after) {
    return sheet((box, close) => {
      const own = first(L.owner);
      const sigKey = 'rs_sig_' + S.me.id;
      const sig = h('textarea', { rows: 4, oninput: () => lsSet(sigKey, sig.value) });
      sig.value = lsGet(sigKey, DEFAULT_SIG(S.me.name));
      const subj = h('input', { value: L.demo_url ? `Made a free website for ${L.business}` : `Quick question about ${L.business}` });
      const body = h('textarea', { rows: 11 });
      body.value = L.demo_url
        ? `Hi ${own || 'there'},\n\nI'm ${first(S.me.name)} with Reekon Systems here in LA. I noticed ${L.business} doesn't have a website yet, so we went ahead and built you a free preview:\n\n${L.demo_url}\n\nNo cost and no catch. If you like it, it can be live this week. If not, no worries at all.\n\nI'll give you a quick call tomorrow to hear what you think.`
        : `Hi ${own || 'there'},\n\nI'm ${first(S.me.name)} with Reekon Systems here in LA. I noticed ${L.business} doesn't have a website yet. We build free website previews for local businesses, and I'd love to make one for you.\n\nWant me to send it over? I'll give you a quick call tomorrow either way.`;
      const full = () => body.value.trim() + '\n\n' + sig.value.trim();
      const logIt = async () => {
        try { await api('POST', '/leads/' + L.id + '/calls', { outcome: 'emailed' }); toast('Logged: emailed ✓'); close(true); after && after(); } catch (x) { fail(x); }
      };
      const sent = h('button', { class: 'btn ok block', hidden: true, onclick: logIt }, '✓ I sent it, log it');
      const gmail = h('a', { class: 'btn primary', target: '_blank', rel: 'noopener', onclick: () => { gmail.href = 'https://mail.google.com/mail/?view=cm&fs=1&to=' + encodeURIComponent(L.email) + '&su=' + encodeURIComponent(subj.value) + '&body=' + encodeURIComponent(full()); sent.hidden = false; } }, icon('mail'), 'Open in Gmail');
      const mailto = h('a', { class: 'btn', onclick: () => { mailto.href = 'mailto:' + L.email + '?subject=' + encodeURIComponent(subj.value) + '&body=' + encodeURIComponent(full()); sent.hidden = false; } }, 'Mail app');
      const copy = h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(full()); toast('Email copied'); } catch { toast('Copy failed, select the text instead', true); } sent.hidden = false; } }, icon('copy'), 'Copy');
      box.append(h('h2', null, 'Email ' + L.business), h('p', { class: 'sub' }, L.email),
        !L.demo_url ? h('div', { class: 'cue-box' }, h('b', null, 'No demo yet.'), ' Emails with a demo link get way more replies. ', h('a', { href: '#/studio/' + L.id }, 'Build the demo first →')) : null,
        h('div', { class: 'field' }, h('label', null, 'Subject'), subj),
        h('div', { class: 'field' }, h('label', null, 'Message'), body),
        h('div', { class: 'field' }, h('label', null, 'Signature (saved on this device, add your mailing address)'), sig),
        h('div', { class: 'row wrap' }, gmail, mailto, copy), h('div', { style: 'height:10px' }), sent,
        h('button', { class: 'btn block', style: 'margin-top:8px', onclick: () => close(null) }, 'Cancel'));
    });
  }

  /* ================= callbacks ================= */
  async function viewCallbacks() {
    const [from, until] = dayBounds();
    const list = await api('GET', '/callbacks?from=' + encodeURIComponent(from) + '&until=' + encodeURIComponent(until));
    const cbs = list.filter((l) => l.status === 'callback'), booked = list.filter((l) => l.status === 'booked');
    const row = (l, when) => {
      const late = l.status === 'callback' && new Date(when) < new Date();
      return h('a', { class: 'lead', href: '#/lead/' + l.id },
        h('div', { class: 'body' }, h('div', { class: 'name' }, l.business),
          h('div', { class: 'meta' }, [l.owner, l.city, S.me.role === 'admin' ? l.rep_name || 'Unassigned' : null].filter(Boolean).join(' · ')),
          h('div', { class: 'tags' }, h('span', { class: 'tag ' + (late ? 'hot' : 'good') }, (late ? 'Overdue · ' : '') + fmt(when)))),
        l.phone ? h('a', { class: 'call-btn', href: telHref(l.phone), onclick: (e) => e.stopPropagation() }, icon('phone')) : null);
    };
    shell('callbacks', [
      h('div', { class: 'head' }, h('div', null, h('h1', null, 'Callbacks due today'), h('p', { class: 'sub' }, 'Overdue ones are at the top. Call, then log the outcome.'))),
      cbs.length ? cbs.map((l) => row(l, l.callback_at)) : h('div', { class: 'card empty' }, h('b', null, 'All caught up'), 'No callbacks due today.'),
      h('div', { class: 'section' }, h('span', { class: 'eyebrow' }, 'Booked calls today'),
        booked.length ? booked.map((l) => row(l, l.booked_at)) : h('p', { class: 'dim' }, 'No booked calls today.')),
    ]);
  }

  /* ================= calendar ================= */
  const CAL_KIND = { audit: 'Audit call', closing: 'Closing call', demo: 'Demo', meeting: 'Meeting', training: 'Training', call: 'Call', followup: 'Follow-up', event: 'Other' };
  const CAL_MINS = { audit: 30, closing: 45, demo: 30, meeting: 30, training: 60, call: 15, followup: 15, event: 0 };
  const CAL_GROUP = { audit: 'audits', closing: 'closing', demo: 'demos', meeting: 'meetings', training: 'meetings', call: 'calls', followup: 'calls', callback: 'calls', booked: 'calls', event: 'other' };
  const CAL_FILTERS = [['all', 'All'], ['audits', 'Audits'], ['closing', 'Closing'], ['demos', 'Demos'], ['meetings', 'Meetings'], ['calls', 'Calls'], ['other', 'Other']];
  const CAL_LEGEND = [['audit', 'Audit'], ['closing', 'Closing'], ['demo', 'Demo'], ['meeting', 'Meeting'], ['callback', 'Callback'], ['booked', 'Booked']];
  const pad2 = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const CAL = { view: 'month', month: null, sel: null, filter: 'all' };
  const hm = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  async function viewCalendar() {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (!CAL.month) CAL.month = new Date(now.getFullYear(), now.getMonth(), 1);
    if (!CAL.sel) CAL.sel = dayKey(now);
    const selDate = new Date(CAL.sel + 'T12:00');
    let from, until;
    if (CAL.view === 'month') {
      const first = new Date(CAL.month.getFullYear(), CAL.month.getMonth(), 1);
      from = new Date(first); from.setDate(1 - first.getDay()); until = new Date(from); until.setDate(from.getDate() + 42);
    } else if (CAL.view === 'week') {
      from = new Date(selDate.getFullYear(), selDate.getMonth(), selDate.getDate() - selDate.getDay()); until = new Date(from); until.setDate(from.getDate() + 7);
    } else { from = todayStart; until = new Date(todayStart); until.setDate(until.getDate() + 45); }
    const q = (a, b) => '/calendar?from=' + encodeURIComponent(a.toISOString()) + '&until=' + encodeURIComponent(b.toISOString());
    const weekAhead = new Date(todayStart); weekAhead.setDate(weekAhead.getDate() + 7);
    const [r, soon] = await Promise.all([api('GET', q(from, until)), api('GET', q(todayStart, weekAhead))]);
    const toItems = (x) => {
      const out = [];
      x.events.forEach((e) => out.push({ at: e.starts_at, end: e.ends_at, type: e.kind, title: e.title, sub: [e.lead_name, S.me.role === 'admin' ? e.owner_name : null].filter(Boolean).join(' · '), ev: e }));
      x.callbacks.forEach((l) => out.push({ at: l.at, type: 'callback', title: 'Call back ' + l.business, sub: 'Callback', lead: l }));
      x.booked.forEach((l) => out.push({ at: l.at, type: 'booked', title: 'Booked: ' + l.business, sub: 'Booked call', lead: l }));
      return out.sort((a, b) => new Date(a.at) - new Date(b.at));
    };
    const all = toItems(r), upcoming = toItems(soon);
    const shown = CAL.filter === 'all' ? all : all.filter((it) => (CAL_GROUP[it.type] || 'other') === CAL.filter);
    const byDay = {};
    shown.forEach((it) => { const k = dayKey(new Date(it.at)); (byDay[k] = byDay[k] || []).push(it); });
    const redraw = () => viewCalendar();

    const openEditor = async (ev, presetDay, presetKind) => {
      const base = ev ? new Date(ev.starts_at) : new Date(presetDay + 'T09:00');
      const done = await sheet((box, close) => {
        const title = h('input', { type: 'text', maxlength: 120, placeholder: 'Audit call with Glow Med Spa', value: ev ? ev.title : '' });
        const kind = h('select', null, Object.entries(CAL_KIND).map(([v, t]) => h('option', { value: v, selected: (ev ? ev.kind : presetKind || 'audit') === v ? true : null }, t)));
        const starts = h('input', { type: 'datetime-local', value: toLocalInput(base) });
        const ends = h('input', { type: 'datetime-local', value: ev && ev.ends_at ? toLocalInput(new Date(ev.ends_at)) : '' });
        const link = h('input', { type: 'url', placeholder: 'https://meet.google.com/…', inputmode: 'url', value: ev && ev.link ? ev.link : '' });
        const notes = h('textarea', { rows: 3, maxlength: 1000, placeholder: 'Notes, what to cover, who is on the call' }, ev && ev.notes ? ev.notes : '');
        const save = h('button', { class: 'btn primary block', onclick: async () => {
          save.disabled = true;
          const startIso = starts.value ? new Date(starts.value).toISOString() : '';
          let endIso = ends.value ? new Date(ends.value).toISOString() : null;
          if (!endIso && !ev && startIso && CAL_MINS[kind.value]) endIso = new Date(new Date(startIso).getTime() + CAL_MINS[kind.value] * 6e4).toISOString();
          try { await api(ev ? 'PATCH' : 'POST', ev ? '/calendar/' + ev.id : '/calendar', { title: title.value, kind: kind.value, starts_at: startIso, ends_at: endIso, link: link.value, notes: notes.value }); close(true); }
          catch (e) { fail(e); save.disabled = false; }
        } }, ev ? 'Save changes' : 'Add to calendar');
        box.append(h('h2', null, ev ? 'Edit event' : 'New event'),
          h('label', { class: 'field' }, h('span', null, 'Title'), title),
          h('div', { class: 'two' }, h('label', { class: 'field' }, h('span', null, 'Type'), kind), h('label', { class: 'field' }, h('span', null, 'Starts'), starts)),
          h('label', { class: 'field' }, h('span', null, 'Ends (optional, filled in for you)'), ends),
          h('label', { class: 'field' }, h('span', null, 'Meeting link (optional)'), link),
          h('label', { class: 'field' }, h('span', null, 'Notes'), notes),
          save,
          ev ? h('button', { class: 'btn danger block', style: 'margin-top:10px', onclick: async () => {
            try { await api('DELETE', '/calendar/' + ev.id); close(true); } catch (e) { fail(e); }
          } }, 'Delete event') : null);
      });
      if (done) { toast(ev ? 'Saved ✓' : 'Added ✓'); redraw(); }
    };

    const row = (it) => {
      const end = it.end ? ' – ' + hm(it.end) : '';
      const past = new Date(it.end || it.at) < now;
      const inner = [
        h('span', { class: 'cal-bar ' + it.type }),
        h('div', { class: 'body' }, h('div', { class: 'name' }, it.title),
          h('div', { class: 'meta' }, hm(it.at) + end + (it.sub ? ' · ' + it.sub : ''), it.ev && it.ev.link ? [' · ', h('a', { href: it.ev.link, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation() }, 'Join link')] : null),
          it.ev && it.ev.notes ? h('div', { class: 'meta dim' }, it.ev.notes) : null,
          h('div', { class: 'tags' }, h('span', { class: 'tag k-' + it.type }, it.ev ? CAL_KIND[it.ev.kind] || 'Event' : it.type === 'booked' ? 'Booked' : 'Callback')))];
      const cls = 'lead cal-row' + (past ? ' past' : '');
      if (it.lead) return h('a', { class: cls, href: '#/lead/' + it.lead.id }, inner, it.lead.phone ? h('a', { class: 'call-btn', href: telHref(it.lead.phone), onclick: (e) => e.stopPropagation() }, icon('phone')) : null);
      return h('button', { type: 'button', class: cls, onclick: () => openEditor(it.ev) }, inner);
    };
    const dayBlock = (d, opts) => {
      const k = dayKey(d), list = byDay[k] || [];
      return h('div', { class: 'cal-day' + (k === dayKey(now) ? ' today' : '') },
        h('div', { class: 'cal-day-h' }, h('b', null, (k === dayKey(now) ? 'Today · ' : '') + d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })),
          h('button', { class: 'cal-plus', 'aria-label': 'Add to ' + k, onclick: () => openEditor(null, k) }, '+')),
        list.length ? list.map(row) : h('p', { class: 'dim cal-free' }, opts && opts.free ? opts.free : 'Nothing scheduled'));
    };

    // ----- top strip: today and what is next -----
    const todayN = upcoming.filter((it) => dayKey(new Date(it.at)) === dayKey(now)).length;
    const next = upcoming.find((it) => new Date(it.at) >= now);
    const strip = h('div', { class: 'cal-strip' },
      h('div', null, h('span', { class: 'eyebrow' }, 'Today'), h('b', null, todayN ? todayN + (todayN === 1 ? ' thing' : ' things') : 'Clear')),
      h('div', { class: 'grow' }, h('span', { class: 'eyebrow' }, 'Up next'),
        next ? h('b', null, next.title, h('small', null, ' · ' + (dayKey(new Date(next.at)) === dayKey(now) ? '' : new Date(next.at).toLocaleDateString([], { weekday: 'short' }) + ' ') + hm(next.at))) : h('b', null, 'Nothing in the next 7 days')));

    // ----- nav + title -----
    const stepMonth = (n) => { CAL.month = new Date(CAL.month.getFullYear(), CAL.month.getMonth() + n, 1); redraw(); };
    const stepWeek = (n) => { const d = new Date(selDate); d.setDate(d.getDate() + n * 7); CAL.sel = dayKey(d); CAL.month = new Date(d.getFullYear(), d.getMonth(), 1); redraw(); };
    const title = CAL.view === 'month' ? CAL.month.toLocaleDateString([], { month: 'long', year: 'numeric' })
      : CAL.view === 'week' ? from.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' – ' + new Date(until.getTime() - 864e5).toLocaleDateString([], { month: 'short', day: 'numeric' })
      : 'Next 45 days';
    const goToday = () => { CAL.month = new Date(now.getFullYear(), now.getMonth(), 1); CAL.sel = dayKey(now); redraw(); };
    const head = h('div', { class: 'cal-head' },
      CAL.view === 'agenda' ? null : h('button', { class: 'cal-nav', 'aria-label': 'Previous', onclick: () => (CAL.view === 'month' ? stepMonth(-1) : stepWeek(-1)) }, '‹'),
      h('b', null, title),
      CAL.view === 'agenda' ? null : h('button', { class: 'cal-nav', 'aria-label': 'Next', onclick: () => (CAL.view === 'month' ? stepMonth(1) : stepWeek(1)) }, '›'),
      h('button', { class: 'btn small', onclick: goToday }, 'Today'));

    // ----- views -----
    let body;
    if (CAL.view === 'month') {
      const cells = [];
      for (let i = 0; i < 42; i++) {
        const d = new Date(from); d.setDate(from.getDate() + i);
        const k = dayKey(d), list = byDay[k] || [];
        cells.push(h('button', { type: 'button', class: 'cal-cell' + (d.getMonth() !== CAL.month.getMonth() ? ' out' : '') + (k === dayKey(now) ? ' today' : '') + (k === CAL.sel ? ' sel' : ''),
          'aria-label': d.toDateString() + (list.length ? ', ' + list.length + ' items' : ''), onclick: () => { CAL.sel = k; redraw(); } },
          h('span', { class: 'n' }, String(d.getDate())),
          h('span', { class: 'dots' }, list.slice(0, 3).map((it) => h('i', { class: 'dot ' + it.type })), list.length > 3 ? h('b', null, '+' + (list.length - 3)) : null)));
      }
      body = [
        h('div', { class: 'card cal' }, head,
          h('div', { class: 'cal-dow' }, ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((x) => h('span', null, x))),
          h('div', { class: 'cal-grid' }, cells),
          h('div', { class: 'cal-legend' }, CAL_LEGEND.map(([t, n]) => h('span', null, h('i', { class: 'dot ' + t }), n)))),
        h('div', { class: 'section' }, dayBlock(selDate, { free: 'Nothing scheduled. Tap + to add an audit, closing call or meeting.' })),
      ];
    } else if (CAL.view === 'week') {
      const days = []; for (let i = 0; i < 7; i++) { const d = new Date(from); d.setDate(from.getDate() + i); days.push(dayBlock(d, { free: 'Free' })); }
      body = [h('div', { class: 'card cal slim' }, head), h('div', { class: 'cal-week' }, days)];
    } else {
      const keys = Object.keys(byDay).sort();
      body = [h('div', { class: 'card cal slim' }, head),
        keys.length ? keys.map((k) => dayBlock(new Date(k + 'T12:00'))) : h('div', { class: 'card empty' }, h('b', null, 'Nothing coming up'), 'Add an audit call, closing call or meeting with + Add.')];
    }

    const counts = {}; all.forEach((it) => { const g = CAL_GROUP[it.type] || 'other'; counts[g] = (counts[g] || 0) + 1; });
    shell('calendar', [
      h('div', { class: 'head' }, h('div', null, h('h1', null, 'Calendar'), h('p', { class: 'sub' }, 'Audits, closing calls, demos, meetings and callbacks in one place.')),
        h('button', { class: 'btn primary small', onclick: () => openEditor(null, CAL.view === 'month' || CAL.view === 'week' ? CAL.sel : dayKey(now)) }, '+ Add')),
      strip,
      h('div', { class: 'seg compact' }, [['month', 'Month'], ['week', 'Week'], ['agenda', 'Agenda']].map(([v, t]) => h('button', { class: CAL.view === v ? 'on' : null, onclick: () => { CAL.view = v; redraw(); } }, t))),
      h('div', { class: 'cal-filters', role: 'group', 'aria-label': 'Filter by type' }, CAL_FILTERS.map(([v, t]) =>
        h('button', { type: 'button', class: 'chip' + (CAL.filter === v ? ' on' : ''), onclick: () => { CAL.filter = v; redraw(); } }, t, v !== 'all' && counts[v] ? h('em', null, String(counts[v])) : null))),
      body,
    ]);
  }

  /* ================= demo queue ================= */
  async function viewDemos(which) {
    which = which || 'needed';
    const r = await api('GET', '/demos' + (which === 'ready' ? '?which=ready' : ''));
    const seg = h('div', { class: 'seg' },
      h('button', { class: which === 'needed' ? 'on' : null, onclick: () => viewDemos('needed') }, 'Needs demo (' + r.needed + ')'),
      h('button', { class: which === 'ready' ? 'on' : null, onclick: () => viewDemos('ready') }, 'Ready'));
    const card = (l) => {
      const input = h('input', { type: 'url', placeholder: 'https://… paste demo link', value: l.demo_url || '', inputmode: 'url' });
      const btn = h('button', { class: 'btn primary', onclick: async () => {
        btn.disabled = true;
        try { await api('POST', '/leads/' + l.id + '/demo', { demo_url: input.value }); toast(which === 'needed' ? 'Marked ready ✓' : 'Link updated'); viewDemos(which); }
        catch (e) { fail(e); btn.disabled = false; }
      } }, which === 'needed' ? 'Mark ready' : 'Update');
      return h('div', { class: 'card' },
        h('div', { class: 'row', style: 'justify-content:space-between;align-items:flex-start' },
          h('div', { style: 'min-width:0' }, h('h2', null, l.business), h('p', { class: 'sub' }, [l.category, l.city, l.owner].filter(Boolean).join(' · ') || '—')),
          l.batch_name ? h('span', { class: 'tag' }, l.batch_name) : null),
        h('div', { class: 'row wrap', style: 'margin-top:12px' },
          h('a', { class: 'btn primary small', href: '#/studio/' + l.id }, icon('spark'), l.demo_url ? 'Edit in Studio' : 'Build in Studio'),
          l.demo_url ? h('a', { class: 'btn small', href: l.demo_url, target: '_blank', rel: 'noopener' }, icon('demos'), 'Open') : null,
          l.link ? h('a', { class: 'btn small', href: l.link, target: '_blank', rel: 'noopener noreferrer' }, icon('link'), 'Their Google / social') : null),
        h('details', { class: 'own-link' }, h('summary', null, 'Built it somewhere else? Paste the link'), h('div', { class: 'row', style: 'margin-top:10px' }, input, btn)));
    };
    shell('demos', [
      h('div', { class: 'head' }, h('div', null, h('h1', null, 'Demo queue'), h('p', { class: 'sub' }, 'Tap Build demo, paste their info, pick a look. The link goes straight to the rep.'))),
      seg,
      r.leads.length ? r.leads.map(card) : h('div', { class: 'card empty' }, h('b', null, which === 'needed' ? 'Queue is empty' : 'Nothing ready yet'), which === 'needed' ? 'New batches land here.' : ''),
    ]);
  }

  /* ================= demo builder ================= */
  const THEMES = {
    noir: { label: 'Noir', note: 'Bold & luxe. Barbers, tattoo, lounges, pros.', bg: '#0b0a09', ink: '#f4eee3', accent: '#d8a64e', font: "Impact, 'Arial Narrow', sans-serif", upper: true },
    glow: { label: 'Glow', note: 'Soft & elegant. Nails, lashes, salons, bakeries.', bg: '#fff7f4', ink: '#2b1620', accent: '#e14f7e', font: "Georgia, serif", italic: true },
    drive: { label: 'Drive', note: 'Fast & loud. Auto, food, fitness.', bg: '#07080b', ink: '#eef2f7', accent: '#c6ff2e', font: "'Arial Black', sans-serif", upper: true },
    fresh: { label: 'Fresh', note: 'Bright & friendly. Pets, cleaning, home services.', bg: '#fbf6ee', ink: '#1d2a25', accent: '#ff6b3d', font: "'Trebuchet MS', sans-serif" },
  };
  const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const DAY_FULL = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
  const DAY_RE = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?/i;

  // "Mon-Fri: 9am-7pm" → one row per day; "Saturday 10 AM–5 PM", "Sun Closed"
  function parseHours(text) {
    const out = {};
    const lines = String(text || '').split('\n').map((x) => x.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      const m = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?(?:\s*(?:-|–|—|to|thru|through)\s*(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?)?\s*[:,]?\s*(.*)$/i.exec(line);
      if (!m) continue;
      let time = m[3].trim();
      // Google Maps copies "Monday" and "9 AM–7 PM" on separate lines
      if (!time && lines[i + 1] && !DAY_RE.test(lines[i + 1]) && /(\d|closed|open 24)/i.test(lines[i + 1])) time = lines[++i];
      if (!time || !/(\d|closed|open)/i.test(time)) continue;
      time = time.replace(/\s*(hide open hours.*|suggest new hours.*)$/i, '').trim();
      const a = DAY_KEYS.indexOf(m[1].toLowerCase()), b = m[2] ? DAY_KEYS.indexOf(m[2].toLowerCase()) : a;
      for (let k = a; ; k = (k + 1) % 7) { out[DAY_KEYS[k]] = time; if (k === b) break; }
    }
    return DAY_KEYS.filter((k) => out[k]).map((k) => ({ day: DAY_FULL[k], time: out[k] }));
  }
  // "Fade - $35 - with hot towel" / "Fade $35" / "Full set ..... $45+"
  function parseServices(text) {
    return String(text || '').split('\n').map((x) => x.trim()).filter(Boolean).map((line) => {
      const pm = /\$\s?\d[\d,]*(?:\.\d{2})?\+?(?:\s*(?:-|–|to)\s*\$?\s?\d[\d,]*\+?)?/.exec(line);
      if (!pm) {
        const [name, ...rest] = line.split(/\s+[-–|]\s+/);
        return { name: name.replace(/^[-•*]\s*/, '').trim(), price: '', desc: rest.join(' - ').trim() };
      }
      let before = line.slice(0, pm.index).replace(/[\s.:–|-]+$/, '').replace(/^[-•*]\s*/, '').trim();
      let lead = '';
      const fm = /\s+(from|starting at|starts at|starting)$/i.exec(before);
      if (fm) { lead = fm[1].toLowerCase() + ' '; before = before.slice(0, fm.index).trim(); }
      const after = line.slice(pm.index + pm[0].length).replace(/^[\s.:–|-]+/, '').trim();
      return { name: before || after, price: lead + pm[0].replace(/\s+/g, ''), desc: before ? after : '' };
    }).filter((s) => s.name).slice(0, 24);
  }
  // Pull what we can out of anything pasted: a Google Maps listing, an Instagram bio, a Yelp page, a menu…
  function parseAnything(text) {
    const r = { services: [], hoursLines: [], other: [] };
    const all = String(text || '');
    const phone = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.exec(all); if (phone) r.phone = phone[0].trim();
    const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(all); if (email) r.email = email[0];
    const ig = /(?:instagram\.com\/|^@|\s@)([A-Za-z0-9_.]{2,30})/m.exec(all); if (ig) r.instagram = 'https://instagram.com/' + ig[1].replace(/\.$/, '');
    const book = /https?:\/\/[^\s]*(?:booksy|vagaro|styleseat|square\.site|squareup|calendly|cal\.com|fresha|glossgenius|schedulicity|acuity)[^\s]*/i.exec(all); if (book) r.booking = book[0];
    const rating = /\b([1-5][.,]\d)\s*(?:★|stars?|\(|\s)\s*\(?([\d,]{1,6})?\)?\s*(?:reviews?|google)?/i.exec(all);
    if (rating) { r.rating = rating[1].replace(',', '.'); if (rating[2]) r.reviews = rating[2].replace(/,/g, ''); }
    const lines = all.split('\n').map((x) => x.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (DAY_RE.test(l)) { r.hoursLines.push(l); if (!/\d|closed/i.test(l.replace(DAY_RE, '')) && lines[i + 1] && /\d|closed/i.test(lines[i + 1]) && !DAY_RE.test(lines[i + 1])) r.hoursLines.push(lines[++i]); continue; }
      if (/\$\s?\d/.test(l) && l.length < 140) { r.services.push(l); continue; }
      if (!r.address && /^\d{2,6}\s+[\w .'-]+\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|way|ln|lane|pl|place|ct|court|hwy|highway|pkwy|parkway)\b/i.test(l)) { r.address = l.replace(/^address:?\s*/i, ''); continue; }
      if (l.length > 70 && !/https?:\/\//.test(l)) r.other.push(l);
    }
    if (r.other.length) r.about = r.other.slice(0, 2).join(' ');
    return r;
  }

  async function viewDemoBuilder(id) {
    const r = await api('GET', '/demos/lead/' + id);
    const L = r.lead, D = (r.demo && r.demo.data) || {};
    let theme = (r.demo && r.demo.theme) || guessTheme(L.category);
    const val = (k, fallback) => (D[k] !== undefined && D[k] !== '' ? D[k] : fallback || '');
    const inp = (k, ph, v, type) => h('input', { name: k, placeholder: ph || '', value: v || '', type: type || 'text' });
    const F = {
      name: inp('name', 'Business name', val('name', L.business)), tagline: inp('tagline', 'e.g. Clean cuts. Sharp lines. No wait.', val('tagline')),
      category: inp('category', 'Barbershop', val('category', L.category)), city: inp('city', 'Inglewood', val('city', L.city)),
      phone: inp('phone', '(310) 555-0100', val('phone', L.phone), 'tel'), email: inp('email', 'owner@email.com', val('email', L.email), 'email'),
      address: inp('address', '123 Main St, Inglewood, CA', val('address', L.address)),
      rating: inp('rating', '4.9', val('rating', L.rating)), reviews: inp('reviews', '213', val('reviews')),
      booking: inp('booking', 'https://booksy.com/…', val('booking'), 'url'), instagram: inp('instagram', 'https://instagram.com/…', val('instagram'), 'url'),
    };
    const about = h('textarea', { rows: 4, placeholder: 'A few lines about them. Who they are, how long they\'ve been open, what they\'re known for.' }); about.value = val('about');
    const services = h('textarea', { rows: 6, placeholder: 'One per line:\nFade - $35 - Hot towel finish\nBeard trim - $15\nKids cut - $25' });
    services.value = (D.services || []).map((s) => [s.name, s.price, s.desc].filter(Boolean).join(' - ')).join('\n');
    const hours = h('textarea', { rows: 7, placeholder: 'Mon-Fri: 9 AM - 7 PM\nSat: 10 AM - 5 PM\nSun: Closed' });
    hours.value = (D.hours || []).map((x) => x.day + ': ' + x.time).join('\n');
    const photos = h('textarea', { rows: 3, placeholder: 'Optional. Image links (https://…), one per line. Right-click a photo on their Google/Instagram → Copy image address.' });
    photos.value = (D.photos || []).join('\n');
    let accent = D.accent || '';
    const accentIn = h('input', { type: 'color', value: accent || THEMES[theme].accent, oninput: () => { accent = accentIn.value; paintThemes(); } });
    const accentReset = h('button', { class: 'btn small', type: 'button', onclick: () => { accent = ''; accentIn.value = THEMES[theme].accent; paintThemes(); } }, 'Theme color');

    const themeRow = h('div', { class: 'themes' });
    function paintThemes() {
      themeRow.replaceChildren(...Object.entries(THEMES).map(([k, t]) => {
        const a = k === theme && accent ? accent : t.accent;
        return h('button', { type: 'button', class: 'theme' + (k === theme ? ' on' : ''), style: `background:${t.bg};color:${t.ink}`, onclick: () => { theme = k; if (!accent) accentIn.value = t.accent; paintThemes(); } },
          h('span', { class: 'tname', style: `font-family:${t.font};${t.upper ? 'text-transform:uppercase;' : ''}${t.italic ? 'font-style:italic;' : ''}` }, F.name.value.split(' ').slice(0, 2).join(' ') || t.label),
          h('span', { class: 'tbar', style: `background:${a}` }),
          h('small', null, h('b', null, t.label + (k === theme ? ' ✓' : '')), ' ', t.note));
      }));
    }
    F.name.addEventListener('input', paintThemes);
    paintThemes();

    const paste = h('textarea', { rows: 5, placeholder: 'Paste anything about the business: their Google Maps listing, Instagram bio, Yelp page, price list, menu… We\'ll pull out the phone, hours, prices, rating and address.' });
    const fillBtn = h('button', { class: 'btn primary block', type: 'button', onclick: () => {
      const p = parseAnything(paste.value); let n = 0;
      for (const k of ['phone', 'email', 'address', 'rating', 'reviews', 'booking', 'instagram']) if (p[k] && !F[k].value) { F[k].value = p[k]; n++; }
      if (p.about && !about.value) { about.value = p.about; n++; }
      if (p.services.length) { services.value = (services.value ? services.value + '\n' : '') + parseServices(p.services.join('\n')).map((s) => [s.name, s.price, s.desc].filter(Boolean).join(' - ')).join('\n'); n += p.services.length; }
      if (p.hoursLines.length) { const hrs = parseHours(p.hoursLines.join('\n')); if (hrs.length) { hours.value = hrs.map((x) => x.day + ': ' + x.time).join('\n'); n++; } }
      toast(n ? 'Filled ' + n + ' thing' + (n === 1 ? '' : 's') + '. Check below.' : 'Couldn\'t find anything to pull. Fill it in below.', !n);
    } }, icon('spark'), 'Fill from paste');

    const result = h('div');
    function showLink(u, views) {
      result.replaceChildren(h('div', { class: 'card section linkbox' },
        h('span', { class: 'eyebrow' }, 'Demo link'), h('div', { class: 'demo-url' }, u),
        views !== undefined ? h('p', { class: 'sub' }, views ? '👀 Opened ' + views + (views === 1 ? ' time' : ' times') + ' by the client' : 'Not opened by the client yet. (Your own views don\'t count.)') : null,
        h('div', { class: 'row wrap' },
          h('a', { class: 'btn primary', href: u, target: '_blank', rel: 'noopener' }, icon('demos'), 'Open demo'),
          h('button', { class: 'btn', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(u); toast('Link copied'); } catch { prompt('Copy the demo link:', u); } } }, icon('copy'), 'Copy link'),
          h('a', { class: 'btn', href: '#/lead/' + L.id }, 'Back to lead'))));
    }
    if (r.demo) showLink(r.demo.url, r.demo.views);

    const save = h('button', { class: 'btn ok block', type: 'button', onclick: async () => {
      if (!F.name.value.trim()) return toast('Add the business name', true);
      save.disabled = true;
      const data = Object.fromEntries(Object.entries(F).map(([k, el]) => [k, el.value.trim()]));
      Object.assign(data, { about: about.value.trim(), services: parseServices(services.value), hours: parseHours(hours.value),
        photos: photos.value.split(/\s+/).filter((x) => /^https:\/\//.test(x)), accent });
      try {
        const res = await api('POST', '/demos', { lead_id: L.id, theme, data });
        toast(r.demo ? 'Demo updated ✓' : 'Demo is live ✓');
        r.demo = { url: res.url }; showLink(res.url);
        save.textContent = 'Save changes';
        result.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (e) { fail(e); }
      save.disabled = false;
    } }, r.demo ? 'Save changes' : 'Save & get link');

    const fld = (label, el, hint) => h('div', { class: 'field' }, h('label', null, label), el, hint ? h('small', { class: 'hint' }, hint) : null);
    shell(S.me.role === 'dev' ? 'demos' : 'leads', [
      h('a', { class: 'back', href: '#/lead/' + L.id }, icon('back'), L.business),
      h('div', { class: 'head' }, h('div', null, h('h1', null, r.demo ? 'Edit demo' : 'Build a demo'), h('p', { class: 'sub' }, 'Paste their info, pick a look, get a link. Takes about 2 minutes.'))),
      result,
      h('div', { class: 'card section' }, h('span', { class: 'eyebrow' }, '1 · Paste their info'),
        L.link ? h('a', { class: 'btn small', style: 'margin:8px 0 10px', href: L.link, target: '_blank', rel: 'noopener noreferrer' }, icon('link'), 'Open their Google listing') : null,
        paste, h('div', { style: 'height:10px' }), fillBtn),
      h('div', { class: 'section' }, h('span', { class: 'eyebrow' }, '2 · Pick a look'), themeRow,
        h('div', { class: 'row', style: 'margin-top:10px;align-items:center' }, h('label', { class: 'dim', style: 'font-size:14px' }, 'Accent color'), accentIn, accentReset)),
      h('div', { class: 'card section' }, h('span', { class: 'eyebrow' }, '3 · Check the details'),
        fld('Business name', F.name), fld('Tagline (big headline)', F.tagline, 'Leave empty and we write one for them.'),
        h('div', { class: 'grid2' }, fld('Category', F.category), fld('City', F.city)),
        h('div', { class: 'grid2' }, fld('Phone', F.phone), fld('Email', F.email)),
        fld('Address', F.address),
        h('div', { class: 'grid2' }, fld('Google rating', F.rating), fld('# of reviews', F.reviews)),
        fld('Services & prices', services, 'One per line: Name - $price - short description'),
        fld('Hours', hours, 'Mon-Fri ranges work. Shows "Open now" live on the site.'),
        fld('About', about),
        h('div', { class: 'grid2' }, fld('Booking link', F.booking), fld('Instagram', F.instagram)),
        fld('Photos', photos)),
      save,
      h('p', { class: 'dim', style: 'text-align:center;font-size:13px;margin-top:10px' }, 'Only use their real info. No made-up reviews or prices.'),
    ]);
  }
  function guessTheme(category) {
    const c = String(category || '').toLowerCase();
    if (/(pet|dog|cat|groom|vet|kennel|puppy|clean|maid|landscap|lawn|garden|daycare|kids|family|handyman|pool)/.test(c)) return 'fresh';
    if (/(nail|lash|brow|salon|spa|beauty|hair|braid|wax|esthetic|makeup|bridal|florist|bakery|cake)/.test(c)) return 'glow';
    if (/(auto|detail|car|tire|smog|mechanic|repair|body shop|gym|fitness|training|taco|food|restaurant|grill|bbq|catering|truck|moving|plumb|electric|roof|construct|clean)/.test(c)) return 'drive';
    return 'noir';
  }

  /* ================= scraper & n8n (admin) ================= */
  async function viewIntegrations() {
    const r = await api('GET', '/keys');
    const endpoint = location.origin + '/api/ingest';
    const copy = async (text, msg) => { try { await navigator.clipboard.writeText(text); toast(msg || 'Copied'); } catch { prompt('Copy this:', text); } };
    const codeBox = (text, label) => h('div', { class: 'code' }, h('pre', null, text), h('button', { class: 'btn small', onclick: () => copy(text, (label || 'Text') + ' copied') }, icon('copy'), 'Copy'));

    const newKey = async () => {
      const name = await sheet((box, close) => {
        const inp = h('input', { placeholder: 'e.g. n8n Google Maps', maxlength: 40 });
        box.append(h('h2', null, 'New API key'), h('p', { class: 'sub' }, 'Name it after where it will be used, so you know which one to revoke later.'),
          h('div', { class: 'field' }, h('label', null, 'Name'), inp),
          h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => close(inp.value.trim() || 'Scraper') }, 'Create key')));
        setTimeout(() => inp.focus(), 50);
      });
      if (!name) return;
      try {
        const k = await api('POST', '/keys', { name });
        await sheet((box, close) => box.append(h('h2', null, 'Copy your key now'),
          h('p', { class: 'sub' }, 'This is the only time it is shown. Paste it into n8n or your scraper. If you lose it, revoke it and make a new one.'),
          h('div', { class: 'secret' }, k.key),
          h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => copy(k.key, 'Key copied') }, icon('copy'), 'Copy key'), h('button', { class: 'btn', onclick: () => close(true) }, 'Done'))));
        viewIntegrations();
      } catch (e) { fail(e); }
    };

    const keysP = panel('API keys', h('button', { class: 'btn small primary', onclick: newKey }, '+ New key'),
      r.keys.length ? h('div', { class: 'keys' }, r.keys.map((k) => h('div', { class: 'krow' + (k.revoked_at ? ' off' : '') },
        h('span', { class: 'kic' }, icon('bolt')),
        h('div', { class: 'kbody' }, h('b', null, k.name), h('div', { class: 'sub' }, h('span', { class: 'mono' }, k.prefix + '…'), ' · ',
          k.revoked_at ? 'revoked ' + ago(k.revoked_at) : k.last_used_at ? 'last used ' + ago(k.last_used_at) : 'never used', ' · ', k.added + ' leads added')),
        k.revoked_at ? h('span', { class: 'tag' }, 'Revoked') : h('button', { class: 'btn small danger', onclick: async () => {
          if (!(await confirmSheet('Revoke "' + k.name + '"?', 'Anything using this key stops working right away. Leads already added stay.', 'Revoke', true))) return;
          try { await api('DELETE', '/keys/' + k.id); toast('Key revoked'); viewIntegrations(); } catch (e) { fail(e); }
        } }, 'Revoke')))) : h('div', { class: 'empty-sm' }, 'No keys yet. Make one to connect n8n or your scraper.'));

    const example = JSON.stringify({ batch: 'Inglewood barbers', leads: [{ business: 'Fresh Cutz Barbershop', phone: '(310) 555-0101', email: '', website: '', city: 'Inglewood', category: 'Barber shop', rating: '4.8', address: '4512 W Century Blvd', link: 'https://maps.google.com/?cid=123' }] }, null, 2);
    const curl = `curl -X POST ${endpoint} \\\n  -H "Authorization: Bearer YOUR_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"leads":[{"business":"Fresh Cutz","phone":"3105550101","city":"Inglewood"}]}'`;
    const howP = panel('How to connect', null,
      h('div', { class: 'steps' },
        h('div', { class: 'step' }, h('i', null, '1'), h('div', null, h('b', null, 'Send a POST to this address'), codeBox(endpoint, 'Address'))),
        h('div', { class: 'step' }, h('i', null, '2'), h('div', null, h('b', null, 'Add your key as a header'), codeBox('Authorization: Bearer YOUR_KEY', 'Header'))),
        h('div', { class: 'step' }, h('i', null, '3'), h('div', null, h('b', null, 'Send the leads as JSON (up to 500 per request)'),
          h('p', { class: 'sub' }, 'Column names are flexible: name or title work for business, phoneNumber works for phone, url or website for the site, and so on. Each lead needs a business name plus a phone or email.'),
          codeBox(example, 'Example')))),
      h('details', { class: 'more-info' }, h('summary', null, 'In n8n'),
        h('ol', null,
          h('li', null, 'Add an ', h('b', null, 'HTTP Request'), ' node after your scraper. Method: POST. URL: the address above.'),
          h('li', null, 'Authentication: ', h('b', null, 'Generic → Header Auth'), '. Name: Authorization. Value: Bearer + a space + your key.'),
          h('li', null, 'Send Body: on. Body Content Type: JSON. Specify Body: Using JSON. Switch the JSON box to Expression and paste: ', h('code', null, '{{ { "leads": $input.all().map(i => i.json) } }}')),
          h('li', null, 'Under Settings, turn on ', h('b', null, 'Execute Once'), ' so all leads go in one request.'),
          h('li', null, 'Run it. The log below shows what came in.'))),
      h('details', { class: 'more-info' }, h('summary', null, 'Options you can add'),
        h('ul', null,
          h('li', null, h('code', null, '"batch": "name"'), ' groups the leads into that batch. Default: the key name plus today’s date.'),
          h('li', null, h('code', null, '"assign": "none"'), ' keeps them unassigned. Default: spread evenly across active reps.'),
          h('li', null, h('code', null, '"start_status": "new"'), ' holds them back. Default: Demo needed, so they land in the demo queue.'),
          h('li', null, h('code', null, '"skip_with_site": false'), ' keeps businesses that already have a website. Default: skip them.'))),
      h('details', { class: 'more-info' }, h('summary', null, 'Test it with curl'), codeBox(curl, 'Command')));

    const logP = panel('What came in', h('span', { class: 'dim small' }, 'Last 50 requests'),
      r.log.length ? h('div', { class: 'ilog' },
        h('div', { class: 'irow head' }, h('span', null, 'When'), h('span', null, 'Key'), h('span', null, 'Got'), h('span', null, 'Added'), h('span', null, 'Skipped')),
        r.log.map((x) => h('div', { class: 'irow' + (x.error ? ' err' : '') },
          h('span', null, ago(x.created_at)), h('span', { class: 'ell' }, x.key_name || '—', x.batch_name ? h('small', null, x.batch_name) : null),
          h('span', null, String(x.received)), h('b', null, String(x.inserted)),
          h('span', { class: 'ell' }, x.error ? x.error : [x.duplicates ? x.duplicates + ' dupes' : null, x.dnc ? x.dnc + ' DNC' : null, x.has_site ? x.has_site + ' have site' : null, x.invalid ? x.invalid + ' bad' : null].filter(Boolean).join(', ') || '—')))) :
        h('div', { class: 'empty-sm' }, 'Nothing yet. Requests show up here as soon as they arrive.'));

    shell('integrations', [
      h('div', { class: 'page-head' }, h('div', null, h('p', { class: 'kicker' }, 'Tools'), h('h1', null, 'Scraper & n8n'),
        h('p', { class: 'sub' }, 'Send leads in automatically. Duplicates, Do Not Call numbers and businesses that already have a website are skipped, same as CSV upload.'))),
      h('div', { class: 'dash-grid' }, h('div', { class: 'col' }, keysP, howP), h('div', { class: 'col' }, logP)),
    ]);
  }

  /* ================= Demo Studio ================= */
  const ENGINE_NAME = { 'workers-ai': 'Cloudflare AI · free', claude: 'Claude AI', basic: 'Basic builder · AI not connected' };
  async function viewStudio(leadId) {
    const r = await api('GET', '/studio' + (leadId ? '?lead=' + leadId : ''));
    let lead = r.lead, draft = r.draft, engine = r.engine, busy = false;
    let device = lsGet('rs_studio_device', 'phone');
    let pane = 'chat';
    const firstName = first(S.me.name);

    const msgs = h('div', { class: 'msgs', 'aria-live': 'polite' });
    const input = h('textarea', { rows: 1, placeholder: lead ? 'Ask for a change, or paste more info about ' + lead.business + '…' : "Paste a business's info (Google listing, Instagram bio, prices, hours)…" });
    const sendBtn = h('button', { class: 'send', 'aria-label': 'Send', onclick: () => send() }, h('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>', style: 'display:contents' }));
    const engineTag = h('span', { class: 'engine ' + engine }, h('i'), ENGINE_NAME[engine] || engine);
    const frame = h('iframe', { class: 'pframe', title: 'Demo preview', loading: 'lazy' });
    const frameWrap = h('div', { class: 'pwrap ' + device }, frame);
    const emptyPv = h('div', { class: 'pempty' }, h('div', { class: 'orb' }), h('b', null, 'Your preview shows up here'), h('span', null, 'Send the business info and watch the site build.'));
    const linkBox = h('div');
    const themeRow = h('div', { class: 'tpick' });
    const leadBar = h('div', { class: 'lead-bar' });

    function autosize() { input.style.height = 'auto'; input.style.height = Math.min(200, input.scrollHeight) + 'px'; }
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width:1000px)').matches) { e.preventDefault(); send(); } });

    function bubble(role, text, eng) {
      return h('div', { class: 'msg ' + role }, role === 'ai' ? h('span', { class: 'avatar ai' }, icon('spark')) : null,
        h('div', { class: 'btext' }, text, role === 'ai' && eng === 'basic' && engine !== 'basic' ? h('small', null, 'basic builder') : null));
    }
    function renderMsgs() {
      const list = (draft && draft.messages) || [];
      msgs.replaceChildren(
        h('div', { class: 'msg ai' }, h('span', { class: 'avatar ai' }, icon('spark')), h('div', { class: 'btext' },
          lead ? `Let's build ${lead.business} a site they can't say no to, with photos made for their kind of business. I already have their ${[lead.phone && 'phone', lead.city && 'city', lead.category && 'category', lead.rating && 'rating'].filter(Boolean).join(', ') || 'name'}. Paste anything else you've got (prices, hours, their Instagram bio), or just hit build.`
            : "Paste everything you've got on a business: their Google listing, Instagram bio, menu or price list. I'll write the site and pick a look. Then tell me what to change.")),
        ...list.map((m) => bubble(m.role, m.text, m.engine)));
      if (!list.length) msgs.append(h('div', { class: 'suggest' }, (lead ? ['Build it from the lead info', 'Build it, make it bold', 'Build it, soft and elegant'] : ['Show me an example']).map((s) => h('button', { onclick: () => {
        if (s === 'Show me an example') { input.value = 'Fresh Cutz Barbershop\n4.8 (213) · Barber shop\n4512 W Century Blvd, Inglewood, CA\n(310) 555-0101\nFade $35\nBeard trim $15\nKids cut $25\nMon-Sat 9 AM–8 PM\nSunday Closed'; autosize(); input.focus(); return; }
        send(s === 'Build it from the lead info' ? 'Build the first version of the site from the business info.' : 'Build the first version. ' + s + '.');
      } }, s))));
      else msgs.append(h('div', { class: 'suggest' }, ['Surprise me with a new design', 'Make it more playful', 'Make it feel more luxury', 'Punchier headline', 'Different photos'].map((s) => h('button', { onclick: () => send(s) }, s))));
      msgs.scrollTop = msgs.scrollHeight;
    }
    function renderLeadBar() {
      leadBar.replaceChildren(lead
        ? h('div', { class: 'for' }, h('small', null, 'Demo for'), h('a', { href: '#/lead/' + lead.id }, lead.business), h('button', { class: 'linkish', onclick: pickLead }, 'Change'))
        : h('div', { class: 'for' }, h('small', null, 'No lead picked'), h('button', { class: 'linkish', onclick: pickLead }, 'Pick a lead'), h('span', { class: 'dim small' }, 'or just paste info below')));
    }
    function renderTheme() {
      const ds = draft && draft.data && draft.data.design;
      const patch = async (body, msg) => {
        if (!draft || !draft.id) return;
        shellEl.classList.add('building');
        try { const x = await api('PATCH', '/studio/' + draft.id, body); draft.data = x.data; renderTheme(); refresh(); if (msg) toast(msg); } catch (e) { fail(e); }
        shellEl.classList.remove('building');
      };
      themeRow.replaceChildren(
        h('button', { class: 'tchoice dice', disabled: !draft, title: 'Give it a whole new design', onclick: () => patch({ shuffle: true }, 'New design 🎲') }, h('span', { class: 'die' }, '🎲'), 'New design'),
        h('div', { class: 'dev-seg mode-seg' }, [['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => h('button', { class: ds && ds.mode === k ? 'on' : null, disabled: !draft, onclick: () => patch({ mode: k }) }, l))),
        ds ? h('span', { class: 'ds-tag', title: 'This site\'s design' }, h('i', { style: 'background:hsl(' + ds.accent_hue + ',' + ds.sat + '%,55%)' }), (ds.style || ds.display) + ' · ' + (ds.pair || ds.hero)) : null);
    }
    function refresh() {
      if (!draft || !draft.id) { frameWrap.hidden = true; emptyPv.hidden = false; return; }
      frameWrap.hidden = false; emptyPv.hidden = true;
      frame.src = '/p/' + draft.id + '?v=' + Date.now();
    }
    async function pickLead() {
      const chosen = await sheet((box, close) => {
        const q = h('input', { type: 'search', placeholder: 'Search leads…' });
        const list = h('div', { class: 'pick-list' });
        let t;
        const load = async () => {
          try {
            const rows = await api('GET', '/studio/leads?q=' + encodeURIComponent(q.value));
            list.replaceChildren(...(rows.length ? rows.map((l) => h('button', { class: 'pick', onclick: () => close(l) }, h('div', null, h('b', null, l.business), h('small', null, [l.category, l.city].filter(Boolean).join(' · '))),
              h('span', { class: 'tag ' + (l.demo_url ? 'good' : '') }, l.demo_url ? 'Has demo' : 'Needs demo'))) : [h('p', { class: 'dim', style: 'padding:14px 4px' }, 'No leads match.')]));
          } catch (e) { fail(e); }
        };
        q.oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
        box.append(h('h2', null, 'Pick a lead'), h('p', { class: 'sub' }, 'Leads without a demo come first.'), q, list,
          h('button', { class: 'btn block', style: 'margin-top:12px', onclick: () => close(null) }, 'Cancel'));
        load(); setTimeout(() => q.focus(), 60);
      });
      if (!chosen) return null;
      if (draft && draft.id && !draft.lead_id) {
        try { await api('PATCH', '/studio/' + draft.id, { lead_id: chosen.id }); } catch (e) { fail(e); return null; }
      }
      location.hash = '#/studio/' + chosen.id;
      return chosen;
    }
    async function send(text) {
      const message = (text || input.value).trim();
      if (!message || busy) return;
      busy = true; sendBtn.disabled = true; input.value = ''; autosize();
      msgs.querySelectorAll('.suggest').forEach((x) => x.remove());
      msgs.append(bubble('user', message), h('div', { class: 'msg ai typing' }, h('span', { class: 'avatar ai' }, icon('spark')), h('div', { class: 'btext' }, h('i'), h('i'), h('i'))));
      msgs.scrollTop = msgs.scrollHeight;
      shellEl.classList.add('building');
      try {
        const x = await api('POST', '/studio/chat', { draft_id: draft && draft.id, lead_id: lead && lead.id, message });
        draft = Object.assign(draft || {}, { id: x.draft_id, theme: x.theme, data: x.data, messages: x.messages, lead_id: lead ? lead.id : (draft && draft.lead_id) });
        renderMsgs(); renderTheme(); refresh(); renderSave();
        if (photoBtn) photoBtn.hidden = false;
        if (!window.matchMedia('(min-width:1000px)').matches) setPane('preview');
      } catch (e) { msgs.querySelector('.typing') && msgs.querySelector('.typing').remove(); fail(e); input.value = message; }
      shellEl.classList.remove('building');
      busy = false; sendBtn.disabled = false;
    }
    function renderSave() {
      const saved = lead && lead.demo_url;
      linkBox.replaceChildren(draft && draft.id ? h('div', { class: 'save-row' },
        h('button', { class: 'btn ok', onclick: save }, icon('spark'), saved ? 'Update ' + (lead ? first(lead.business) + "'s" : 'the') + ' demo' : 'Save to lead'),
        saved ? h('button', { class: 'btn small', onclick: async () => { try { await navigator.clipboard.writeText(lead.demo_url); toast('Demo link copied'); } catch { prompt('Copy the demo link:', lead.demo_url); } } }, icon('copy'), 'Copy link') : null,
        saved ? h('a', { class: 'btn small', href: lead.demo_url, target: '_blank', rel: 'noopener' }, 'Open live') : null,
        h('button', { class: 'btn small', onclick: async () => { const t = devBrief(); try { await navigator.clipboard.writeText(t); toast('Dev brief copied'); } catch { prompt('Copy the dev brief:', t); } } }, icon('copy'), 'Copy dev brief')) : null);
    }
    // everything a developer needs to build the real site from this demo
    function devBrief() {
      const d = (draft && draft.data) || {}, ds = d.design || {};
      const L = [];
      L.push('WEBSITE BUILD BRIEF: ' + (d.name || (lead && lead.business) || 'Business'));
      if (lead && lead.demo_url) L.push('Approved demo (match this look): ' + lead.demo_url);
      L.push('');
      L.push('BUSINESS');
      [['Category', d.category], ['City', d.city], ['Phone', d.phone], ['Email', d.email], ['Address', d.address], ['Booking link', d.booking], ['Instagram', d.instagram], ['Google rating', d.rating ? d.rating + (d.reviews ? ' (' + d.reviews + ' reviews)' : '') : '']]
        .forEach(([k, v]) => v && L.push('- ' + k + ': ' + v));
      L.push(''); L.push('COPY');
      if (d.tagline) L.push('- Headline: ' + d.tagline);
      if (d.about) L.push('- About: ' + d.about);
      if (d.cta) L.push('- Closing line: ' + d.cta);
      if ((d.highlights || []).length) { L.push('- Why us:'); d.highlights.forEach((x) => L.push('  • ' + x.title + (x.text ? ': ' + x.text : ''))); }
      if ((d.services || []).length) { L.push(''); L.push('SERVICES'); d.services.forEach((x) => L.push('- ' + x.name + (x.price ? ' ' + x.price : '') + (x.desc ? ': ' + x.desc : ''))); }
      if ((d.hours || []).length) { L.push(''); L.push('HOURS'); d.hours.forEach((x) => L.push('- ' + x.day + ': ' + x.time)); }
      L.push(''); L.push('DESIGN (see the demo for exact colors)');
      L.push('- Style: ' + (ds.style || '—') + ' · ' + (ds.mode || '') + ' mode');
      L.push('- Fonts: ' + (ds.pair || ds.display || '—') + ' pairing (Google Fonts)');
      L.push('- Hero layout: ' + (ds.hero || '—') + ' · Sections in order: ' + (ds.order || []).join(', '));
      if ((d.stock || []).length) { L.push(''); L.push('SAMPLE PHOTOS (replace with the client\'s real photos before launch)'); d.stock.forEach((x) => L.push('- ' + (x.page || x.src) + (x.by ? ' (by ' + x.by + ', Pexels)' : ''))); }
      L.push(''); L.push('MUST HAVE: mobile-first, tap-to-call button, Google Maps link, fast load, real photos from the client, no fake reviews.');
      return L.join('\n');
    }
    async function save() {
      let target = lead;
      if (!target) { target = await pickLead(); if (!target) return; }
      try {
        const x = await api('POST', '/studio/' + draft.id + '/save', { lead_id: target.id });
        toast('Saved to ' + x.business + ' ✓');
        lead = Object.assign({}, lead || target, { demo_url: x.url });
        renderSave(); renderLeadBar();
        await sheet((box, close) => box.append(h('h2', null, 'Demo is live ✓'), h('p', { class: 'sub' }, 'Saved to ' + x.business + '. The link is on their lead now, ready to text or email.'),
          h('div', { class: 'demo-url' }, x.url),
          h('div', { class: 'row wrap' }, h('button', { class: 'btn primary', onclick: async () => { try { await navigator.clipboard.writeText(x.url); toast('Copied'); } catch { prompt('Copy:', x.url); } } }, icon('copy'), 'Copy link'),
            h('a', { class: 'btn', href: '#/lead/' + x.lead_id, onclick: () => close() }, 'Go to lead'), h('button', { class: 'btn', onclick: () => close() }, 'Keep editing'))));
      } catch (e) { fail(e); }
    }
    function setPane(p) { pane = p; shellEl.dataset.pane = p; paneSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.p === p)); }
    const photoBtn = r.photos ? h('button', { class: 'btn small', hidden: !(draft && draft.id), onclick: async (e) => {
      const b = e.currentTarget; b.disabled = true; b.textContent = 'Making photos…'; shellEl.classList.add('building');
      try { const x = await api('POST', '/studio/' + draft.id + '/photos', {}); draft.data = x.data; refresh(); toast('New photos ✓'); } catch (er) { fail(er); }
      shellEl.classList.remove('building'); b.disabled = false; b.textContent = 'New photos';
    } }, 'New photos') : null;
    const paneSeg = h('div', { class: 'seg pane-seg' }, h('button', { 'data-p': 'chat', class: 'on', onclick: () => setPane('chat') }, 'Chat'), h('button', { 'data-p': 'preview', onclick: () => setPane('preview') }, 'Preview'));
    const devSeg = h('div', { class: 'dev-seg' }, [['phone', 'Phone'], ['desktop', 'Desktop']].map(([k, l]) => h('button', { class: device === k ? 'on' : null, onclick: (e) => {
      device = k; lsSet('rs_studio_device', k); frameWrap.className = 'pwrap ' + k; devSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget));
    } }, l)));

    const shellEl = h('div', { class: 'studio', 'data-pane': pane },
      h('section', { class: 'chat-pane' },
        h('div', { class: 'studio-head' }, h('p', { class: 'kicker' }, h('span', { class: 'live' }), 'Demo Studio'), h('h1', null, 'Welcome, ' + firstName), leadBar),
        msgs,
        h('div', { class: 'composer' }, input, sendBtn),
        h('div', { class: 'composer-foot' }, engineTag, draft && draft.id ? h('button', { class: 'linkish', onclick: async () => {
          if (!(await confirmSheet('Start over?', 'Clears this chat and draft. A demo you already saved stays live.', 'Start over', true))) return;
          try { await api('PATCH', '/studio/' + draft.id, { reset: true }); viewStudio(leadId); } catch (e) { fail(e); }
        } }, 'Start over') : null, lead ? h('a', { class: 'linkish', href: '#/demo/' + lead.id }, 'Manual editor') : null)),
      h('section', { class: 'preview-pane' },
        h('div', { class: 'pv-bar' }, themeRow, h('span', { style: 'flex:1' }), photoBtn, devSeg, draft && draft.id ? h('a', { class: 'icon-btn', href: '/p/' + draft.id, target: '_blank', rel: 'noopener', title: 'Open full screen', 'aria-label': 'Open preview full screen' }, icon('link')) : null),
        h('div', { class: 'pv-stage' }, emptyPv, frameWrap),
        linkBox));

    renderLeadBar(); renderMsgs(); renderTheme(); refresh(); renderSave();
    shell('studio', [paneSeg, shellEl]);
  }

  /* ================= Lead Finder (admin) ================= */
  const NICHES = ['Barber shop', 'Nail salon', 'Hair salon', 'Lash studio', 'Auto detailing', 'Mobile mechanic', 'Taqueria', 'Food truck', 'Braiding salon', 'Tattoo shop', 'Cleaning service', 'Landscaping'];
  const CITIES = ['Inglewood', 'Hawthorne', 'Compton', 'Gardena', 'Culver City', 'Long Beach', 'Carson', 'South Gate', 'Lynwood', 'Downey', 'Torrance', 'Pasadena'];
  async function viewFinder() {
    const st = await api('GET', '/finder');
    const F = S.finder || (S.finder = { what: '', where: '', maxReviews: '50', site: 'none', results: [], next: null, sel: new Set(), city: '' });
    const usageEl = h('span', { class: 'usage' });
    const showUsage = (u) => usageEl.replaceChildren(h('b', null, u.today + ' / ' + st.limits.day), ' searches today · ', h('b', null, u.month + ' / ' + st.limits.month), ' this month');
    showUsage(st.usage);

    if (!st.ready) {
      return shell('finder', [
        h('div', { class: 'page-head' }, h('div', null, h('p', { class: 'kicker' }, 'Tools'), h('h1', null, 'Lead Finder'),
          h('p', { class: 'sub' }, 'Find local businesses with no website, then add them to the CRM in one tap. Free with a TomTom key.'))),
        panel('One-time setup (about 3 minutes, free, no card)', null, h('ol', { class: 'setup' },
          h('li', null, 'Go to ', h('b', null, 'developer.tomtom.com'), ' and click ', h('b', null, 'Register'), '. Sign up free with your email (no card).'),
          h('li', null, 'Open your ', h('b', null, 'Dashboard → Keys'), '. Copy the API key that is already there (or click ', h('b', null, 'Create key'), ').'),
          h('li', null, 'In Cloudflare, open your portal worker → ', h('b', null, 'Settings → Variables and Secrets → + Add'), '. Type: Secret. Name: ', h('code', null, 'TOMTOM_KEY'), '. Value: the key. Deploy.'),
          h('li', null, 'Come back here and refresh. The portal caps searches at ' + st.limits.day + ' a day and ' + st.limits.month + ' a month so you stay inside TomTom\'s free 2,500 requests.'))),
      ]);
    }

    const whatIn = h('input', { placeholder: 'e.g. Barber shop', value: F.what, list: 'nicheList' });
    const whereIn = h('input', { placeholder: 'e.g. Inglewood, CA', value: F.where, list: 'cityList' });
    const noReviews = st.provider === 'tomtom';
    if (noReviews) F.maxReviews = '';
    const revSel = h('select', { hidden: noReviews }, [['', 'Any number of reviews'], ['20', 'Under 20 reviews'], ['50', 'Under 50 reviews'], ['100', 'Under 100 reviews'], ['200', 'Under 200 reviews']].map(([v, l]) => h('option', { value: v }, l)));
    revSel.value = F.maxReviews;
    const siteSel = h('select', null, [['none', 'No real website'], ['all', 'Show everyone']].map(([v, l]) => h('option', { value: v }, l)));
    siteSel.value = F.site;
    const goBtn = h('button', { class: 'btn primary', type: 'submit' }, icon('search'), 'Find leads');
    const listEl = h('div', { class: 'finds' });
    const summary = h('div', { class: 'find-sum' });
    const moreBtn = h('button', { class: 'btn block', hidden: true, onclick: () => search(true) }, 'Load more');
    const addBar = h('div', { class: 'add-bar', hidden: true });

    const visible = () => F.results.filter((x) => (F.site === 'all' || x.site_status === 'none' || x.site_status === 'social') && (!F.maxReviews || x.reviews < +F.maxReviews));
    function render() {
      const v = visible();
      const hiddenSite = F.results.filter((x) => F.site !== 'all' && (x.site_status === 'site' || x.site_status === 'found')).length;
      const hiddenRev = F.results.filter((x) => F.maxReviews && x.reviews >= +F.maxReviews).length;
      summary.replaceChildren(F.results.length ? h('p', null, h('b', null, v.length + ' match'), ' out of ' + F.results.length + ' businesses',
        hiddenSite ? ' · ' + hiddenSite + ' hidden for having a website' : '', hiddenRev ? ' · ' + hiddenRev + ' hidden for too many reviews' : '') : null);
      listEl.replaceChildren(...v.map(card));
      if (F.results.length && !v.length) listEl.append(h('div', { class: 'empty-sm' }, 'Nothing matches your filters in this batch. Load more, loosen the review filter, or try a nearby city.'));
      moreBtn.hidden = !F.next;
      renderAdd();
    }
    function card(x) {
      const can = !x.in_crm && !x.dnc && !!x.phone;
      const on = F.sel.has(x.place_id);
      const badge = x.site_status === 'none' ? h('span', { class: 'fb good' }, '✓ No website')
        : x.site_status === 'social' ? h('span', { class: 'fb good' }, '✓ Social page only')
          : x.site_status === 'found' ? h('a', { class: 'fb warn', href: x.found_site, target: '_blank', rel: 'noopener noreferrer' }, '⚠ Might have a site: ' + x.found_site.replace(/^https:\/\//, ''))
            : h('a', { class: 'fb', href: x.website, target: '_blank', rel: 'noopener noreferrer' }, 'Has website');
      const el = h('label', { class: 'find' + (on ? ' on' : '') + (can ? '' : ' off') },
        h('input', { type: 'checkbox', checked: on, disabled: !can, onchange: (e) => { e.target.checked ? F.sel.add(x.place_id) : F.sel.delete(x.place_id); el.classList.toggle('on', e.target.checked); renderAdd(); } }),
        h('div', { class: 'fbody' },
          h('div', { class: 'ftop' }, h('b', null, x.business), x.rating ? h('span', { class: 'stars' }, '★ ' + x.rating.toFixed(1), h('small', null, ' (' + x.reviews + ')')) : x.reviews === 0 ? h('span', { class: 'stars none' }, 'No reviews') : null),
          h('div', { class: 'fmeta' }, [x.category, x.short_address || x.address].filter(Boolean).join(' · ')),
          h('div', { class: 'fmeta' }, x.phone || 'No phone listed'),
          h('div', { class: 'fbadges' }, badge, x.in_crm ? h('span', { class: 'fb' }, 'Already in CRM') : null, x.dnc ? h('span', { class: 'fb bad' }, 'Do Not Call') : null,
            x.link ? h('a', { class: 'fb link', href: x.link, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation() }, 'Google Maps ↗') : null)));
      return el;
    }
    function renderAdd() {
      const n = F.sel.size;
      addBar.hidden = !n;
      if (!n) return;
      const repSel = h('select', null, h('option', { value: 'auto' }, 'Spread across reps'), h('option', { value: 'none' }, "Don't assign yet"));
      addBar.replaceChildren(h('b', null, n + ' selected'), repSel,
        h('button', { class: 'btn ok', onclick: async () => {
          const picked = F.results.filter((x) => F.sel.has(x.place_id)).map((x) => Object.assign({}, x, { city: F.city }));
          try {
            const r = await api('POST', '/finder/add', { places: picked, assign: repSel.value, batch: F.what + ' · ' + F.city });
            toast(r.inserted + ' added to the CRM' + (r.duplicates ? ' · ' + r.duplicates + ' were already there' : ''));
            F.results.forEach((x) => { if (F.sel.has(x.place_id)) x.in_crm = true; });
            F.sel.clear(); render();
            await sheet((box, close) => box.append(h('h2', null, '✓ ' + r.inserted + ' leads added'), h('p', { class: 'sub' }, 'Saved as the batch "' + r.batch + '". They are in the demo queue and assigned' + (repSel.value === 'none' ? ' to nobody yet.' : ' across your reps.')),
              h('div', { class: 'row wrap' }, h('a', { class: 'btn primary', href: '#/studio', onclick: () => close() }, icon('spark'), 'Build demos'), h('button', { class: 'btn', onclick: () => { Object.assign(S.leadFilters, { status: 'all', rep: '', batch: String(r.batch_id), city: '', q: '', heat: '', contact: '', tag: '', due: '', source: '' }); close(); location.hash = '#/leads'; } }, 'See the leads'),
                h('button', { class: 'btn', onclick: () => close() }, 'Keep searching'))));
          } catch (e) { fail(e); }
        } }, 'Add to CRM'));
    }
    async function search(more) {
      F.what = whatIn.value.trim(); F.where = whereIn.value.trim();
      if (!F.what || !F.where) return toast('Type what and where', true);
      goBtn.disabled = true; moreBtn.disabled = true;
      if (!more) { F.results = []; F.sel.clear(); F.next = null; listEl.replaceChildren(h('div', { class: 'empty-sm' }, h('div', { class: 'spinner', style: 'margin:auto' }), h('p', { style: 'margin-top:10px' }, 'Searching and double-checking websites…'))); }
      try {
        const r = await api('POST', '/finder/search', { what: F.what, where: F.where, page_token: more ? F.next : undefined });
        F.city = F.where.replace(/,.*$/, '').trim();
        const seen = new Set(F.results.map((x) => x.place_id));
        F.results = F.results.concat(r.results.filter((x) => !seen.has(x.place_id)));
        F.next = r.next_page_token;
        // pre-select the good ones
        r.results.forEach((x) => { if (!x.in_crm && !x.dnc && x.phone && (x.site_status === 'none' || x.site_status === 'social') && (!F.maxReviews || x.reviews < +F.maxReviews)) F.sel.add(x.place_id); });
        showUsage(r.usage); render();
        if (!more && !window.matchMedia('(min-width:1000px)').matches) summary.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (e) { fail(e); if (!more) listEl.replaceChildren(); }
      goBtn.disabled = false; moreBtn.disabled = false;
    }
    revSel.onchange = () => { F.maxReviews = revSel.value; render(); };
    siteSel.onchange = () => { F.site = siteSel.value; render(); };
    const form = h('form', { class: 'finder-form', onsubmit: (e) => { e.preventDefault(); search(false); } },
      h('div', { class: 'field' }, h('label', null, 'What kind of business'), whatIn),
      h('div', { class: 'field' }, h('label', null, 'Where'), whereIn),
      noReviews ? null : h('div', { class: 'field' }, h('label', null, 'Reviews'), revSel),
      h('div', { class: 'field' }, h('label', null, 'Website'), siteSel),
      goBtn,
      h('datalist', { id: 'nicheList' }, NICHES.map((n) => h('option', { value: n }))),
      h('datalist', { id: 'cityList' }, CITIES.map((c) => h('option', { value: c + ', CA' }))));
    const chips = h('div', { class: 'quick' }, NICHES.slice(0, 8).map((n) => h('button', { type: 'button', class: 'vchip', onclick: () => { whatIn.value = n; } }, n)));

    shell('finder', [
      h('div', { class: 'page-head' }, h('div', null, h('p', { class: 'kicker' }, 'Tools'), h('h1', null, 'Lead Finder'),
        h('p', { class: 'sub' }, st.provider === 'tomtom' ? 'Local businesses with no real website, from TomTom maps. Each search checks 40 businesses.' : 'Businesses with no real website and few reviews, straight from Google. Each search checks 20 businesses.')), usageEl),
      autoBox,
      h('section', { class: 'panel' }, form, chips),
      summary, listEl, moreBtn, addBar,
    ]);
    if (F.results.length) render();
    loadAuto();
  }

  /* ---- auto lead bot panel (on the Lead Finder page) ---- */
  const autoBox = h('div');
  async function loadAuto() {
    let d; try { d = await api('GET', '/finder/auto'); } catch (e) { autoBox.replaceChildren(); return; }
    const cfg = d.config;
    const again = () => loadAuto();
    const listEditor = (id, label, key, placeholder, hint) => {
      const ta = h('textarea', { id, rows: 3, placeholder }); ta.value = cfg[key].join('\n');
      ta.addEventListener('input', () => { cfg[key] = ta.value.split('\n').map((x) => x.trim()).filter(Boolean); dirty(); });
      return h('div', { class: 'field' }, h('label', { for: id }, label), ta, h('span', { class: 'hint' }, hint));
    };
    const save = h('button', { class: 'btn primary small', hidden: true, onclick: async () => {
      try { await api('PUT', '/finder/auto', cfg); toast('Saved'); again(); } catch (e) { fail(e); } } }, 'Save');
    const dirty = () => (save.hidden = false);
    const combos = cfg.niches.length * cfg.cities.length;
    const status = !d.ready ? 'Connect Lead Finder first' : cfg.enabled
      ? 'On · keeps ' + cfg.target_ready + ' fresh leads ready, searching midnight to 6 AM' + (d.added_week ? ' · ' + d.added_week + ' added this week' : '')
      : 'Off';
    const toggle = h('button', { class: 'btn small ' + (cfg.enabled ? '' : 'primary'), disabled: !d.ready, onclick: async () => {
      try { await api('PUT', '/finder/auto', { ...cfg, enabled: !cfg.enabled }); toast(cfg.enabled ? 'Auto lead bot off' : 'Auto lead bot on. Check your leads in the morning'); again(); } catch (e) { fail(e); } } },
      cfg.enabled ? 'Turn off' : 'Turn on');
    const runNow = h('button', { class: 'btn small', disabled: !d.ready, onclick: async () => {
      runNow.disabled = true; runNow.textContent = 'Searching…';
      try {
        const r = await api('POST', '/finder/auto/run');
        if (r.skipped) toast(r.skipped, true);
        else if (r.run.error) toast(r.run.error, true);
        else toast(r.run.search + ': ' + r.run.added + ' new lead' + (r.run.added === 1 ? '' : 's') + ' added');
        again();
      } catch (e) { fail(e); runNow.disabled = false; runNow.textContent = 'Run one search now'; }
    } }, 'Run one search now');
    const perNight = h('input', { id: 'auto-per', type: 'number', min: 1, max: 150, inputmode: 'numeric', value: cfg.per_night, oninput: (e) => { cfg.per_night = +e.target.value || 1; dirty(); } });
    const maxRev = h('input', { id: 'auto-rev', type: 'number', min: 0, max: 5000, inputmode: 'numeric', value: cfg.max_reviews, oninput: (e) => { cfg.max_reviews = +e.target.value || 0; dirty(); } });
    const anySite = h('input', { id: 'auto-anysite', type: 'checkbox', checked: !!cfg.any_site, onchange: (e) => { cfg.any_site = e.target.checked; dirty(); } });
    const social = h('input', { id: 'auto-social', type: 'checkbox', checked: cfg.include_social, onchange: (e) => { cfg.include_social = e.target.checked; dirty(); } });
    const targetIn = h('input', { id: 'auto-target', type: 'number', min: 10, max: 2000, inputmode: 'numeric', value: cfg.target_ready, oninput: (e) => { cfg.target_ready = +e.target.value || 200; dirty(); } });
    const capIn = h('input', { id: 'auto-cap', type: 'number', min: 0, max: 50000, inputmode: 'numeric', value: d.caps.month, oninput: (e) => { cfg.month_cap = +e.target.value || 0; dirty(); } });
    const expandBox = h('input', { id: 'auto-expand', type: 'checkbox', checked: cfg.expand !== false, onchange: (e) => { cfg.expand = e.target.checked; dirty(); } });
    const purgeBox = h('input', { id: 'auto-purge', type: 'checkbox', checked: !!cfg.purge_nonfocus, onchange: (e) => { cfg.purge_nonfocus = e.target.checked; dirty(); } });
    const pct = Math.min(100, Math.round(100 * d.stock / Math.max(1, cfg.target_ready)));
    const stockBar = h('div', { class: 'stockbar' },
      h('div', { class: 'stk-top' }, h('b', null, d.stock.toLocaleString()), h('span', null, ' fresh med spa leads ready to dial · goal ' + cfg.target_ready.toLocaleString())),
      h('div', { class: 'stk-track' }, h('i', { style: 'width:' + pct + '%' + (pct >= 100 ? ';background:var(--ok)' : '') })),
      h('div', { class: 'sub' }, d.usage.month.toLocaleString() + ' of ' + d.caps.month.toLocaleString() + ' searches used this month' + (d.both ? ' (Google ' + d.usage.google + ', TomTom ' + d.usage.tomtom + ' · auto-switches to TomTom near Google\'s free limit)' : '') + ((d.expanded || []).length ? ' · expanded into ' + d.expanded.length + ' more cities (latest: ' + d.expanded[d.expanded.length - 1] + ')' : '')));
    const cleanBtn = h('button', { class: 'btn block', style: 'margin-top:10px', onclick: async () => {
      try {
        const p = await api('POST', '/leads/cleanup', {});
        if (!p.count) return toast('Nothing to remove. Every other lead has been worked or is a med spa.');
        const go = await sheet((box, close) => box.append(h('h2', null, 'Remove ' + p.count.toLocaleString() + ' old leads?'),
          h('p', { class: 'sub' }, 'These are not med spas and nobody has called, noted or booked them. Med spa leads and anything you have worked stay' + (p.kept_touched ? ' (' + p.kept_touched + ' worked leads kept)' : '') + '. This cannot be undone.'),
          h('div', { class: 'card', style: 'margin:10px 0' }, p.sample.map((x) => h('div', { class: 'sub' }, x.business + (x.city ? ' · ' + x.city : '')))),
          h('div', { class: 'row wrap' }, h('button', { class: 'btn primary', onclick: () => close(true) }, 'Remove ' + p.count.toLocaleString()), h('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'))));
        if (!go) return;
        const r = await api('POST', '/leads/cleanup', { confirm: true }); toast(r.removed.toLocaleString() + ' old leads removed'); again();
      } catch (e) { fail(e); } } }, 'Remove old non-med-spa leads');
    const runs = (d.runs || []).slice(0, 8);
    const isMed = cfg.niches.some((n) => /med|botox|aesthetic|laser/i.test(n)) && cfg.any_site && cfg.per_night >= 20;
    const medBtn = isMed ? null : h('button', { class: 'btn primary block', style: 'margin-bottom:12px', disabled: !d.ready, onclick: async () => {
      try { await api('PUT', '/finder/auto', { enabled: true, niches: ['med spa', 'medical spa', 'botox clinic', 'aesthetics clinic', 'laser hair removal'], cities: ['Los Angeles, CA', 'Beverly Hills, CA', 'Santa Monica, CA', 'West Hollywood, CA', 'Culver City, CA', 'Pasadena, CA', 'Glendale, CA', 'Burbank, CA', 'Sherman Oaks, CA', 'Encino, CA', 'Woodland Hills, CA', 'Torrance, CA', 'Manhattan Beach, CA', 'Long Beach, CA', 'Irvine, CA'], per_night: 20, max_reviews: 5000, any_site: true, include_social: true });
        toast('Med spa mode on: 20 searches a night across LA. Leads appear in the morning'); again(); } catch (e) { fail(e); } } }, 'Med spa mode: LA, 20 searches a night, turn on');
    autoBox.replaceChildren(h('section', { class: 'panel auto-bot' },
      h('div', { class: 'panel-head' }, h('div', null, h('h3', null, 'Auto lead bot'), h('div', { class: 'sub' }, h('span', { class: 'dot ' + (cfg.enabled && d.ready ? 'on' : '') }), status)),
        h('div', { class: 'row', style: 'gap:8px' }, toggle)),
      stockBar,
      medBtn,
      h('div', { class: 'row', style: 'margin:0 0 10px' }, cleanBtn),
      h('p', { class: 'sub', style: 'margin:0 0 12px' }, 'Every night it searches until your fresh lead goal is met, moving to new cities when needed, and skips anyone already in your CRM or on Do Not Call.'),
      h('details', { class: 'auto-set' }, h('summary', null, 'Settings · ' + cfg.niches.length + ' types × ' + (cfg.cities.length + (d.expanded || []).length) + ' cities, grows by itself'),
        h('div', { class: 'grid2' },
          listEditor('auto-niches', 'Types of business (one per line)', 'niches', 'barber shop', 'Like barber shop, nail salon, auto detailing, lash tech'),
          listEditor('auto-cities', 'Cities (one per line)', 'cities', 'Palmdale, CA', 'Write them like Palmdale, CA')),
        h('div', { class: 'grid2' },
          h('div', { class: 'field' }, h('label', { for: 'auto-per' }, 'Searches per night'), perNight, h('span', { class: 'hint' }, 'Up to 20. Some daily searches are always saved for you.')),
          d.provider === 'google' ? h('div', { class: 'field' }, h('label', { for: 'auto-rev' }, 'Most Google reviews'), maxRev, h('span', { class: 'hint' }, 'Skip businesses with more reviews than this.')) : h('div')),
        h('div', { class: 'grid2' },
          h('div', { class: 'field' }, h('label', { for: 'auto-target' }, 'Fresh leads to keep ready'), targetIn, h('span', { class: 'hint' }, 'It keeps searching each night until this many uncalled med spa leads are waiting.')),
          h('div', { class: 'field' }, h('label', { for: 'auto-cap' }, 'Searches allowed per month'), capIn, h('span', { class: 'hint' }, d.provider === 'google' ? 'Google gives about 900 free a month. Searches past that cost roughly 3 to 4 cents each.' : 'TomTom gives about 1,100 free a month here. Past that your plan may charge.'))),
        h('label', { class: 'check' }, expandBox, ' Expand to new cities and states on its own when these run dry'),
        h('label', { class: 'check' }, purgeBox, ' Each night, delete untouched leads that are not med spas'),
        h('label', { class: 'check' }, anySite, ' Include businesses that already have a website (use for med spas, gyms, insurance)'),
        cfg.any_site ? h('p', { class: 'sub', style: 'margin:4px 0 8px' }, 'On: the bot adds any business with a phone number, ignores the review limit, and files them under New instead of Demo needed.') : h('label', { class: 'check' }, social, ' Include businesses that only have a Facebook or Instagram page'),
        h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:8px' }, save)),
      h('div', { class: 'auto-runs' },
        h('div', { class: 'row', style: 'justify-content:space-between;align-items:center;margin-bottom:6px' }, h('span', { class: 'eyebrow' }, 'Recent searches'), runNow),
        runs.length ? runs.map((r) => h('div', { class: 'list-row' }, h('div', { style: 'flex:1;min-width:0' }, h('b', { class: 'ellip', style: 'display:block' }, r.search), h('div', { class: 'sub' }, ago(r.at))),
          r.error ? h('span', { class: 'tag', style: 'color:var(--bad)' }, 'Error') : h('span', { class: 'tag ' + (r.added ? 'good' : '') }, '+' + r.added + ' of ' + r.checked)))
          : h('div', { class: 'sub', style: 'padding:8px 0' }, 'No searches yet. Turn it on, or tap Run one search now to try it.'))));
  }

  /* ================= batches + upload ================= */
  async function viewBatches() {
    const list = await api('GET', '/batches');
    shell('batches', [
      h('div', { class: 'head' }, h('div', null, h('h1', null, 'Batches'), h('p', { class: 'sub' }, 'Each upload of leads is a batch.')),
        h('a', { class: 'btn primary small', href: '#/upload' }, 'Upload CSV')),
      list.length ? list.map((b) => h('div', { class: 'card' },
        h('div', { class: 'row', style: 'justify-content:space-between' }, h('div', null, h('h2', null, b.name), h('p', { class: 'sub' }, b.total + ' leads · ' + fmt(b.created_at, { month: 'short', day: 'numeric', year: 'numeric' }))),
          h('button', { class: 'btn small', onclick: () => { Object.assign(S.leadFilters, { status: 'all', rep: '', batch: String(b.id), city: '', q: '' }); location.hash = '#/leads'; } }, 'View')),
        h('div', { class: 'stats' },
          [['Need demo', b.need_demo], ['Demo ready', b.ready], ['Working', b.working], ['Booked', b.booked], ['Won', b.won], ['Unassigned', b.unassigned]]
            .map(([k, v]) => h('div', { class: 'stat' }, h('b', null, v || 0), h('small', null, k))))))
        : h('div', { class: 'card empty' }, h('b', null, 'No batches yet'), 'Upload your first CSV of leads.'),
    ]);
  }

  // CSV parser that handles quotes, commas inside quotes and line breaks
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const delim = (text.split('\n')[0].match(/\t/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim()));
  }
  const FIELD_NAMES = {
    business: ['business', 'businessname', 'name', 'company', 'companyname', 'title', 'place', 'placename', 'qbfpd'],
    owner: ['owner', 'ownername', 'contact', 'contactname', 'decisionmaker'],
    phone: ['phone', 'phonenumber', 'telephone', 'tel', 'mobile', 'number'],
    email: ['email', 'emailaddress', 'mail', 'emails'],
    website: ['website', 'site', 'web', 'websiteurl', 'domain'],
    address: ['address', 'street', 'streetaddress', 'fulladdress'],
    rating: ['rating', 'stars', 'googlerating', 'score'],
    city: ['city', 'town', 'location', 'area'],
    category: ['category', 'type', 'industry', 'niche', 'categories'],
    link: ['link', 'googlesociallink', 'google', 'googlelink', 'maps', 'mapslink', 'googlemaps', 'social', 'sociallink', 'facebook', 'instagram', 'profile'],
  };
  const PHONE_RE = /^\s*(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\s*$/;
  const EMAIL_RE = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/;
  const ADDR_RE = /^\d{1,6}\s+[\w .'#-]+\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|way|ln|lane|pl|place|ct|court|hwy|highway|pkwy|parkway|cir|circle)\b/i;
  // Works with any CSV: matches headers first, then looks at what is actually in each column
  // (Instant Data Scraper exports have junk headers like "qBF1Pd" or "UsdlK").
  function mapColumns(rows) {
    const header = rows[0];
    const norm = header.map((x) => String(x).toLowerCase().replace(/[^a-z]/g, ''));
    const map = {};
    const used = () => Object.values(map);
    for (const [field, names] of Object.entries(FIELD_NAMES)) {
      const i = norm.findIndex((n, idx) => names.includes(n) && !used().includes(idx));
      if (i >= 0) map[field] = i;
    }
    const headerHits = Object.keys(map).length;
    const body = rows.slice(headerHits >= 2 ? 1 : 0, 80);
    const cols = header.map((_, i) => body.map((r) => String(r[i] || '').trim()).filter(Boolean));
    const share = (vals, fn) => (vals.length ? vals.filter(fn).length / vals.length : 0);
    const free = (i) => !used().includes(i) && cols[i].length;
    const pick = (field, fn, min) => {
      if (map[field] !== undefined) return;
      let best = -1, bestScore = min;
      cols.forEach((vals, i) => { if (!free(i)) return; const sc = share(vals, fn); if (sc > bestScore) { best = i; bestScore = sc; } });
      if (best >= 0) map[field] = best;
    };
    const isUrl = (v) => /^https?:\/\//i.test(v);
    pick('email', (v) => EMAIL_RE.test(v), 0.5);
    pick('phone', (v) => PHONE_RE.test(v), 0.5);
    pick('link', (v) => /google\.[a-z.]+\/maps|maps\.app\.goo|goo\.gl\/maps/i.test(v), 0.5);
    pick('website', (v) => isUrl(v) && !/google\.[a-z.]+\/(maps|search)|gstatic|googleusercontent|ggpht/i.test(v), 0.5);
    pick('rating', (v) => /^[1-5][.,]\d$/.test(v), 0.6);
    pick('address', (v) => ADDR_RE.test(v.replace(/^[^\w]*\s*/, '')), 0.4);
    if (map.business === undefined) {
      // the business name: mostly-unique text, not a URL/number, usually the first such column
      let best = -1, bestScore = 0;
      cols.forEach((vals, i) => {
        if (!free(i) || vals.length < body.length * 0.6) return;
        const text = share(vals, (v) => /[a-z]/i.test(v) && !isUrl(v) && v.length >= 3 && v.length <= 80 && !/^(open|closed|website|directions|call|share|save|order|reserve)/i.test(v));
        const uniq = new Set(vals).size / vals.length;
        const sc = text * uniq - i * 0.01;
        if (text > 0.7 && uniq > 0.6 && sc > bestScore) { best = i; bestScore = sc; }
      });
      if (best >= 0) map.business = best;
    }
    if (map.category === undefined) {
      // category: short text that repeats a lot (e.g. "Barber shop")
      let best = -1, bestScore = 0;
      cols.forEach((vals, i) => {
        if (!free(i) || vals.length < body.length * 0.5) return;
        const short = share(vals, (v) => /^[A-Za-z][A-Za-z &'/-]{2,40}(\s·.*)?$/.test(v) && !/^(open|closed|website|directions|call|share|save)\b/i.test(v));
        const uniq = new Set(vals).size / vals.length;
        if (short > 0.7 && uniq <= 0.85 && short - uniq * 0.5 > bestScore) { best = i; bestScore = short - uniq * 0.5; }
      });
      if (best >= 0) map.category = best;
    }
    const smart = headerHits < 2;
    if (map.business === undefined && smart) return { map: { business: 0, owner: 1, phone: 2, city: 3, category: 4, link: 5 }, hasHeader: false, smart: false };
    // a header row exists if row 0 doesn't look like data in the phone/email columns
    const r0 = rows[0];
    const looksData = (map.phone !== undefined && PHONE_RE.test(r0[map.phone] || '')) || (map.email !== undefined && EMAIL_RE.test(r0[map.email] || ''));
    return { map, hasHeader: !looksData, smart };
  }

  async function viewUpload() {
    const opts = await getOptions(true);
    let parsed = null;
    const nameIn = h('input', { placeholder: 'e.g. Inglewood barbers – Nov', value: '' });
    const fileIn = h('input', { type: 'file', accept: '.csv,text/csv,.tsv,text/plain' });
    const paste = h('textarea', { placeholder: 'Or paste CSV text here…' });
    const cityIn = h('input', { placeholder: 'e.g. Inglewood (optional, fills empty cities)' });
    const catIn = h('input', { placeholder: 'e.g. Barber (optional, fills empty categories)' });
    const skipSite = h('input', { type: 'checkbox', checked: true, onchange: () => lastText && refresh() });
    let lastText = '';
    const refresh = () => preview(lastText);
    const startSel = h('select', null, h('option', { value: 'demo_needed' }, 'Demo needed (send to dev queue)'), h('option', { value: 'new' }, 'New (hold for now)'));
    const assignSel = h('select', null, h('option', { value: 'auto' }, 'Auto-assign (spread evenly across reps)'), h('option', { value: 'none' }, "Don't assign yet"),
      opts.reps.filter((r) => r.active).map((r) => h('option', { value: r.id }, 'All to ' + r.name)));
    const previewBox = h('div');
    const go = h('button', { class: 'btn primary block', disabled: true }, 'Upload leads');
    const prog = h('div', { class: 'progress', hidden: true }, h('i'));
    const result = h('div');

    function preview(text) {
      lastText = text;
      const rows = parseCSV(text);
      if (!rows.length) { parsed = null; previewBox.replaceChildren(); go.disabled = true; return; }
      const { map, hasHeader, smart } = mapColumns(rows);
      const cleanRow = (r) => {
        const o = Object.fromEntries(Object.entries(map).map(([f, i]) => [f, String(r[i] || '').trim()]));
        if (o.phone && !PHONE_RE.test(o.phone)) { const m = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.exec(o.phone); o.phone = m ? m[0] : ''; }
        if (o.email && !EMAIL_RE.test(o.email)) o.email = '';
        if (o.address) o.address = o.address.replace(/^[^\w]*\s*/, '');
        if (o.category) o.category = o.category.split(' · ')[0].trim();
        if (o.rating) o.rating = (/[1-5][.,]\d/.exec(o.rating) || [''])[0].replace(',', '.');
        if (!o.city && cityIn.value.trim()) o.city = cityIn.value.trim();
        if (!o.category && catIn.value.trim()) o.category = catIn.value.trim();
        return o;
      };
      let all = (hasHeader ? rows.slice(1) : rows).map(cleanRow).filter((r) => r.business);
      // drop exact repeats inside the same file (scrapers often grab a listing twice)
      const seenKey = new Set();
      all = all.filter((r) => { const k = (r.phone || r.email || r.business).toLowerCase().replace(/\W/g, ''); if (seenKey.has(k)) return false; seenKey.add(k); return true; });
      const noContact = all.filter((r) => !r.phone && !r.email).length;
      const NOT_SITE = /(facebook|fb\.com|instagram|linktr|yelp|booksy|vagaro|styleseat|square|tiktok|fresha|glossgenius)/i;
      const withSite = all.filter((r) => r.website && !NOT_SITE.test(r.website)).length;
      const data = all.filter((r) => r.phone || r.email);
      parsed = data;
      const cols = ['business', 'phone', 'email', 'website', 'category', 'city', 'address', 'rating', 'link'].filter((c) => map[c] !== undefined || (c === 'city' && cityIn.value) || (c === 'category' && catIn.value) || c === 'business');
      const ready = data.length - (skipSite.checked ? withSite : 0);
      previewBox.replaceChildren(h('div', { class: 'card section' },
        h('b', null, ready + ' leads ready to add'),
        h('p', { class: 'sub' }, [data.length + ' rows with a phone or email',
          skipSite.checked && withSite ? withSite + ' already have a website (will be skipped)' : null,
          noContact ? noContact + ' had no phone or email (skipped)' : null].filter(Boolean).join(' · ')),
        h('p', { class: 'sub' }, (smart ? 'Auto-detected columns: ' : hasHeader ? 'Columns matched: ' : 'No header row, read in order: ') + cols.map((c) => c + (map[c] !== undefined ? ' ✓' : '')).join(' · ')),
        h('div', { class: 'preview' }, h('table', null, h('thead', null, h('tr', null, cols.map((c) => h('th', null, c)))),
          h('tbody', null, data.slice(0, 5).map((r) => h('tr', null, cols.map((c) => h('td', null, r[c] ? String(r[c]).slice(0, 40) : '—')))))))));
      go.disabled = !data.length;
    }
    fileIn.addEventListener('change', async () => { const f = fileIn.files[0]; if (!f) return; if (!nameIn.value) nameIn.value = f.name.replace(/\.[^.]+$/, ''); preview(await f.text()); });
    paste.addEventListener('input', () => preview(paste.value));
    cityIn.addEventListener('input', () => lastText && refresh());
    catIn.addEventListener('input', () => lastText && refresh());

    go.addEventListener('click', async () => {
      if (!parsed || !parsed.length) return;
      go.disabled = true; prog.hidden = false; result.replaceChildren();
      const bar = prog.firstChild; const tot = { inserted: 0, duplicates: 0, dnc: 0, invalid: 0, hasSite: 0 };
      try {
        const b = await api('POST', '/batches', { name: nameIn.value });
        for (let i = 0; i < parsed.length; i += 200) {
          const r = await api('POST', '/batches/' + b.id + '/leads', { rows: parsed.slice(i, i + 200), startStatus: startSel.value, assign: assignSel.value, skipWithSite: skipSite.checked });
          for (const k in tot) tot[k] += r[k] || 0;
          bar.style.width = Math.round(Math.min(100, ((i + 200) / parsed.length) * 100)) + '%';
        }
        result.replaceChildren(h('div', { class: 'card section' }, h('h2', null, '✓ Batch "' + b.name + '" uploaded'),
          h('div', { class: 'stats' }, [['Added', tot.inserted], ['Already have a website', tot.hasSite], ['Duplicates skipped', tot.duplicates], ['Do Not Call skipped', tot.dnc]].map(([k, v]) => h('div', { class: 'stat' }, h('b', null, v), h('small', null, k)))),
          assignSel.value === 'auto' && !opts.reps.some((r) => r.active) ? h('p', { class: 'sub' }, "Note: you have no reps yet, so these leads are unassigned. Add reps under Team, then assign them from Leads.") : null,
          h('div', { class: 'row', style: 'margin-top:14px' }, h('a', { class: 'btn primary', href: '#/batches' }, 'See batches'), h('a', { class: 'btn', href: '#/demos' }, 'Demo queue'))));
        toast(tot.inserted + ' leads added');
      } catch (e) { fail(e); go.disabled = false; }
    });

    shell('batches', [
      h('a', { class: 'back', href: '#/batches' }, icon('back'), 'Batches'),
      h('h1', null, 'Upload a batch'),
      h('p', { class: 'sub' }, 'Drop in the CSV straight from Instant Data Scraper (or any spreadsheet). We find the name, phone, email, website and rating columns for you. Duplicates and Do Not Call numbers are skipped automatically.'),
      h('div', { class: 'card section' },
        h('div', { class: 'field' }, h('label', null, 'Batch name'), nameIn),
        h('div', { class: 'field' }, h('label', null, 'CSV file'), fileIn), paste,
        h('div', { class: 'grid2', style: 'margin-top:12px' }, h('div', { class: 'field' }, h('label', null, 'City'), cityIn), h('div', { class: 'field' }, h('label', null, 'Category'), catIn)),
        h('label', { class: 'check' }, skipSite, h('span', null, h('b', null, 'Skip businesses that already have a website'), h('br'), h('small', { class: 'dim' }, 'Facebook / Instagram / booking pages don\'t count as a website. Those stay in.')))),
      previewBox,
      h('div', { class: 'card section' },
        h('div', { class: 'field' }, h('label', null, 'Start leads as'), startSel),
        h('div', { class: 'field' }, h('label', null, 'Assign to reps'), assignSel), go, prog),
      result,
    ]);
  }

  /* ================= team ================= */
  async function viewUsers() {
    const users = await api('GET', '/users');
    const showSecret = (title, email, pw) => sheet((box, close) => box.append(h('h2', null, title),
      h('p', { class: 'sub' }, 'Send these to them privately. The password is shown only once — they can change it under Account.'),
      h('div', { class: 'secret' }, email, h('br'), pw),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(`Reekon Systems sales portal\n${location.origin}\nEmail: ${email}\nPassword: ${pw}`); toast('Copied'); } catch { /* */ } } }, icon('copy'), 'Copy'),
        h('button', { class: 'btn primary', onclick: () => close() }, 'Done'))));

    const pw = h('input', { name: 'password', value: genPassword(), autocomplete: 'off' });
    const form = h('form', null,
      h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', null, 'Name'), h('input', { name: 'name', required: true })),
        h('div', { class: 'field' }, h('label', null, 'Role'), h('select', { name: 'role' }, h('option', { value: 'rep' }, 'Rep'), h('option', { value: 'dev' }, 'Dev'), h('option', { value: 'admin' }, 'Admin')))),
      h('div', { class: 'field' }, h('label', null, 'Email'), h('input', { name: 'email', type: 'email', required: true, autocomplete: 'off' })),
      h('div', { class: 'field' }, h('label', null, 'Temporary password'), pw),
      h('button', { class: 'btn primary block', type: 'submit' }, 'Add team member'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(form));
      try { await api('POST', '/users', d); S.options = null; await showSecret('Added ' + d.name, d.email.toLowerCase(), d.password); viewUsers(); } catch (x) { fail(x); }
    });

    const row = (u) => h('div', { class: 'list-row' },
      h('div', { style: 'min-width:0' }, h('b', { style: u.active ? null : 'opacity:.5' }, u.name), ' ', h('span', { class: 'tag' }, u.role), u.active ? null : h('span', { class: 'tag hot', style: 'margin-left:4px' }, 'off'),
        h('div', { class: 'sub', style: 'overflow:hidden;text-overflow:ellipsis' }, u.email + (u.role === 'rep' ? ' · ' + u.open_leads + ' open leads' : '') + (u.commission_pct !== null && u.commission_pct !== undefined ? ' · ' + pctTxt(u.commission_pct) : ''))),
      h('button', { class: 'btn small', onclick: () => manage(u) }, 'Manage'));

    async function manage(u) {
      const self = u.id === S.me.id;
      const roleSel = h('select', { disabled: self }, ['rep', 'dev', 'admin'].map((r) => h('option', { value: r }, r[0].toUpperCase() + r.slice(1))));
      roleSel.value = u.role;
      const pctIn = h('input', { type: 'number', inputmode: 'decimal', min: 0, max: 100, step: '0.5', placeholder: 'Default', value: u.commission_pct ?? '' });
      const act = await sheet((box, close) => box.append(
        h('h2', null, u.name), h('p', { class: 'sub' }, u.email),
        h('div', { class: 'field' }, h('label', null, 'Role'), roleSel),
        u.role !== 'dev' ? h('div', { class: 'field' }, h('label', null, 'Commission % (leave empty to use the default)'),
          h('div', { class: 'row' }, pctIn, h('button', { class: 'btn', type: 'button', onclick: () => close('pct') }, 'Save'))) : null,
        h('div', { class: 'stack' },
          h('button', { class: 'btn block', disabled: self, onclick: () => close('role') }, 'Save role'),
          h('button', { class: 'btn block', onclick: () => close('reset') }, 'Reset password'),
          u.active
            ? h('button', { class: 'btn danger block', disabled: self, onclick: () => close('off') }, 'Remove access')
            : h('button', { class: 'btn ok block', onclick: () => close('on') }, 'Give access back'),
          h('button', { class: 'btn block', onclick: () => close(null) }, 'Close'))));
      try {
        if (act === 'role') { await api('PATCH', '/users/' + u.id, { role: roleSel.value }); toast('Role updated'); }
        if (act === 'pct') { await api('PATCH', '/users/' + u.id, { commission_pct: pctIn.value === '' ? null : pctIn.value }); toast(pctIn.value === '' ? 'Using the default %' : 'Commission set to ' + pctTxt(pctIn.value)); }
        if (act === 'reset') { const p = genPassword(); await api('PATCH', '/users/' + u.id, { password: p }); await showSecret('New password for ' + u.name, u.email, p); }
        if (act === 'off') {
          const unassign = u.role === 'rep' && u.open_leads ? await confirmSheet('Remove ' + u.name + '?', 'They are logged out right away. Also unassign their ' + u.open_leads + ' open leads so you can give them to someone else?', 'Yes, unassign', false) : false;
          await api('PATCH', '/users/' + u.id, { active: false, unassign }); toast('Access removed');
        }
        if (act === 'on') { await api('PATCH', '/users/' + u.id, { active: true }); toast('Access restored'); }
        if (act) { S.options = null; viewUsers(); }
      } catch (e) { fail(e); }
    }

    shell('users', [
      h('div', { class: 'head' }, h('div', null, h('h1', null, 'Team'), h('p', { class: 'sub' }, 'Add reps and devs. Removing someone logs them out instantly.'))),
      h('div', { class: 'card' }, users.map(row)),
      h('div', { class: 'section' }, h('span', { class: 'eyebrow' }, 'Add someone'), h('div', { class: 'card' }, form)),
    ]);
  }

  /* ================= account ================= */
  function viewAccount() {
    const form = h('form', null,
      h('div', { class: 'field' }, h('label', null, 'Current password'), h('input', { name: 'current', type: 'password', required: true, autocomplete: 'current-password' })),
      h('div', { class: 'field' }, h('label', null, 'New password (8+ characters)'), h('input', { name: 'next', type: 'password', required: true, minLength: 8, autocomplete: 'new-password' })),
      h('button', { class: 'btn primary block', type: 'submit' }, 'Change password'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('POST', '/password', Object.fromEntries(new FormData(form))); form.reset(); toast('Password changed'); } catch (x) { fail(x); }
    });
    shell('account', [
      h('h1', null, S.me.name), h('p', { class: 'sub' }, S.me.email + ' · ' + S.me.role),
      h('div', { class: 'section' }, h('span', { class: 'eyebrow' }, 'Password'), h('div', { class: 'card' }, form)),
      h('div', { class: 'section' }, h('button', { class: 'btn danger block', onclick: async () => { try { await api('POST', '/logout', {}); } catch { /* */ } S.me = null; S.options = null; location.hash = ''; render(); } }, 'Log out')),
      h('p', { class: 'dim', style: 'margin-top:18px;font-size:13px;text-align:center' }, 'Tip: add this page to your home screen for one-tap access.'),
    ]);
  }

  /* =====================================================================
     STAGE 2
     ===================================================================== */

  /* ================= call script ================= */
  async function getScript(force) {
    if (!S.script || force) S.script = await api('GET', '/script');
    return S.script;
  }
  const SAMPLE_LEAD = { emailed_at: new Date(Date.now() - 864e5).toISOString(), business: 'Fresh Fadez Barbershop', owner: 'Marcus Hill', city: 'Inglewood', category: 'Barber', demo_url: 'https://freshfadez-demo.pages.dev' };
  function ctxFor(L) {
    const own = String(L.owner || '').trim();
    return {
      owner_first: first(own) || 'the owner', owner: own || 'the owner', business: L.business || 'your business',
      rep_first: first(S.me.name) || 'me', rep: S.me.name, city: L.city || 'your area',
      category: (L.category || 'local').toLowerCase(), demo_link: L.demo_url || '(demo not ready yet)',
      email_day: L.emailed_at ? emailDay(L.emailed_at) : 'yesterday',
    };
  }
  // Renders script text safely: {placeholders} filled + highlighted, [stage directions] dimmed, "- " lines as bullets
  function scriptText(text, ctx) {
    const wrap = h('div', { class: 'stext' });
    let ul = null;
    for (const raw of String(text || '').split('\n')) {
      const bullet = /^\s*[-•]\s+/.test(raw);
      const line = raw.replace(/^\s*[-•]\s+/, '');
      const el = h(bullet ? 'li' : 'p', null);
      if (!line.trim() && !bullet) { ul = null; wrap.append(h('div', { class: 'gap' })); continue; }
      for (const part of line.split(/(\{[a-z_]+\}|\[[^\]]*\])/g)) {
        if (!part) continue;
        const ph = /^\{([a-z_]+)\}$/.exec(part);
        if (ph && ctx[ph[1]] !== undefined) el.append(h('span', { class: 'fill' }, ctx[ph[1]]));
        else if (/^\[.*\]$/.test(part)) el.append(h('span', { class: 'cue' }, part.slice(1, -1)));
        else el.append(part);
      }
      if (bullet) { if (!ul) { ul = h('ul'); wrap.append(ul); } ul.append(el); } else { ul = null; wrap.append(el); }
    }
    return wrap;
  }
  function scriptBox(sections, ctx, collapsible) {
    const steps = sections.filter((s) => s.kind !== 'objection'), objs = sections.filter((s) => s.kind === 'objection');
    const item = (s, i, open) => h('details', { class: 'sitem', open }, h('summary', null, i !== null ? h('i', null, i + 1) : null, h('span', null, s.title), icon('chev')), scriptText(s.body, ctx));
    const inner = h('div', { class: 'sbody' },
      steps.map((s, i) => item(s, i, i === 0)),
      objs.length ? h('span', { class: 'eyebrow', style: 'display:block;margin:16px 2px 8px' }, 'If they say…') : null,
      objs.map((s) => item(s, null, false)));
    if (!collapsible) return h('div', { class: 'script card' }, inner);
    const box = h('details', { class: 'script card section', open: lsGet('rs_script_open', '1') === '1' },
      h('summary', null, icon('script'), h('b', null, 'Call script'), h('span', { class: 'dim', style: 'margin-left:auto;font-size:13px' }, 'show / hide')), inner);
    box.addEventListener('toggle', () => lsSet('rs_script_open', box.open ? '1' : '0'));
    return box;
  }

  async function viewScript() {
    const sc = await getScript(true);
    if (S.me.role !== 'admin') {
      shell('home', [
        h('a', { class: 'back', href: '#/home' }, icon('back'), 'Home'),
        h('h1', null, 'Practice the script'),
        h('p', { class: 'sub', style: 'margin-bottom:14px' }, 'Shown with a sample lead. On a real lead, the names fill in for you.'),
        scriptBox(sc.sections, ctxFor(SAMPLE_LEAD), false),
      ]);
      return;
    }
    // admin editor
    let list = sc.sections.map((s) => ({ ...s }));
    const wrap = h('div');
    const draw = () => {
      wrap.replaceChildren(...list.map((s, i) => {
        const title = h('input', { value: s.title, placeholder: 'Section title', oninput: (e) => (s.title = e.target.value) });
        const kind = h('select', { onchange: (e) => (s.kind = e.target.value) }, h('option', { value: 'step' }, 'Script step'), h('option', { value: 'objection' }, 'Objection'));
        kind.value = s.kind === 'objection' ? 'objection' : 'step';
        const body = h('textarea', { rows: 6, oninput: (e) => (s.body = e.target.value) }); body.value = s.body;
        const mv = (d) => { const j = i + d; if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; draw(); };
        return h('div', { class: 'card' },
          h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', null, 'Title'), title), h('div', { class: 'field' }, h('label', null, 'Type'), kind)),
          h('div', { class: 'field' }, h('label', null, 'What to say'), body),
          h('div', { class: 'row' },
            h('button', { class: 'btn small', type: 'button', disabled: i === 0, onclick: () => mv(-1), 'aria-label': 'Move up' }, '↑'),
            h('button', { class: 'btn small', type: 'button', disabled: i === list.length - 1, onclick: () => mv(1), 'aria-label': 'Move down' }, '↓'),
            h('span', { style: 'flex:1' }),
            h('button', { class: 'btn small danger', type: 'button', onclick: () => { list.splice(i, 1); draw(); } }, 'Remove')));
      }));
    };
    draw();
    const save = h('button', { class: 'btn primary block', onclick: async () => {
      save.disabled = true;
      try { await api('PUT', '/script', { sections: list }); await getScript(true); toast('Script saved. Reps see it now.'); } catch (e) { fail(e); }
      save.disabled = false;
    } }, 'Save script');
    shell('script', [
      h('a', { class: 'back', href: '#/more' }, icon('back'), 'More'),
      h('div', { class: 'head' }, h('div', null, h('h1', null, 'Call script'), h('p', { class: 'sub' }, sc.custom ? 'Your custom script.' : 'The starter script. Edit it to make it yours.'))),
      h('div', { class: 'card hint' },
        h('b', null, 'Fill-ins: '), '{owner_first} {owner} {business} {rep_first} {city} {category} {demo_link} {email_day}', h('br'),
        h('b', null, '[Brackets]'), ' = a note for the rep (shown dimmed). Start a line with ', h('b', null, '- '), ' for a bullet.'),
      h('div', { class: 'row', style: 'margin:12px 0' },
        h('button', { class: 'btn small', onclick: () => sheet((box, close) => box.append(h('h2', null, 'Preview'), h('p', { class: 'sub' }, 'With a sample lead'), scriptBox(list, ctxFor(SAMPLE_LEAD), false), h('button', { class: 'btn block', style: 'margin-top:12px', onclick: () => close() }, 'Close'))) }, 'Preview'),
        h('span', { style: 'flex:1' }),
        sc.custom ? h('button', { class: 'btn small', onclick: async () => {
          if (!(await confirmSheet('Reset to the starter script?', 'Your edits will be replaced by the original script.', 'Reset', true))) return;
          try { await api('PUT', '/script', { reset: true }); toast('Script reset'); viewScript(); } catch (e) { fail(e); }
        } }, 'Reset to starter') : null),
      wrap,
      h('button', { class: 'btn block', style: 'margin:12px 0', onclick: () => { list.push({ kind: 'objection', title: '', body: '' }); draw(); wrap.lastChild.scrollIntoView({ behavior: 'smooth' }); } }, '+ Add section'),
      save,
    ]);
  }

  /* ================= home: dashboard + leaderboard ================= */
  /* ================= home ================= */
  const tzMin = () => String(-new Date().getTimezoneOffset());
  const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—');
  const PERIODS = [['today', 'Today'], ['week', 'This week'], ['month', 'This month']];
  const PERIOD_NAME = { today: 'today', week: 'this week', month: 'this month' };
  function periodSeg(onPick) {
    return h('div', { class: 'seg compact' }, PERIODS.map(([k, l]) => h('button', { class: S.period === k ? 'on' : null, onclick: () => { S.period = k; onPick(); } }, l)));
  }
  function kpiTile(ic, label, value, note, opts) {
    opts = opts || {};
    return h(opts.href ? 'a' : 'div', { class: 'kpi2' + (opts.cls ? ' ' + opts.cls : ''), href: opts.href || null },
      h('div', { class: 'kpi-top' }, h('span', { class: 'kic' }, icon(ic)), h('small', null, label)),
      h('b', null, value), note ? h('span', { class: 'kpi-note' }, note) : null);
  }
  function goalBar(done, goal, label) {
    const pct = goal ? Math.min(100, Math.round((done / goal) * 100)) : 0;
    const state = !goal ? '' : done >= goal ? ' hit' : done === 0 ? ' zero' : '';
    return h('div', { class: 'goal' + state },
      h('div', { class: 'goal-line' }, h('span', null, label || 'Today'), h('b', null, done + (goal ? ' / ' + goal : ''))),
      goal ? h('div', { class: 'goal-track' }, h('i', { style: 'width:' + pct + '%' })) : null);
  }
  function panel(title, right, ...body) {
    return h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', null, title), right || null), ...body);
  }

  /* ================= admin home: everything on one page ================= */
  const SVGNS = 'http://www.w3.org/2000/svg';
  function sv(tag, attrs, ...kids) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) el.setAttribute(k, v);
    for (const k of kids.flat(Infinity)) if (k) el.append(k);
    return el;
  }
  const shortDay = (d) => new Date(d + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' });
  // grouped bar chart. series: [{name, values, cls}], labels: strings, goal: optional dashed line
  function barChart({ labels, series, goal, fmt }) {
    const W = 340, H = 116, top = 8, n = labels.length, gw = W / n;
    const f = fmt || ((v) => v.toLocaleString());
    const max = Math.max(1, goal || 0, ...series.flatMap((s) => s.values));
    const bw = Math.max(2, (gw * 0.68) / series.length);
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ov-svg', role: 'img', preserveAspectRatio: 'none' });
    svg.append(sv('line', { x1: 0, y1: H - 0.5, x2: W, y2: H - 0.5, class: 'ov-axis' }));
    labels.forEach((lab, i) => series.forEach((s, j) => {
      const v = s.values[i] || 0, bh = v ? Math.max(3, (v / max) * (H - top)) : 0;
      const x = i * gw + (gw - bw * series.length) / 2 + j * bw;
      const r = sv('rect', { x: x.toFixed(1), y: (H - bh).toFixed(1), width: (bw - 1).toFixed(1), height: bh.toFixed(1), rx: 1.5, class: 'ov-bar ' + s.cls + (i === n - 1 ? ' last' : '') });
      r.append(sv('title', null, document.createTextNode(`${lab} · ${s.name}: ${f(v)}`)));
      svg.append(r);
    }));
    if (goal) svg.append(sv('line', { x1: 0, y1: (H - (goal / max) * (H - top)).toFixed(1), x2: W, y2: (H - (goal / max) * (H - top)).toFixed(1), class: 'ov-goal' }));
    const wrap = h('div', { class: 'ov-chart' }, svg,
      h('div', { class: 'ov-ax' }, h('span', null, labels[0]), h('span', null, labels[Math.floor(n / 2)]), h('span', null, labels[n - 1])),
      series.length > 1 || goal ? h('div', { class: 'ov-legend' }, series.map((s) => h('span', null, h('i', { class: s.cls }), s.name)), goal ? h('span', null, h('i', { class: 'goalkey' }), 'Goal') : null) : null);
    return wrap;
  }
  function ovCard(o) {
    return h('section', { class: 'ov-card' },
      h('div', { class: 'ov-head' }, h('span', { class: 'kic' }, icon(o.ic)), h('h3', null, o.title),
        o.manage ? h('a', { class: 'btn small ov-manage', href: o.manage[1] }, o.manage[0] + ' →') : null),
      o.big ? h('div', { class: 'ov-big' }, o.big.map(([v, l]) => h('div', null, h('b', null, v), h('small', null, l)))) : null,
      o.body,
      o.quick ? h('div', { class: 'ov-quick' }, o.quick) : null,
      o.note ? h('p', { class: 'ov-note ' + (o.note[0] || '') }, o.note[1]) : null);
  }

  /* ================= content system (from the notes: problem / demo / audit / result) ================= */
  const CONTENT_TYPES = [
    { id: 'problem', name: 'Problem post', job: 'Show where med spas are losing money right now.', visual: 'Text card or screenshot: one big number or one sentence on a dark background. No face needed.' },
    { id: 'demo', name: 'Demo post', job: 'Show the AI actually working.', visual: 'Screen recording on your phone: the AI receptionist answering a call, or the missed-call text going out. 15–30 seconds.' },
    { id: 'audit', name: 'Audit post', job: 'Break down a med spa\'s front desk and show what you would fix.', visual: 'Screenshot of a public Google listing (hours, phone, reviews) with arrows and 3 fixes. Blur the name if you haven\'t asked permission.' },
    { id: 'result', name: 'Result post', job: 'Show the wins.', visual: 'Screenshot of your own scorecard (dials, audits booked) until you have client results. Never invent a client result.' },
  ];
  const CTA = { ig: 'Own a med spa? DM "AUDIT" and I\'ll run a free 30-minute AI audit of your front desk.', x: 'Own a med spa? DM me "AUDIT" for a free 30-min AI audit.', li: 'If you run a med spa and want a free 30-minute AI audit of your front desk, send me a message.' };
  const TAGS = '#medspa #medspamarketing #aesthetics #botox #aiautomation #smallbusiness';
  const CONTENT_LIB = {
    problem: [
      { hook: 'Where med spas lose the most money',
        ig: 'Most med spas don\'t lose clients to a competitor.\n\nThey lose them to a phone that rings and nobody picks up.\n\nThe front desk is with a patient. It\'s after 5pm. It\'s lunch. The caller books somewhere else in under 5 minutes.\n\nExample math (yours will differ): 10 missed calls a week × 3 that would have booked × $400 treatment = $1,200 a week walking out the door.',
        x: 'Med spas rarely lose clients to competitors.\n\nThey lose them to a phone nobody answers after 5pm.\n\nExample: 3 missed bookings a week x $400 = $1,200/week gone.',
        li: 'The most expensive problem I see in med spas isn\'t marketing. It\'s the phone.\n\nA caller who reaches voicemail rarely leaves a message. They call the next spa on Google.\n\nIllustrative math, not a statistic: if 3 missed calls a week would have booked a $400 treatment, that\'s about $1,200 a week and over $60,000 a year.\n\nThe fix is simple: every call answered, every missed call texted back within a minute.' },
      { hook: 'The 5pm problem',
        ig: 'Think about when people look up a med spa.\n\nEvenings. Weekends. On their phone after work.\n\nThat\'s exactly when most front desks are closed.\n\nSo the person who was ready to book a consult tonight gets voicemail and books with whoever answers.',
        x: 'People search for med spas at night and on weekends.\n\nMost front desks are closed then.\n\nWhoever answers first gets the booking.',
        li: 'Most med spa searches happen outside business hours. Most med spa phones go to voicemail outside business hours.\n\nThat gap is where bookings quietly leak.\n\nAn AI receptionist that answers, answers basic questions and books the consult closes that gap without adding staff.' },
      { hook: 'Speed to lead: who replies first wins',
        ig: `A new customer fills out a form at 7pm.

If nobody replies until tomorrow, they've already messaged two other spas.

The business that answers in under a minute usually gets the booking. That's not luck, it's just speed.

An AI can reply in seconds, ask the right questions, and offer a time. Every night. Every weekend.`,
        x: `A lead fills out a form at 7pm.

The spa that replies first usually wins.

AI replies in seconds, even at 2am.`,
        li: `Speed to lead is one of the cheapest wins in a service business. A new inquiry that gets a reply in a minute is far more likely to book than one that waits until morning.

An AI can respond instantly, qualify the inquiry and offer times, without anyone staying late.` },
      { hook: 'Your past clients are your cheapest revenue',
        ig: `Every med spa has a list of clients who came once or twice and never came back.

They already trust you. They just haven't heard from you in a while.

A friendly text ("We miss you, want to book?") sent to the right people is the cheapest booking you'll ever get.

Example math (yours will differ): 200 quiet clients × 5% rebook × $300 = $3,000.`,
        x: `Your past clients already trust you.

They just haven't heard from you in 6 months.

Example: 200 quiet clients x 5% x $300 = $3,000.`,
        li: `The cheapest new revenue in a med spa is often sitting in the client list: people who visited once or twice and drifted away.

A simple, friendly follow-up to lapsed clients costs almost nothing and requires no new advertising.

Illustrative math, not a statistic: 200 quiet clients, 5% rebook, $300 each, about $3,000.` },
    ],
    demo: [
      { hook: 'Watch an AI receptionist book a consult',
        ig: 'This is what happens when a patient calls a med spa at 7pm.\n\nThe AI answers on the first ring, answers questions about Botox and fillers, and books the consult into the calendar.\n\nNo voicemail. No missed lead. The front desk wakes up to a full schedule.',
        x: '7pm. A patient calls a med spa.\n\nThe AI answers, answers questions, books the consult.\n\nNo voicemail. No lost lead.',
        li: 'A short demo of an AI voice receptionist handling an after-hours call for a med spa: greeting, treatment questions, and booking a consult.\n\nThe point isn\'t the technology. It\'s that the caller never hit voicemail.' },
      { hook: 'The missed-call text-back',
        ig: 'A call goes unanswered.\n\n60 seconds later the patient gets a text: "Sorry we missed you, want to book a consult? Here\'s our link."\n\nMost people reply to a text faster than they return a voicemail.',
        x: 'Missed call.\n\n60 seconds later: an automatic text with a booking link.\n\nPeople answer texts faster than they check voicemail.',
        li: 'Missed-call text-back in action: a call goes unanswered and the caller gets a friendly text with a booking link within a minute.\n\nIt turns a lost call into a conversation.' },
      { hook: 'AI answers while your front desk is busy',
        ig: `The front desk is checking a patient in. The phone rings. Nobody can get it.

An AI receptionist picks up, answers the common questions (hours, prices, what to expect) and books the consult.

The front desk keeps doing the work only a human can do.`,
        x: `Front desk is with a patient. Phone rings.

AI picks up, answers questions, books the consult.

Humans handle humans. AI handles the phone.`,
        li: `The busiest moments in a med spa are exactly when the phone goes unanswered.

An AI receptionist covers those moments: it answers common questions, books consults and passes anything unusual to a person. It supports the front desk instead of replacing it.` },
      { hook: 'Website chatbot: the 24/7 front door',
        ig: `Most people check a med spa's website at night on their phone.

A chatbot that answers "how much is filler?" and "do you have anything Saturday?" turns that visit into a booking.

No waiting for the front desk to open.`,
        x: `People browse med spa sites at night.

A chatbot that answers questions and books the consult turns a visit into an appointment.`,
        li: `A website that only displays information is a brochure. A website with an AI assistant that answers questions and books consults is a front door that never closes.

For businesses that get evening and weekend traffic, that difference shows up in the calendar.` },
    ],
    audit: [
      { hook: 'I audited a med spa\'s front desk in 10 minutes',
        ig: 'I looked at one med spa\'s Google listing for 10 minutes. Here\'s what I\'d fix:\n\n1. Phone goes to voicemail after 5pm\n2. No instant reply to new inquiries\n3. Old clients never get a "we miss you" message\n\nNone of it needs more staff. It needs a system.',
        x: 'Audited a med spa\'s front desk in 10 minutes.\n\nFixes:\n1. After-hours calls answered\n2. Instant reply to inquiries\n3. Message past clients\n\nNo new staff needed.',
        li: 'I spent ten minutes reviewing a med spa\'s public presence. Three fixes stood out: after-hours calls, response speed to new inquiries, and reactivating past clients.\n\nNone of them need more staff. They need a system that runs without anyone remembering to do it.' },
      { hook: 'Three questions to ask your front desk today',
        ig: 'Ask your front desk three questions today:\n\n1. How many calls did we miss this week?\n2. How fast do we reply to a new inquiry?\n3. When did we last message clients who haven\'t booked in 6 months?\n\nIf nobody knows the answers, that\'s where the money is.',
        x: 'Ask your front desk:\n\n1. How many calls did we miss this week?\n2. How fast do we reply to new inquiries?\n3. When did we last message lapsed clients?\n\nIf nobody knows, that\'s the leak.',
        li: 'Three questions every med spa owner should be able to answer: how many calls we missed this week, how quickly we respond to a new inquiry, and when we last contacted clients who haven\'t booked in six months.\n\nIf the answers aren\'t known, that is usually where revenue is leaking.' },
      { hook: 'Call your own business at 7pm',
        ig: `Try this tonight: call your own business at 7pm like a customer would.

What happens?

Voicemail? Rings forever? A message that says call back tomorrow?

That's what every after-hours caller hears. It's the easiest leak to find, and the easiest to fix.`,
        x: `Call your own business at 7pm tonight.

Voicemail? Rings out?

That's what every after-hours customer hears.`,
        li: `A simple test for any owner: call your own business at 7pm and listen to the experience a new customer gets.

If it ends in voicemail, you have found the easiest revenue leak to fix.` },
      { hook: '4 things I check on any Google listing',
        ig: `Four things I look at first on a business's Google listing:

1. Do they answer the phone after 5pm?
2. Is there a way to message or book without calling?
3. How fast do they reply to reviews and questions?
4. Are the hours accurate?

Each one is a place where customers quietly give up.`,
        x: `4 things I check on a Google listing:

1. After-hours calls
2. Message/booking options
3. Reply speed
4. Accurate hours

Each is where customers quietly give up.`,
        li: `When I look at a business's Google listing I check four things: whether the phone is answered after hours, whether customers can message or book without calling, how quickly the business replies, and whether the hours are accurate.

Each is a small friction point, and together they decide who gets the booking.` },
    ],
    result: [
      { hook: 'Day-by-day scorecard',
        ig: 'Day {day} of 30 building my AI agency in public.\n\nDials today: {dials}\nPick-ups: {talks}\nAudits booked: {demos}\n\nNo shortcuts. Inputs drive outputs.',
        x: 'Day {day} of 30.\n\nDials: {dials}\nPick-ups: {talks}\nAudits booked: {demos}\n\nInputs drive outputs.',
        li: 'Day {day} of a 30-day push to prove an AI front-desk offer for med spas.\n\nToday: {dials} dials, {talks} conversations, {demos} audits booked.\n\nBuilding in public, and the numbers stay honest.' },
      { hook: 'What I learned this week',
        ig: 'Week of calling med spas, what I learned:\n\n• Front desks are busiest right before lunch\n• The owner usually picks up after 4pm\n• "We already have someone" usually means "we miss calls and don\'t know it"\n\nDials this week: {week}',
        x: 'A week of cold calling med spas:\n\n- Owners pick up more after 4pm\n- "We have someone" often means they miss calls and don\'t know it\n\nDials this week: {week}',
        li: 'A week of calling med spas taught me a few things: owners are easier to reach late in the afternoon, and "we already have someone covering the phones" often means missed calls nobody is counting.\n\nDials this week: {week}.' },
      { hook: 'Inputs, not outcomes',
        ig: `Day {day} of 30.

I can't control who says yes. I can control the inputs.

Dials today: {dials}
Conversations: {talks}
Audits booked: {demos}

Show up, count honestly, repeat.`,
        x: `Day {day}/30.

Can't control who says yes. Can control inputs.

Dials: {dials}
Talks: {talks}
Audits: {demos}`,
        li: `Day {day} of the 30-day push. Outcomes are out of my hands; inputs aren't.

Today: {dials} dials, {talks} conversations, {demos} audits booked. Tracking it honestly is the whole system.` },
      { hook: 'What the free audit actually is',
        ig: `People hear "free AI audit" and think it's a sales pitch.

It's 30 minutes of me asking how your leads come in, who answers, what software you use, and where customers fall through.

You leave knowing what's leaking and a ballpark of what fixing it costs. No card needed.

Dials this week: {week}`,
        x: `"Free AI audit" = 30 min.

I ask how leads come in, who answers, where customers fall through.

You leave with a ballpark. No card needed.`,
        li: `The free AI audit is simple: thirty minutes to understand how a business gets leads, who handles them, what software is in use, and where customers fall through.

The goal is a clear picture of the leak and a ballpark of the fix, whether or not we work together.` },
    ],
  };
  const CPLAT = [['ig', 'Instagram'], ['x', 'X'], ['li', 'LinkedIn']];

  /* ================= demo videos (rendered MP4s in /demos, same CTA as the posts) ================= */
  const DV_STYLES = { A: 'Flow map', B: 'Text thread', C: 'Money counter' };
  const DV_TOPICS = {
    missed: { name: 'Missed calls after 5', hook: 'Losing $1,200 a week to missed calls',
      cap: { ig: 'A customer calls at 6:42 PM. The front desk is closed. Voicemail. She books your competitor.\n\nThree of those a week at $400 each is $1,200 a week walking out the door.\n\nThe fix: an AI receptionist that answers on the first ring and books the appointment.\n\n(Example numbers. Yours will differ.)', x: 'Customer calls at 6:42 PM. Voicemail. She books your competitor.\n\n3 a week x $400 = $1,200/week gone.\n\nAI answers on ring one and books it.\n\n(Example numbers)', li: 'A customer calls after hours, reaches voicemail and books a competitor. Three of those a week at $400 each is about $1,200 a week.\n\nAn AI receptionist that answers every call and books the appointment closes that gap.\n\n(Illustrative numbers, not a statistic.)' },
      vo: { hook: "Your business could be losing twelve hundred dollars a week. Here's where it leaks.", problem: "It's Tuesday, six forty-two PM. A customer finds you on Google and calls. Your front desk is closed. It rings, then goes to voicemail. She doesn't leave a message. She books your competitor instead. That's about four hundred dollars, gone.", cost: "Say that happens three times a week. Three bookings, four hundred dollars each. That's twelve hundred a week. Over a year, over sixty-two thousand dollars walking out the door.", fix: "Now, same call. But an AI receptionist picks up on the first ring. It answers her questions and books her appointment for seven thirty, right on your calendar. She shows up, and you keep the four hundred." } },
    slow: { name: 'Slow replies lose the job', hook: 'The first to reply wins',
      cap: { ig: 'A new inquiry comes in at 7 PM. Nobody sees it until morning. By then she has hired someone who replied in minutes.\n\nTwo cold leads a week at $500 each is $1,000 a week.\n\nThe fix: an AI that replies in seconds, asks the right questions and books the visit.\n\n(Example numbers. Yours will differ.)', x: 'New inquiry at 7 PM. No reply until morning. She already hired someone else.\n\n2 leads a week x $500 = $1,000/week.\n\nAI replies in 20 seconds.\n\n(Example numbers)', li: 'A new inquiry that waits until morning has usually gone to whoever replied first. Two lost jobs a week at $500 each is about $1,000 a week.\n\nAn AI that replies in seconds, asks the right questions and books the visit fixes the delay.\n\n(Illustrative numbers, not a statistic.)' },
      vo: { hook: "The first business to reply usually wins. Slow replies lose the job.", problem: "It's seven PM. A new customer fills out your form and asks for a quote. Nobody sees it tonight. Fourteen hours go by with no reply. By morning, she's already hired someone else. That's about five hundred dollars, gone.", cost: "Two leads a week going cold, at five hundred dollars each, is a thousand dollars every week. Over a year, that's fifty-two thousand dollars going to whoever replied first.", fix: "Now, same inquiry. An AI replies in twenty seconds, asks the right questions, and books the visit for Tuesday morning. You wake up to a booking you would have lost." } },
    quiet: { name: 'Customers who went quiet', hook: '200 customers went quiet',
      cap: { ig: 'Every business has customers who came once and never came back. Nobody followed up.\n\n200 quiet customers, 5% come back, $300 each: $3,000 sitting in your list.\n\nThe fix: an AI that texts them a friendly "we miss you" and books the ones who reply.\n\n(Example numbers. Yours will differ.)', x: '200 customers went quiet. Nobody followed up.\n\n5% come back x $300 = $3,000 sitting in your list.\n\nAI texts them and books the replies.\n\n(Example numbers)', li: 'Most businesses have a list of past customers who drifted away without a single follow-up. With 200 of them, a 5% return and $300 per visit, that is about $3,000 sitting unclaimed.\n\nAn AI follow-up that checks the list, sends a friendly text and books the replies costs no staff time.\n\n(Illustrative numbers, not a statistic.)' },
      vo: { hook: "Two hundred customers went quiet. And nobody ever followed up.", problem: "She loved the service. Then six months passed, with no reminder and no check-in. She forgot about you and booked somewhere else. That's about three hundred dollars lost, and it happened with every one of them.", cost: "Take two hundred customers who've gone quiet. If just five percent come back, at three hundred dollars a visit, that's three thousand dollars sitting in your customer list.", fix: "With an AI follow-up, it checks your list every night and sends a friendly text: we miss you, want to book? She replies, the AI offers times that work, and she's booked with zero staff time." } },
  };
  const DV_ORDER = ['A-missed', 'B-slow', 'C-quiet', 'B-missed', 'C-slow', 'A-quiet', 'C-missed', 'A-slow', 'B-quiet'];
  const DV_TIMES_UNUSED = { A: [['Hook', 0, 'hook'], ['Problem', 3.8, 'problem'], ['The cost', 11, 'cost'], ['The fix', 17.5, 'fix'], ['Call to action', 25.5, 'cta']], B: [['Hook', 0, 'hook'], ['Problem', 3.6, 'problem+cost'], ['The fix', 14.2, 'fix'], ['Call to action', 25, 'cta']], C: [['Hook', 0, 'hook'], ['Problem', 3.6, 'problem+cost'], ['The fix', 14.6, 'fix'], ['Call to action', 25.6, 'cta']] };
  const VO_CTA = 'Want to know what your business is losing? DM me the word AUDIT for a free thirty-minute AI audit.';
  const dvOf = (id) => { const [st, tp] = id.split('-'); return { id, style: st, topic: tp, t: DV_TOPICS[tp], styleName: DV_STYLES[st] }; };
  const dvScript = (v) => ['hook', 'problem', 'cost', 'fix'].map((k) => v.t.vo[k]).concat(VO_CTA).join(' ');
  const dvToday = (n) => { const i = ((n - 1) * 2) % DV_ORDER.length; return [DV_ORDER[i], DV_ORDER[(i + 1) % DV_ORDER.length]]; };
  const DV_PLAT = [['ig', 'Instagram'], ['x', 'X'], ['li', 'LinkedIn']];
  function dvCard(v, dayN, open) {
    let plat = 'ig';
    const key = 'rs_dv_' + dayN + '_' + v.id;
    let posted = false; try { posted = localStorage.getItem(key) === '1'; } catch {}
    const area = h('textarea', { class: 'ct-text', rows: 9 });
    const setCap = () => { area.value = v.t.cap[plat] + '\n\n' + CTA[plat] + (plat === 'ig' ? '\n\n' + TAGS : ''); };
    const tabs = h('div', { class: 'stagechips' });
    const drawTabs = () => tabs.replaceChildren(...DV_PLAT.map(([k, label]) => h('button', { class: 'schip' + (plat === k ? ' on' : ''), onclick: () => { plat = k; drawTabs(); setCap(); } }, label)));
    drawTabs(); setCap();
    const cp = async (txt, msg) => { try { await navigator.clipboard.writeText(txt); toast(msg); } catch { toast('Copy not allowed here. Select the text and copy it.', true); } };
    const script = dvScript(v);
    const doneBtn = h('button', { class: 'btn' + (posted ? ' ok on' : ''), onclick: () => { posted = !posted; try { localStorage.setItem(key, posted ? '1' : '0'); } catch {} doneBtn.textContent = posted ? 'Posted ✓ (tap to undo)' : 'Mark as posted'; doneBtn.classList.toggle('ok', posted); doneBtn.classList.toggle('on', posted); } }, posted ? 'Posted ✓ (tap to undo)' : 'Mark as posted');
    return h('div', { class: 'card dv-card' },
      h('div', { class: 'dv-vid' }, h('video', { src: '/demos/' + v.id + '.mp4', poster: '/demos/' + v.id + '.jpg', controls: true, playsinline: true, preload: 'none', loop: true, muted: true })),
      h('div', { class: 'dv-body' },
        h('div', { class: 'dv-meta' }, h('span', { class: 'tag hot' }, v.styleName), h('b', null, v.t.name)),
        h('p', { class: 'dim small' }, '32 seconds with sound effects. Add your voice in CapCut using the script below (turn the effects down if you want), then post.'),
        h('a', { class: 'btn primary', href: '/demos/' + v.id + '.mp4', download: 'reekon-' + v.id + '.mp4' }, 'Download video'),
        tabs, area,
        h('div', { class: 'row wrap' }, h('button', { class: 'btn primary', onclick: () => cp(area.value, 'Caption copied') }, 'Copy caption'), doneBtn),
        h('details', { class: 'dv-vo', open: !!open }, h('summary', null, 'Voice-over script'),
          h('p', { class: 'dv-script' }, script), h('button', { class: 'btn', onclick: () => cp(script, 'Script copied. Paste it into your voice tool') }, 'Copy script'))));
  }

  async function viewContent() {
    const [r, trk] = await Promise.all([api('GET', '/content'), api('GET', '/tracker')]);
    const dayN = r.day_n;
    const typeFor = (n) => CONTENT_TYPES[(((n - 1) % 4) + 4) % 4];
    const tplFor = (n) => { const t = typeFor(n); const lib = CONTENT_LIB[t.id]; return lib[Math.floor(((((n - 1) % (4 * lib.length)) + 4 * lib.length) % (4 * lib.length)) / 4) % lib.length]; };
    const week = trk.history.slice(-7).reduce((a, d) => a + d.dials, 0);
    const fill = (txt) => txt.replace(/\{day\}/g, dayN).replace(/\{dials\}/g, trk.day.dials).replace(/\{talks\}/g, trk.day.talks).replace(/\{demos\}/g, trk.day.demos).replace(/\{week\}/g, week);
    const type = typeFor(dayN), tpl = tplFor(dayN);
    const done = new Set(r.done_today);
    let plat = CPLAT.find(([k]) => !done.has(k))?.[0] || 'ig';
    const area = h('textarea', { class: 'ct-text', rows: 11 });
    const doneBtn = h('button', { class: 'btn ok' });
    const setText = () => { area.value = fill(tpl[plat]) + '\n\n' + CTA[plat] + (plat === 'ig' ? '\n\n' + TAGS : ''); doneBtn.textContent = done.has(plat) ? 'Posted ✓ (tap to undo)' : 'Mark as posted'; doneBtn.classList.toggle('on', done.has(plat)); };
    const tabs = h('div', { class: 'stagechips' });
    const drawTabs = () => tabs.replaceChildren(...CPLAT.map(([k, label]) => h('button', { class: 'schip' + (plat === k ? ' on' : ''), onclick: () => { plat = k; drawTabs(); setText(); } }, label + (done.has(k) ? ' ✓' : ''))));
    drawTabs(); setText();
    const copy = h('button', { class: 'btn primary', onclick: async () => {
      try { await navigator.clipboard.writeText(area.value); toast('Copied. Paste it into ' + CPLAT.find(([k]) => k === plat)[1]); } catch { area.select(); toast('Press copy on your keyboard', true); }
    } }, 'Copy post');
    doneBtn.onclick = async () => {
      doneBtn.disabled = true;
      try { await api('POST', '/content/toggle', { platform: plat, type: type.id }); viewContent(); } catch (e) { fail(e); doneBtn.disabled = false; }
    };
    const strip = h('div', { class: 'ct-week' }, r.week.map((d) => {
      const t = typeFor(d.n);
      return h('div', { class: 'ct-day' + (d.today ? ' now' : '') + (d.done.length === 3 ? ' full' : '') },
        h('small', null, d.label), h('b', null, t.name.replace(' post', '')), h('span', null, d.future ? '' : d.done.length + '/3'));
    }));
    const lib = h('div', { class: 'ct-lib' }, CONTENT_TYPES.map((t) => h('details', { class: 'card ct-det' }, h('summary', null, h('b', null, t.name), h('small', { class: 'dim' }, t.job)),
      h('p', { class: 'ct-vis' }, 'Visual: ' + t.visual),
      CONTENT_LIB[t.id].map((p) => h('div', { class: 'ct-tpl' }, h('b', null, p.hook), h('pre', null, fill(p.ig)))))));
    shell('content', [
      h('div', { class: 'page-head' }, h('div', null, h('p', { class: 'kicker' }, 'Content'), h('h1', null, 'Post today'), h('p', { class: 'sub' }, 'One post a day, on Instagram, X and LinkedIn. Faceless and phone-only. Takes 10 minutes.'))),
      h('section', { class: 'ct-today' },
        h('div', { class: 'ct-type' }, h('span', { class: 'tag hot' }, 'Today: ' + type.name), h('p', null, type.job), h('p', { class: 'dim small' }, 'Visual: ' + type.visual)),
        h('div', { class: 'ct-hook' }, tpl.hook),
        tabs, area,
        h('div', { class: 'row wrap' }, copy, doneBtn),
        h('p', { class: 'dim small' }, 'Edit the text first if you want. The numbers in example math are illustrations, so keep them labeled as examples. Marking a platform posted adds to your post count on Home.')),
      h('h3', { class: 'trk-h' }, 'Demo videos for today (2 ready)'),
      h('p', { class: 'dim small' }, 'Same call to action on every caption. Download, add the voice-over, post one now and one later.'),
      h('div', { class: 'dv-grid' }, dvToday(dayN).map((id, i) => dvCard(dvOf(id), dayN, i === 0))),
      h('h3', { class: 'trk-h' }, 'Video library'),
      h('div', { class: 'ct-lib' }, DV_ORDER.map((id) => { const v = dvOf(id); return h('details', { class: 'card ct-det' }, h('summary', null, h('b', null, v.t.name), h('small', { class: 'dim' }, v.styleName + ' style')), dvCard(v, 'lib', false)); })),
      h('h3', { class: 'trk-h' }, 'This week'), strip,
      h('h3', { class: 'trk-h' }, 'More posts to pull from'), lib,
    ]);
  }

  /* ================= theme, calendar links ================= */
  function applyTheme(mode) {
    let eff = mode;
    if (mode === 'system') eff = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', eff === 'light' ? 'light' : 'dark');
    const m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', eff === 'light' ? '#f4f6fb' : '#06070a');
  }
  const gcalLink = ({ title, start, minutes, details }) => {
    const s = new Date(start), e = new Date(s.getTime() + (minutes || 30) * 60000);
    const f = (d) => d.toISOString().replace(/[-:]|\.\d{3}/g, '');
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(title) + '&dates=' + f(s) + '/' + f(e) + '&details=' + encodeURIComponent(details || '');
  };

  /* ================= daily brief ================= */
  async function viewRebrief(dayArg) {
    const r = await api('GET', '/rebrief' + (dayArg ? '?day=' + dayArg : ''));
    const shift = (d, n) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
    const go = (d) => { location.hash = '#/rebrief/' + d; };
    const label = r.is_today ? 'Today' : new Date(r.day + 'T12:00:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    const nav = h('div', { class: 'rb-nav' },
      h('button', { class: 'btn small', onclick: () => go(shift(r.day, -1)) }, '← Back'),
      h('b', null, label),
      h('button', { class: 'btn small', disabled: r.is_today, onclick: () => go(shift(r.day, 1)) }, 'Next →'));
    const [vk, vTitle, vLine] = r.verdict;
    const hero = h('section', { class: 'rb-hero ' + vk },
      h('div', { class: 'rb-score' }, h('b', null, r.score), h('small', null, '/ 100')),
      h('div', null, h('h2', null, vTitle), h('p', null, vLine)));
    const bars = h('div', { class: 'rb-bars' }, r.breakdown.map(([n, v, max]) => h('div', { class: 'rb-bar' }, h('span', null, n), h('div', { class: 'ov-ftrack' }, h('i', { style: 'width:' + (max ? (v / max) * 100 : 0) + '%' })), h('b', null, v + '/' + max))));
    const OC = { no_answer: 'No answer', voicemail: 'Voicemail', gatekeeper: 'Gatekeeper', not_interested: 'Not interested', callback: 'Callback', booked: 'Audit booked', dnc: 'Do not call', emailed: 'Emailed', demo_sent: 'Demo sent' };
    const oc = Object.entries(r.stats.outcomes).map(([k, n]) => h('span', { class: 'tag' }, (OC[k] || k) + ' · ' + n));
    const list = (items, empty, cls) => items.length ? h('ul', { class: 'rb-list ' + cls }, items.map((x) => h('li', null, x))) : h('p', { class: 'dim' }, empty);
    const cbRow = (l) => h('div', { class: 'rb-row' }, h('a', { href: '#/lead/' + l.id }, h('b', null, l.business), h('small', null, fmt(l.callback_at, { weekday: 'short', hour: 'numeric', minute: '2-digit' }))),
      h('a', { class: 'btn small', target: '_blank', rel: 'noopener', href: gcalLink({ title: 'Callback: ' + l.business, start: l.callback_at, minutes: 15, details: 'Callback from Reekon CRM' }) }, '+ Calendar'));
    const bkRow = (l) => h('div', { class: 'rb-row' }, h('a', { href: '#/lead/' + l.id }, h('b', null, l.business), h('small', null, (l.status === 'call2' ? 'Call 2 · ' : 'Audit · ') + fmt(l.booked_at, { weekday: 'short', hour: 'numeric', minute: '2-digit' }))),
      h('a', { class: 'btn small', target: '_blank', rel: 'noopener', href: gcalLink({ title: (l.status === 'call2' ? 'Call 2: ' : 'Free AI audit: ') + l.business, start: l.booked_at, minutes: 30, details: 'Booked in Reekon CRM' }) }, '+ Calendar'));
    const note = h('textarea', { class: 'live-notes', rows: 3, placeholder: 'One thing I learned. One thing I\'ll do differently tomorrow.' });
    note.value = r.note;
    let t = null;
    const saveNote = async () => { try { await api('PUT', '/tracker', { day: r.day, note: note.value }); st.textContent = 'Saved ✓'; } catch (e) { st.textContent = 'Not saved'; } };
    const st = h('small', { class: 'dim' }, 'Autosaves');
    note.addEventListener('input', () => { st.textContent = 'Typing…'; clearTimeout(t); t = setTimeout(saveNote, 700); });
    const dials7 = r.history.map((x) => x.dials), mx = Math.max(r.goal, ...dials7, 1);
    const spark = h('div', { class: 'rb-spark' }, r.history.map((x) => h('div', { class: 'rb-sp' + (x.day === r.day ? ' now' : '') }, h('i', { style: 'height:' + Math.max(2, (x.dials / mx) * 100) + '%' }), h('small', null, new Date(x.day + 'T12:00:00').toLocaleDateString([], { weekday: 'narrow' })))));
    shell('rebrief', [
      h('div', { class: 'page-head' }, h('div', null, h('p', { class: 'kicker' }, 'Daily brief'), h('h1', null, r.is_today ? 'How today went' : 'How the day went'), h('p', { class: 'sub' }, 'Honest scorecard. It reads your tracker and your call log, so you don\'t have to remember.'))),
      nav, hero, bars,
      h('div', { class: 'rb-two' },
        h('section', { class: 'ov-card' }, h('div', { class: 'ov-head' }, h('h3', null, 'What got done')), list(r.done, 'Nothing logged.', 'ok'), oc.length ? h('div', { class: 'row wrap' }, oc) : null),
        h('section', { class: 'ov-card' }, h('div', { class: 'ov-head' }, h('h3', null, r.is_today ? 'Still to do today' : 'What was missed')), list(r.todo, r.sunday ? 'Rest day.' : 'Nothing left. Clean day.', 'todo'))),
      h('section', { class: 'ov-card' }, h('div', { class: 'ov-head' }, h('h3', null, 'Last 7 days of dials'), h('span', { class: 'dim small' }, 'goal ' + r.goal)), spark),
      h('section', { class: 'ov-card' }, h('div', { class: 'ov-head' }, h('h3', null, 'Next up')),
        h('p', { class: 'dim small' }, r.tomorrow.fresh_leads.toLocaleString() + ' fresh leads waiting.'),
        r.tomorrow.booked.length ? h('div', { class: 'rb-rows' }, h('span', { class: 'eyebrow' }, 'Upcoming audits and call 2s'), r.tomorrow.booked.map(bkRow)) : h('p', { class: 'dim' }, 'No audits on the calendar yet. That\'s tomorrow\'s job.'),
        r.tomorrow.callbacks.length ? h('div', { class: 'rb-rows' }, h('span', { class: 'eyebrow' }, 'Callbacks due'), r.tomorrow.callbacks.map(cbRow)) : null),
      h('section', { class: 'ov-card' }, h('div', { class: 'ov-head' }, h('h3', null, 'Reflection'), st), note),
    ]);
  }

  /* ================= review cards ================= */
  async function viewCards() {
    const c = await api('GET', '/cards');
    const tile = (label, v, sub, cls) => h('div', { class: 'ov-kpi' + (cls ? ' ' + cls : '') }, h('small', null, label), h('b', null, v), h('span', null, sub));
    const log = async (kind) => {
      await sheet((box, close) => {
        const qty = h('input', { type: 'number', inputmode: 'numeric', min: 1, value: 1 });
        const price = h('input', { type: 'text', inputmode: 'decimal', value: '50' });
        const biz = h('input', { type: 'text', placeholder: 'Business name' });
        const note = h('input', { type: 'text', placeholder: 'Optional note' });
        const err = h('p', { class: 'err-line' });
        const title = { sold: 'Sold review cards', given: 'Gave cards away', lost: 'Lost or damaged' }[kind];
        box.append(h('h2', null, title),
          h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', null, 'How many'), qty), kind === 'sold' ? h('div', { class: 'field' }, h('label', null, 'Price each ($)'), price) : null),
          kind !== 'lost' ? h('div', { class: 'field' }, h('label', null, 'Business'), biz) : null,
          h('div', { class: 'field' }, h('label', null, 'Note'), note), err,
          h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'),
            h('button', { class: 'btn ok', onclick: async () => { try { await api('POST', '/cards', { kind, qty: qty.value, price: price.value, business: biz.value, note: note.value }); toast('Logged'); close(true); } catch (e) { err.textContent = e.message; } } }, 'Save')));
      });
      viewCards();
    };
    const row = (e) => h('div', { class: 'rb-row' }, h('div', null, h('b', null, e.qty + ' × ' + ({ sold: 'sold', given: 'given away', lost: 'lost' }[e.kind]) + (e.business ? ' · ' + e.business : '')),
      h('small', null, fmt(e.created_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + (e.kind === 'sold' ? ' · ' + money(e.qty * e.price_cents) : '') + (e.note ? ' · ' + e.note : ''))),
      h('button', { class: 'btn small danger', onclick: async () => { if (!(await confirmSheet('Delete this entry?', 'Stock and revenue will update.', 'Delete', true))) return; await api('DELETE', '/cards/' + e.id); viewCards(); } }, 'Delete'));
    shell('cards', [
      h('div', { class: 'page-head' }, h('div', null, h('p', { class: 'kicker' }, 'Tools'), h('h1', null, 'Review cards'), h('p', { class: 'sub' }, 'Your NFC "Review us on Google" cards: stock, sales and revenue.'))),
      h('div', { class: 'ov-kpis' }, tile('In stock', c.stock.toLocaleString(), 'of ' + c.total + ' ordered', c.stock <= 5 ? 'bad' : ''), tile('Sold', c.sold.toLocaleString(), c.today_sold + ' today', c.sold ? 'good' : ''), tile('Revenue', money(c.revenue_cents), c.sold ? money(Math.round(c.revenue_cents / c.sold)) + ' avg per card' : 'no sales yet', c.revenue_cents ? 'good' : ''), tile('Given away', c.given.toLocaleString(), 'as samples or bundled'), tile('Lost', c.lost.toLocaleString(), 'damaged or missing')),
      h('div', { class: 'row wrap', style: 'margin:12px 0' }, h('button', { class: 'btn ok', onclick: () => log('sold') }, 'Log a sale'), h('button', { class: 'btn', onclick: () => log('given') }, 'Gave some away'), h('button', { class: 'btn', onclick: () => log('lost') }, 'Lost or damaged')),
      h('p', { class: 'ov-note' }, 'Tap counts are not tracked, because a card links straight to Google. To track taps per business, each card would need to point at a tracked link, which is a bigger build.'),
      h('h3', { class: 'trk-h' }, 'History'), c.log.length ? h('div', { class: 'card' }, c.log.map(row)) : h('p', { class: 'dim' }, 'No entries yet. Log your first sale when the cards arrive.'),
    ]);
  }

  /* ================= settings ================= */
  async function viewSettings() {
    const s = await api('GET', '/settings');
    const sec = (title, sub, ...kids) => h('section', { class: 'ov-card' }, h('div', { class: 'ov-head' }, h('h3', null, title), sub ? h('span', { class: 'dim small' }, sub) : null), ...kids);
    const mode = lsGet('rs_theme', 'dark');
    const themeRow = h('div', { class: 'stagechips' }, [['dark', 'Dark'], ['light', 'Light'], ['system', 'Match device']].map(([k, label]) => h('button', { class: 'schip' + (mode === k ? ' on' : ''), onclick: () => { lsSet('rs_theme', k); applyTheme(k); viewSettings(); } }, label)));
    const field = (label, input, hint) => h('div', { class: 'field' }, h('label', null, label), input, hint ? h('small', { class: 'dim' }, hint) : null);
    const goal = h('input', { type: 'number', inputmode: 'numeric', min: 1, max: 2000, value: s.goal });
    const start = h('input', { type: 'date', value: s.push_start });
    const niche = h('input', { type: 'text', value: s.focus_niche });
    const cards = h('input', { type: 'number', inputmode: 'numeric', min: 0, value: s.cards_total });
    const gv = h('input', { type: 'text', placeholder: '(310) 555-0100', value: s.gv_number });
    const savedMsg = h('small', { class: 'dim' });
    const saveAll = async () => {
      try {
        await api('PUT', '/tracker/goal', { goal: +goal.value });
        await api('PUT', '/settings', { push_start: start.value, focus_niche: niche.value, cards_total: cards.value, gv_number: gv.value });
        savedMsg.textContent = 'Saved ✓'; toast('Settings saved');
      } catch (e) { savedMsg.textContent = ''; fail(e); }
    };
    const p = s.providers;
    const status = (name, ok, where) => h('div', { class: 'rb-row' }, h('div', null, h('b', null, name), h('small', null, ok ? 'Connected' : where)), h('span', { class: 'tag ' + (ok ? 'good' : 'hot') }, ok ? 'On' : 'Missing'));
    let list = {}; try { list = JSON.parse(s.checklist || '{}'); } catch { /* ignore */ }
    const CHECK = [['gv', 'Google Voice number set up and popups allowed for this site'], ['places', 'Lead Finder returns med spa results (Google key working)'], ['bot', 'Lead bot on: med spa, my cities, include businesses with websites'], ['ig', 'Instagram set to a business profile, bio + link ready'], ['x', 'X account ready (bio says what you do)'], ['li', 'LinkedIn profile updated with the med spa offer'], ['cal', 'Google Calendar open for audit bookings'], ['cards', 'Review cards arrived and counted'], ['script', 'Call script finalized for med spas']];
    const checkRow = ([k, label]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!list[k], onchange: async (e) => { list[k] = e.target.checked; try { await api('PUT', '/settings', { checklist: JSON.stringify(list) }); } catch (x) { fail(x); } } }), h('span', null, label));
    const link = (href, name, sub) => h('a', { class: 'list-row link', href }, h('div', { style: 'flex:1;min-width:0' }, h('b', null, name), h('div', { class: 'sub' }, sub)));
    shell('settings', [
      h('div', { class: 'page-head' }, h('div', null, h('p', { class: 'kicker' }, 'System'), h('h1', null, 'Settings'), h('p', { class: 'sub' }, 'Everything backend, in one place.'))),
      h('div', { class: 'ov-grid' },
        sec('Appearance', null, themeRow),
        sec('Targets and focus', null, field('Daily dial goal', goal, 'Your floor is 150. Target 200.'), field('Day 1 of the 30-day push', start), field('Focus niche', niche, 'Leads matching this sort to the top.'), field('Review cards ordered', cards), field('Google Voice number', gv, 'For your reference. Calls open Google Voice in a side window.'),
          h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: saveAll }, 'Save'), savedMsg)),
        sec('Connections', 'status only', status('Google Places (Lead Finder)', p.google_places, 'Add GOOGLE_PLACES_KEY in Cloudflare'), status('TomTom (backup finder)', p.tomtom, 'Optional'), status('Twilio (in-portal dialer)', p.twilio, 'Optional. Google Voice works without it.'),
          h('p', { class: 'ov-note' }, 'API keys are kept as secrets in Cloudflare (Workers → your worker → Settings → Variables and Secrets), so they never sit in this page. Finder is using: ' + p.finder_provider + '.')),
        sec('Instagram handles', 'automatic', h('p', { class: 'dim' }, 'The lead bot reads each med spa\'s own website for an Instagram link and saves it on the lead. It runs by itself every night. Businesses without a website still need Find on Instagram on their lead page.'),
          (() => { const out = h('p', { class: 'ov-note' }, 'Checking…'); api('GET', '/instagram/stats').then((x) => { out.textContent = x.have + ' leads have an Instagram saved. ' + x.waiting + ' websites are waiting to be checked.'; }).catch(() => { out.textContent = ''; });
            const btn = h('button', { class: 'btn', onclick: async () => { btn.disabled = true; btn.textContent = 'Checking…'; try { const r = await api('POST', '/instagram/enrich'); out.textContent = 'Checked ' + r.checked + ', found ' + r.found + '. ' + r.have + ' leads now have an Instagram. ' + r.waiting + ' waiting.'; } catch (e) { fail(e); } btn.disabled = false; btn.textContent = 'Check 15 more now'; } }, 'Check 15 more now');
            return h('div', { class: 'row wrap' }, btn, out); })()),
        sec('Google Calendar', null, h('p', { class: 'dim' }, 'Audits, call 2s and callbacks show a "+ Calendar" button that adds them to Google Calendar in one tap (Daily brief and each lead). A full two-way sync needs a Google sign-in setup, which we can add later.')),
        sec('Launch checklist', 'saves as you tick', h('div', { class: 'check-list' }, CHECK.map(checkRow))),
        sec('Advanced', 'hidden from the menu', h('div', { class: 'card' }, link('#/integrations', 'API keys and webhooks', 'Scraper and n8n access'), link('#/emailbot', 'Email bot', 'Cold email from Gmail (off for now)'), link('#/users', 'Team members', 'Reps, goals and commission'), link('#/recordings', 'Call recordings', 'Twilio dialer only'), link('#/upload', 'Add leads', 'Upload a CSV'), link('#/account', 'Account', 'Password and log out')))),
    ]);
  }

  async function viewAdminHome() {
    const ov = await api('GET', '/overview');
    const trk = ov;
    const niche = ov.focus_niche || 'med spa';
    const C = ov.calls, F = ov.funnel, R = ov.revenue, E = ov.email, O = ov.outreach, T = ov.content, SU = ov.supply;
    const labels = C.days.map(shortDay);
    const dateLine = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    const quickLog = (field, n, today) => async () => {
      try { await api('PUT', '/tracker', { [field]: today + n }); toast('Logged'); viewHome(); } catch (e) { fail(e); }
    };
    const startDialing = async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try { const r = await api('GET', '/leads/next'); if (r.id) location.hash = '#/lead/' + r.id; else { toast('No dialable leads left. Run the Lead Finder.', true); b.disabled = false; } } catch (x) { fail(x); b.disabled = false; }
    };

    const head = h('div', { class: 'page-head' },
      h('div', null, h('p', { class: 'kicker' }, h('span', { class: 'live' }), dateLine),
        h('h1', null, 'Day ' + Math.min(ov.day_n, 30) + ' of 30'),
        h('p', { class: 'sub' }, 'Everything in one place. Focus: ' + niche + 's.')),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/rebrief' }, 'Daily brief'), h('button', { class: 'btn primary', onclick: startDialing }, icon('phone'), 'Start dialing')));
    const prog = h('div', { class: 'ov-days' }, Array.from({ length: 30 }, (_, i) => h('i', { class: i + 1 < ov.day_n ? 'past' : i + 1 === ov.day_n ? 'now' : '' })));

    const reality = h('section', { class: 'ov-reality' },
      h('div', { class: 'ov-head' }, h('span', { class: 'kic' }, icon('flag')), h('h3', null, 'Reality check'), h('span', { class: 'dim small' }, 'straight talk, no cheerleading')),
      h('div', { class: 'ov-checks' }, ov.check.map((c) => h('div', { class: 'ov-check ' + c.level }, h('i'), h('span', null, c.text)))),
      prog);

    const kpi = (label, value, note, cls) => h('div', { class: 'ov-kpi' + (cls ? ' ' + cls : '') }, h('small', null, label), h('b', null, value), h('span', null, note));
    const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '0%');
    const kpis = h('div', { class: 'ov-kpis' },
      kpi('Dials today', C.today.toLocaleString(), 'of ' + ov.goal, C.today >= ov.goal ? 'good' : C.today < C.expected_now * 0.6 && C.expected_now > 20 ? 'bad' : ''),
      kpi('7-day average', C.avg7.toLocaleString(), 'dials per work day', C.avg7 >= ov.goal ? 'good' : C.avg7 < ov.goal * 0.75 ? 'bad' : ''),
      kpi('Audits booked', C.demos7.toLocaleString(), 'last 7 days', C.demos7 ? 'good' : ''),
      kpi('MRR', money(R.mrr_total), R.deals + (R.deals === 1 ? ' client' : ' clients'), R.mrr_total ? 'good' : ''),
      kpi('Setup revenue', money(R.setup_total), money(R.month_setup) + ' this month', R.setup_total ? 'good' : ''),
      kpi('Streak', ov.streak + 'd', 'all wins + goal dials', ov.streak ? 'good' : ''));

    const callsCard = ovCard({
      ic: 'phone', title: 'Calls', manage: ['Tracker', '#/tracker'],
      big: [[C.dials7.toLocaleString(), 'dials · 7d'], [C.talks7.toLocaleString(), 'pick-ups (' + pct(C.talks7, C.dials7) + ')'], [C.demos7.toLocaleString(), 'audits (' + pct(C.demos7, C.talks7) + ' of pick-ups)']],
      body: barChart({ labels, series: [{ name: 'Dials', values: C.dials, cls: 's1' }, { name: 'Pick-ups', values: C.talks, cls: 's2' }], goal: ov.goal }),
      note: [C.avg7 < ov.goal * 0.75 ? 'bad' : C.avg7 >= ov.goal ? 'good' : 'warn', `${C.avg7}/day average against a goal of ${ov.goal}. ${C.demos7 ? C.demos7 + ' audit' + (C.demos7 === 1 ? '' : 's') + ' booked this week.' : 'No audits booked this week.'}`] });

    const fmax = Math.max(1, F.focus_open, F.called, F.callback, F.booked, F.call2, F.won);
    const stage = (label, v, href) => h('a', { class: 'ov-fstep', href }, h('span', null, label), h('div', { class: 'ov-ftrack' }, h('i', { style: 'width:' + Math.max(v ? 3 : 0, (v / fmax) * 100) + '%' })), h('b', null, v.toLocaleString()));
    const go = (status) => () => Object.assign(S.leadFilters, { status, rep: '', batch: '', city: '', q: '', heat: '', contact: '', tag: '', due: '', source: '' });
    const pipeCard = ovCard({
      ic: 'chart', title: 'Pipeline', manage: ['Open leads', '#/leads'],
      big: [[F.focus_open.toLocaleString(), 'fresh ' + niche + ' leads'], [(F.booked + F.call2).toLocaleString(), 'audits + call 2'], [F.won.toLocaleString(), 'won']],
      body: h('div', { class: 'ov-funnel' },
        [['Fresh', F.focus_open, 'new'], ['Contacted', F.called, 'called'], ['Callback', F.callback, 'callback'], ['Audit booked', F.booked, 'booked'], ['Call 2', F.call2, 'call2'], ['Won', F.won, 'won']].map(([l, v, st]) => {
          const a = stage(l, v, '#/leads'); a.addEventListener('click', go(st)); return a;
        })),
      note: [F.booked + F.call2 ? 'good' : 'warn', `${F.total.toLocaleString()} leads in the CRM. ${F.focus_total.toLocaleString()} are ${niche}s; everything else is parked below them.`] });

    const revCard = ovCard({
      ic: 'deals', title: 'Revenue and MRR', manage: ['Deals', '#/deals'],
      big: [[money(R.mrr_total), 'MRR'], [money(R.mrr_total * 12), 'annual run rate'], [money(R.setup_total), 'setup fees']],
      body: barChart({ labels: R.months.map((m) => new Date(m + '-15T12:00:00').toLocaleDateString([], { month: 'short' })), series: [{ name: 'Setup', values: R.setup.map((v) => v / 100), cls: 's1' }, { name: 'MRR added', values: R.mrr.map((v) => v / 100), cls: 's3' }], fmt: (v) => '$' + v.toLocaleString() }),
      note: [R.deals ? 'good' : 'bad', R.deals ? `${R.deals} client${R.deals === 1 ? '' : 's'} closed. One more $3k + $800/mo deal adds ${money(80000 * 12)} a year.` : 'No revenue yet. Add your first deal with a Monthly amount and MRR starts here.'] });

    const smsCard = ovCard({
      ic: 'sms', title: 'SMS and DMs', manage: ['Log on tracker', '#/tracker'],
      big: [[O.texts7.toLocaleString(), 'texts · 7d'], [O.dms7.toLocaleString(), 'DMs · 7d'], [(O.today_texts + O.today_dms).toLocaleString(), 'today']],
      body: barChart({ labels, series: [{ name: 'Texts', values: O.texts, cls: 's1' }, { name: 'DMs', values: O.dms, cls: 's3' }] }),
      quick: [h('button', { class: 'trk-b', onclick: quickLog('texts', 10, O.today_texts) }, '+10 texts'), h('button', { class: 'trk-b', onclick: quickLog('texts', 1, O.today_texts) }, '+1 text'), h('button', { class: 'trk-b', onclick: quickLog('dms', 1, O.today_dms) }, '+1 DM')],
      note: ['', 'These are counts you log yourself. The portal can\'t see texts or DMs sent from your phone.'] });

    const contentCard = ovCard({
      ic: 'spark', title: 'Content and referrals', manage: ['Open Content', '#/content'],
      big: [[T.posts7.toLocaleString(), 'posts · 7d'], [T.refs7.toLocaleString(), 'referral asks · 7d'], [(T.today_posts + T.today_refs).toLocaleString(), 'today']],
      body: barChart({ labels, series: [{ name: 'Posts', values: T.posts, cls: 's1' }, { name: 'Referral asks', values: T.refs, cls: 's3' }] }),
      quick: [h('button', { class: 'trk-b', onclick: quickLog('refs', 1, T.today_refs) }, '+1 referral ask')],
      note: [T.posts7 ? 'good' : 'warn', T.posts7 ? `${T.posts7} posts this week. Content is the slow channel; keep it daily and it compounds.` : 'No posts logged this week. Content compounds, but only if it ships.'] });

    let cardsData = null; try { cardsData = await api('GET', '/cards'); } catch { /* optional */ }
    const cardsCard = cardsData ? ovCard({
      ic: 'deals', title: 'Review cards', manage: ['Manage', '#/cards'],
      big: [[cardsData.stock.toLocaleString(), 'in stock'], [cardsData.sold.toLocaleString(), 'sold'], [money(cardsData.revenue_cents), 'revenue']],
      note: [cardsData.stock <= 5 ? 'warn' : '', cardsData.sold ? cardsData.today_sold + ' sold today. ' + cardsData.given + ' given away.' : 'No sales yet. Log each sale so revenue stays honest.'] }) : null;
    const supplyCard = ovCard({
      ic: 'search', title: 'Lead supply', manage: ['Lead Finder', '#/finder'],
      big: [[SU.focus_open.toLocaleString(), niche + ' leads left'], [SU.days_left + 'd', 'at ' + ov.goal + ' dials/day'], [SU.added.slice(-7).reduce((a, b) => a + b, 0).toLocaleString(), 'added · 7d']],
      body: barChart({ labels, series: [{ name: 'Leads added', values: SU.added, cls: 's2' }] }),
      note: [SU.focus_open < ov.goal * 2 ? 'warn' : 'good', SU.focus_open < ov.goal * 2 ? 'You are about to run out of fresh leads. Turn on the lead bot or run a search.' : 'Enough fresh leads to keep dialing.'] });

    // live feed
    const feedBox = h('div', { class: 'feed' }, h('div', { class: 'empty-sm' }, h('div', { class: 'spinner', style: 'margin:auto' })));
    const feed = panel('Live activity', h('span', { class: 'live-tag' }, h('span', { class: 'live' }), 'Live'), feedBox);
    async function loadFeed() {
      try {
        const r = await api('GET', '/feed?limit=25');
        feedBox.replaceChildren(...(r.feed.length ? r.feed.map(feedRow) : [h('div', { class: 'empty-sm' }, 'Nothing yet. Calls, notes, demos and deals show up here the second they happen.')]));
      } catch { /* keep last */ }
    }
    loadFeed();
    clearInterval(S.feedTimer);
    S.feedTimer = setInterval(() => { if (!document.body.contains(feedBox)) { clearInterval(S.feedTimer); return; } if (!document.hidden) loadFeed(); }, 20000);

    shell('home', [head, reality, kpis, h('div', { class: 'ov-grid' }, callsCard, pipeCard, revCard, smsCard, contentCard, supplyCard, cardsCard), feed]);
  }

  async function viewHome() {
    const isAdmin = S.me.role === 'admin';
    if (isAdmin) return viewAdminHome();
    const [from, until] = periodBounds(S.period);
    const [dfrom, duntil] = dayBounds();
    const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - 6);
    const qs = new URLSearchParams({ from, until, since: since.toISOString(), tz: tzMin(), dfrom, duntil });
    const [d, me, team, trk] = await Promise.all([
      api('GET', '/dashboard?' + qs),
      api('GET', '/me'),
      null,
      isAdmin ? api('GET', '/tracker').catch(() => null) : null,
    ]);
    S.me.daily_goal = me.daily_goal;
    const T = d.totals, P = d.pipeline, F = d.funnel || {};
    const pn = PERIOD_NAME[S.period];
    const dateLine = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

    const head = h('div', { class: 'page-head' },
      h('div', null, h('p', { class: 'kicker' }, h('span', { class: 'live' }), dateLine),
        h('h1', null, 'Welcome back, ' + first(S.me.name)),
        h('p', { class: 'sub' }, isAdmin ? "Here's your pipeline " + pn + '.' : 'Your numbers ' + pn + '. Keep stacking.')),
      periodSeg(viewHome));

    if (!isAdmin) return repHome(d, me, head);

    const kpis = h('div', { class: 'kpi-grid' },
      kpiTile('phone', 'Calls made', T.calls.toLocaleString(), T.calls ? Math.round((T.booked / T.calls) * 100) + '% booked' : 'No calls yet', { href: '#/leads' }),
      kpiTile('mail', 'Demos sent', T.demos_sent.toLocaleString(), T.emails ? T.emails + ' by email' : 'by text or email'),
      kpiTile('callbacks', 'Callbacks due', (P.callbacks_due || 0).toLocaleString(), P.callback ? P.callback + ' scheduled in total' : 'none scheduled', { href: '#/callbacks', cls: P.callbacks_due ? 'warn' : '' }),
      kpiTile('cal', 'Calls booked', T.booked.toLocaleString(), 'with the closer'),
      kpiTile('trophy', 'Deals closed', T.closes.toLocaleString(), T.booked ? Math.round((T.closes / Math.max(1, T.booked)) * 100) + '% of booked' : '', { href: '#/deals' }),
      kpiTile('deals', 'Revenue', money(T.revenue_cents), 'setup fees ' + pn, { cls: 'money', href: '#/deals' }));

    // funnel
    const stages = [['Leads', F.leads, 'all'], ['Demo built', F.demo, 'demo_ready'], ['Contacted', F.contacted, 'called'], ['Booked', F.booked, 'booked'], ['Won', F.won, 'won']];
    const top = Math.max(1, F.leads || 0);
    const funnel = panel('Pipeline funnel', h('span', { class: 'dim small' }, 'All time'),
      h('div', { class: 'funnel' }, stages.map(([l, v, st], i) => {
        const prev = i ? stages[i - 1][1] : null;
        return h('button', { class: 'fstep', onclick: () => { Object.assign(S.leadFilters, { status: st, rep: '', batch: '', city: '', q: '', heat: '', contact: '' }); location.hash = '#/leads'; } },
          h('div', { class: 'fl' }, h('span', null, l), h('b', null, (v || 0).toLocaleString())),
          h('div', { class: 'ftrack' }, h('i', { style: 'width:' + Math.max(v ? 3 : 0, ((v || 0) / top) * 100) + '%;--d:' + i * 90 + 'ms' })),
          h('small', null, i && prev ? Math.round(((v || 0) / prev) * 100) + '% of ' + stages[i - 1][0].toLowerCase() : i ? '—' : 'not counting Do Not Call'));
      })));

    // live feed
    const feedBox = h('div', { class: 'feed' }, h('div', { class: 'empty-sm' }, h('div', { class: 'spinner', style: 'margin:auto' })));
    const feed = panel('Live activity', h('span', { class: 'live-tag' }, h('span', { class: 'live' }), 'Live'), feedBox);
    async function loadFeed() {
      try {
        const r = await api('GET', '/feed?limit=25');
        feedBox.replaceChildren(...(r.feed.length ? r.feed.map(feedRow) : [h('div', { class: 'empty-sm' }, 'Nothing yet. Calls, notes, demos and deals show up here the second they happen.')]));
      } catch { /* keep last */ }
    }
    loadFeed();
    clearInterval(S.feedTimer);
    S.feedTimer = setInterval(() => { if (!document.body.contains(feedBox)) { clearInterval(S.feedTimer); return; } if (!document.hidden) loadFeed(); }, 20000);

    const owed = d.owed_cents ? h('a', { class: 'banner', href: '#/deals' }, h('span', { class: 'kic' }, icon('deals')),
      h('div', null, h('b', null, money(d.owed_cents) + ' commission owed'), h('div', { class: 'sub' }, d.owed_deals + (d.owed_deals === 1 ? ' unpaid deal' : ' unpaid deals'))),
      h('span', { class: 'btn small' }, 'Pay out')) : null;

    const stat = (label, value, href, cls) => h('a', { class: 'stat-cell' + (cls ? ' ' + cls : ''), href }, h('small', null, label), h('b', null, value));
    const statLine = h('div', { class: 'statline' },
      stat('Calls', T.calls.toLocaleString(), '#/leads'),
      stat('Booked', T.booked.toLocaleString(), '#/leads'),
      stat('Callbacks due', (P.callbacks_due || 0).toLocaleString(), '#/callbacks', P.callbacks_due ? 'warn' : ''),
      stat('Closed', T.closes.toLocaleString(), '#/deals'),
      stat('Revenue', money(T.revenue_cents), '#/deals', 'money'));
    const trkWins = trk ? TRK_PLAN.filter((b) => b.win && trk.day.blocks.includes(b.id)).length : 0;
    const trkBanner = trk ? h('a', { class: 'banner', href: '#/tracker' }, h('span', { class: 'kic' }, icon('flag')),
      h('div', null, h('b', null, trk.day.dials + ' / ' + trk.goal + ' dials today'), h('div', { class: 'sub' }, trkWins + ' of 3 wins · ' + trk.streak + '-day streak')),
      h('span', { class: 'btn small' }, 'Open')) : null;
    shell('home', [
      head, trkBanner, statLine, owed,
      h('div', { class: 'dash-grid solo' },
        h('div', { class: 'col' }, feed)),
    ]);
  }

  function feedRow(e) {
    let what, cls = '';
    if (e.kind === 'call') {
      const o = e.detail;
      const verbs = { no_answer: 'called · no answer', voicemail: 'left a voicemail for', gatekeeper: 'hit a gatekeeper at', not_interested: 'called · not interested:', callback: 'set a callback with', demo_sent: 'sent the demo to', booked: 'booked a call with', dnc: 'marked Do Not Call:', emailed: 'emailed', status_change: 'changed status of', demo_ready: 'marked demo ready for', closed_won: 'closed' };
      what = verbs[o] || (OUTCOME_LABEL[o] || o) + ':';
      cls = o === 'booked' ? 'ok' : o === 'callback' ? 'warn' : o === 'emailed' || o === 'demo_sent' ? 'blue' : '';
    } else if (e.kind === 'note') { what = 'added a note on'; }
    else if (e.kind === 'deal') { what = 'closed ' + money(+e.detail) + ' with'; cls = 'money'; }
    else if (e.kind === 'demo') { what = 'built a demo for'; cls = 'blue'; }
    else if (e.kind === 'view') { what = 'opened their demo (' + e.detail + 'x)'; cls = 'hot'; }
    const who = e.kind === 'view' ? (e.biz || 'A lead') : (e.who || 'Someone');
    return h('a', { class: 'frow', href: e.lead_id ? '#/lead/' + e.lead_id : null },
      h('span', { class: 'fdot ' + cls }),
      h('div', { class: 'ftext' }, h('b', null, who), ' ', what, e.kind === 'view' ? null : [' ', h('b', null, e.biz || 'a lead')],
        e.kind === 'note' && e.detail ? h('div', { class: 'fquote' }, '“' + e.detail + '”') : null),
      h('time', null, ago(e.t)));
  }

  function repHome(d, me, head) {
    const T = d.totals, P = d.pipeline;
    const goal = me.daily_goal || 0, today = d.today_calls || 0;
    const goalCard = h('section', { class: 'panel goal-panel' },
      h('div', { class: 'panel-head' }, h('h3', null, 'Today'), goal ? h('span', { class: 'dim small' }, 'Goal: ' + goal + ' calls') : h('span', { class: 'dim small' }, 'No daily goal set')),
      h('div', { class: 'big-goal' }, h('b', null, today), h('span', null, goal ? '/ ' + goal + ' calls' : today === 1 ? 'call today' : 'calls today')),
      goal ? goalBar(today, goal, today >= goal ? 'Goal hit. Keep going.' : goal - today + ' to go') : null);
    const kpis = h('div', { class: 'kpi-grid four' },
      kpiTile('phone', 'Calls', T.calls.toLocaleString(), T.calls ? Math.round((T.booked / T.calls) * 100) + '% booked' : null),
      kpiTile('cal', 'Booked', T.booked.toLocaleString()),
      kpiTile('trophy', 'Closes', T.closes.toLocaleString()),
      kpiTile('deals', 'You earned', money(T.commission_cents), 'commission ' + PERIOD_NAME[S.period], { cls: 'money' }));
    const next = h('a', { class: 'banner', href: P.callbacks_due ? '#/callbacks' : '#/leads' }, h('span', { class: 'kic' }, icon(P.callbacks_due ? 'callbacks' : 'phone')),
      h('div', null, h('b', null, P.callbacks_due ? P.callbacks_due + (P.callbacks_due === 1 ? ' callback due' : ' callbacks due') : 'No callbacks due'),
        h('div', { class: 'sub' }, (P.demo_ready || 0) + ' demo-ready leads to call')),
      h('span', { class: 'btn primary small' }, P.callbacks_due ? 'Call back' : 'Start calling'));
    shell('home', [head, goalCard, kpis, next,
      h('div', { class: 'dash-grid' }, h('div', { class: 'col' }, weekChart(d.days, false), pipeline(P, false)), h('div', { class: 'col' }, leaderboard(d.leaderboard, false, PERIOD_NAME[S.period])))]);
  }

  /* ================= team stats (admin) ================= */
  async function viewTeam() {
    const [from, until] = periodBounds(S.period);
    const [dfrom, duntil] = dayBounds();
    const r = await api('GET', '/team?' + new URLSearchParams({ from, until, dfrom, duntil }));
    const pn = PERIOD_NAME[S.period];
    const reps = r.team.filter((u) => u.role !== 'dev');
    const devs = r.team.filter((u) => u.role === 'dev');
    const key = S.teamSort || 'calls';
    const sorted = [...reps].sort((a, b) => b[key] - a[key] || b.calls - a.calls || a.name.localeCompare(b.name));
    const noCalls = reps.filter((u) => u.active && u.role === 'rep' && u.today_calls === 0);
    const under = reps.filter((u) => u.active && u.role === 'rep' && u.daily_goal && u.today_calls > 0 && u.today_calls < u.daily_goal);

    const flags = h('div', { class: 'flag-row' },
      h('div', { class: 'flag-card' + (noCalls.length ? ' bad' : ' ok') }, h('b', null, noCalls.length), h('span', null, noCalls.length === 1 ? 'rep with no calls today' : 'reps with no calls today'),
        noCalls.length ? h('small', null, noCalls.map((u) => first(u.name)).join(', ')) : null),
      h('div', { class: 'flag-card' + (under.length ? ' warn' : ' ok') }, h('b', null, under.length), h('span', null, 'under their daily goal'),
        under.length ? h('small', null, under.map((u) => first(u.name) + ' ' + u.today_calls + '/' + u.daily_goal).join(', ')) : null),
      h('div', { class: 'flag-card' }, h('b', null, reps.reduce((n, u) => n + u.today_calls, 0)), h('span', null, 'team calls today')));

    const sortBtn = (k, l) => h('button', { class: 'th' + (key === k ? ' on' : ''), onclick: () => { S.teamSort = k; viewTeam(); } }, l);
    const medal = ['🥇', '🥈', '🥉'];
    const board = h('div', { class: 'tboard' },
      h('div', { class: 'trow thead' }, h('span', null, '#'), h('span', null, 'Rep'), sortBtn('calls', 'Calls'), sortBtn('booked', 'Booked'), sortBtn('closes', 'Closes'), sortBtn('revenue_cents', 'Revenue'), h('span', { class: 'hide-sm' }, 'Today'), h('span', { class: 'hide-sm' }, 'Last call')),
      sorted.length ? sorted.map((u, i) => h('a', { class: 'trow', href: '#/rep/' + u.id },
        h('span', { class: 'rk' }, u[key] && i < 3 ? medal[i] : String(i + 1)),
        h('span', { class: 'tname' }, h('span', { class: 'avatar sm' }, initials(u.name)), h('span', null, h('b', null, u.name),
          h('small', null, !u.active ? 'Inactive' : u.role === 'admin' ? 'Admin' : u.today_calls === 0 ? 'No calls today' : u.daily_goal ? u.today_calls + ' / ' + u.daily_goal + ' today' : u.today_calls + ' today'))),
        h('span', { class: 'n' + (key === 'calls' ? ' on' : '') }, u.calls), h('span', { class: 'n' + (key === 'booked' ? ' on' : '') }, u.booked),
        h('span', { class: 'n' + (key === 'closes' ? ' on' : '') }, u.closes), h('span', { class: 'n' + (key === 'revenue_cents' ? ' on' : '') }, money(u.revenue_cents)),
        h('span', { class: 'hide-sm' }, u.role === 'rep' ? goalBar(u.today_calls, u.daily_goal, '') : '—'),
        h('span', { class: 'hide-sm dim' }, u.last_call ? ago(u.last_call) : '—'))) :
        h('div', { class: 'empty-sm' }, 'No reps yet. ', h('a', { href: '#/users' }, 'Add one under Team members →')));

    const devBoard = devs.length ? panel('Demo builders · ' + pn, null, h('div', { class: 'tboard' },
      h('div', { class: 'trow thead dev' }, h('span', null, 'Builder'), h('span', null, 'Demos'), h('span', null, 'Today'), h('span', null, 'Avg speed')),
      devs.map((u) => h('a', { class: 'trow dev', href: '#/rep/' + u.id },
        h('span', { class: 'tname' }, h('span', { class: 'avatar sm dev' }, initials(u.name)), h('b', null, u.name)),
        h('span', { class: 'n on' }, u.demos), h('span', { class: 'n' }, u.demos_today + (u.daily_goal ? ' / ' + u.daily_goal : '')),
        h('span', { class: 'n' }, u.demo_avg_hours == null ? '—' : fmtHours(u.demo_avg_hours)))),
      h('p', { class: 'dim small', style: 'margin-top:10px' }, 'Avg speed = time from when the lead was uploaded to when its demo was built.'))) : null;

    shell('team', [
      h('div', { class: 'page-head' }, h('div', null, h('p', { class: 'kicker' }, 'Team'), h('h1', null, 'Who’s putting in work'),
        h('p', { class: 'sub' }, 'Tap anyone to see their day hour by hour. Set daily goals on their page.')), periodSeg(viewTeam)),
      flags,
      panel('Leaderboard · ' + pn, h('span', { class: 'dim small' }, 'Tap a column to rank'), board),
      devBoard,
    ]);
  }
  const fmtHours = (hrs) => (hrs < 1 ? Math.max(1, Math.round(hrs * 60)) + ' min' : hrs < 48 ? (Math.round(hrs * 10) / 10) + ' hrs' : Math.round(hrs / 24) + ' days');

  async function viewRep(id) {
    const [from, until] = periodBounds(S.period);
    const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - 13);
    const r = await api('GET', '/team/' + id + '?' + new URLSearchParams({ from, until, since: since.toISOString(), tz: tzMin() }));
    const U = r.user, isDev = U.role === 'dev';
    const pn = PERIOD_NAME[S.period];
    const dayKey = (x) => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
    const byDay = Object.fromEntries(r.daily.map((x) => [x.day, x]));
    const demoDay = Object.fromEntries(r.demo_daily.map((x) => [x.day, x.demos]));
    const days = [];
    for (let i = 13; i >= 0; i--) { const x = new Date(); x.setHours(12, 0, 0, 0); x.setDate(x.getDate() - i); const k = dayKey(x); days.push({ date: x, key: k, ...(byDay[k] || {}), demos: demoDay[k] || 0, today: i === 0 }); }
    const today = days[13];
    const metric = isDev ? 'demos' : 'calls';
    const periodCalls = r.hourly.reduce((n, x) => n + x.calls, 0);
    const booked = r.outcomes.find((o) => o.outcome === 'booked');
    const revenue = r.deals.reduce((n, x) => n + x.amount_cents, 0);

    const editGoal = async () => {
      const v = await sheet((box, close) => {
        const inp = h('input', { type: 'number', min: 0, max: 1000, inputmode: 'numeric', value: U.daily_goal || '' });
        box.append(h('h2', null, 'Daily goal for ' + first(U.name)), h('p', { class: 'sub' }, isDev ? 'Demos to build per day.' : 'Calls to make per day. They see it on their home screen.'),
          h('div', { class: 'field' }, h('label', null, isDev ? 'Demos per day' : 'Calls per day'), inp),
          h('div', { class: 'row wrap', style: 'margin-bottom:12px' }, (isDev ? [5, 10, 15] : [40, 60, 80, 100]).map((n) => h('button', { class: 'btn small', type: 'button', onclick: () => { inp.value = n; } }, String(n)))),
          h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => close(inp.value === '' ? 0 : +inp.value) }, 'Save goal')));
      });
      if (v === null || v === undefined) return;
      try { await api('PATCH', '/users/' + U.id, { daily_goal: v }); toast('Goal saved'); viewRep(id); } catch (e) { fail(e); }
    };

    const todayVal = isDev ? today.demos : today.calls || 0;
    const head = h('div', { class: 'page-head' },
      h('div', { class: 'rep-id' }, h('span', { class: 'avatar lg' + (isDev ? ' dev' : '') }, initials(U.name)),
        h('div', null, h('p', { class: 'kicker' }, ROLE_NAME[U.role] + (U.active ? '' : ' · inactive')), h('h1', null, U.name),
          h('p', { class: 'sub' }, U.email))),
      periodSeg(() => viewRep(id)));

    const goalP = h('section', { class: 'panel goal-panel' },
      h('div', { class: 'panel-head' }, h('h3', null, 'Today'), h('button', { class: 'btn small', onclick: editGoal }, icon('flag'), U.daily_goal ? 'Goal: ' + U.daily_goal + '/day' : 'Set daily goal')),
      h('div', { class: 'big-goal' }, h('b', null, todayVal), h('span', null, U.daily_goal ? '/ ' + U.daily_goal + ' ' + metric : metric + ' today')),
      U.daily_goal ? goalBar(todayVal, U.daily_goal, todayVal >= U.daily_goal ? 'Goal hit' : todayVal === 0 ? 'Nothing yet today' : U.daily_goal - todayVal + ' to go') : null,
      !isDev ? h('div', { class: 'times' }, h('div', null, h('small', null, 'First call'), h('b', null, clock(today.first_call))), h('div', null, h('small', null, 'Last call'), h('b', null, today.last_call ? clock(today.last_call) + ' · ' + ago(today.last_call) : '—'))) : null);

    const kpis = isDev
      ? h('div', { class: 'kpi-grid four' },
        kpiTile('spark', 'Demos built', r.demos.length.toLocaleString(), pn),
        kpiTile('bolt', 'Avg speed', r.demos.length ? fmtHours(r.demos.reduce((n, d) => n + (d.hours || 0), 0) / r.demos.length) : '—', 'upload → demo'),
        kpiTile('demos', 'Demo opens', r.demos.reduce((n, d) => n + (d.views || 0), 0).toLocaleString(), 'by business owners'),
        kpiTile('cal', 'Last 14 days', days.reduce((n, x) => n + x.demos, 0).toLocaleString(), 'demos'))
      : h('div', { class: 'kpi-grid four' },
        kpiTile('phone', 'Calls', periodCalls.toLocaleString(), pn),
        kpiTile('cal', 'Booked', (booked ? booked.n : 0).toLocaleString(), periodCalls ? Math.round(((booked ? booked.n : 0) / periodCalls) * 100) + '% of calls' : null),
        kpiTile('trophy', 'Closes', r.deals.length.toLocaleString()),
        kpiTile('deals', 'Revenue', money(revenue), pn, { cls: 'money' }));

    // 14-day bars with goal line
    const max = Math.max(1, U.daily_goal || 0, ...days.map((x) => (isDev ? x.demos : x.calls || 0)));
    const readout = h('div', { class: 'readout' });
    const show = (x) => readout.replaceChildren(h('b', null, (isDev ? x.demos : x.calls || 0) + ' ' + metric), h('span', null, ' · ' + (x.today ? 'today' : x.date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })) + (!isDev && x.first_call ? ' · ' + clock(x.first_call) + '–' + clock(x.last_call) : '')));
    const bars = days.map((x) => {
      const v = isDev ? x.demos : x.calls || 0;
      const b = h('button', { class: 'bar' + (x.today ? ' today' : '') + (U.daily_goal && v >= U.daily_goal ? ' hit' : ''), type: 'button', onmouseenter: () => { show(x); mark(b); }, onclick: () => { show(x); mark(b); } },
        h('div', { class: 'track' }, h('i', { style: 'height:' + (v ? Math.max(4, (v / max) * 100) : 0) + '%' })), h('small', null, x.date.toLocaleDateString([], { weekday: 'narrow' })));
      return b;
    });
    const mark = (b0) => bars.forEach((b) => b.classList.toggle('sel', b === b0));
    show(today); mark(bars[13]);
    const chart = panel((isDev ? 'Demos' : 'Calls') + ' per day · last 14 days', U.daily_goal ? h('span', { class: 'dim small' }, '— goal ' + U.daily_goal) : null,
      readout, h('div', { class: 'chart tall' }, U.daily_goal ? h('div', { class: 'goal-mark', style: 'bottom:' + Math.round(22 + (U.daily_goal / max) * 158) + 'px' }) : null, bars));

    // calls by hour
    let hourPanel = null, dayTable = null, outcomesP = null;
    if (!isDev) {
      const hrs = Object.fromEntries(r.hourly.map((x) => [x.hour, x.calls]));
      const lo = Math.min(7, ...r.hourly.map((x) => x.hour)), hi = Math.max(20, ...r.hourly.map((x) => x.hour));
      const hmax = Math.max(1, ...r.hourly.map((x) => x.calls));
      const lbl = (hr) => (hr % 12 || 12) + (hr < 12 ? 'a' : 'p');
      const cols = []; for (let hr = lo; hr <= hi; hr++) cols.push(hr);
      hourPanel = panel('Calls by hour · ' + pn, null, r.hourly.length ? h('div', { class: 'hours' }, cols.map((hr) => h('div', { class: 'hcol', title: lbl(hr) + ': ' + (hrs[hr] || 0) + ' calls' },
        h('div', { class: 'htrack' }, h('i', { style: 'height:' + ((hrs[hr] || 0) / hmax) * 100 + '%' }), hrs[hr] ? h('em', null, hrs[hr]) : null), h('small', null, hr % 2 === 0 ? lbl(hr) : '')))) :
        h('div', { class: 'empty-sm' }, 'No calls ' + pn + '.'));
      const worked = days.filter((x) => x.calls || x.emails).reverse();
      dayTable = panel('Day by day', null, worked.length ? h('div', { class: 'dtable' },
        h('div', { class: 'drow head' }, h('span', null, 'Day'), h('span', null, 'Calls'), h('span', null, 'Booked'), h('span', null, 'First'), h('span', null, 'Last')),
        worked.map((x) => h('div', { class: 'drow' + (U.daily_goal && x.calls < U.daily_goal ? ' under' : '') },
          h('span', null, x.today ? 'Today' : x.date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })),
          h('span', null, String(x.calls || 0), U.daily_goal && x.calls < U.daily_goal ? h('i', { class: 'flag-dot', title: 'Under goal' }) : null),
          h('span', null, String(x.booked || 0)), h('span', null, clock(x.first_call)), h('span', null, clock(x.last_call))))) :
        h('div', { class: 'empty-sm' }, 'No calls in the last 14 days.'));
      const omax = Math.max(1, ...r.outcomes.map((o) => o.n));
      outcomesP = panel('Outcomes · ' + pn, null, r.outcomes.length ? h('div', { class: 'obars' }, r.outcomes.map((o) => h('div', { class: 'obar o-' + o.outcome },
        h('span', null, OUTCOME_LABEL[o.outcome] || o.outcome), h('div', { class: 'otrack' }, h('i', { style: 'width:' + (o.n / omax) * 100 + '%' })), h('b', null, o.n)))) :
        h('div', { class: 'empty-sm' }, 'Nothing logged ' + pn + '.'));
    }
    const dealsP = !isDev && r.deals.length ? panel('Closes · ' + pn, null, r.deals.map((d) => h('a', { class: 'frow', href: '#/lead/' + d.lead_id }, h('span', { class: 'fdot money' }),
      h('div', { class: 'ftext' }, h('b', null, d.business || 'Deal'), ' ', d.package || ''), h('time', null, money(d.amount_cents))))) : null;
    const demosP = isDev ? panel('Demos built · ' + pn, null, r.demos.length ? r.demos.map((d) => h('a', { class: 'frow', href: '#/lead/' + d.lead_id }, h('span', { class: 'fdot blue' }),
      h('div', { class: 'ftext' }, h('b', null, d.business || 'Demo'), h('div', { class: 'fquote' }, (d.hours == null ? '' : 'built ' + fmtHours(d.hours) + ' after upload · ') + (d.views || 0) + ' opens')), h('time', null, ago(d.created_at)))) :
      h('div', { class: 'empty-sm' }, 'No demos built ' + pn + '.')) : null;
    const recentP = !isDev ? panel('Recent activity', null, r.recent.length ? r.recent.map((c) => feedRow({ kind: 'call', t: c.created_at, detail: c.outcome, who: first(U.name), biz: c.business, lead_id: c.lead_id })) : h('div', { class: 'empty-sm' }, 'No activity yet.')) : null;

    shell('rep', [
      h('a', { class: 'back', href: '#/users' }, icon('back'), 'Team members'),
      head, goalP, kpis,
      h('div', { class: 'dash-grid' }, h('div', { class: 'col' }, chart, hourPanel, outcomesP, demosP), h('div', { class: 'col' }, dayTable, dealsP, recentP)),
    ]);
  }

  function weekChart(rows, isAdmin) {
    const byDay = Object.fromEntries(rows.map((r) => [r.day, r]));
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const x = new Date(); x.setHours(12, 0, 0, 0); x.setDate(x.getDate() - i);
      const key = x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
      const r = byDay[key] || {};
      days.push({ date: x, calls: r.calls || 0, booked: r.booked || 0, today: i === 0 });
    }
    const max = Math.max(1, ...days.map((x) => x.calls));
    const readout = h('div', { class: 'readout' });
    const show = (x) => readout.replaceChildren(h('b', null, x.calls + (x.calls === 1 ? ' call' : ' calls')), h('span', null, ' · ' + x.booked + ' booked · ' + (x.today ? 'today' : x.date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }))));
    const bars = days.map((x) => {
      const col = h('button', { class: 'bar' + (x.today ? ' today' : ''), type: 'button', 'aria-label': x.date.toLocaleDateString([], { weekday: 'long' }) + ': ' + x.calls + ' calls, ' + x.booked + ' booked',
        onmouseenter: () => { show(x); mark(col); }, onfocus: () => { show(x); mark(col); }, onclick: () => { show(x); mark(col); } },
        h('div', { class: 'track' }, h('i', { style: 'height:' + (x.calls ? Math.max(4, (x.calls / max) * 100) : 0) + '%' })),
        h('small', null, x.today ? 'Today' : x.date.toLocaleDateString([], { weekday: 'short' })));
      return col;
    });
    const mark = (col) => bars.forEach((b) => b.classList.toggle('sel', b === col));
    show(days[6]); mark(bars[6]);
    const chart = h('div', { class: 'chart', onmouseleave: () => { show(days[6]); mark(bars[6]); } }, bars);
    return h('div', { class: 'section' }, h('span', { class: 'eyebrow' }, (isAdmin ? 'Team calls' : 'Your calls') + ' · last 7 days'),
      h('div', { class: 'card' }, readout, chart));
  }

  function leaderboard(rows, isAdmin, periodName) {
    const key = S.boardSort;
    const sorted = [...rows].sort((a, b) => b[key] - a[key] || b.closes - a.closes || b.booked - a.booked || b.calls - a.calls || a.name.localeCompare(b.name));
    const medal = ['🥇', '🥈', '🥉'];
    const hdr = (k, l) => h('button', { class: 'th' + (key === k ? ' on' : ''), onclick: () => { S.boardSort = k; box.replaceWith(leaderboard(rows, isAdmin, periodName)); } }, l);
    const box = h('div', { class: 'section' }, h('span', { class: 'eyebrow' }, 'Leaderboard · ' + periodName),
      h('div', { class: 'card board' },
        h('div', { class: 'brow bhead' }, h('span', { class: 'rk' }, '#'), h('span', { class: 'nm' }, 'Rep'), hdr('calls', 'Calls'), hdr('booked', 'Booked'), hdr('closes', 'Closes')),
        sorted.length ? sorted.map((r, i) => {
          const zero = !r[key];
          return h('div', { class: 'brow' + (r.me ? ' mine' : '') },
            h('span', { class: 'rk' }, !zero && i < 3 ? medal[i] : String(i + 1)),
            h('span', { class: 'nm' }, r.name, isAdmin && r.revenue_cents ? h('small', null, money(r.revenue_cents)) : null),
            h('span', { class: 'n' + (key === 'calls' ? ' on' : '') }, r.calls), h('span', { class: 'n' + (key === 'booked' ? ' on' : '') }, r.booked), h('span', { class: 'n' + (key === 'closes' ? ' on' : '') }, r.closes));
        }) : h('p', { class: 'dim', style: 'padding:10px 0' }, 'Add reps under Team to start the leaderboard.'),
        h('p', { class: 'dim', style: 'font-size:12px;margin-top:10px' }, 'Tap a column to rank by it.')));
    return box;
  }

  function pipeline(P, isAdmin) {
    const go = (status) => () => { Object.assign(S.leadFilters, { status, rep: '', batch: '', city: '', q: '' }); location.hash = '#/leads'; };
    const items = [['Need demo', P.need_demo, 'demo_needed', 's-demo_needed'], ['Demo ready', P.demo_ready, 'demo_ready', 's-demo_ready'], ['Called', P.called, 'called', 's-called'],
      ['Callbacks', P.callback, 'callback', 's-callback'], ['Booked', P.booked, 'booked', 's-booked'], ['Closed won', P.won, 'won', 's-won']];
    return h('div', { class: 'section' }, h('span', { class: 'eyebrow' }, isAdmin ? 'Pipeline right now' : 'Your pipeline'),
      h('div', { class: 'stats pipe' }, items.map(([l, v, st, cls]) => h('button', { class: 'stat', onclick: go(st) }, h('b', null, v || 0), h('small', null, h('span', { class: 'dot ' + cls }), l)))));
  }

  /* ================= deals + commissions ================= */
  function dealCard(d, onEdit) {
    const isAdmin = S.me.role === 'admin';
    const el = h(onEdit ? 'button' : 'div', { class: 'deal', type: onEdit ? 'button' : null, onclick: onEdit || null },
      h('div', { class: 'body' },
        h('div', { class: 'name' }, d.business || 'Lead #' + d.lead_id),
        h('div', { class: 'meta' }, [isAdmin ? d.rep_name || 'No rep' : null, d.package, fmt(d.created_at, { month: 'short', day: 'numeric', year: 'numeric' })].filter(Boolean).join(' · ')),
        h('div', { class: 'tags' },
          h('span', { class: 'tag' }, money(d.amount_cents) + ' deal'),
          d.mrr_cents ? h('span', { class: 'tag good' }, money(d.mrr_cents) + '/mo') : null,
          h('span', { class: 'tag' }, pctTxt(d.commission_pct)),
          d.paid ? h('span', { class: 'tag good' }, '✓ Paid ' + fmt(d.paid_at, { month: 'short', day: 'numeric' })) : h('span', { class: 'tag hot' }, 'Unpaid'))),
      h('div', { class: 'amt' }, h('b', null, money(d.commission_cents)), h('small', null, 'commission')));
    return el;
  }

  // Create (no deal) or edit (deal) — returns true if something was saved
  async function dealSheet({ lead, deal }) {
    const [settings, users] = await Promise.all([api('GET', '/settings'), api('GET', '/users')]);
    const reps = users.filter((u) => u.role !== 'dev' && (u.active || (deal && u.id === deal.rep_id) || u.id === lead.assigned_to));
    const pctFor = (id) => { const u = reps.find((r) => r.id === +id); return u ? (u.commission_pct ?? settings.default_commission_pct) : 0; };
    return sheet((box, close) => {
      const pkg = h('select', null, h('option', { value: '' }, 'Pick a package (optional)'), settings.packages.map((p) => h('option', { value: p.name }, p.name + (p.amount ? ' · $' + p.amount.toLocaleString() : ''))));
      const amount = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0', value: deal ? String(deal.amount_cents / 100) : '' });
      const mrr = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0', value: deal && deal.mrr_cents ? String(deal.mrr_cents / 100) : '' });
      const repSel = h('select', null, h('option', { value: '' }, 'No rep (no commission)'), reps.map((r) => h('option', { value: r.id }, r.name + (r.active ? '' : ' (off)'))));
      repSel.value = String(deal ? deal.rep_id || '' : lead.assigned_to || '');
      const pct = h('input', { type: 'number', inputmode: 'decimal', min: 0, max: 100, step: '0.5', value: deal ? deal.commission_pct : pctFor(repSel.value) });
      let pctTouched = !!deal;
      const note = h('textarea', { placeholder: 'Anything to remember: monthly plan, start date, upsells…' }); note.value = deal ? deal.note || '' : '';
      const paid = h('input', { type: 'checkbox', checked: deal ? !!deal.paid : false });
      const calc = h('div', { class: 'calc' });
      if (deal && deal.package) { if (![...pkg.options].some((o) => o.value === deal.package)) pkg.append(h('option', { value: deal.package }, deal.package)); pkg.value = deal.package; }
      const update = () => {
        const a = parseFloat(String(amount.value).replace(/[$,\s]/g, '')) || 0, p = repSel.value ? parseFloat(pct.value) || 0 : 0;
        calc.replaceChildren(h('span', null, repSel.value ? 'Rep commission' : 'No rep selected'), h('b', null, money(Math.round(a * p))));
      };
      pkg.addEventListener('change', () => { const p = settings.packages.find((x) => x.name === pkg.value); if (p && p.amount && (!amount.value || !deal)) amount.value = String(p.amount); update(); });
      amount.addEventListener('input', update);
      pct.addEventListener('input', () => { pctTouched = true; update(); });
      repSel.addEventListener('change', () => { if (!pctTouched) pct.value = pctFor(repSel.value); pct.disabled = !repSel.value; update(); });
      pct.disabled = !repSel.value;
      update();
      const err = h('p', { class: 'err-line' });
      const saveBtn = h('button', { class: 'btn ok' }, deal ? 'Save' : 'Close it 💰');
      saveBtn.onclick = async () => {
        err.textContent = '';
        if (!String(amount.value).trim()) { err.textContent = 'Enter the deal amount'; return; }
        const payload = { amount: amount.value, rep_id: repSel.value ? +repSel.value : null, commission_pct: repSel.value ? pct.value : 0, package: pkg.value, note: note.value, paid: paid.checked, mrr: mrr.value };
        saveBtn.disabled = true;
        try {
          if (deal) await api('PATCH', '/deals/' + deal.id, payload);
          else await api('POST', '/deals', Object.assign({ lead_id: lead.id }, payload));
          toast(deal ? 'Deal updated' : 'Closed won 💰'); close(true);
        } catch (e) { err.textContent = e.message; saveBtn.disabled = false; }
      };
      box.append(
        h('h2', null, deal ? 'Edit deal' : 'Close the deal'), h('p', { class: 'sub' }, lead.business || deal.business || ''),
        h('div', { class: 'field' }, h('label', null, 'Package'), pkg),
        h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', null, 'Setup fee ($)'), amount), h('div', { class: 'field' }, h('label', null, 'Monthly ($/mo, MRR)'), mrr)),
        h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', null, 'Rep'), repSel), h('div', { class: 'field' }, h('label', null, 'Commission %'), pct)),
        calc,
        h('label', { class: 'check' }, paid, h('span', null, 'Commission already paid')),
        h('div', { class: 'field' }, h('label', null, 'Note'), note),
        err,
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'), saveBtn),
        deal ? h('button', { class: 'btn danger block', style: 'margin-top:12px', onclick: async () => {
          if (!(await confirmSheet('Delete this deal?', 'Use this for refunds or mistakes. The lead stays Closed won — change its status on the lead page if needed.', 'Delete deal', true))) return;
          try { await api('DELETE', '/deals/' + deal.id); toast('Deal deleted'); close(true); } catch (e) { err.textContent = e.message; }
        } }, 'Delete deal') : null);
    });
  }

  async function viewDeals() {
    const [r, settings] = await Promise.all([api('GET', '/deals' + (S.dealsFilter ? '?paid=' + S.dealsFilter : '')), api('GET', '/settings')]);
    const again = () => viewDeals();
    const totalOwed = r.summary.reduce((a, s) => a + s.owed_cents, 0);
    const totalRev = r.summary.reduce((a, s) => a + s.revenue_cents, 0);

    const payRow = (s) => h('div', { class: 'list-row' },
      h('div', { style: 'min-width:0' }, h('b', null, s.rep_name || 'No rep'),
        h('div', { class: 'sub' }, s.deals + (s.deals === 1 ? ' deal' : ' deals') + ' · earned ' + money(s.earned_cents) + ' · paid ' + money(s.paid_cents))),
      s.owed_cents ? h('div', { class: 'row' }, h('b', { class: 'owe' }, money(s.owed_cents)),
        h('button', { class: 'btn small ok', onclick: async () => {
          if (!(await confirmSheet('Pay ' + (s.rep_name || 'no-rep deals') + '?', 'Marks ' + s.unpaid + (s.unpaid === 1 ? ' deal' : ' deals') + ' paid (' + money(s.owed_cents) + '). Do this after you send the money.', 'Mark paid', false))) return;
          try { await api('POST', '/deals/pay', { rep_id: s.rep_id }); toast('Marked paid'); again(); } catch (e) { fail(e); }
        } }, 'Mark paid')) : h('span', { class: 'tag good' }, 'All paid'));

    const leadRow = (l, label) => h('div', { class: 'list-row' },
      h('a', { href: '#/lead/' + l.id, style: 'min-width:0;color:inherit' }, h('b', null, l.business), h('div', { class: 'sub' }, [l.owner, l.rep_name || 'Unassigned', l.booked_at ? '📅 ' + fmt(l.booked_at) : null].filter(Boolean).join(' · '))),
      h('button', { class: 'btn small ok', onclick: async () => { if (await dealSheet({ lead: l })) again(); } }, label));

    const seg = h('div', { class: 'seg' }, [['0', 'Unpaid'], ['1', 'Paid'], ['', 'All']].map(([k, l]) =>
      h('button', { class: S.dealsFilter === k ? 'on' : null, onclick: () => { S.dealsFilter = k; again(); } }, l)));

    shell('deals', [
      h('div', { class: 'head' }, h('div', null, h('h1', null, 'Deals'), h('p', { class: 'sub' }, 'Closes and rep commissions.'))),
      h('div', { class: 'kpis two' },
        h('div', { class: 'kpi money' }, h('small', null, 'Commission owed'), h('b', null, money(totalOwed))),
        h('div', { class: 'kpi' }, h('small', null, 'Revenue closed (all time)'), h('b', null, money(totalRev)))),
      r.summary.length ? h('div', { class: 'section' }, h('span', { class: 'eyebrow' }, 'Payouts by rep'), h('div', { class: 'card' }, r.summary.map(payRow))) : null,
      r.toClose.length ? h('div', { class: 'section' }, h('span', { class: 'eyebrow' }, 'Booked · ready to close (' + r.toClose.length + ')'), h('div', { class: 'card' }, r.toClose.map((l) => leadRow(l, 'Close')))) : null,
      r.missing.length ? h('div', { class: 'section' }, h('span', { class: 'eyebrow' }, 'Closed won · no amount yet (' + r.missing.length + ')'), h('div', { class: 'card' }, r.missing.map((l) => leadRow(l, 'Add amount')))) : null,
      h('div', { class: 'section' }, h('span', { class: 'eyebrow' }, 'All deals'), seg,
        r.deals.length ? r.deals.map((d) => dealCard(d, async () => { if (await dealSheet({ lead: { id: d.lead_id, business: d.business, assigned_to: d.rep_id }, deal: d })) again(); }))
          : h('div', { class: 'card empty' }, h('b', null, S.dealsFilter === '0' ? 'Nothing unpaid' : 'No deals yet'), 'Close a booked lead to add one.')),
      h('div', { class: 'section card row', style: 'justify-content:space-between' },
        h('div', null, h('b', null, 'Default commission: ' + pctTxt(settings.default_commission_pct)), h('div', { class: 'sub' }, 'Used for reps without their own % (set that under Team).')),
        h('button', { class: 'btn small', onclick: async () => {
          const v = await sheet((box, close) => {
            const inp = h('input', { type: 'number', inputmode: 'decimal', min: 0, max: 100, step: '0.5', value: settings.default_commission_pct });
            box.append(h('h2', null, 'Default commission %'), h('p', { class: 'sub' }, 'Only changes new deals. Existing deals keep their %.'), h('div', { class: 'field' }, inp),
              h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => close(inp.value) }, 'Save')));
          });
          if (v === null || v === undefined) return;
          try { await api('PUT', '/settings', { default_commission_pct: v }); toast('Default set to ' + pctTxt(v)); again(); } catch (e) { fail(e); }
        } }, 'Change')),
    ]);
  }

  async function viewEarnings() {
    const r = await api('GET', '/deals');
    const s = r.summary[0] || { earned_cents: 0, paid_cents: 0, owed_cents: 0, deals: 0 };
    shell('earnings', [
      h('div', { class: 'head' }, h('div', null, h('h1', null, 'Earnings'), h('p', { class: 'sub' }, 'Commission from every deal you closed.'))),
      h('div', { class: 'kpis three' },
        h('div', { class: 'kpi money' }, h('small', null, 'Earned'), h('b', null, money(s.earned_cents))),
        h('div', { class: 'kpi' }, h('small', null, 'Paid to you'), h('b', null, money(s.paid_cents))),
        h('div', { class: 'kpi' }, h('small', null, 'Coming to you'), h('b', null, money(s.owed_cents)))),
      h('div', { class: 'section' }, h('span', { class: 'eyebrow' }, 'Your deals'),
        r.deals.length ? r.deals.map((d) => dealCard(d, null))
          : h('div', { class: 'card empty' }, h('b', null, 'No deals yet'), 'Book calls. When one closes, your commission shows up here.')),
    ]);
  }

  /* ================= admin "More" ================= */
  /* ================= dialer ================= */
  async function getDialer() {
    if (S.dialer && Date.now() - S.dialer.at < 300000) return S.dialer;
    try { S.dialer = { ...(await api('GET', '/dialer')), at: Date.now() }; } catch { S.dialer = { ready: false, at: Date.now() }; }
    return S.dialer;
  }
  const mmss = (n) => Math.floor((n || 0) / 60) + ':' + String((n || 0) % 60).padStart(2, '0');
  const CALL_STATUS = { completed: 'Answered', answered: 'Answered', busy: 'Busy', 'no-answer': 'No answer', failed: 'Failed', canceled: 'Hung up before answer', ringing: 'Calling…' };
  function dialRow(d) {
    return h('div', { class: 'dial-row' },
      h('div', { class: 'dial-top' }, h('b', null, CALL_STATUS[d.status] || d.status), h('span', null, [d.rep_name ? first(d.rep_name) : null, fmt(d.created_at), d.duration ? mmss(d.duration) : null].filter(Boolean).join(' · '))),
      d.has_recording || d.recording_seconds ? h('audio', { controls: true, preload: 'none', src: '/api/recordings/' + d.id + '/audio' }) : null);
  }
  let twilioLoading = null;
  function loadTwilio() {
    if (window.Twilio && window.Twilio.Device) return Promise.resolve();
    return twilioLoading || (twilioLoading = new Promise((res, rej) => { const sc = h('script', { src: '/vendor/twilio-voice-2.18.5.min.js' }); sc.onload = res; sc.onerror = () => { twilioLoading = null; rej(new Error('Could not load the dialer. Check your connection.')); }; document.head.append(sc); }));
  }
  let activeCall = null;
  async function startCall(L, after) {
    if (activeCall) return toast('You are already on a call', true);
    const bar = h('div', { class: 'callbar', role: 'region', 'aria-label': 'Call in progress' });
    const status = h('span', { class: 'cb-status' }, 'Connecting…');
    const timer = h('span', { class: 'cb-time' }, '');
    let call = null, device = null, t0 = 0, tick = null, muted = false;
    const muteBtn = h('button', { class: 'cbtn', disabled: true, onclick: () => { muted = !muted; call && call.mute(muted); muteBtn.textContent = muted ? 'Unmute' : 'Mute'; muteBtn.classList.toggle('on', muted); } }, 'Mute');
    const pad = h('div', { class: 'cb-pad', hidden: true }, '123456789*0#'.split('').map((k) => h('button', { class: 'cbtn', onclick: () => call && call.sendDigits(k) }, k)));
    const padBtn = h('button', { class: 'cbtn', disabled: true, onclick: () => { pad.hidden = !pad.hidden; } }, 'Keypad');
    const end = () => { try { call ? call.disconnect() : device && device.destroy(); } catch { /* */ } finish('Call ended'); };
    let finished = false;
    function finish(msg) {
      if (finished) return; finished = true;
      clearInterval(tick); bar.remove(); activeCall = null;
      try { device && device.destroy(); } catch { /* */ }
      toast(msg); if (after) setTimeout(after, 1500);
    }
    bar.append(h('div', { class: 'cb-main' }, h('span', { class: 'rec-dot', title: 'Recording' }), h('div', { class: 'cb-who' }, h('b', null, L.business), h('div', null, status, timer))),
      h('div', { class: 'cb-btns' }, muteBtn, padBtn, h('button', { class: 'cbtn end', onclick: end }, 'Hang up')), pad,
      h('div', { class: 'cb-note' }, 'This call is recorded. They hear a short recording notice when they pick up.'));
    document.body.append(bar); activeCall = bar;
    try {
      await loadTwilio();
      const { token } = await api('POST', '/dialer/token');
      device = new window.Twilio.Device(token, { codecPreferences: ['opus', 'pcmu'], logLevel: 'error' });
      call = await device.connect({ params: { To: L.phone, lead_id: String(L.id) } });
      status.textContent = 'Ringing…';
      call.on('accept', () => { status.textContent = 'Connected '; muteBtn.disabled = false; padBtn.disabled = false; t0 = Date.now(); tick = setInterval(() => (timer.textContent = mmss(Math.round((Date.now() - t0) / 1000))), 1000); });
      call.on('disconnect', () => finish('Call ended. Log how it went below.'));
      call.on('cancel', () => finish('Call canceled'));
      call.on('reject', () => finish('Call rejected'));
      call.on('error', (e) => finish('Call error: ' + (e && e.message ? e.message : 'something went wrong')));
    } catch (e) {
      finish(/permission|NotAllowed/i.test(String(e && e.message)) ? 'Allow microphone access to call from the CRM' : (e.message || 'Could not start the call'));
    }
  }

  /* ---- personal tracker (admin) ---- */
  const TRK_PLAN = [
    { id: 'pray', from: '06:00', to: '06:30', title: 'Prayer', tag: 'Spiritual win', win: true },
    { id: 'gym', from: '06:30', to: '07:15', title: 'Workout', tag: 'Physical win', win: true },
    { id: 'reset', from: '07:15', to: '07:45', title: 'Shower and eat' },
    { id: 'mind', from: '07:45', to: '08:15', title: 'Read or journal', tag: 'Mental win', win: true },
    { id: 'prep', from: '08:15', to: '09:00', title: "Load today's med spa list, read the offer, say the opener 10 times" },
    { id: 'c1', from: '09:00', to: '10:30', title: 'Call block 1: Med spas', quota: 67 },
    { id: 'rep', from: '10:30', to: '10:45', title: 'Answer every reply, call every positive reply' },
    { id: 'c2', from: '10:45', to: '12:15', title: 'Call block 2: Med spas', quota: 67 },
    { id: 'lunch', from: '12:15', to: '13:00', title: 'Lunch' },
    { id: 'c3', from: '13:00', to: '14:30', title: 'Call block 3: Med spas', quota: 66 },
    { id: 'brk', from: '14:30', to: '14:45', title: 'Break' },
    { id: 'aud', from: '14:45', to: '16:15', title: 'Audits and closing calls (write scopes between calls)' },
    { id: 'cont', from: '16:15', to: '17:00', title: 'Post content (Instagram, X, LinkedIn) and send DMs' },
    { id: 'close', from: '17:00', to: '18:00', title: "Scorecard, CRM, one referral ask, tomorrow's lists" },
  ];
  const trkMin = (t) => { const [a, b] = t.split(':').map(Number); return a * 60 + b; };
  const trk12 = (t) => { const [a, b] = t.split(':').map(Number); return ((a + 11) % 12 + 1) + ':' + String(b).padStart(2, '0') + (a >= 12 ? ' PM' : ' AM'); };
  function trkNowMin() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    return (+p.hour % 24) * 60 + +p.minute;
  }

  async function viewTracker() {
    const r = await api('GET', '/tracker');
    let goal = r.goal, day = r.day, streak = r.streak, saveT = null;
    const hist = r.history;
    const root = h('div', { class: 'trk' });
    const note = h('textarea', { class: 'trk-note', rows: 2, maxlength: 500, placeholder: 'One line on today: what worked, what to fix tomorrow', oninput: (e) => { day.note = e.target.value; queueSave(); } });
    note.value = day.note || '';
    const quotaOf = (b) => Math.round(b.quota * goal / 200);

    function expectedNow() {
      const now = trkNowMin();
      let e = 0;
      for (const b of TRK_PLAN) {
        if (!b.quota) continue;
        const a = trkMin(b.from), z = trkMin(b.to);
        if (now >= z) e += quotaOf(b); else if (now > a) e += quotaOf(b) * (now - a) / (z - a);
      }
      return Math.round(e);
    }
    function queueSave() {
      clearTimeout(saveT);
      saveT = setTimeout(async () => {
        try {
          const x = await api('PUT', '/tracker', { day: day.day, blocks: day.blocks, dials: day.dials, talks: day.talks, demos: day.demos, texts: day.texts, dms: day.dms, posts: day.posts, refs: day.refs, note: day.note });
          streak = x.streak;
          const i = hist.findIndex((z) => z.day === day.day);
          if (i >= 0) hist[i] = { ...hist[i], ...day, kept: x.kept };
          paint();
        } catch (e) { fail(e); }
      }, 350);
    }
    const bump = (field, n) => { day[field] = Math.max(0, Math.min(5000, day[field] + n)); const i = hist.findIndex((z) => z.day === day.day); if (i >= 0) hist[i][field] = day[field]; paint(); queueSave(); };
    const toggle = (id) => { day.blocks = day.blocks.includes(id) ? day.blocks.filter((x) => x !== id) : day.blocks.concat(id); const i = hist.findIndex((z) => z.day === day.day); if (i >= 0) hist[i].blocks = day.blocks; paint(); queueSave(); };

    function paint() {
      const wins = TRK_PLAN.filter((b) => b.win), winsDone = wins.filter((b) => day.blocks.includes(b.id)).length;
      const pct = Math.min(100, Math.round((day.dials / goal) * 100));
      const hit = day.dials >= goal, allWins = winsDone === wins.length;
      const exp = expectedNow(), diff = day.dials - exp, now = trkNowMin();
      const pace = hit ? 'Goal hit. ' + (day.dials - goal ? '+' + (day.dials - goal) + ' extra.' : '') :
        now < 540 ? 'Calling starts at 9:00 AM.' : diff >= 0 ? 'On pace. ' + (diff ? diff + ' ahead.' : '') : (-diff) + ' behind pace. Catch up in the next block.';
      const counter = (label, field, big) => h('div', { class: 'trk-ctr' + (big ? ' big' : '') },
        h('small', null, label), h('b', null, day[field].toLocaleString()),
        h('div', { class: 'trk-btns' },
          h('button', { class: 'trk-b', 'aria-label': 'Minus one ' + label, onclick: () => bump(field, -1) }, '−1'),
          big ? h('button', { class: 'trk-b', onclick: () => bump(field, 10) }, '+10') : null,
          h('button', { class: 'trk-b main', 'aria-label': 'Plus one ' + label, onclick: () => bump(field, 1) }, '+1')));
      const hero = h('section', { class: 'panel trk-hero' + (hit ? ' hit' : '') },
        h('div', { class: 'trk-top' }, h('div', null, h('small', null, 'Dials today'), h('div', { class: 'trk-num' }, h('b', null, day.dials.toLocaleString()), h('span', null, ' / ' + goal))),
          h('span', { class: 'trk-streak' + (streak ? ' on' : '') }, icon('flag'), streak + (streak === 1 ? '-day streak' : '-day streak'))),
        h('div', { class: 'goal-track trk-track' }, h('i', { style: 'width:' + pct + '%' })),
        h('p', { class: 'trk-pace' + (!hit && now >= 540 && diff < 0 ? ' bad' : '') }, pace),
        h('div', { class: 'trk-btns big' },
          h('button', { class: 'trk-b', onclick: () => bump('dials', -1) }, '−1'),
          h('button', { class: 'trk-b', onclick: () => bump('dials', 10) }, '+10'),
          h('button', { class: 'trk-b main', onclick: () => bump('dials', 1) }, '+1 dial')));
      const small = h('div', { class: 'trk-two' }, counter('Pick-ups', 'talks'), counter('Audits booked', 'demos'));
      const crm = h('p', { class: 'trk-crm' }, 'CRM today: ' + r.crm.logged + ' calls logged, ' + r.crm.booked + ' booked. Every outcome you log on a lead adds to your dials, pick-ups and audits automatically, so only tap +1 for calls you did not log.');
      const outreach = h('div', { class: 'trk-two four' }, counter('Texts sent', 'texts'), counter('DMs sent', 'dms'), counter('Posts published', 'posts'), counter('Referral asks', 'refs'));
      const winRow = h('div', { class: 'trk-wins' }, wins.map((b) => {
        const on = day.blocks.includes(b.id);
        return h('button', { class: 'trk-win' + (on ? ' on' : ''), onclick: () => toggle(b.id), 'aria-pressed': on }, h('small', null, b.tag.replace(' win', '')), h('b', null, on ? 'Done' : b.title));
      }));
      const list = h('div', { class: 'trk-list' }, TRK_PLAN.map((b) => {
        const on = day.blocks.includes(b.id), a = trkMin(b.from), z = trkMin(b.to), cur = now >= a && now < z;
        return h('button', { class: 'trk-row' + (on ? ' done' : '') + (cur ? ' now' : '') + (!on && now >= z ? ' late' : ''), onclick: () => toggle(b.id), 'aria-pressed': on },
          h('span', { class: 'trk-box' }, on ? '✓' : ''),
          h('div', { class: 'trk-what' }, h('b', null, b.title), h('small', null, trk12(b.from) + ' to ' + trk12(b.to) + (b.tag ? ' · ' + b.tag : '') + (b.quota ? ' · ' + quotaOf(b) + ' dials' : ''))),
          cur ? h('span', { class: 'trk-now' }, 'Now') : null);
      }));
      const bars = h('div', { class: 'trk-hist' }, hist.map((d) => {
        const p = Math.min(100, Math.round((d.dials / goal) * 100)), dn = ['S', 'M', 'T', 'W', 'T', 'F', 'S'][new Date(d.day + 'T12:00:00').getDay()];
        const w = TRK_PLAN.filter((b) => b.win && d.blocks.includes(b.id)).length;
        return h('div', { class: 'trk-col' + (d.kept ? ' kept' : '') + (d.off ? ' off' : '') + (d.day === day.day ? ' today' : ''), title: d.day + ': ' + d.dials + ' dials, ' + w + '/3 wins' },
          h('div', { class: 'trk-bar' }, h('i', { style: 'height:' + Math.max(d.dials ? 6 : 0, p) + '%' })),
          h('span', { class: 'trk-dots' }, [0, 1, 2].map((i) => h('i', { class: i < w ? 'on' : '' }))), h('small', null, dn));
      }));
      const goalBox = h('details', { class: 'trk-goal' }, h('summary', null, 'Daily dial goal: ' + goal),
        h('div', { class: 'trk-goal-row' },
          h('input', { type: 'number', min: 1, max: 2000, value: goal, id: 'trk-goal-in', 'aria-label': 'Daily dial goal' }),
          h('button', { class: 'btn small', onclick: async () => {
            try { const g = await api('PUT', '/tracker/goal', { goal: document.getElementById('trk-goal-in').value }); goal = g.goal; toast('Goal saved'); paint(); } catch (e) { fail(e); }
          } }, 'Save')));
      root.replaceChildren(
        hero, small, crm,
        h('h3', { class: 'trk-h' }, 'Outreach and content', h('span', { class: 'dim small' }, 'feeds your Home charts')), outreach,
        h('h3', { class: 'trk-h' }, 'Daily wins', h('span', { class: 'dim small' }, winsDone + ' of 3' + (allWins ? '' : ''))), winRow,
        h('h3', { class: 'trk-h' }, 'The day, 6 AM to 6 PM'), list,
        h('h3', { class: 'trk-h' }, 'Last 14 days'), bars,
        h('p', { class: 'trk-rule' }, 'A day counts when you finish all 3 wins and hit the dial goal. Sundays are your day off and never break the streak.'),
        h('h3', { class: 'trk-h' }, 'Note'), note, goalBox);
    }
    paint();
    shell('tracker', [
      h('div', { class: 'head' }, h('div', null, h('h1', null, 'Daily tracker'),
        h('p', { class: 'sub' }, new Date(r.today + 'T12:00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) + '. Inputs drive outputs.'))),
      root,
    ]);
  }

  async function viewRecordings() {
    const isAdmin = S.me.role === 'admin';
    const [r, opts] = await Promise.all([api('GET', '/recordings' + (S.recRep ? '?rep=' + S.recRep : '')), isAdmin ? getOptions() : null]);
    const repSel = isAdmin ? h('select', { class: 'inline-sel', 'aria-label': 'Filter by rep', onchange: (e) => { S.recRep = e.target.value; viewRecordings(); } },
      h('option', { value: '' }, 'Everyone'), opts.reps.map((x) => h('option', { value: x.id, selected: String(x.id) === String(S.recRep || '') }, x.name))) : null;
    const setup = !r.ready ? panel('Turn on calling from the CRM', null, h('ol', { class: 'steps-list' },
      h('li', null, 'Sign up at ', h('b', null, 'twilio.com'), ', add a card, and buy a US phone number with Voice (about $1.15 a month). Calls cost about 1–2¢ a minute.'),
      h('li', null, 'In Twilio, go to ', h('b', null, 'Voice → TwiML Apps → Create'), '. Name it "Reekon CRM". Set the Voice Request URL to ', h('code', null, location.origin + '/voice/twiml'), ' (HTTP POST). Save and copy its SID (starts with AP).'),
      h('li', null, 'Go to ', h('b', null, 'Account → API keys → Create API key'), ' (Standard). Copy the SID (starts with SK) and the Secret. The secret is only shown once.'),
      h('li', null, 'In Cloudflare, open your portal worker → ', h('b', null, 'Settings → Variables and Secrets'), ' and add these as Secrets: ',
        h('code', null, 'TWILIO_ACCOUNT_SID'), ', ', h('code', null, 'TWILIO_AUTH_TOKEN'), ' (both on your Twilio home page), ', h('code', null, 'TWILIO_API_KEY'), ', ', h('code', null, 'TWILIO_API_SECRET'), ', ',
        h('code', null, 'TWILIO_TWIML_APP_SID'), ', and ', h('code', null, 'TWILIO_NUMBER'), ' like +13105550100. Deploy.'),
      h('li', null, 'Refresh. The Call button on every lead now calls from the CRM and records.')),
      h('p', { class: 'sub' }, 'California needs everyone on a call to agree to recording. The dialer plays "this call may be recorded" to the person who picks up, before you are connected.')) : null;
    const list = r.recordings.length ? h('div', { class: 'card' }, r.recordings.map((d) => h('div', { class: 'dial-row' },
      h('div', { class: 'dial-top' }, h('a', { href: '#/lead/' + d.lead_id }, h('b', null, d.business || d.to_number)),
        h('span', null, [isAdmin && d.rep_name ? first(d.rep_name) : null, fmt(d.created_at), mmss(d.recording_seconds || d.duration)].filter(Boolean).join(' · '))),
      d.lead_status ? h('div', { style: 'margin:2px 0 6px' }, pill(d.lead_status)) : null,
      h('audio', { controls: true, preload: 'none', src: '/api/recordings/' + d.id + '/audio' }))))
      : h('div', { class: 'card empty' }, h('b', null, 'No recordings yet'), r.ready ? 'Call a lead from the CRM and the recording shows up here a minute after you hang up.' : 'Set up calling below to start recording.');
    shell('recordings', [
      h('div', { class: 'head' }, h('div', null, h('h1', null, 'Call recordings'), h('p', { class: 'sub' }, 'Listen back to calls to sharpen the script. Booked calls are the ones to study.')), repSel),
      setup ? setup : null, list,
    ]);
  }

  /* ================= email bot ================= */
  const BOT_KIND = { sent: 'Sent', replied: 'Replied 🔥', opted_out: 'Opted out', bounced: 'Bounced', failed: 'Failed to send', stopped: 'Stopped' };
  const STEP_NAME = (i) => (i === 0 ? 'First email' : 'Follow-up ' + i);
  const DAY_NAME = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };
  const hourTxt = (n) => (n === 0 || n === 24 ? '12 AM' : n === 12 ? '12 PM' : n < 12 ? n + ' AM' : (n - 12) + ' PM');
  function botScript(portal, key) {
    return `// Reekon email bot. Runs on your Gmail every 30 minutes.
// The CRM decides who gets emailed and what it says. This just sends it.
const PORTAL = '${portal}';
const KEY = '${key}';

// Run this once. It turns the bot on.
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('run').timeBased().everyMinutes(30).create();
  PropertiesService.getScriptProperties().setProperty('since', String(Date.now() - 2 * 864e5));
  run();
}

// Run this to check the connection. It emails you a test.
function sendTestToMyself() {
  var t = api('get', '/today');
  if (!t) throw new Error('Could not reach your CRM. Check PORTAL and KEY at the top.');
  var me = Session.getActiveUser().getEmail();
  GmailApp.sendEmail(me, 'Your Reekon email bot is connected', 'It works. Bot status in the CRM: ' + (t.enabled ? 'running' : 'paused') + (t.reason ? ' (' + t.reason + ')' : '') + '.');
  Logger.log('Connected. Test email sent to ' + me);
}

function run() {
  try { checkInbox(); } catch (e) { console.error('inbox', e); }
  sendDue();
}

function sendDue() {
  var t = api('get', '/today');
  if (!t || !t.messages || !t.messages.length) return;
  for (var i = 0; i < t.messages.length; i++) {
    var m = t.messages[i], item = { lead_id: m.lead_id, step: m.step, subject: m.subject, ok: true };
    try { GmailApp.sendEmail(m.to, m.subject, m.body, { name: t.from_name }); }
    catch (e) { item.ok = false; item.error = String(e.message || e); }
    api('post', '/done', { items: [item] });
    if (!item.ok && /limit|quota/i.test(item.error)) break;
    if (i < t.messages.length - 1) Utilities.sleep(15000 + Math.floor(Math.random() * 20000));
  }
}

function checkInbox() {
  var props = PropertiesService.getScriptProperties();
  var since = Number(props.getProperty('since') || (Date.now() - 2 * 864e5));
  var me = Session.getActiveUser().getEmail().toLowerCase();
  var threads = GmailApp.search('in:inbox newer_than:3d (subject:re OR from:mailer-daemon OR from:postmaster)', 0, 100);
  var out = [], newest = since;
  threads.forEach(function (th) {
    th.getMessages().forEach(function (msg) {
      var at = msg.getDate().getTime();
      if (at <= since) return;
      newest = Math.max(newest, at);
      var raw = msg.getFrom(), from = ((raw.match(/<([^>]+)>/) || [])[1] || raw).trim().toLowerCase();
      if (from === me) return;
      var body = msg.getPlainBody() || '';
      if (/mailer-daemon|postmaster/.test(from)) {
        var found = (body.match(/[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+/g) || []).filter(function (e) { e = e.toLowerCase(); return e !== me && !/mailer-daemon|postmaster|google\\.com|googlemail/.test(e); });
        if (found.length) out.push({ bounce: true, bounce_for: found[0] });
        return;
      }
      out.push({ from: from, subject: msg.getSubject(), snippet: body.split(/\\n\\s*On .+wrote:/)[0].slice(0, 600) });
    });
  });
  if (out.length) api('post', '/inbox', { messages: out.slice(0, 100) });
  props.setProperty('since', String(newest));
}

function api(method, path, body) {
  var opts = { method: method, contentType: 'application/json', headers: { Authorization: 'Bearer ' + KEY }, muteHttpExceptions: true };
  if (body) opts.payload = JSON.stringify(body);
  var r = UrlFetchApp.fetch(PORTAL + '/api/outreach' + path, opts);
  if (r.getResponseCode() >= 300) { console.error(path + ' ' + r.getResponseCode() + ' ' + r.getContentText()); return null; }
  return JSON.parse(r.getContentText() || '{}');
}
`;
  }

  async function viewEmailBot() {
    const d = await api('GET', '/emailbot');
    const cfg = JSON.parse(JSON.stringify(d.config));
    const again = () => viewEmailBot();
    const copy = async (text, msg) => { try { await navigator.clipboard.writeText(text); toast(msg || 'Copied'); } catch { prompt('Copy this:', text); } };
    const seenRecently = d.last_seen && Date.now() - new Date(d.last_seen) < 2 * 3600e3;
    const state = !d.key ? ['off', 'Not connected', 'Connect your Gmail below to start'] : !seenRecently ? ['warn', 'Not checking in', d.last_seen ? 'Last heard from ' + ago(d.last_seen) + '. Run setup again in Google Apps Script.' : 'Run setup in Google Apps Script to finish connecting.']
      : cfg.enabled ? ['on', 'Running', 'Sends ' + cfg.days.map((x) => DAY_NAME[x]).join(', ') + ', ' + hourTxt(cfg.start_hour) + '–' + hourTxt(cfg.end_hour) + ' (LA time)'] : ['paused', 'Paused', 'Nothing goes out until you start it'];
    const S2 = d.stats;
    let dirty = false;
    const saveBtn = h('button', { class: 'btn primary', disabled: true, onclick: () => save() }, 'Save changes');
    const saveBar = h('div', { class: 'save-bar', hidden: true }, h('span', null, 'Unsaved changes'), saveBtn);
    const touch = () => { dirty = true; saveBtn.disabled = false; saveBar.hidden = false; schedulePreview(); };
    async function save(extra) {
      try {
        const r = await api('PUT', '/emailbot', { ...cfg, ...(extra || {}) });
        Object.assign(cfg, r.config); dirty = false; saveBtn.disabled = true; saveBar.hidden = true; toast('Saved');
        return true;
      } catch (e) { fail(e); return false; }
    }
    const toggle = h('button', { class: 'btn ' + (cfg.enabled ? '' : 'primary'), onclick: async () => {
      if (!cfg.enabled && !cfg.address.trim()) { toast('Add your mailing address in Schedule first. The law requires it on cold emails.', true); return; }
      if (await save({ enabled: !cfg.enabled })) again();
    } }, cfg.enabled ? 'Pause bot' : 'Start bot');

    // ---- emails (sequence) ----
    let lastField = null;
    const TAGS = [['{first_name}', 'Owner first name'], ['{business}', 'Business'], ['{city}', 'City'], ['{category}', 'Type of business'], ['{demo_link}', 'Their demo link'], ['{my_name}', 'Your name']];
    const chips = h('div', { class: 'chips' }, h('small', null, 'Tap to insert:'), TAGS.map(([t, l]) => h('button', { class: 'chip', type: 'button', title: l, onmousedown: (e) => e.preventDefault(), onclick: () => {
      const f = lastField; if (!f) return toast('Tap into an email first', true);
      const a = f.selectionStart, b = f.selectionEnd; f.value = f.value.slice(0, a) + t + f.value.slice(b); f.selectionStart = f.selectionEnd = a + t.length; f.focus(); f.dispatchEvent(new Event('input'));
    } }, t)));
    const stepsBox = h('div', { class: 'steps' });
    const previews = [];
    function drawSteps() {
      previews.length = 0;
      stepsBox.replaceChildren(...cfg.steps.map((st, i) => {
        const subj = h('input', { id: 'bot-subj-' + i, value: st.subject, maxlength: 150, onfocus: (e) => (lastField = e.target), oninput: (e) => { st.subject = e.target.value; touch(); } });
        const body = h('textarea', { id: 'bot-body-' + i, rows: 8, onfocus: (e) => (lastField = e.target), oninput: (e) => { st.body = e.target.value; touch(); } }); body.value = st.body;
        const wait = i ? h('input', { id: 'bot-wait-' + i, type: 'number', min: 1, max: 30, inputmode: 'numeric', value: st.wait_days, style: 'width:72px', oninput: (e) => { st.wait_days = +e.target.value || 1; touch(); } }) : null;
        const prev = h('pre', { class: 'mail-preview' }, 'Loading preview…'); previews.push(prev);
        return h('div', { class: 'card step-card' },
          h('div', { class: 'step-top' }, h('b', null, STEP_NAME(i)),
            i ? h('label', { class: 'wait' }, 'Send ', wait, ' days after the last one, if no reply') : h('span', { class: 'sub' }, 'Goes out first'),
            i && i === cfg.steps.length - 1 ? h('button', { class: 'linkish', type: 'button', onclick: () => { cfg.steps.pop(); drawSteps(); touch(); } }, 'Remove') : null),
          h('div', { class: 'field' }, h('label', { for: 'bot-subj-' + i }, 'Subject'), subj),
          h('div', { class: 'field' }, h('label', { for: 'bot-body-' + i }, 'Message'), body),
          h('details', { class: 'prev-wrap' }, h('summary', null, 'Preview'), prev));
      }), cfg.steps.length < 5 ? h('button', { class: 'btn small', type: 'button', onclick: () => { cfg.steps.push({ wait_days: 4, subject: 'Re: ' + (cfg.steps[0].subject || ''), body: 'Hey {first_name}, ' }); drawSteps(); touch(); } }, '+ Add a follow-up') : null);
      schedulePreview(true);
    }
    let pvTimer, noDemo = false;
    const demoSeg = h('div', { class: 'seg compact' }, [['with', 'Lead has a demo'], ['without', 'No demo yet']].map(([k, l]) => h('button', { type: 'button', class: k === 'with' ? 'on' : null, onclick: (e) => {
      noDemo = k === 'without'; demoSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); schedulePreview(true); } }, l)));
    function schedulePreview(now) {
      clearTimeout(pvTimer);
      pvTimer = setTimeout(async () => {
        try {
          const r = await api('POST', '/emailbot/preview', { steps: cfg.steps, from_name: cfg.from_name, company: cfg.company, address: cfg.address || '(your mailing address)', no_demo: noDemo });
          r.emails.forEach((e, i) => { if (previews[i]) previews[i].textContent = 'To: ' + 'owner@kingscutz.com' + '\nSubject: ' + e.subject + '\n\n' + e.body; });
        } catch (e) { previews.forEach((p) => (p.textContent = e.message)); }
      }, now ? 0 : 600);
    }

    // ---- schedule ----
    const dayBtns = h('div', { class: 'daypick' }, Object.entries(DAY_NAME).map(([k, l]) => h('button', { type: 'button', class: cfg.days.includes(k) ? 'on' : null, 'aria-pressed': String(cfg.days.includes(k)), onclick: (e) => {
      const on = cfg.days.includes(k); cfg.days = on ? cfg.days.filter((x) => x !== k) : [...cfg.days, k];
      e.currentTarget.classList.toggle('on', !on); e.currentTarget.setAttribute('aria-pressed', String(!on)); touch(); } }, l)));
    const hourSel = (id, val, lo, hi, key) => h('select', { id, onchange: (e) => { cfg[key] = +e.target.value; touch(); } },
      Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).map((n) => h('option', { value: n, selected: n === val }, hourTxt(n))));
    const inp = (id, key, attrs) => h('input', { id, value: cfg[key] || '', ...attrs, oninput: (e) => { cfg[key] = e.target.value; touch(); } });

    const tiles = h('div', { class: 'kpi-grid' },
      kpiTile('mail', 'Sent today', S2.today + ' / ' + cfg.daily_cap, S2.week + ' this week'),
      kpiTile('leads', 'Ready to email', S2.ready.toLocaleString(), S2.no_email ? S2.no_email + ' leads have no email' : 'have an email, never contacted'),
      kpiTile('callbacks', 'In follow-ups', S2.in_sequence.toLocaleString(), 'waiting on the next email'),
      kpiTile('flag', 'Replies', S2.replied.toLocaleString(), S2.contacted ? Math.round((S2.replied / S2.contacted) * 1000) / 10 + '% of ' + S2.contacted + ' emailed' : 'none yet', { href: '#/leads', cls: S2.replied ? 'money' : '' }),
      kpiTile('account', 'Opted out', S2.opted_out.toLocaleString(), 'never emailed again'),
      kpiTile('script', 'Bounced', S2.bounced.toLocaleString(), 'bad addresses'));
    tiles.lastChild.previousSibling.previousSibling.addEventListener('click', () => Object.assign(S.leadFilters, { status: 'all', rep: '', batch: '', city: '', q: '', heat: '', contact: '', tag: 'replied', due: '', source: '' }));

    const next = d.next.length ? d.next.map((n) => h('a', { class: 'list-row link', href: '#/lead/' + n.id },
      h('div', { style: 'flex:1;min-width:0' }, h('b', null, n.business), h('div', { class: 'sub ellip' }, n.email)),
      h('div', { class: 'row', style: 'gap:6px;flex:none' }, n.queued ? h('span', { class: 'tag hot' }, 'Queued') : null, n.has_demo ? h('span', { class: 'tag good' }, 'Demo') : null, h('span', { class: 'tag' }, STEP_NAME(n.step)))))
      : [h('div', { class: 'empty' }, h('b', null, 'Nobody to email right now'), 'Add leads with email addresses from Lead Finder, an upload, or your scraper.')];

    const log = d.log.length ? d.log.map((e) => h(e.lead_id ? 'a' : 'div', { class: 'list-row' + (e.lead_id ? ' link' : ''), href: e.lead_id ? '#/lead/' + e.lead_id : null },
      h('div', { style: 'flex:1;min-width:0' }, h('b', null, e.business || 'Lead'), h('div', { class: 'sub ellip' }, e.kind === 'sent' ? STEP_NAME((e.step || 1) - 1) + ' · ' + (e.subject || '') : (e.detail || e.subject || ''))),
      h('div', { style: 'text-align:right;flex:none' }, h('span', { class: 'tag' + (e.kind === 'replied' ? ' hot' : e.kind === 'sent' ? ' good' : '') }, BOT_KIND[e.kind] || e.kind), h('div', { class: 'sub' }, ago(e.created_at)))))
      : [h('div', { class: 'empty' }, h('b', null, 'No activity yet'), 'Sends, replies and bounces show up here.')];

    const connect = async () => {
      if (d.key && !(await confirmSheet('Get new bot code?', 'This makes a new key and turns off the old one. Paste the new code into Google Apps Script right after, or the bot stops.', 'Get new code'))) return;
      let r; try { r = await api('POST', '/emailbot/key'); } catch (e) { return fail(e); }
      const code = botScript(r.portal, r.key);
      await sheet((box, close) => box.append(h('h2', null, 'Your bot code'),
        h('p', { class: 'sub' }, 'This is the only time the key is shown. Copy it now and paste it into Google Apps Script.'),
        h('div', { class: 'code' }, h('pre', null, code), h('button', { class: 'btn small primary', onclick: () => copy(code, 'Bot code copied') }, icon('copy'), 'Copy code')),
        h('button', { class: 'btn block', style: 'margin-top:12px', onclick: () => { close(); again(); } }, 'Done')));
    };

    drawSteps();
    shell('emailbot', [
      h('div', { class: 'head' }, h('div', null, h('h1', null, 'Email bot'), h('p', { class: 'sub' }, 'Cold emails and follow-ups from your Gmail. Stops the moment someone replies.')),
        h('div', { class: 'row' }, toggle)),
      h('div', { class: 'bot-state ' + state[0] }, h('i'), h('div', null, h('b', null, state[1]), h('div', { class: 'sub' }, state[2]))),
      tiles,
      h('div', { class: 'bot-cols' },
        h('div', { class: 'bot-main' },
          panel('Emails', null, h('div', { class: 'prev-pick' }, h('small', null, 'Preview as:'), demoSeg), chips, stepsBox),
          panel('Schedule & sender', null,
            h('div', { class: 'field' }, h('label', null, 'Days it sends'), dayBtns),
            h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', { for: 'bot-start' }, 'From'), hourSel('bot-start', cfg.start_hour, 0, 23, 'start_hour')),
              h('div', { class: 'field' }, h('label', { for: 'bot-end' }, 'Until (LA time)'), hourSel('bot-end', cfg.end_hour, 1, 24, 'end_hour'))),
            h('div', { class: 'field' }, h('label', { for: 'bot-cap' }, 'Most emails per day'), h('input', { id: 'bot-cap', type: 'number', min: 1, max: 90, inputmode: 'numeric', value: cfg.daily_cap, oninput: (e) => { cfg.daily_cap = +e.target.value || 1; touch(); } }),
              h('span', { class: 'hint' }, 'Start around 20 to 40. Gmail stops a regular account at 100 a day, and slow and steady keeps you out of spam.')),
            h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', { for: 'bot-from' }, 'Your name'), inp('bot-from', 'from_name', { maxlength: 60 })),
              h('div', { class: 'field' }, h('label', { for: 'bot-co' }, 'Company'), inp('bot-co', 'company', { maxlength: 80 }))),
            h('div', { class: 'field' }, h('label', { for: 'bot-addr' }, 'Mailing address'), inp('bot-addr', 'address', { maxlength: 200, placeholder: 'Street, city, state, ZIP or a P.O. box' }),
              h('span', { class: 'hint' }, 'US law (CAN-SPAM) requires a real mailing address on cold emails. A P.O. box works.'))),
          saveBar),
        h('div', { class: 'bot-side' },
          panel('Up next', h('span', { class: 'sub' }, 'Follow-ups go first'), h('div', { class: 'card' }, next)),
          panel('Activity', null, h('div', { class: 'card' }, log)),
          panel('Connect your Gmail', null, h('div', { class: 'card' },
            h('ol', { class: 'steps-list' },
              h('li', null, 'Tap ', h('b', null, d.key ? 'Get new bot code' : 'Get bot code'), ' and copy it.'),
              h('li', null, 'Go to ', h('b', null, 'script.google.com'), ' signed in as the Gmail you send from. New project, delete what is there, paste, Save.'),
              h('li', null, 'Pick ', h('b', null, 'sendTestToMyself'), ' at the top and Run. Allow access (Advanced → Go to project). Check your inbox.'),
              h('li', null, 'Pick ', h('b', null, 'setup'), ' and Run. Done, it checks in every 30 minutes.'),
              h('li', null, 'Used the first email robot? Delete that old project so leads are not emailed twice.')),
            h('button', { class: 'btn ' + (d.key ? '' : 'primary') + ' block', onclick: connect }, icon('bolt'), d.key ? 'Get new bot code' : 'Get bot code'),
            d.key ? h('div', { class: 'sub', style: 'margin-top:8px' }, 'Key ' + d.key.prefix + '… · ' + (d.key.last_used_at ? 'last used ' + ago(d.key.last_used_at) : 'never used yet')) : null)))),
    ]);
    window.addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); }, { once: true });
  }

  function viewMore() {
    const GROUPS = [
      ['Sell', [
        ['leads', 'Leads', 'Pipeline and every lead', 'leads'], ['callbacks', 'Callbacks', 'Who to call back', 'callbacks', 'cb'],
        ['calendar', 'Calendar', 'Audits, closings, meetings', 'calendar'], ['deals', 'Deals', 'Closes, payouts, commission', 'deals'],
        ['tracker', 'Daily tracker', 'Dials, wins, streak', 'flag'], ['rebrief', 'Daily brief', 'How today went', 'chart']]],
      ['Tools', [
        ['finder', 'Lead Finder', 'Find and auto-fill leads', 'search'], ['content', 'Content', 'Posts and demo videos', 'spark'],
        ['studio', 'Demo Studio', 'Build a demo site', 'spark'], ['demos', 'Demo queue', 'Demos to build and send', 'demos'],
        ['cards', 'Review cards', 'NFC plates stock and sales', 'deals'], ['script', 'Call script', 'What to say', 'script']]],
      ['Team', [
        ['users', 'Team', 'Reps, devs and logins', 'users'], ['upload', 'Upload leads', 'Add leads from a file', 'batches'],
        ['batches', 'Batches', 'Lead lists and who has them', 'batches'], ['recordings', 'Recordings', 'Call recordings', 'phone']]],
      ['System', [
        ['integrations', 'Integrations', 'Connections and API keys', 'bolt'], ['settings', 'Settings', 'Targets, theme, checklist', 'account'],
        ['account', 'Account', 'Password and log out', 'account']]],
    ];
    const search = h('input', { type: 'search', placeholder: 'Search pages', 'aria-label': 'Search pages', autocomplete: 'off' });
    const sections = GROUPS.map(([label, items]) => {
      const tiles = items.map(([href, title, sub, ic, badge]) => h('a', { class: 'hub-tile', href: '#/' + href, 'data-q': (title + ' ' + sub).toLowerCase() },
        h('span', { class: 'hub-ic' }, icon(ic)),
        badge ? h('span', { class: 'count cb-count', hidden: true }) : null,
        h('b', null, title), h('small', null, sub)));
      return h('section', { class: 'hub-sec' }, h('span', { class: 'eyebrow' }, label), h('div', { class: 'hub-grid' }, tiles));
    });
    const empty = h('p', { class: 'dim', hidden: true, style: 'text-align:center;margin-top:24px' }, 'No page matches that.');
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase(); let any = false;
      document.querySelectorAll('.hub-sec').forEach((sec) => {
        let n = 0;
        sec.querySelectorAll('.hub-tile').forEach((t) => { const show = !q || t.dataset.q.includes(q); t.hidden = !show; if (show) n++; });
        sec.hidden = !n; if (n) any = true;
      });
      empty.hidden = any;
    });
    shell('more', [
      h('a', { class: 'hub-me', href: '#/account' }, h('span', { class: 'avatar big' }, initials(S.me.name)),
        h('div', { style: 'min-width:0;flex:1' }, h('b', null, S.me.name), h('small', null, ROLE_NAME[S.me.role] || S.me.role)), icon('chev')),
      h('div', { class: 'hub-search' }, icon('search'), search),
      sections, empty,
    ]);
  }

  render();
})();
