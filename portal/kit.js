/* Reekon Systems demo kit: one link per prospect, every offer as a live demo. Vanilla JS, no libraries. */
(function () {
  'use strict';
  const $app = document.getElementById('app');
  const slug = (location.pathname.match(/^\/k\/([a-z0-9-]+)/) || [])[1] || '';
  let K = null, tab = '';

  /* ---------- tiny helpers ---------- */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v; else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v; else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    return el;
  }
  const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const call = async (op, body) => {
    const r = await fetch('/kit-api/' + slug + (op ? '/' + op : ''), body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const j = await r.json().catch(() => ({}));
    if (!r.ok && !j.reply) throw new Error(j.error || 'Something went wrong. Try again.');
    return j;
  };
  const first = () => (K.owner || '').split(' ')[0] || 'there';
  const svc = (id) => K.services.find((s) => s.id === id) || K.services[0];
  const lower = (s) => s.toLowerCase();
  const mid = (s, qty) => s.unit === 'project' ? (s.lo + s.hi) / 2 : ((s.lo + s.hi) / 2) * qty;
  const typicalQty = (s) => s.unit === 'sq ft' ? (s.id === 'deck' ? 300 : s.id === 'wall' ? 150 : 400) : s.unit === 'linear ft' ? 120 : 1;
  const slider = (min, max, step, value, onInput) => { const el = h('input', { type: 'range', min, max, step, value }); el.addEventListener('input', () => onInput(+el.value)); return el; };

  /* ---------- audio (WebAudio so iOS lets us play after async work) ---------- */
  let ctx = null, curSrc = null;
  function unlockAudio() {
    try { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume(); } catch { /* none */ }
  }
  const decode = (buf) => new Promise((res, rej) => { try { ctx.decodeAudioData(buf, res, rej); } catch (e) { rej(e); } });
  function stopAudio() { try { if (curSrc) { curSrc.onended = null; curSrc.stop(); } } catch { /* done */ } curSrc = null; if (window.speechSynthesis) speechSynthesis.cancel(); }
  async function speak(text) {
    try {
      const j = await call('tts', { text });
      const bin = atob(j.audio), u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const buf = await decode(u8.buffer);
      await new Promise((res) => { const src = ctx.createBufferSource(); curSrc = src; src.buffer = buf; src.connect(ctx.destination); src.onended = res; src.start(0); });
    } catch (e) {
      if (!window.speechSynthesis) return;
      await new Promise((res) => { const u = new SpeechSynthesisUtterance(text); u.onend = res; u.onerror = res; speechSynthesis.speak(u); });
    }
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  /* ---------- reusable text thread (phone mock) ---------- */
  function phone(title) {
    const thread = h('div', { class: 'thread' });
    const node = h('div', { class: 'phone' }, h('div', { class: 'phone-top' }, h('span', null, title), h('span', null, '6:42 PM')), thread);
    return {
      node, thread,
      add(cls, text) { const m = h('div', { class: 'm ' + cls }, text); thread.append(m); thread.scrollTop = thread.scrollHeight; return m; },
      alert(title, text) { const a = h('div', { class: 'alert' }, h('b', null, title), text); node.append(a); return a; },
      clear() { thread.replaceChildren(); node.querySelectorAll('.alert').forEach((a) => a.remove()); },
    };
  }
  // a thread where the visitor plays the homeowner and the AI texts back
  function aiThread(title, opener, placeholder) {
    const p = phone(title), hist = [];
    let busy = false, ended = false;
    const input = h('input', { type: 'text', placeholder: placeholder || 'Reply as the homeowner', maxlength: 300, autocomplete: 'off' });
    const send = async () => {
      const t = input.value.trim(); if (!t || busy || ended) return;
      input.value = ''; busy = true; p.add('out', t);
      const w = p.add('in', '…');
      try {
        const j = await call('talk', { mode: 'sms', text: t, history: hist });
        w.textContent = j.reply || 'Sorry, say that again?'; hist.push({ r: 'u', t }, { r: 'a', t: j.reply || '' });
        if (j.booking) { ended = true; p.node.append(bookingCard(j.booking, true)); }
      } catch (e) { w.textContent = e.message; }
      busy = false; input.focus();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
    const compose = h('div', { class: 'compose' }, input, h('button', { class: 'btn sm pri', onclick: send }, 'Send'));
    compose.hidden = true; p.node.append(compose);
    return { ...p, compose, hist, start(text) { const msg = text || opener; p.add('in', msg); hist.push({ r: 'a', t: msg }); compose.hidden = false; }, reset() { p.clear(); hist.length = 0; ended = false; compose.hidden = true; p.node.querySelectorAll('.book').forEach((b) => b.remove()); } };
  }
  function bookingCard(b, sms) {
    return h('div', { class: 'book' }, h('b', null, 'Estimate booked'),
      h('div', null, b.name + ' · ' + b.phone), h('div', null, b.project || 'Free on-site estimate'), h('div', null, b.when),
      h('div', { class: 'note', style: 'margin-top:8px' }, sms ? 'In real life this lands in your lead tracker and ' + (K.owner || 'you') + ' gets a text.' : 'Confirmation text sent. It is on the calendar and in the tracker.'));
  }

  /* ---------- panels ---------- */
  function pMath() {
    let miss = 6, avg = K.avg_job, close = 30;
    const out = h('div', { class: 'big' }), yr = h('p', { class: 'sub' });
    const upd = () => { const m = miss * 4.3 * (close / 100) * avg; out.textContent = money(m); yr.textContent = 'about ' + money(m * 12) + ' a year'; };
    const row = (label, ctl, val) => h('div', null, h('label', null, h('span', null, label + ' '), val), ctl);
    const v1 = h('b', null, miss), v2 = h('b', null, money(avg)), v3 = h('b', null, close + '%');
    upd();
    return [
      h('h2', null, (first() === 'there' ? 'Here' : first() + ', here') + ' is what a missed call costs'),
      h('p', { class: 'lead' }, 'Move the sliders to your real numbers. This is example math, not a promise.'),
      h('div', { class: 'card' },
        row('Calls you miss each week', slider(1, 30, 1, miss, (v) => { miss = v; v1.textContent = v; upd(); }), v1),
        row('Average job', slider(500, 30000, 500, avg, (v) => { avg = v; v2.textContent = money(v); upd(); }), v2),
        row('How many of those callers would have hired you', slider(10, 60, 5, close, (v) => { close = v; v3.textContent = v + '%'; upd(); }), v3)),
      h('div', { class: 'card' }, h('p', { class: 'eyebrow' }, 'Walking out the door each month'), out, yr),
      h('p', { class: 'lead' }, 'Everything on the next tabs is a working example for ' + K.business + '. Tap through it. Talk to the receptionist first.'),
      h('button', { class: 'btn pri', onclick: () => go('voice') }, 'Hear it answer a call'),
    ];
  }

  function pVoice() {
    let active = false, busy = false, hist = [], empties = 0, rec = null;
    const avatar = h('div', { class: 'avatar' }, K.agent[0]);
    const status = h('div', { class: 'status' }, 'Tap to start the call');
    const thread = h('div', { class: 'thread card', style: 'min-height:80px' });
    const addMsg = (cls, t) => { const m = h('div', { class: 'm ' + cls }, t); thread.append(m); thread.scrollTop = thread.scrollHeight; return m; };
    const mic = h('button', { class: 'mic', onclick: toggle }, SR ? 'Tap to call' : 'Start');
    const box = h('div');
    const input = h('input', { type: 'text', placeholder: 'Or type what you would say', maxlength: 300, autocomplete: 'off' });
    const say = (t, cls) => { status.textContent = t; avatar.classList.toggle('live', cls === 'live'); };
    async function turn(text) {
      addMsg('out', text); say('Thinking…'); busy = true;
      let j; try { j = await call('talk', { mode: 'voice', text, history: hist }); } catch (e) { addMsg('sys', e.message); busy = false; return; }
      hist.push({ r: 'u', t: text }, { r: 'a', t: j.reply || '' });
      addMsg('in', j.reply); if (j.booking) box.append(bookingCard(j.booking, false));
      say('Speaking…', 'live'); await speak(j.reply); busy = false;
      if (j.limited) hang();
    }
    function listen() {
      return new Promise((res) => {
        let finalText = ''; const r = new SR(); rec = r; r.lang = 'en-US'; r.interimResults = true;
        r.onresult = (e) => { let t = ''; for (const x of e.results) t += x[0].transcript; finalText = t; status.textContent = '“' + t + '”'; };
        r.onerror = () => res(''); r.onend = () => res(finalText.trim());
        try { r.start(); say('Listening… talk now', 'live'); } catch { res(''); }
      });
    }
    async function loop() {
      while (active) {
        if (busy) { await wait(200); continue; }
        const t = await listen(); if (!active) break;
        if (!t) { if (++empties >= 3) { say('Tap to talk again'); hang(); } continue; }
        empties = 0; await turn(t);
      }
    }
    function hang() { active = false; mic.classList.remove('rec'); mic.textContent = SR ? 'Tap to call' : 'Start'; try { rec && rec.abort(); } catch { /* ok */ } stopAudio(); say('Call ended. Tap to call again.'); avatar.classList.remove('live'); }
    async function toggle() {
      unlockAudio();
      if (active) return hang();
      active = true; mic.classList.add('rec'); mic.textContent = 'Hang up';
      if (!hist.length) { const g = 'Thanks for calling ' + K.business + ', this is ' + K.agent + '. How can I help with your backyard?'; addMsg('in', g); hist.push({ r: 'a', t: g }); say('Speaking…', 'live'); await speak(g); }
      if (SR) loop(); else { say('Type your reply below'); active = false; mic.classList.remove('rec'); mic.textContent = 'Start'; }
    }
    const sendTyped = async () => { const t = input.value.trim(); if (!t || busy) return; input.value = ''; unlockAudio(); if (!hist.length) { const g = 'Thanks for calling ' + K.business + ', this is ' + K.agent + '. How can I help with your backyard?'; addMsg('in', g); hist.push({ r: 'a', t: g }); } await turn(t); say(active ? 'Listening…' : 'Type or tap to talk'); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendTyped(); } });
    const ideas = ['How much for a paver patio?', 'Can you come out this week?', 'Do you do artificial turf?', 'My yard floods when it rains'];
    return [
      h('h2', null, 'Call ' + K.business + ' after hours'),
      h('p', { class: 'lead' }, 'This is a live AI voice receptionist. Tap the button, talk like a homeowner, and watch it book the estimate. ' + (K.premium_voice ? '' : 'Voice is a standard demo voice. The real one is custom.')),
      h('div', { class: 'card call-card' }, avatar, h('b', null, K.agent + ' · AI receptionist'), h('div', { class: 'note' }, K.business), status, mic,
        SR ? null : h('p', { class: 'note', style: 'margin-top:12px' }, 'This browser cannot listen. Type below and ' + K.agent + ' will answer out loud.')),
      h('div', { class: 'chips' }, ideas.map((t) => h('button', { class: 'chip', onclick: () => { unlockAudio(); input.value = t; sendTyped(); } }, t))),
      h('div', { class: 'compose', style: 'padding:0 0 10px' }, input, h('button', { class: 'btn sm pri', onclick: sendTyped }, 'Send')),
      thread, box,
      h('p', { class: 'note' }, 'Answers every call on the first ring, nights and weekends included. Not a promise of results, just what it sounds like.'),
    ];
  }

  function pSite() {
    return [
      h('h2', null, 'A website that books jobs'),
      h('p', { class: 'lead' }, 'A sample site for ' + K.business + ', built from what we know. The chat bubble in the corner is the AI chat: ask it anything a homeowner would.'),
      h('iframe', { class: 'frame', src: '/k/' + slug + '/site', title: 'Sample website', loading: 'lazy' }),
      h('div', { class: 'row', style: 'margin-top:10px' }, h('a', { class: 'btn pri', href: '/k/' + slug + '/site', target: '_blank', rel: 'noopener' }, 'Open full screen'),
        h('span', { class: 'note' }, 'Photos and reviews are placeholders. Yours go here.')),
    ];
  }

  function pTextback() {
    const t = aiThread('Homeowner phone', '', 'Reply as the homeowner');
    const log = h('div');
    const btn = h('button', { class: 'btn pri', onclick: run }, 'Simulate a missed call');
    async function run() {
      btn.disabled = true; t.reset(); log.replaceChildren();
      t.add('sys', 'Missed call · (310) 555-0142 · 6:42 PM');
      log.append(h('div', { class: 'alert' }, h('b', null, 'Your phone'), 'You were on a job. No voicemail left. Auto text going out…'));
      await wait(1400);
      t.start('Hi, this is ' + K.business + '. Sorry we missed you, we are on a job site. What are you looking to build? You can text me here.');
      log.replaceChildren(h('div', { class: 'alert' }, h('b', null, 'Texted back in 4 seconds'), 'The caller is now talking to the assistant instead of calling your competitor.'));
      btn.disabled = false; btn.textContent = 'Run it again';
    }
    return [
      h('h2', null, 'Missed call? Texted back in seconds'),
      h('p', { class: 'lead' }, 'When you cannot pick up, the caller gets a text right away and the AI keeps the conversation going. Play the homeowner.'),
      h('div', { class: 'row' }, btn), t.node, log,
    ];
  }

  function pSpeed() {
    const t = aiThread('Homeowner phone', '', 'Keep replying as Alex');
    const out = h('div');
    const sel = h('select', null, K.services.map((s) => h('option', { value: s.id }, s.name)));
    const name = h('input', { type: 'text', value: 'Alex', maxlength: 30 });
    const go1 = h('button', { class: 'btn pri', onclick: submit }, 'Submit as a homeowner');
    async function submit() {
      const n = (name.value || 'Alex').trim(), s = svc(sel.value);
      go1.disabled = true; t.reset(); out.replaceChildren();
      out.append(h('div', { class: 'alert' }, h('b', null, 'New lead from your ad'), n + ' wants ' + lower(s.name) + '. Auto-replied in 6 seconds. Added to the lead tracker.'));
      await wait(900);
      t.start('Hi ' + n + ', thanks for reaching out to ' + K.business + '! We would love to look at your ' + lower(s.name) + ' project. What is your zip code, and what days work for a free estimate?');
      go1.disabled = false; go1.textContent = 'Try again';
    }
    return [
      h('h2', null, 'Every new lead gets an answer in seconds'),
      h('p', { class: 'lead' }, 'Facebook, Google or website lead comes in. The homeowner hears back before they message the next contractor.'),
      h('div', { class: 'card' }, h('label', null, 'Homeowner name'), name, h('label', null, 'They want'), sel, h('div', { class: 'row', style: 'margin-top:12px' }, go1)),
      t.node, out,
    ];
  }

  function pQuotes() {
    let sid = K.services[0].id, replied = false, qm = 20, quiet = 50;
    const tl = h('div', { class: 'tl' }), math = h('div', { class: 'card' });
    const sel = h('select', { onchange: () => { sid = sel.value; draw(); } }, K.services.map((s) => h('option', { value: s.id }, s.name)));
    const who = K.owner ? K.owner.split(' ')[0] : 'our team';
    function draw() {
      const s = svc(sid), n = lower(s.name), steps = [
        ['Right after you send the quote', 'Hi Sarah, it is ' + who + ' at ' + K.business + '. Here is your ' + n + ' estimate. Reply here with any questions.'],
        ['Day 1', 'Hi Sarah, just checking that you got the ' + n + ' estimate. Happy to walk through it or adjust the scope if the number feels off.'],
        ['Day 3', 'Sarah, we are booking projects for next month. Want me to hold a spot for your ' + n + ' project? No obligation.'],
        ['Day 7', 'Still thinking about the ' + n + '? If the budget is the hold-up, we can look at doing it in phases.'],
        ['Day 14', 'Last note from me, Sarah. If the timing is off, no worries, I will check back in the spring. Reply YES if you would like me to keep your quote open.'],
      ];
      tl.replaceChildren(...(replied ? steps.slice(0, 2) : steps).map(([w, m]) => h('div', { class: 'step' }, h('div', { class: 'when' }, w), h('div', { class: 'msg' }, m))));
      if (replied) tl.append(h('div', { class: 'step' }, h('div', { class: 'when' }, 'Sarah replies'), h('div', { class: 'msg' }, 'Sequence stops. ' + (K.owner || 'You') + ' gets a text: Sarah replied about her ' + n + '. Call her now.')));
    }
    const mathOut = h('div', { class: 'big' });
    const v1 = h('b', null, qm), v2 = h('b', null, quiet + '%');
    const calc = () => { mathOut.textContent = money(qm * (quiet / 100) * 0.1 * K.avg_job); };
    calc(); draw();
    math.append(h('p', { class: 'eyebrow' }, 'Example math'),
      h('label', null, h('span', null, 'Quotes you send a month '), v1), slider(5, 80, 5, qm, (v) => { qm = v; v1.textContent = v; calc(); }),
      h('label', null, h('span', null, 'Go quiet with no answer '), v2), slider(20, 80, 5, quiet, (v) => { quiet = v; v2.textContent = v + '%'; calc(); }),
      h('p', { class: 'note' }, 'If follow-up wins back just 1 in 10 of the quiet ones at ' + money(K.avg_job) + ' a job, that is about:'), mathOut, h('p', { class: 'note' }, 'more booked work per month. Change the sliders to your numbers.'));
    return [
      h('h2', null, 'No quote gets forgotten'),
      h('p', { class: 'lead' }, 'Most estimates go quiet because nobody follows up. This does it for you, in your voice, and stops the second the customer replies.'),
      h('div', { class: 'card' }, h('label', null, 'Quote for'), sel, h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn sm', onclick: () => { replied = !replied; draw(); } }, 'Customer replies'))), tl, math,
    ];
  }

  function pReviews() {
    const p = phone('Customer phone'), extra = h('div');
    const s = K.services[0], who = K.owner ? K.owner.split(' ')[0] : 'our team';
    function start() {
      p.clear(); extra.replaceChildren();
      p.add('in', 'Hi Sarah, it is ' + who + ' at ' + K.business + '. Your ' + lower(s.name) + ' is done. How did we do? Tap a star (1 to 5).');
    }
    const stars = h('div', { class: 'stars' }, [1, 2, 3, 4, 5].map((n) => h('button', { class: 'star', 'aria-label': n + ' stars', onclick: () => rate(n) }, '★')));
    function rate(n) {
      [...stars.children].forEach((b, i) => b.classList.toggle('on', i < n));
      start(); p.add('out', n + ' stars');
      if (n >= 4) p.add('in', 'Thank you Sarah, that means a lot! Would you share that on Google? It takes 20 seconds: g.page/your-business');
      else { p.add('in', 'Thank you for being honest, Sarah. ' + who + ' will call you today to make it right. If you would still like to leave a public review, here is the link: g.page/your-business'); extra.replaceChildren(h('div', { class: 'alert' }, h('b', null, 'Alert to you'), 'Sarah gave ' + n + ' stars on her ' + lower(s.name) + '. Call her today, before it turns into a problem.')); }
    }
    start();
    return [
      h('h2', null, 'Reviews after every job'),
      h('p', { class: 'lead' }, 'The moment a job is marked done, the customer gets the ask. Everyone is invited to review on Google. Unhappy customers also reach you privately so you can fix it fast.'),
      stars, p.node, extra,
      h('div', { class: 'card' }, h('b', null, 'Tap-to-review card'), h('p', { class: 'note' }, 'Leave one in the truck or hand it over at the end of the job. The customer taps their phone on it and your Google review page opens. No app, no typing.'),
        h('div', { class: 'nfc' }, h('span', { class: 'eyebrow' }, 'Tap here'), h('b', null, K.business), h('span', { class: 'note' }, 'Loved your new yard? Tap to leave a review.'))),
    ];
  }

  function pWinback() {
    const camps = [
      ['Spring refresh', (n) => 'Hi {first}, it is ' + n + ' at ' + K.business + '. Spring is here. Want us to take a look at refreshing the yard we built for you? Reply YES and I will send a quick quote.'],
      ['Shade for summer', (n) => 'Hi {first}, ' + n + ' at ' + K.business + '. Summer is coming. A shade structure over your patio makes the yard usable all day. Want a free quote? Reply YES.'],
      ['Before the rain', (n) => 'Hi {first}, ' + n + ' at ' + K.business + '. Rain season is close. Want us to check your drainage before it matters? Reply YES for a free look.'],
      ['Maintenance check', (n) => 'Hi {first}, ' + n + ' at ' + K.business + '. It has been a while since we finished your project. Want us to stop by and check how it is holding up? Reply YES.'],
    ];
    let ci = 0, past = 80, rate = 6;
    const msg = h('div', { class: 'msg card' }), math = h('div', { class: 'big' });
    const who = K.owner ? K.owner.split(' ')[0] : 'the team';
    const names = [['Sarah M.', 'Replied YES'], ['Carlos R.', 'Sent'], ['Dana W.', 'Sent'], ['Mike T.', 'Replied YES'], ['Priya S.', 'Sent']];
    const list = h('div', { class: 'card' }, h('p', { class: 'eyebrow' }, 'Sample past customers'), names.map(([n, st]) => h('div', { class: 'out', style: 'padding:6px 0;border-bottom:1px solid var(--line)' }, h('span', null, n), h('span', { class: 'pill' + (st[0] === 'R' ? ' ok' : '') }, st))));
    const calc = () => { math.textContent = money(past * (rate / 100) * 0.5 * K.avg_job); };
    const draw = () => { msg.textContent = camps[ci][1](who); };
    const chips = h('div', { class: 'chips' }, camps.map((c, i) => h('button', { class: 'chip' + (i === 0 ? ' on' : ''), onclick: (e) => { ci = i; [...chips.children].forEach((x) => x.classList.remove('on')); e.target.classList.add('on'); draw(); } }, c[0])));
    const v1 = h('b', null, past), v2 = h('b', null, rate + '%');
    draw(); calc();
    return [
      h('h2', null, 'Bring past customers back'),
      h('p', { class: 'lead' }, 'Every customer you ever built for is a repeat job or a referral waiting. A friendly text at the right time wakes them up.'),
      chips, msg, list,
      h('div', { class: 'card' }, h('p', { class: 'eyebrow' }, 'Example math'),
        h('label', null, h('span', null, 'Past customers '), v1), slider(20, 400, 10, past, (v) => { past = v; v1.textContent = v; calc(); }),
        h('label', null, h('span', null, 'Who reply '), v2), slider(2, 15, 1, rate, (v) => { rate = v; v2.textContent = v + '%'; calc(); }),
        h('p', { class: 'note' }, 'If half of the repliers become jobs at ' + money(K.avg_job) + ':'), math, h('p', { class: 'note' }, 'Texts only go to people who agreed to hear from you, and STOP always works.')),
    ];
  }

  function pRemind() {
    const p = phone('Customer phone'), acts = h('div', { class: 'row', style: 'margin-top:8px' });
    let n = 0;
    const who = K.owner ? K.owner.split(' ')[0] : 'our estimator';
    const seq = [
      () => p.add('in', 'Confirmed: free estimate at your place Thursday at 10:00 AM with ' + K.business + '. Reply C to confirm or R to reschedule.'),
      () => p.add('in', 'Reminder: ' + who + ' is coming tomorrow at 10:00 AM. Need to change it? Reply R.'),
      () => p.add('in', 'We are on the way. Arriving around 10:00 AM.'),
    ];
    const next = h('button', { class: 'btn pri sm', onclick: () => { if (n < seq.length) seq[n++](); if (n >= seq.length) next.disabled = true; } }, 'Next text →');
    const resched = h('button', { class: 'btn sm', onclick: async () => {
      p.add('out', 'R'); await wait(500);
      const m = p.add('in', 'No problem. Which works: Friday 9:00 AM, Friday 1:00 PM, or Monday 10:00 AM?');
      acts.replaceChildren(...['Friday 9:00 AM', 'Friday 1:00 PM', 'Monday 10:00 AM'].map((t) => h('button', { class: 'chip', onclick: async () => { p.add('out', t); await wait(500); p.add('in', 'Done. You are set for ' + t + '. The calendar is updated.'); p.alert('Calendar updated', 'The customer moved to ' + t + '. You did not have to make a call.'); acts.replaceChildren(); } }, t)));
    } }, 'Customer replies R');
    seq[n++]();
    return [
      h('h2', null, 'Fewer no-shows, zero phone tag'),
      h('p', { class: 'lead' }, 'Estimate appointments get confirmed, reminded and rescheduled by text. Step through it.'),
      p.node, h('div', { class: 'row' }, next, resched), acts,
    ];
  }

  function pBallpark() {
    let sid = K.services[0].id, qty = typicalQty(K.services[0]);
    const out = h('div'), sizeBox = h('div'), booked = h('div');
    const sel = h('select', { onchange: () => { sid = sel.value; qty = typicalQty(svc(sid)); drawSize(); draw(); } }, K.services.map((s) => h('option', { value: s.id }, s.name)));
    function drawSize() {
      const s = svc(sid); sizeBox.replaceChildren();
      if (s.unit === 'project') { sizeBox.append(h('p', { class: 'note' }, 'Priced per project. ' + s.q)); return; }
      const mx = s.unit === 'linear ft' ? 400 : 1500, step = s.unit === 'linear ft' ? 10 : 50, v = h('b', null, qty + ' ' + s.unit);
      sizeBox.append(h('label', null, h('span', null, 'Size '), v), slider(step, mx, step, Math.min(qty, mx), (x) => { qty = x; v.textContent = x + ' ' + s.unit; draw(); }));
    }
    function draw() {
      const s = svc(sid), lo = s.unit === 'project' ? s.lo : s.lo * qty, hi = s.unit === 'project' ? s.hi : s.hi * qty;
      out.replaceChildren(h('p', { class: 'eyebrow' }, 'Ballpark'), h('div', { class: 'big' }, money(lo) + ' to ' + money(hi)),
        h('p', { class: 'note' }, 'Example ranges only. Your real rates go here, and the homeowner always gets a free estimate for the exact number.'),
        h('div', { class: 'lc', style: 'margin-top:12px' }, h('b', null, 'What you get as a lead'), h('small', null, 'Sarah M. · ' + s.name + ' · ' + (s.unit === 'project' ? 'project' : qty + ' ' + s.unit) + ' · asked for ~' + money(mid(s, qty)))));
      booked.replaceChildren();
    }
    drawSize(); draw();
    return [
      h('h2', null, 'Instant ballpark for homeowners'),
      h('p', { class: 'lead' }, 'Homeowners want a number before they call. Give them a range on your site and you get a qualified lead with the project and size already filled in.'),
      h('div', { class: 'card' }, h('label', null, 'Project'), sel, sizeBox), h('div', { class: 'card' }, out,
        h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn pri sm', onclick: () => booked.replaceChildren(bookingCard({ name: 'Sarah M.', phone: '(310) 555-0142', project: svc(sid).name, when: 'Free estimate · tomorrow 10:00 AM' }, true)) }, 'Book my free estimate'))), booked,
    ];
  }

  const KEEP = { turf: 'yearly cleaning check', pavers: 'sealing check in 2 years', deck: 'yearly reseal check', patio: 'sealing check in 2 years', fence: 'stain check in 2 years', wall: 'yearly inspection', pergola: 'yearly inspection', kitchen: 'yearly inspection', drainage: 'check before rainy season', lighting: 'yearly bulb and timer check' };
  function pJobdone() {
    let sid = K.services[0].id;
    const tl = h('div', { class: 'tl' }), sel = h('select', { onchange: () => { sid = sel.value; tl.replaceChildren(); } }, K.services.map((s) => h('option', { value: s.id }, s.name)));
    const who = K.owner ? K.owner.split(' ')[0] : 'our team';
    const run = async () => {
      const s = svc(sid), n = lower(s.name); tl.replaceChildren();
      const steps = [
        ['You tap "job done"', 'Everything below starts on its own. You do not touch anything else.'],
        ['2 hours later · review ask', 'Hi Sarah, it is ' + who + ' at ' + K.business + '. Thanks for trusting us with your ' + n + '. Would you share a quick Google review? g.page/your-business'],
        ['Same day · before and after post (draft for you to approve)', 'Before and after: ' + n + ' in ' + K.city + '. Another yard finished. Want yours next? Message us for a free estimate.'],
        ['3 days later · referral ask', 'Sarah, know a neighbor thinking about a project? Send them my way and I will thank you both when they book.'],
        ['Later · ' + KEEP[sid], 'Hi Sarah, ' + who + ' here. Time for a ' + KEEP[sid] + ' on your ' + n + '. Want me to schedule it? (Suggested timing. You set it.)'],
      ];
      for (const [w, m] of steps) { tl.append(h('div', { class: 'step' }, h('div', { class: 'when' }, w), h('div', { class: 'msg' }, m))); await wait(450); }
    };
    return [
      h('h2', null, 'One tap when the job is done'),
      h('p', { class: 'lead' }, 'The work finishes and the marketing starts: reviews, a before and after post, referrals, and a reminder for the next job.'),
      h('div', { class: 'card' }, h('label', null, 'Finished project'), sel, h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn pri', onclick: run }, 'Mark job done'))), tl,
    ];
  }

  function pTracker() {
    const cols = ['New', 'Estimate booked', 'Quote sent', 'Won'];
    const names = ['Sarah M.', 'Carlos R.', 'Dana W.', 'Mike T.', 'Priya S.', 'Jordan L.'];
    const cards = names.map((n, i) => { const s = K.services[i % K.services.length]; return { n, s: s.name, amt: Math.round(mid(s, typicalQty(s)) / 100) * 100, c: [0, 0, 1, 1, 2, 3][i], src: ['Missed call', 'Website chat', 'Facebook ad', 'Voice receptionist', 'Website form', 'Referral'][i] }; });
    const board = h('div', { class: 'board' });
    const draw = () => {
      board.replaceChildren(...cols.map((c, ci) => {
        const mine = cards.filter((x) => x.c === ci);
        return h('div', { class: 'col' }, h('h4', null, h('span', null, c), h('span', null, money(mine.reduce((a, b) => a + b.amt, 0)))),
          mine.map((x) => h('div', { class: 'lc' }, h('b', null, x.n), h('small', null, x.s + ' · ' + money(x.amt)), h('div', { class: 'row', style: 'justify-content:space-between;margin-top:6px' }, h('span', { class: 'pill' }, x.src), ci < 3 ? h('button', { class: 'btn sm', onclick: () => { x.c++; draw(); } }, '→') : null))));
      }));
    };
    draw();
    return [
      h('h2', null, 'Every lead in one place'),
      h('p', { class: 'lead' }, 'Calls, texts, chats and forms all land here with the project and the dollar amount. Tap the arrows to move a job along. Sample data.'),
      board,
      h('p', { class: 'note' }, 'This is a simple custom tracker, not another app to learn. You see the money at every step.'),
    ];
  }

  const TABS = [['math', 'Missed jobs', pMath], ['voice', 'AI receptionist', pVoice], ['site', 'Website + chat', pSite], ['textback', 'Text-back', pTextback], ['speed', 'Instant reply', pSpeed], ['quotes', 'Quote follow-up', pQuotes],
    ['reviews', 'Reviews', pReviews], ['winback', 'Win-back', pWinback], ['remind', 'Reminders', pRemind], ['ballpark', 'Instant ballpark', pBallpark], ['jobdone', 'Job done', pJobdone], ['tracker', 'Lead tracker', pTracker]];

  /* ---------- shell ---------- */
  const panel = h('div', { class: 'panel' });
  const tabsIn = h('div', { class: 'tabs-in' });
  function go(id, noPush) {
    if (!TABS.some((t) => t[0] === id)) id = 'math';
    stopAudio(); tab = id;
    if (!noPush) history.replaceState(null, '', '#' + id);
    [...tabsIn.children].forEach((b) => b.classList.toggle('on', b.dataset.id === id));
    const def = TABS.find((t) => t[0] === id);
    panel.replaceChildren(...[def[2]()].flat());
    const on = tabsIn.querySelector('.on'); if (on && on.scrollIntoView) on.scrollIntoView({ inline: 'center', block: 'nearest' });
    window.scrollTo(0, 0);
    call('hit', { d: id }).catch(() => {});
  }
  function lead() {
    const err = h('p', { class: 'err' }), body = h('div');
    const name = h('input', { type: 'text', value: K.owner || '', placeholder: 'Your name', maxlength: 60 }), phone = h('input', { type: 'tel', placeholder: 'Best phone number', maxlength: 30 }), note = h('input', { type: 'text', placeholder: 'Anything we should know? (optional)', maxlength: 300 });
    const hp = h('input', { class: 'hp', type: 'text', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
    const sheet = h('div', { class: 'sheet', onclick: (e) => { if (e.target === sheet) sheet.remove(); } }, h('div', { class: 'sheet-in' }, body));
    const send = h('button', { class: 'btn pri', style: 'width:100%;margin-top:14px', onclick: async () => {
      err.textContent = ''; send.disabled = true;
      try { await call('lead', { name: name.value, phone: phone.value, note: note.value, hp: hp.value }); body.replaceChildren(h('h2', null, 'Got it.'), h('p', { class: 'lead' }, 'We will call you today to set this up for ' + K.business + '.'), h('button', { class: 'btn', onclick: () => sheet.remove() }, 'Close')); }
      catch (e) { err.textContent = e.message; send.disabled = false; }
    } }, 'Get this for ' + K.business);
    body.append(h('h2', null, 'Want this live in a week?'), h('p', { class: 'lead' }, 'Leave your number and we will call you today. No pressure, no spam.'),
      h('label', null, 'Name'), name, h('label', null, 'Phone'), phone, h('label', null, 'Note'), note, hp, err, send);
    document.body.append(sheet);
  }
  function mount() {
    document.title = K.business + ' · demo';
    const t = h('div', { class: 'tabs' }, h('div', { class: 'wrap' }, tabsIn));
    TABS.forEach(([id, label]) => tabsIn.append(h('button', { class: 'tab', 'data-id': id, onclick: () => go(id) }, label)));
    $app.replaceChildren(
      h('div', { class: 'wrap' }, h('div', { class: 'top' }, h('div', { class: 'eyebrow' }, 'Live demo · built by Reekon Systems'),
        h('h1', null, K.business), h('p', { class: 'sub' }, (K.owner ? K.owner.split(' ')[0] + ', everything' : 'Everything') + ' here works. Tap through it. Nothing is sent to real customers.'))),
      t, h('div', { class: 'wrap' }, panel),
      h('div', { class: 'dock' }, h('button', { class: 'btn pri', onclick: lead }, 'I want this for ' + K.business)));
    go((location.hash || '').replace('#', '') || 'math', true);
  }
  window.addEventListener('hashchange', () => { const id = location.hash.replace('#', ''); if (id && id !== tab) go(id, true); });

  call('').then((k) => { K = k; mount(); }).catch((e) => { $app.replaceChildren(h('p', { class: 'boot' }, e.message || 'This demo link is not available.')); });
})();
