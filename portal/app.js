/* Reekon Systems — Sales Portal (stage 2) */
(function () {
  'use strict';

  /* ================= basics ================= */
  const $app = document.getElementById('app');
  const S = { me: null, options: null, leadFilters: { status: 'open', rep: '', batch: '', city: '', q: '' }, selected: new Set(), selecting: false,
    script: null, period: 'today', boardSort: 'closes', dealsFilter: '0' };

  const STATUS = {
    new: 'New', demo_needed: 'Demo needed', demo_ready: 'Demo ready', called: 'Called', callback: 'Callback',
    booked: 'Booked', won: 'Closed won', lost: 'Closed lost', dnc: 'Do Not Call',
  };
  const OUTCOMES = [
    ['no_answer', 'No answer'], ['voicemail', 'Voicemail'], ['gatekeeper', 'Gatekeeper'], ['not_interested', 'Not interested'],
    ['callback', 'Callback'], ['demo_sent', 'Demo sent'], ['booked', 'Booked'], ['dnc', 'Do Not Call'],
  ];
  const OUTCOME_LABEL = Object.fromEntries(OUTCOMES.concat([['status_change', 'Status changed'], ['demo_ready', 'Demo marked ready'], ['closed_won', 'Deal closed']]));

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
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10.5L12 4l8 6.5V20"/><path d="M9.5 20v-5.5h5V20"/></svg>',
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
  function tabsFor(role) {
    if (role === 'admin') return [['home', 'Home'], ['leads', 'Leads'], ['callbacks', 'Callbacks'], ['demos', 'Demos'], ['deals', 'Deals'], ['more', 'More']];
    if (role === 'rep') return [['home', 'Home'], ['leads', 'My Leads'], ['callbacks', 'Callbacks'], ['earnings', 'Earnings'], ['account', 'Account']];
    return [['demos', 'Demo Queue'], ['account', 'Account']];
  }
  const home = () => (S.me.role === 'dev' ? 'demos' : 'home');
  const TAB_ICON = { earnings: 'deals' };
  // pages that live under the admin "More" tab
  const UNDER_MORE = ['batches', 'upload', 'users', 'script', 'account'];

  function shell(active, content) {
    const tabs = tabsFor(S.me.role);
    if (S.me.role === 'admin' && UNDER_MORE.includes(active)) active = 'more';
    const nav = h('nav', { class: 'tabs' + (tabs.length > 5 ? ' six' : ''), 'aria-label': 'Main' },
      tabs.map(([k, label]) => h('a', { href: '#/' + k, class: active === k ? 'on' : null }, icon(TAB_ICON[k] || k), h('span', null, label),
        k === 'callbacks' ? h('span', { class: 'count', id: 'cbCount', hidden: true }) : null)));
    const top = h('header', { class: 'top' },
      h('a', { href: '#/' + home(), class: 'logo' }, icon('logo'), h('span', null, 'Reekon ', h('em', null, 'Systems')), h('small', null, 'Sales')),
      h('a', { href: '#/account', class: 'me', title: S.me.name }, initials(S.me.name)));
    const main = h('main', { id: 'view' }, content);
    $app.replaceChildren(top, main, nav);
    if (S.me.role !== 'dev') refreshCallbackBadge();
    window.scrollTo(0, 0);
    return main;
  }

  async function refreshCallbackBadge() {
    try {
      const [from, until] = dayBounds();
      const list = await api('GET', '/callbacks?from=' + encodeURIComponent(from) + '&until=' + encodeURIComponent(until));
      const el = document.getElementById('cbCount');
      if (el) { el.textContent = list.length; el.hidden = !list.length; }
    } catch { /* ignore */ }
  }

  async function render() {
    if (!S.me) {
      try { S.me = await api('GET', '/me'); } catch { S.me = null; }
    }
    if (!S.me) return renderAuth();
    const [route, arg] = (location.hash.replace(/^#\/?/, '') || home()).split('/');
    const extra = { admin: ['account', 'lead', 'upload', 'batches', 'users', 'script'], rep: ['lead', 'script'], dev: ['lead'] }[S.me.role] || [];
    const allowed = tabsFor(S.me.role).map((t) => t[0]).concat(extra);
    if (!allowed.includes(route)) { location.hash = '#/' + home(); return; }
    try {
      switch (route) {
        case 'home': return await viewHome();
        case 'deals': return await viewDeals();
        case 'earnings': return await viewEarnings();
        case 'more': return viewMore();
        case 'script': return await viewScript();
        case 'leads': return await viewLeads();
        case 'lead': return await viewLead(+arg);
        case 'callbacks': return await viewCallbacks();
        case 'demos': return await viewDemos();
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

  async function viewLeads() {
    const isAdmin = S.me.role === 'admin';
    const opts = await getOptions(true);
    const F = S.leadFilters;
    const listEl = h('div');
    const countEl = h('p', { class: 'count-line' });
    const moreBtn = h('button', { class: 'btn block more', hidden: true }, 'Load more');
    let offset = 0;

    const sel = (key, first, items) => {
      const s = h('select', { class: F[key] && F[key] !== 'open' ? 'set' : null, onchange: () => { F[key] = s.value; s.className = s.value && s.value !== 'open' ? 'set' : ''; load(true); } },
        first.map(([v, l]) => h('option', { value: v }, l)), items.map(([v, l]) => h('option', { value: v }, l)));
      s.value = F[key]; return s;
    };
    const statusSel = sel('status', [['open', 'All open'], [isAdmin ? 'all' : '', isAdmin ? 'Everything (incl. DNC)' : 'All']], Object.entries(STATUS).filter(([k]) => isAdmin || k !== 'dnc'));
    const filters = h('div', { class: 'filters' }, statusSel,
      isAdmin ? sel('rep', [['', 'All reps'], ['none', 'Unassigned']], opts.reps.map((r) => [String(r.id), r.name + (r.active ? '' : ' (off)')])) : null,
      isAdmin ? sel('batch', [['', 'All batches']], opts.batches.map((b) => [String(b.id), b.name])) : null,
      sel('city', [['', 'All cities']], opts.cities.map((c) => [c, c])));

    let tmr;
    const search = h('div', { class: 'search' }, icon('search'),
      h('input', { type: 'search', placeholder: 'Search business, owner, phone…', value: F.q, oninput: (e) => { clearTimeout(tmr); tmr = setTimeout(() => { F.q = e.target.value; load(true); }, 300); } }));

    // admin bulk select
    const bulk = h('div', { class: 'bulk', hidden: true });
    const selectBtn = isAdmin ? h('button', { class: 'btn small', onclick: () => { S.selecting = !S.selecting; S.selected.clear(); selectBtn.textContent = S.selecting ? 'Done' : 'Select'; load(true); } }, S.selecting ? 'Done' : 'Select') : null;

    function renderBulk() {
      if (!isAdmin || !S.selecting || !S.selected.size) { bulk.hidden = true; return; }
      bulk.hidden = false;
      const repSel = h('select', null, h('option', { value: 'auto' }, 'Auto-assign (spread evenly)'), h('option', { value: 'none' }, 'Unassign'),
        opts.reps.filter((r) => r.active).map((r) => h('option', { value: r.id }, r.name)));
      bulk.replaceChildren(
        h('div', { class: 'row' }, h('b', null, S.selected.size + ' selected'), h('span', { style: 'flex:1' }),
          h('button', { class: 'btn small', onclick: async () => { try { await api('POST', '/leads/bulk', { ids: [...S.selected], action: 'demo_needed' }); toast('Sent to demo queue'); S.selected.clear(); load(true); } catch (e) { fail(e); } } }, 'Send to demos')),
        h('div', { class: 'row' }, repSel, h('button', { class: 'btn primary small', onclick: async () => {
          try { await api('POST', '/leads/bulk', { ids: [...S.selected], action: 'assign', rep: repSel.value }); toast('Assigned ' + S.selected.size + ' leads'); S.selected.clear(); load(true); } catch (e) { fail(e); }
        } }, 'Assign')));
    }

    async function load(reset) {
      if (reset) { offset = 0; listEl.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'spinner', style: 'margin:auto' }))); }
      const qs = new URLSearchParams({ limit: 50, offset });
      for (const k of ['status', 'rep', 'batch', 'city', 'q']) if (F[k]) qs.set(k, F[k]);
      if (F.status === '') qs.delete('status');
      try {
        const r = await api('GET', '/leads?' + qs);
        if (reset) listEl.replaceChildren();
        countEl.textContent = r.total + (r.total === 1 ? ' lead' : ' leads');
        if (!r.leads.length && reset) listEl.append(h('div', { class: 'empty' }, h('b', null, 'No leads here'), isAdmin ? 'Try other filters, or upload a batch.' : 'Nothing matches. New leads show up when your admin assigns them.'));
        r.leads.forEach((l) => listEl.append(leadCard(l)));
        offset += r.leads.length; moreBtn.hidden = !r.more;
        renderBulk();
      } catch (e) { fail(e); }
    }

    function leadCard(l) {
      const tags = [pill(l.status)];
      if (l.status === 'callback' && l.callback_at) tags.push(h('span', { class: 'tag hot' }, '↻ ' + fmt(l.callback_at)));
      if (l.status === 'booked' && l.booked_at) tags.push(h('span', { class: 'tag good' }, '📅 ' + fmt(l.booked_at)));
      tags.push(l.demo_url ? h('span', { class: 'tag good' }, 'Demo ✓') : h('span', { class: 'tag' }, 'No demo'));
      if (l.attempts) tags.push(h('span', { class: 'tag' }, l.attempts + (l.attempts === 1 ? ' call' : ' calls')));
      if (isAdmin) tags.push(h('span', { class: 'tag' }, l.rep_name || 'Unassigned'));
      const card = h('a', { class: 'lead', href: '#/lead/' + l.id },
        S.selecting ? h('input', { type: 'checkbox', checked: S.selected.has(l.id), onclick: (e) => { e.stopPropagation(); e.target.checked ? S.selected.add(l.id) : S.selected.delete(l.id); renderBulk(); } }) : null,
        h('div', { class: 'body' }, h('div', { class: 'name' }, l.business),
          h('div', { class: 'meta' }, [l.owner, l.city, l.category].filter(Boolean).join(' · ') || '—'),
          h('div', { class: 'tags' }, tags)),
        l.phone && !S.selecting ? h('a', { class: 'call-btn', href: telHref(l.phone), 'aria-label': 'Call ' + l.business, onclick: (e) => e.stopPropagation() }, icon('phone')) : null);
      if (S.selecting) card.addEventListener('click', (e) => { if (e.target.type !== 'checkbox') { e.preventDefault(); const cb = card.querySelector('input'); cb.checked = !cb.checked; cb.checked ? S.selected.add(l.id) : S.selected.delete(l.id); renderBulk(); } });
      return card;
    }

    moreBtn.onclick = () => load(false);
    shell('leads', [
      h('div', { class: 'head' }, h('div', null, h('h1', null, isAdmin ? 'Leads' : 'My leads'), h('p', { class: 'sub' }, isAdmin ? 'Every lead across all batches.' : 'Tap a lead to call and log the outcome.')),
        isAdmin ? h('div', { class: 'row' }, selectBtn, h('a', { class: 'btn small primary', href: '#/upload' }, 'Upload')) : null),
      search, filters, countEl, listEl, moreBtn, bulk,
    ]);
    load(true);
  }

  /* ================= lead detail ================= */
  async function viewLead(id) {
    const isAdmin = S.me.role === 'admin';
    const [{ lead: L, calls, notes, deals = [] }, script] = await Promise.all([api('GET', '/leads/' + id), S.me.role === 'dev' ? null : getScript()]);
    const reload = () => viewLead(id);
    const closed = ['won', 'lost', 'dnc'].includes(L.status);

    const smsBody = `Hi ${L.owner ? L.owner.split(' ')[0] : 'there'}, it's ${S.me.name.split(' ')[0]} with Reekon Systems. Here's the free website we built for ${L.business}: ${L.demo_url || ''}`;
    const actions = h('div', { class: 'actions' },
      L.phone ? h('a', { class: 'btn ok wide', href: telHref(L.phone) }, icon('phone'), 'Call ' + L.phone) : h('div', { class: 'btn wide', style: 'opacity:.5' }, 'No phone number'),
      L.demo_url && L.phone ? h('a', { class: 'btn primary', href: 'sms:' + String(L.phone).replace(/[^\d+]/g, '') + '?&body=' + encodeURIComponent(smsBody) }, icon('sms'), 'Text demo') : null,
      L.demo_url ? h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(L.demo_url); toast('Demo link copied'); } catch { prompt('Copy the demo link:', L.demo_url); } } }, icon('copy'), 'Copy link') : null,
      L.demo_url ? h('a', { class: 'btn', href: L.demo_url, target: '_blank', rel: 'noopener' }, icon('demos'), 'Open demo') : null,
      L.link ? h('a', { class: 'btn', href: L.link, target: '_blank', rel: 'noopener noreferrer' }, icon('link'), 'Google / social') : null);

    const info = h('div', { class: 'info' },
      [['Owner', L.owner], ['Phone', L.phone], ['City', L.city], ['Category', L.category], ['Batch', L.batch_name], ['Rep', L.rep_name || 'Unassigned'],
        ['Demo', L.demo_url ? 'Ready' : 'Not ready yet'], ['Calls made', String(L.attempts || 0)],
        L.callback_at && L.status === 'callback' ? ['Callback', fmt(L.callback_at)] : null,
        L.booked_at && L.status === 'booked' ? ['Booked call', fmt(L.booked_at)] : null]
        .filter((x) => x && x[1]).map(([k, v]) => h('div', null, h('span', null, k), h('span', null, v))));

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
        const r = await api('POST', '/leads/' + id + '/calls', Object.assign({ outcome }, extra));
        toast(OUTCOME_LABEL[outcome] + ' logged → ' + STATUS[r.status]);
        if (outcome === 'dnc' && S.me.role === 'rep') { location.hash = '#/leads'; return; }
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

    const noteBox = h('textarea', { placeholder: 'Notes from this call…' });
    const saveNote = h('button', { class: 'btn primary block', style: 'margin-top:8px', onclick: async () => {
      if (!noteBox.value.trim()) return toast('Write a note first', true);
      saveNote.disabled = true;
      try { await api('POST', '/leads/' + id + '/notes', { body: noteBox.value }); toast('Note saved'); reload(); } catch (e) { fail(e); saveNote.disabled = false; }
    } }, 'Save note');

    const hist = [...calls.map((c) => ({ t: c.created_at, kind: 'call', c })), ...notes.map((n) => ({ t: n.created_at, kind: 'note', n }))]
      .sort((a, b) => (a.t < b.t ? 1 : -1));
    const timeline = hist.length ? h('ul', { class: 'timeline' }, hist.map((x) => x.kind === 'note'
      ? h('li', { class: 'note' }, h('b', null, x.n.user_name || 'Someone'), ' added a note', h('div', { class: 'when' }, fmt(x.t)), h('div', { class: 'text' }, x.n.body))
      : h('li', null, h('b', null, OUTCOME_LABEL[x.c.outcome] || x.c.outcome),
        x.c.to_status && x.c.to_status !== x.c.from_status ? h('span', { class: 'muted' }, ' → ' + (STATUS[x.c.to_status] || x.c.to_status)) : null,
        h('div', { class: 'when' }, (x.c.user_name || '') + ' · ' + fmt(x.t)))))
      : h('p', { class: 'dim' }, 'No calls or notes yet.');

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

    shell(S.me.role === 'admin' || S.me.role === 'rep' ? 'leads' : 'demos', [
      h('a', { class: 'back', href: '#/leads', onclick: (e) => { if (S.cameFromList) { e.preventDefault(); window.history.back(); } } }, icon('back'), 'Back'),
      h('div', { class: 'detail-head' }, h('div', { class: 'row wrap', style: 'gap:8px;margin-bottom:8px' }, pill(L.status), L.demo_sent ? h('span', { class: 'tag good' }, 'Demo sent') : null),
        h('h1', null, L.business)),
      actions,
      scriptPanel,
      h('div', { class: 'card section' }, info),
      dealBox,
      h('div', { class: 'section' }, h('span', { class: 'eyebrow' }, 'Log this call'), outcomes, closeBtn),
      h('div', { class: 'section' }, h('span', { class: 'eyebrow' }, 'Notes'), noteBox, saveNote),
      h('div', { class: 'section' }, h('span', { class: 'eyebrow' }, 'History'), h('div', { class: 'card' }, timeline)),
      adminPanel,
    ]);
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
        l.link ? h('a', { class: 'btn small', style: 'margin-top:12px', href: l.link, target: '_blank', rel: 'noopener noreferrer' }, icon('link'), 'Open their Google / social') : null,
        h('div', { class: 'row', style: 'margin-top:12px' }, input, btn));
    };
    shell('demos', [
      h('div', { class: 'head' }, h('div', null, h('h1', null, 'Demo queue'), h('p', { class: 'sub' }, 'Build an unlisted demo site, paste its link, mark it ready. Reps see it right away.'))),
      seg,
      r.leads.length ? r.leads.map(card) : h('div', { class: 'card empty' }, h('b', null, which === 'needed' ? 'Queue is empty' : 'Nothing ready yet'), which === 'needed' ? 'New batches land here.' : ''),
    ]);
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
    business: ['business', 'businessname', 'name', 'company', 'companyname', 'title', 'place', 'placename'],
    owner: ['owner', 'ownername', 'contact', 'contactname', 'decisionmaker'],
    phone: ['phone', 'phonenumber', 'telephone', 'tel', 'mobile', 'number'],
    city: ['city', 'town', 'location', 'area'],
    category: ['category', 'type', 'industry', 'niche', 'categories'],
    link: ['link', 'googlesociallink', 'google', 'googlelink', 'maps', 'mapslink', 'googlemaps', 'url', 'social', 'sociallink', 'facebook', 'instagram', 'profile'],
  };
  function mapColumns(header) {
    const norm = header.map((x) => x.toLowerCase().replace(/[^a-z]/g, ''));
    const map = {}; let hits = 0;
    for (const [field, names] of Object.entries(FIELD_NAMES)) {
      const i = norm.findIndex((n, idx) => names.includes(n) && !Object.values(map).includes(idx));
      if (i >= 0) { map[field] = i; hits++; }
    }
    if (map.business === undefined) { const i = norm.findIndex((n) => n.includes('business') || n.includes('company')); if (i >= 0) { map.business = i; hits++; } }
    if (map.link === undefined) { const i = norm.findIndex((n) => n.includes('link') || n.includes('url') || n.includes('google')); if (i >= 0) { map.link = i; hits++; } }
    return hits >= 2 ? { map, hasHeader: true } : { map: { business: 0, owner: 1, phone: 2, city: 3, category: 4, link: 5 }, hasHeader: false };
  }

  async function viewUpload() {
    const opts = await getOptions(true);
    let parsed = null;
    const nameIn = h('input', { placeholder: 'e.g. Inglewood barbers – Nov', value: '' });
    const fileIn = h('input', { type: 'file', accept: '.csv,text/csv,.tsv,text/plain' });
    const paste = h('textarea', { placeholder: 'Or paste CSV text here…' });
    const startSel = h('select', null, h('option', { value: 'demo_needed' }, 'Demo needed (send to dev queue)'), h('option', { value: 'new' }, 'New (hold for now)'));
    const assignSel = h('select', null, h('option', { value: 'auto' }, 'Auto-assign (spread evenly across reps)'), h('option', { value: 'none' }, "Don't assign yet"),
      opts.reps.filter((r) => r.active).map((r) => h('option', { value: r.id }, 'All to ' + r.name)));
    const previewBox = h('div');
    const go = h('button', { class: 'btn primary block', disabled: true }, 'Upload leads');
    const prog = h('div', { class: 'progress', hidden: true }, h('i'));
    const result = h('div');

    function preview(text) {
      const rows = parseCSV(text);
      if (!rows.length) { parsed = null; previewBox.replaceChildren(); go.disabled = true; return; }
      const { map, hasHeader } = mapColumns(rows[0]);
      const data = (hasHeader ? rows.slice(1) : rows).map((r) => Object.fromEntries(Object.entries(map).map(([f, i]) => [f, (r[i] || '').trim()]))).filter((r) => r.business);
      parsed = data;
      const cols = ['business', 'owner', 'phone', 'city', 'category', 'link'];
      previewBox.replaceChildren(h('div', { class: 'card section' },
        h('b', null, data.length + ' leads found'),
        h('p', { class: 'sub' }, hasHeader ? 'Columns matched: ' + cols.map((c) => c + (map[c] !== undefined ? ' ✓' : ' ✗')).join(' · ') : 'No header row detected, so columns are read in this order: business, owner, phone, city, category, link.'),
        h('div', { class: 'preview' }, h('table', null, h('thead', null, h('tr', null, cols.map((c) => h('th', null, c)))),
          h('tbody', null, data.slice(0, 5).map((r) => h('tr', null, cols.map((c) => h('td', null, r[c] || '—')))))))));
      go.disabled = !data.length;
    }
    fileIn.addEventListener('change', async () => { const f = fileIn.files[0]; if (!f) return; if (!nameIn.value) nameIn.value = f.name.replace(/\.[^.]+$/, ''); preview(await f.text()); });
    paste.addEventListener('input', () => preview(paste.value));

    go.addEventListener('click', async () => {
      if (!parsed || !parsed.length) return;
      go.disabled = true; prog.hidden = false; result.replaceChildren();
      const bar = prog.firstChild; const tot = { inserted: 0, duplicates: 0, dnc: 0, invalid: 0 };
      try {
        const b = await api('POST', '/batches', { name: nameIn.value });
        for (let i = 0; i < parsed.length; i += 200) {
          const r = await api('POST', '/batches/' + b.id + '/leads', { rows: parsed.slice(i, i + 200), startStatus: startSel.value, assign: assignSel.value });
          for (const k in tot) tot[k] += r[k];
          bar.style.width = Math.round(Math.min(100, ((i + 200) / parsed.length) * 100)) + '%';
        }
        result.replaceChildren(h('div', { class: 'card section' }, h('h2', null, '✓ Batch "' + b.name + '" uploaded'),
          h('div', { class: 'stats' }, [['Added', tot.inserted], ['Duplicates skipped', tot.duplicates], ['Do Not Call skipped', tot.dnc]].map(([k, v]) => h('div', { class: 'stat' }, h('b', null, v), h('small', null, k)))),
          assignSel.value === 'auto' && !opts.reps.some((r) => r.active) ? h('p', { class: 'sub' }, "Note: you have no reps yet, so these leads are unassigned. Add reps under Team, then assign them from Leads.") : null,
          h('div', { class: 'row', style: 'margin-top:14px' }, h('a', { class: 'btn primary', href: '#/batches' }, 'See batches'), h('a', { class: 'btn', href: '#/demos' }, 'Demo queue'))));
        toast(tot.inserted + ' leads added');
      } catch (e) { fail(e); go.disabled = false; }
    });

    shell('batches', [
      h('a', { class: 'back', href: '#/batches' }, icon('back'), 'Batches'),
      h('h1', null, 'Upload a batch'),
      h('p', { class: 'sub' }, 'CSV columns: business name, owner, phone, city, category, Google/social link. Duplicates and Do Not Call numbers are skipped automatically.'),
      h('div', { class: 'card section' },
        h('div', { class: 'field' }, h('label', null, 'Batch name'), nameIn),
        h('div', { class: 'field' }, h('label', null, 'CSV file'), fileIn), paste),
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
  const SAMPLE_LEAD = { business: 'Fresh Fadez Barbershop', owner: 'Marcus Hill', city: 'Inglewood', category: 'Barber', demo_url: 'https://freshfadez-demo.pages.dev' };
  function ctxFor(L) {
    const own = String(L.owner || '').trim();
    return {
      owner_first: first(own) || 'the owner', owner: own || 'the owner', business: L.business || 'your business',
      rep_first: first(S.me.name) || 'me', rep: S.me.name, city: L.city || 'your area',
      category: (L.category || 'local').toLowerCase(), demo_link: L.demo_url || '(demo not ready yet)',
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
        h('b', null, 'Fill-ins: '), '{owner_first} {owner} {business} {rep_first} {city} {category} {demo_link}', h('br'),
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
  async function viewHome() {
    const isAdmin = S.me.role === 'admin';
    const [from, until] = periodBounds(S.period);
    const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - 6);
    const qs = new URLSearchParams({ from, until, since: since.toISOString(), tz: String(-new Date().getTimezoneOffset()) });
    const d = await api('GET', '/dashboard?' + qs);
    const T = d.totals, P = d.pipeline;
    const periodName = { today: 'today', week: 'this week', month: 'this month' }[S.period];

    const seg = h('div', { class: 'seg' }, [['today', 'Today'], ['week', 'This week'], ['month', 'This month']].map(([k, l]) =>
      h('button', { class: S.period === k ? 'on' : null, onclick: () => { S.period = k; viewHome(); } }, l)));

    const kpi = (label, value, note, cls) => h('div', { class: 'kpi ' + (cls || '') }, h('small', null, label), h('b', null, value), note ? h('span', null, note) : null);
    const bookRate = T.calls ? Math.round((T.booked / T.calls) * 100) + '% of calls' : null;
    const kpis = h('div', { class: 'kpis' },
      kpi('Calls', T.calls.toLocaleString()),
      kpi('Booked', T.booked.toLocaleString(), bookRate),
      kpi('Closes', T.closes.toLocaleString(), T.booked && T.closes ? Math.round((T.closes / Math.max(T.booked, 1)) * 100) + '% of booked' : null),
      isAdmin ? kpi('Revenue', money(T.revenue_cents), 'setup fees closed', 'money') : kpi('You earned', money(T.commission_cents), 'commission ' + periodName, 'money'));

    // rep: what to do next
    const nextUp = !isAdmin ? h('div', { class: 'card next' },
      h('div', { style: 'min-width:0' }, h('b', null, P.callbacks_due ? P.callbacks_due + (P.callbacks_due === 1 ? ' callback due' : ' callbacks due') : 'No callbacks due'),
        h('div', { class: 'sub' }, (P.demo_ready || 0) + ' demo-ready leads to call')),
      h('a', { class: 'btn primary', href: P.callbacks_due ? '#/callbacks' : '#/leads' }, P.callbacks_due ? 'Call back' : 'Start calling')) : null;

    // admin: commissions owed
    const owed = isAdmin && d.owed_cents ? h('a', { class: 'card next', href: '#/deals' },
      h('div', null, h('b', null, money(d.owed_cents) + ' commission owed'), h('div', { class: 'sub' }, d.owed_deals + (d.owed_deals === 1 ? ' unpaid deal' : ' unpaid deals'))),
      h('span', { class: 'btn small' }, 'Pay out')) : null;

    shell('home', [
      h('div', { class: 'head' }, h('div', null, h('h1', null, 'Hey ' + first(S.me.name)), h('p', { class: 'sub' }, isAdmin ? 'How the whole team is doing.' : 'Your numbers. Keep stacking.'))),
      seg, kpis, nextUp, owed,
      weekChart(d.days, isAdmin),
      leaderboard(d.leaderboard, isAdmin, periodName),
      pipeline(P, isAdmin),
      !isAdmin ? h('a', { class: 'card next section', href: '#/script' }, h('div', null, h('b', null, 'Practice the call script'), h('div', { class: 'sub' }, 'Read it before your first dial.')), icon('chev')) : null,
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
        const payload = { amount: amount.value, rep_id: repSel.value ? +repSel.value : null, commission_pct: repSel.value ? pct.value : 0, package: pkg.value, note: note.value, paid: paid.checked };
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
        h('div', { class: 'field' }, h('label', null, 'Deal amount ($, setup fee)'), amount),
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
  function viewMore() {
    const row = (href, ic, title, sub) => h('a', { class: 'list-row link', href }, h('span', { class: 'ic' }, icon(ic)), h('div', { style: 'flex:1;min-width:0' }, h('b', null, title), h('div', { class: 'sub' }, sub)), icon('chev'));
    shell('more', [
      h('div', { class: 'head' }, h('div', null, h('h1', null, 'More'))),
      h('div', { class: 'card' },
        row('#/batches', 'batches', 'Batches', 'Lead uploads and how each batch is doing'),
        row('#/upload', 'batches', 'Upload CSV', 'Add a new batch of leads'),
        row('#/users', 'users', 'Team', 'Add reps and devs, set commission %'),
        row('#/script', 'script', 'Call script', 'Edit what reps say on the phone'),
        row('#/deals', 'deals', 'Commission settings', 'Default % and payouts'),
        row('#/account', 'account', 'Account', 'Password and log out')),
    ]);
  }

  render();
})();
