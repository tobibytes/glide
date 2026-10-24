// Glide Remote: the phone web app (docs/PHONE.md). Plain DOM, no framework, no network besides POST /api.
(function () {
  'use strict';
  const { call, Pairing, GlideError } = window.GlideAPI;

  // ---------- tiny DOM helpers ----------

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    append(el, kids);
    return el;
  }
  function append(el, kids) {
    for (const k of kids.flat(Infinity)) {
      if (k === undefined || k === null || k === false) continue;
      el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  // Icons: static SVG paths drawn for Glide Remote (24x24, stroke).
  const ICONS = {
    home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    send: '<path d="M4 12l16-8-6 16-3-7z"/><path d="M11 13l9-9"/>',
    remote: '<rect x="4" y="3" width="16" height="18" rx="4"/><path d="M12 3v7"/><path d="M4 10h16"/>',
    more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
    clipboard: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4.5h6V7H9z"/>',
    files: '<path d="M4 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>',
    file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
    agent: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    sleep: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    play: '<path d="M7 5v14l11-7z"/><path d="M19 5v14" opacity="0"/>',
    playpause: '<path d="M5 5v14l9-7z"/><path d="M16 5v14M20 5v14"/>',
    next: '<path d="M5 5v14l10-7z"/><path d="M19 5v14"/>',
    prev: '<path d="M19 5v14L9 12z"/><path d="M5 5v14"/>',
    volup: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
    voldown: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6"/>',
    mute: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9l5 6M21 9l-5 6"/>',
    timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/>',
    chevron: '<path d="M9 5l7 7-7 7"/>',
    left: '<path d="M15 5l-7 7 7 7"/>',
    right: '<path d="M9 5l7 7-7 7"/>',
    up: '<path d="M5 15l7-7 7 7"/>',
    down: '<path d="M5 9l7 7 7-7"/>',
    mac: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    photo: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 8"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
    run: '<path d="M6 4l14 8-14 8z"/>',
    workflow: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H14a4 4 0 0 1 4 4v5.5"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  };
  function icon(name) {
    const span = document.createElement('span');
    span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
    return span.firstChild;
  }

  // ---------- toast and errors ----------

  const toastBox = document.getElementById('toast');
  let lastToast = { text: '', at: 0 };
  function toast(text, kind) {
    const now = Date.now();
    if (text === lastToast.text && now - lastToast.at < 2500) return;
    lastToast = { text, at: now };
    const el = h('div', { class: 'toast-msg' + (kind ? ' ' + kind : '') }, text);
    toastBox.appendChild(el);
    setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3000);
  }

  const SWITCHES = { clipboard: 'Clipboard', remote: 'Remote control', files: 'Files', agent: 'Glide Agent' };
  function groupOf(action) {
    if (/^clipboard\./.test(action)) return 'clipboard';
    if (/^(pointer|keys|type|slides)\./.test(action) || action === 'media') return 'remote';
    if (/^files\./.test(action)) return 'files';
    if (action === 'agent.ask') return 'agent';
    return '';
  }
  const GENERIC_DENIED = 'Not allowed. Turn this on in Glide → Settings → iPhone.';

  /** A sentence for the person holding the phone: what happened and what to do next. */
  function explain(e) {
    if (!(e instanceof GlideError)) return 'Something went wrong. Try again.';
    if (e.code === 'denied') {
      const g = groupOf(e.action);
      if ((!e.message || e.message === GENERIC_DENIED) && g) {
        return SWITCHES[g] + ' is off. On the Mac, open Glide, then Settings, then iPhone, and turn on ' + SWITCHES[g] + '.';
      }
      return e.message || 'The Mac did not allow this. Check Glide, then Settings, then iPhone.';
    }
    if (e.code === 'not-found' && e.message === 'Unknown action') {
      return "The Glide on your Mac can't do this yet. Update Glide on the Mac.";
    }
    return e.message || 'Something went wrong on the Mac. Try again.';
  }

  /** Show an error; an unpaired answer switches to the pairing screen. */
  function fail(e) {
    if (e instanceof GlideError && e.code === 'unpaired' && Pairing.load()) { state.rejected = true; render(); return; }
    toast(explain(e), 'error');
  }

  // ---------- state, routing ----------

  const state = {
    rejected: false,        // the Mac answered 401 to a stored pairing
    pairing: null,          // {deviceId, key} from #pair= while hello runs
    pairError: '',
    approveId: '',          // from #approve=<id>
    hello: null,            // last hello result (mac, device, groups, actions)
    chat: loadChat(),
  };
  const app = document.getElementById('app');
  const tabs = document.getElementById('tabs');
  let cleanup = [];
  function onLeave(f) { cleanup.push(f); }

  const TABS = [
    ['home', 'Home', 'home'], ['send', 'Send', 'send'], ['remote', 'Remote', 'remote'], ['search', 'Search', 'search'], ['more', 'More', 'more'],
  ];
  const SCREENS = { home: Home, search: Search, send: Send, clipboard: Clipboard, remote: Remote, files: Files, agent: Agent, settings: Settings, more: More };

  function currentRoute() {
    const m = /^#\/([a-z]+)/.exec(location.hash);
    return m && SCREENS[m[1]] ? m[1] : 'home';
  }
  function go(route) {
    if (location.hash === '#/' + route) render();
    else location.hash = '#/' + route;
  }

  function render() {
    for (const f of cleanup) { try { f(); } catch (e) { /* ignore */ } }
    cleanup = [];
    clear(app);
    const paired = Pairing.load();
    if (state.pairing) { app.className = 'app bare'; tabs.hidden = true; app.appendChild(PairingProgress()); return; }
    if (!paired || state.rejected) { app.className = 'app bare'; tabs.hidden = true; app.appendChild(Unpaired(paired)); return; }
    app.className = 'app';
    const route = currentRoute();
    renderTabs(route);
    app.appendChild(SCREENS[route]());
    window.scrollTo(0, 0);
  }

  function renderTabs(route) {
    tabs.hidden = false;
    clear(tabs);
    const active = ['clipboard', 'files', 'agent', 'settings'].includes(route) ? 'more' : route;
    for (const [id, label, ic] of TABS) {
      tabs.appendChild(h('a', { href: '#/' + id, 'aria-current': id === active ? 'page' : null }, icon(ic), h('span', {}, label)));
    }
  }

  function header(title, sub) {
    return [h('h1', { class: 'page-title' }, title), sub ? h('p', { class: 'page-sub' }, sub) : null];
  }
  function sectionTitle(t) { return h('h2', { class: 'section-title' }, t); }

  /** Run a button's action with a busy state; errors become toasts. */
  async function busy(btn, f) {
    if (btn.disabled) return;
    const old = Array.from(btn.childNodes);
    btn.disabled = true;
    btn.appendChild(h('span', { class: 'spinner', 'aria-hidden': 'true' }));
    try { return await f(); } catch (e) { fail(e); } finally {
      btn.disabled = false;
      clear(btn);
      append(btn, old);
    }
  }

  function button(label, opts, f) {
    const o = opts || {};
    const b = h('button', { class: 'btn ' + (o.class || ''), type: 'button', 'aria-label': o.aria || null }, o.icon ? icon(o.icon) : null, label ? h('span', {}, label) : null);
    b.addEventListener('click', () => busy(b, () => f(b)));
    return b;
  }

  // ---------- pairing ----------

  function deviceName() {
    const ua = navigator.userAgent || '';
    if (/iPad/.test(ua)) return 'iPad';
    if (/iPhone/.test(ua)) return 'iPhone';
    return 'Phone';
  }

  async function pairWith(p) {
    state.pairing = p;
    state.pairError = '';
    render();
    const name = (Pairing.load() || {}).name || deviceName();
    try {
      const r = await call('hello', { name }, { pairing: p, timeout: 20000 });
      Pairing.save({ deviceId: p.deviceId, key: p.key, base: location.origin, name: (r && r.device && r.device.name) || name,
        mac: (r && r.mac && r.mac.name) || 'Mac', pairedAt: Date.now() });
      state.hello = r;
      state.pairing = null;
      state.rejected = false;
      toast('Paired with ' + ((r && r.mac && r.mac.name) || 'your Mac'), 'success');
      go('home');
    } catch (e) {
      state.pairError = e instanceof GlideError && e.code === 'unpaired'
        ? "This pairing code has expired or was already used. On the Mac, open Glide, then Settings, then iPhone, and click Pair iPhone again."
        : explain(e);
      render();
    }
  }

  function PairingProgress() {
    const wrap = h('div', {},
      h('div', { class: 'hero' }, h('img', { src: '/icon-180.png', alt: '' }), h('h1', {}, state.pairError ? "Couldn't pair" : 'Pairing with your Mac')));
    if (!state.pairError) {
      wrap.appendChild(h('p', { class: 'center muted' }, h('span', { class: 'spinner' }), '  Connecting'));
      return wrap;
    }
    const p = state.pairing;
    wrap.appendChild(h('div', { class: 'notice error' }, state.pairError));
    wrap.appendChild(h('div', { class: 'stack', style: 'margin-top:16px' },
      button('Try again', { class: 'btn-primary btn-block' }, async () => pairWith(p)),
      button('Cancel', { class: 'btn-ghost btn-block' }, async () => { state.pairing = null; state.pairError = ''; render(); })));
    return wrap;
  }

  function Unpaired(stored) {
    const rejected = stored && state.rejected;
    return h('div', {},
      h('div', { class: 'hero' }, h('img', { src: '/icon-180.png', alt: '' }),
        h('h1', {}, rejected ? 'Pair this iPhone again' : 'Glide Remote'),
        h('p', { class: 'muted' }, rejected
          ? "Your Mac didn't accept this iPhone. It may have been removed in Glide, or this iPhone's clock may be off."
          : 'Use Glide on your Mac from this iPhone: send text and photos, control the Mac, find files and more.')),
      h('div', { class: 'panel' },
        h('ol', { class: 'steps-list' },
          h('li', {}, 'On your Mac, open Glide, then Settings, then ', h('b', {}, 'iPhone'), '.'),
          h('li', {}, 'Turn on ', h('b', {}, 'Let my iPhone use Glide'), ' and click ', h('b', {}, 'Pair iPhone'), '.'),
          h('li', {}, "Point this iPhone's Camera at the code and open the link."))),
      h('p', { class: 'small muted center', style: 'margin-top:16px' }, 'The iPhone and the Mac need to be on the same Wi-Fi. Pairing creates a key that only they share.'),
      rejected ? h('div', { class: 'stack', style: 'margin-top:16px' },
        button('Try again', { class: 'btn-primary btn-block' }, async () => {
          state.rejected = false;
          try { state.hello = await call('hello', { name: stored.name || deviceName() }); render(); } catch (e) { state.rejected = e.code === 'unpaired'; if (!state.rejected) fail(e); render(); }
        }),
        button('Forget this Mac', { class: 'btn-ghost btn-block' }, async () => { Pairing.clear(); state.rejected = false; render(); })) : null);
  }

  // ---------- Home ----------

  function fmtDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    const two = (n) => (n < 10 ? '0' : '') + n;
    return hh > 0 ? hh + ':' + two(mm) + ':' + two(ss) : mm + ':' + two(ss);
  }

  function Home() {
    const p = Pairing.load() || {};
    const statusBox = h('div', { class: 'panel' }, h('div', { class: 'status-card' }, h('div', { class: 'mac' }, icon('mac')),
      h('div', { class: 'grow' }, h('div', { style: 'font-weight:600' }, p.mac || 'Your Mac'), h('div', { class: 'small muted' }, h('span', { class: 'spinner' }), ' Checking'))));
    const timersBox = h('div', {});
    let timers = [];
    let fetchedAt = 0;

    function drawStatus(st, error) {
      clear(statusBox);
      const mac = (st && st.mac) || {};
      const lines = [];
      if (error) lines.push(h('div', { class: 'small' }, h('span', { class: 'dot off' }), error));
      else {
        lines.push(h('div', { class: 'small muted' }, h('span', { class: 'dot' }), 'Connected' + (mac.version ? ', Glide ' + mac.version : '')));
      }
      const pills = [];
      if (st && st.battery && typeof st.battery.percent === 'number') {
        pills.push(h('span', { class: 'badge badge-soft' }, 'Battery ' + st.battery.percent + '%' + (st.battery.charging ? ', charging' : '')));
      }
      if (st && st.focus && st.focus.active) {
        pills.push(h('span', { class: 'badge badge-soft badge-primary' }, 'Focus' + (st.focus.goal ? ': ' + st.focus.goal : '') + (st.focus.remainingMs ? ', ' + fmtDuration(st.focus.remainingMs) + ' left' : '')));
      }
      statusBox.appendChild(h('div', { class: 'status-card' }, h('div', { class: 'mac' }, icon('mac')),
        h('div', { class: 'grow' }, h('div', { style: 'font-weight:600', class: 'truncate' }, mac.name || p.mac || 'Your Mac'), lines)));
      if (pills.length) statusBox.appendChild(h('div', { class: 'pill-row' }, pills));
    }

    function drawTimers() {
      clear(timersBox);
      if (!timers.length) return;
      timersBox.appendChild(sectionTitle('Timers'));
      const panel = h('div', { class: 'panel' });
      for (const t of timers) {
        const left = t.paused ? t.remainingMs : t.remainingMs - (Date.now() - fetchedAt);
        panel.appendChild(h('div', { class: 'timer' },
          h('div', { class: 'time' }, fmtDuration(left)),
          h('div', { class: 'grow truncate' }, t.name || 'Timer', t.paused ? h('span', { class: 'muted small' }, '  paused') : null),
          button('Stop', { class: 'btn-sm btn-ghost' }, async () => { await call('timers.stop', { id: t.id }); toast('Timer stopped'); refresh(); })));
      }
      timersBox.appendChild(panel);
    }

    async function refresh() {
      try {
        const st = await call('status', {}, { timeout: 15000 });
        timers = Array.isArray(st && st.timers) ? st.timers : [];
        fetchedAt = Date.now();
        drawStatus(st);
        drawTimers();
      } catch (e) {
        if (e.code === 'unpaired') return fail(e);
        drawStatus(null, explain(e));
      }
    }

    const minutes = h('input', { class: 'field', type: 'number', inputmode: 'decimal', min: '1', max: '1440', value: '5', 'aria-label': 'Minutes' });
    const media = (key, ic, label) => button('', { icon: ic, aria: label, class: 'btn-soft' }, async () => { await call('media', { key }); });

    const page = h('div', {},
      header('Glide'),
      statusBox,
      timersBox,
      sectionTitle('Quick actions'),
      h('div', { class: 'grid3' },
        button('Lock', { icon: 'lock', class: 'tall btn-soft' }, async () => { await call('mac.lock'); toast('Mac locked'); }),
        button('Sleep', { icon: 'sleep', class: 'tall btn-soft' }, async () => { toast('Asking the Mac'); await call('mac.sleep'); toast('Mac is going to sleep'); }),
        button('Send clipboard', { icon: 'clipboard', class: 'tall btn-soft' }, async () => { state.focusPaste = true; go('clipboard'); })),
      sectionTitle('Media'),
      h('div', { class: 'grid3' }, media('prev', 'prev', 'Previous track'), media('playpause', 'playpause', 'Play or pause'), media('next', 'next', 'Next track')),
      h('div', { class: 'grid3', style: 'margin-top:10px' }, media('voldown', 'voldown', 'Volume down'), media('mute', 'mute', 'Mute'), media('volup', 'volup', 'Volume up')),
      sectionTitle('Timer'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, minutes), h('span', { class: 'muted' }, 'min'),
        button('Start', { icon: 'timer', class: 'btn-primary' }, async () => {
          const m = parseFloat(minutes.value);
          if (!(m > 0)) { toast('Enter how many minutes.', 'error'); return; }
          await call('timers.start', { minutes: m });
          toast('Timer started');
          refresh();
        })));

    refresh();
    const tick = setInterval(drawTimers, 1000);
    const poll = setInterval(refresh, 15000);
    const vis = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', vis);
    onLeave(() => { clearInterval(tick); clearInterval(poll); document.removeEventListener('visibilitychange', vis); });
    return page;
  }

  // ---------- Search ----------

  function Search() {
    const field = h('input', { class: 'field', type: 'search', placeholder: 'Search Glide', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search', 'aria-label': 'Search Glide' });
    const results = h('div', {});
    let seq = 0;
    let timer = 0;

    function rows(items, onTap) {
      const ul = h('ul', { class: 'rows' });
      for (const it of items) {
        const b = h('button', { class: 'rowbtn', type: 'button' }, h('span', { class: 'icon' }, icon(it.icon || 'run')),
          h('span', { class: 'text' }, h('div', { class: 'title' }, it.title || 'Untitled'), it.subtitle ? h('div', { class: 'sub' }, it.subtitle) : null),
          it.badge ? h('span', { class: 'badge badge-ghost badge-sm' }, it.badge) : null);
        b.addEventListener('click', () => busy(b, () => onTap(it)));
        ul.appendChild(h('li', {}, b));
      }
      return h('div', { class: 'panel tight' }, ul);
    }

    async function runItem(it, argument) {
      toast('Running on the Mac');
      const r = await call('run', argument ? { id: it.id, argument } : { id: it.id });
      toast((r && r.message) || 'Done', 'success');
    }

    function askArgument(it) {
      const input = h('input', { class: 'field', type: 'text', placeholder: 'Type the argument', autocomplete: 'off', enterkeyhint: 'go', 'aria-label': 'Argument' });
      const close = () => back.remove();
      const go = button('Run', { icon: 'run', class: 'btn-primary btn-block' }, async () => { await runItem(it, input.value.trim()); close(); });
      const back = h('div', { class: 'sheet-backdrop', onclick: (e) => { if (e.target === back) close(); } },
        h('div', { class: 'sheet stack' }, h('div', { style: 'font-weight:600;font-size:19px' }, it.title),
          it.subtitle ? h('div', { class: 'small muted' }, it.subtitle) : null, input, go,
          h('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: close }, 'Cancel')));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
      document.body.appendChild(back);
      onLeave(close);
      setTimeout(() => input.focus(), 50);
    }

    async function showWorkflows() {
      const my = ++seq;
      try {
        const r = await call('workflows.list');
        if (my !== seq) return;
        clear(results);
        const list = (r && r.workflows) || [];
        if (!list.length) { results.appendChild(h('p', { class: 'empty' }, 'Type to search apps, commands and workflows on your Mac.')); return; }
        results.appendChild(sectionTitle('Workflows'));
        results.appendChild(rows(list.map((w) => ({ id: w.id, title: w.name, icon: 'workflow' })), async (w) => {
          toast('Running ' + w.title);
          const out = await call('workflows.run', { id: w.id });
          toast(out && out.result ? String(out.result).slice(0, 200) : 'Workflow finished', 'success');
        }));
      } catch (e) {
        if (my !== seq) return;
        clear(results);
        if (e.code === 'unpaired') return fail(e);
        results.appendChild(h('p', { class: 'empty' }, 'Type to search apps, commands and workflows on your Mac.'));
      }
    }

    async function search(q) {
      const my = ++seq;
      try {
        const r = await call('search', { query: q, limit: 30 }, { timeout: 15000 });
        if (my !== seq) return;
        clear(results);
        const items = (r && r.items) || [];
        if (!items.length) { results.appendChild(h('p', { class: 'empty' }, 'Nothing found for "' + q + '".')); return; }
        results.appendChild(rows(items.map((it) => Object.assign({}, it, { badge: it.acceptsArgument ? 'Argument' : null })),
          async (it) => (it.acceptsArgument ? askArgument(it) : runItem(it))));
      } catch (e) {
        if (my !== seq) return;
        clear(results);
        fail(e);
      }
    }

    field.addEventListener('input', () => {
      clearTimeout(timer);
      const q = field.value.trim();
      timer = setTimeout(() => (q ? search(q) : showWorkflows()), 220);
    });
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); const q = field.value.trim(); if (q) search(q); field.blur(); } });
    onLeave(() => clearTimeout(timer));
    showWorkflows();
    return h('div', {}, header('Search', 'Find apps, commands and workflows on your Mac and run them.'),
      h('div', { class: 'search-wrap' }, icon('search'), field), h('div', { style: 'margin-top:12px' }, results));
  }

  // ---------- Send ----------

  function segmented(options, value, onChange) {
    const wrap = h('div', { class: 'segmented', role: 'group' });
    const btns = options.map(([id, label]) => {
      const b = h('button', { type: 'button', 'aria-pressed': String(id === value) }, label);
      b.addEventListener('click', () => { for (const x of btns) x.setAttribute('aria-pressed', String(x === b)); onChange(id); });
      wrap.appendChild(b);
      return b;
    });
    return wrap;
  }

  const URL_RE = /^(https?:\/\/|mailto:)\S+$/i;

  function readAsBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
      r.onerror = () => reject(new GlideError('read', "Couldn't read that photo. Try another one."));
      r.readAsDataURL(blob);
    });
  }

  /** Photos above 12 MB are scaled to 4096 px JPEG so the encrypted request stays under the Mac's 32 MB limit. */
  function shrink(file) {
    return new Promise((resolve) => {
      if (file.size <= 12 * 1024 * 1024) { resolve(file); return; }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 4096 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob((b) => resolve(b || file), 'image/jpeg', 0.88);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  function Send() {
    let to = 'clipboard';
    const text = h('textarea', { class: 'field', placeholder: 'Type or paste text or a link', 'aria-label': 'Text or link', autocapitalize: 'sentences' });
    const hint = h('p', { class: 'small muted', style: 'margin:8px 2px 0' }, 'Copies it to the Mac clipboard.');
    const HINTS = { clipboard: 'Copies it to the Mac clipboard.', note: 'Adds it to the note "From iPhone" in Glide Notes.', open: 'Opens the link in the Mac browser.' };
    const picker = h('input', { type: 'file', accept: 'image/*', hidden: true });
    const preview = h('div', {});
    let photo = null;

    picker.addEventListener('change', () => {
      photo = picker.files && picker.files[0] ? picker.files[0] : null;
      clear(preview);
      if (!photo) return;
      const url = URL.createObjectURL(photo);
      onLeave(() => URL.revokeObjectURL(url));
      preview.appendChild(h('div', { class: 'panel stack', style: 'margin-top:12px' },
        h('img', { class: 'preview-img', src: url, alt: 'Selected photo' }),
        h('div', { class: 'small muted center' }, (photo.name || 'Photo') + ', ' + Math.max(1, Math.round(photo.size / 1024)) + ' KB'),
        button('Send photo to the Mac clipboard', { icon: 'send', class: 'btn-primary btn-block' }, async () => {
          const blob = await shrink(photo);
          const image = await readAsBase64(blob);
          const r = await call('send', { image, to: 'clipboard', name: photo.name || 'photo.jpg', type: blob.type || photo.type || 'image/jpeg' }, { timeout: 120000 });
          toast((r && r.message) || 'Photo copied on the Mac', 'success');
          photo = null;
          picker.value = '';
          clear(preview);
        })));
    });

    const sendBtn = button('Send', { icon: 'send', class: 'btn-primary btn-block' }, async () => {
      const v = text.value;
      if (!v.trim()) { toast('Type or paste something first.', 'error'); return; }
      const isURL = URL_RE.test(v.trim());
      if (to === 'open' && !isURL) { toast('Only links can be opened. Choose Clipboard or Note for text.', 'error'); return; }
      const r = await call('send', isURL ? { url: v.trim(), to } : { text: v, to });
      toast((r && r.message) || 'Sent', 'success');
      text.value = '';
    });

    return h('div', {}, header('Send to Mac', 'Text, links and photos from this iPhone.'),
      h('div', { class: 'stack' },
        segmented([['clipboard', 'Clipboard'], ['note', 'Note'], ['open', 'Open link']], to, (v) => { to = v; hint.textContent = HINTS[v]; }),
        h('div', {}, text, hint),
        sendBtn),
      sectionTitle('Photo'),
      picker,
      button('Choose a photo', { icon: 'photo', class: 'btn-soft btn-block' }, async () => { picker.click(); }),
      preview);
  }

  // ---------- Clipboard ----------

  /** Copy without navigator.clipboard (not available on plain http): a selected textarea and execCommand. */
  function copyText(t) {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.className = 'copy-buffer';
    ta.setAttribute('aria-hidden', 'true');
    ta.contentEditable = 'true';
    document.body.appendChild(ta);
    const range = document.createRange();
    range.selectNodeContents(ta);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    ta.setSelectionRange(0, t.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    sel.removeAllRanges();
    return ok;
  }

  function Clipboard() {
    const mac = h('textarea', { class: 'field short', readonly: true, placeholder: 'Loading', 'aria-label': 'Mac clipboard' });
    const macState = h('div', {});
    const paste = h('textarea', { class: 'field short', placeholder: 'Tap and hold here, then Paste', 'aria-label': 'Text to send to the Mac clipboard' });
    const history = h('div', {});
    let macText = '';

    async function load() {
      clear(macState);
      try {
        const r = await call('clipboard.get');
        macText = (r && r.text) || '';
        mac.value = macText;
        mac.placeholder = 'The Mac clipboard has no text';
      } catch (e) {
        mac.value = '';
        mac.placeholder = '';
        if (e.code === 'unpaired') return fail(e);
        macState.appendChild(h('div', { class: 'notice' + (e.code === 'denied' ? '' : ' error') }, explain(e)));
      }
    }

    async function loadHistory() {
      clear(history);
      try {
        const r = await call('clipboard.history', { limit: 15 });
        const items = ((r && r.items) || []).filter((x) => x.text);
        if (!items.length) return;
        history.appendChild(sectionTitle('Recent on the Mac'));
        const ul = h('ul', { class: 'rows' });
        for (const it of items) {
          const b = h('button', { class: 'rowbtn', type: 'button' }, h('span', { class: 'icon' }, icon('copy')),
            h('span', { class: 'text' }, h('div', { class: 'title' }, String(it.text).replace(/\s+/g, ' ').slice(0, 120)), it.title && it.title !== it.text ? h('div', { class: 'sub' }, it.title) : null));
          b.addEventListener('click', () => { toast(copyText(String(it.text)) ? 'Copied to this iPhone' : "Couldn't copy. Tap and hold the text instead.", 'success'); });
          ul.appendChild(h('li', {}, b));
        }
        history.appendChild(h('div', { class: 'panel tight' }, ul));
      } catch (e) { /* history is optional; the main box already explains a denied clipboard */ }
    }

    const copyBtn = h('button', { class: 'btn btn-primary', type: 'button' }, icon('copy'), h('span', {}, 'Copy to iPhone'));
    copyBtn.addEventListener('click', () => {
      if (!macText) { toast('There is no text to copy.', 'error'); return; }
      if (copyText(macText)) toast('Copied to this iPhone', 'success');
      else { mac.focus(); mac.select(); toast('Tap and hold the text, then tap Copy.'); }
    });

    const page = h('div', {}, header('Clipboard', 'Move text between this iPhone and your Mac.'),
      sectionTitle('Mac clipboard'),
      h('div', { class: 'stack' }, mac, macState, h('div', { class: 'grid2' }, copyBtn,
        button('Refresh', { icon: 'refresh', class: 'btn-soft' }, async () => { await load(); }))),
      sectionTitle('Send to the Mac'),
      h('div', { class: 'stack' }, paste,
        button('Send to the Mac clipboard', { icon: 'send', class: 'btn-primary btn-block' }, async () => {
          if (!paste.value) { toast('Paste something first.', 'error'); return; }
          await call('clipboard.set', { text: paste.value });
          toast('Copied on the Mac', 'success');
          paste.value = '';
          load();
        })),
      history);
    load().then(loadHistory);
    if (state.focusPaste) { state.focusPaste = false; setTimeout(() => paste.focus(), 80); }
    return page;
  }

  // ---------- Remote ----------

  function Remote() {
    let mode = state.remoteMode || 'trackpad';
    const body = h('div', { style: 'margin-top:14px' });
    let lastErr = 0;
    function remoteFail(e) {
      if (Date.now() - lastErr < 3000) return;
      lastErr = Date.now();
      fail(e);
    }

    // Sequential sender: at most one pointer request in flight; deltas pile up meanwhile.
    const acc = { mx: 0, my: 0, sx: 0, sy: 0 };
    let inflight = false;
    function pump() {
      if (inflight) return;
      let action = '', args = null;
      if (Math.abs(acc.mx) >= 1 || Math.abs(acc.my) >= 1) {
        args = { dx: Math.round(acc.mx), dy: Math.round(acc.my) };
        acc.mx -= args.dx; acc.my -= args.dy;
        action = 'pointer.move';
      } else if (Math.abs(acc.sx) >= 1 || Math.abs(acc.sy) >= 1) {
        args = { dx: Math.round(acc.sx), dy: Math.round(acc.sy) };
        acc.sx -= args.dx; acc.sy -= args.dy;
        action = 'pointer.scroll';
      } else return;
      inflight = true;
      call(action, args, { timeout: 5000 }).catch(remoteFail).finally(() => { inflight = false; pump(); });
    }
    const queue = [];
    let queueBusy = false;
    function send(action, args) {
      queue.push([action, args]);
      if (queueBusy) return;
      queueBusy = true;
      (async () => {
        while (queue.length) {
          const [a, g] = queue.shift();
          try { await call(a, g, { timeout: 8000 }); } catch (e) { remoteFail(e); queue.length = 0; }
        }
        queueBusy = false;
      })();
    }

    function Trackpad() {
      const pad = h('div', { class: 'trackpad', role: 'application', 'aria-label': 'Trackpad' },
        h('div', { class: 'hint' }, 'Drag to move. Tap to click. Two fingers to scroll, or tap with two fingers to right-click.'));
      const pts = new Map();
      let moved = false, maxPts = 0, t0 = 0;
      function ripple(x, y) {
        const r = pad.getBoundingClientRect();
        const el = h('div', { class: 'ripple', style: 'left:' + (x - r.left) + 'px;top:' + (y - r.top) + 'px' });
        pad.appendChild(el);
        setTimeout(() => el.remove(), 400);
      }
      pad.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { pad.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        if (pts.size === 0) { moved = false; maxPts = 0; t0 = performance.now(); }
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
        maxPts = Math.max(maxPts, pts.size);
        pad.classList.add('active');
      });
      pad.addEventListener('pointermove', (e) => {
        const p = pts.get(e.pointerId);
        if (!p) return;
        e.preventDefault();
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        p.x = e.clientX; p.y = e.clientY;
        if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 8) moved = true;
        if (!moved) return;
        if (pts.size === 1) {
          const speed = Math.hypot(dx, dy);
          const k = 1.3 + Math.min(speed / 12, 2.2); // gentle acceleration
          acc.mx += dx * k; acc.my += dy * k;
        } else {
          acc.sx += dx / pts.size * 2; acc.sy += dy / pts.size * 2;
        }
        pump();
      });
      const end = (e) => {
        if (!pts.has(e.pointerId)) return;
        pts.delete(e.pointerId);
        if (pts.size > 0) return;
        pad.classList.remove('active');
        if (!moved && performance.now() - t0 < 350) {
          ripple(e.clientX, e.clientY);
          send('pointer.click', { button: maxPts >= 2 ? 'right' : 'left', double: false });
        }
      };
      pad.addEventListener('pointerup', end);
      pad.addEventListener('pointercancel', end);
      pad.addEventListener('contextmenu', (e) => e.preventDefault());
      return h('div', {}, pad,
        h('div', { class: 'grid3', style: 'margin-top:12px' },
          h('button', { class: 'btn btn-soft', type: 'button', onclick: () => send('pointer.click', { button: 'left', double: false }) }, 'Click'),
          h('button', { class: 'btn btn-soft', type: 'button', onclick: () => send('pointer.click', { button: 'left', double: true }) }, 'Double-click'),
          h('button', { class: 'btn btn-soft', type: 'button', onclick: () => send('pointer.click', { button: 'right', double: false }) }, 'Right-click')));
    }

    function Keyboard() {
      const mods = new Set();
      const modBtns = [];
      function press(key) {
        send('keys.press', { key, modifiers: Array.from(mods) });
        mods.clear();
        for (const b of modBtns) b.setAttribute('aria-pressed', 'false');
      }
      // Characters typed in a burst go out as one type.text call.
      let pending = '', flushTimer = 0;
      function typeChars(s) {
        if (!s) return;
        if (mods.size) { for (const ch of s) press(ch.toLowerCase()); return; }
        pending += s;
        clearTimeout(flushTimer);
        flushTimer = setTimeout(() => { const t = pending; pending = ''; if (t) send('type.text', { text: t }); }, 60);
      }
      onLeave(() => clearTimeout(flushTimer));
      const live = h('input', { class: 'field', type: 'text', placeholder: 'Tap here and type on the Mac', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'send', 'aria-label': 'Type on the Mac' });
      live.addEventListener('beforeinput', (e) => {
        const t = e.inputType;
        if (t === 'insertText' || t === 'insertReplacementText') { typeChars(e.data || (e.dataTransfer && e.dataTransfer.getData('text/plain')) || ''); e.preventDefault(); }
        else if (t === 'insertFromPaste') { typeChars((e.dataTransfer && e.dataTransfer.getData('text/plain')) || ''); e.preventDefault(); }
        else if (t === 'deleteContentBackward') { press('delete'); e.preventDefault(); }
        else if (t === 'insertLineBreak' || t === 'insertParagraph') { press('return'); e.preventDefault(); }
      });
      live.addEventListener('compositionend', (e) => { typeChars(e.data || ''); live.value = ''; });
      live.addEventListener('keydown', (e) => {
        const map = { Enter: 'return', Backspace: 'delete', Escape: 'escape', Tab: 'tab', ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
        if (map[e.key] && !e.isComposing) { e.preventDefault(); press(map[e.key]); }
      });
      live.addEventListener('input', () => { if (live.value) { typeChars(live.value); live.value = ''; } });

      const mod = (id, label) => {
        const b = h('button', { class: 'btn btn-outline mod', type: 'button', 'aria-pressed': 'false', 'aria-label': id }, label);
        b.addEventListener('click', () => { if (mods.has(id)) mods.delete(id); else mods.add(id); b.setAttribute('aria-pressed', String(mods.has(id))); });
        modBtns.push(b);
        return b;
      };
      const key = (k, label, ic) => h('button', { class: 'btn btn-soft', type: 'button', 'aria-label': k, onclick: () => press(k) }, ic ? icon(ic) : label);
      const block = h('textarea', { class: 'field short', placeholder: 'Or write a longer text here', 'aria-label': 'Text to type on the Mac' });
      return h('div', { class: 'stack' }, live,
        h('div', { class: 'grid4 keys' }, mod('cmd', '⌘ cmd'), mod('alt', '⌥ opt'), mod('ctrl', '⌃ ctrl'), mod('shift', '⇧ shift')),
        h('div', { class: 'grid4 keys' }, key('escape', 'esc'), key('tab', 'tab'), key('space', 'space'), key('delete', 'delete')),
        h('div', { class: 'grid4 keys' }, key('left', '', 'left'), key('up', '', 'up'), key('down', '', 'down'), key('right', '', 'right')),
        h('button', { class: 'btn btn-soft btn-block', type: 'button', onclick: () => press('return') }, 'return'),
        block,
        button('Type it on the Mac', { class: 'btn-primary btn-block' }, async () => {
          if (!block.value) { toast('Write something first.', 'error'); return; }
          await call('type.text', { text: block.value });
          block.value = '';
          toast('Typed on the Mac', 'success');
        }));
    }

    function Slides() {
      return h('div', { class: 'stack' },
        h('p', { class: 'small muted', style: 'margin:0 2px' }, 'Works with Keynote, PowerPoint, Google Slides and PDFs. Click into the slides on the Mac first.'),
        h('div', { class: 'grid2' },
          h('button', { class: 'btn btn-soft slide-btn', type: 'button', onclick: () => send('slides.prev', {}) }, icon('left'), 'Back'),
          h('button', { class: 'btn btn-primary slide-btn', type: 'button', onclick: () => send('slides.next', {}) }, 'Next', icon('right'))),
        h('div', { class: 'grid2' },
          h('button', { class: 'btn btn-soft', type: 'button', onclick: () => send('keys.press', { key: 'b', modifiers: [] }) }, 'Black screen'),
          h('button', { class: 'btn btn-soft', type: 'button', onclick: () => send('keys.press', { key: 'escape', modifiers: [] }) }, 'End show')));
    }

    function Media() {
      const m = (key, ic, label) => h('button', { class: 'btn btn-soft tall', type: 'button', 'aria-label': label, onclick: () => send('media', { key }) }, icon(ic), label);
      return h('div', { class: 'stack' },
        h('div', { class: 'grid3' }, m('prev', 'prev', 'Previous'), m('playpause', 'playpause', 'Play/Pause'), m('next', 'next', 'Next')),
        h('div', { class: 'grid3' }, m('voldown', 'voldown', 'Quieter'), m('mute', 'mute', 'Mute'), m('volup', 'volup', 'Louder')));
    }

    const views = { trackpad: Trackpad, keyboard: Keyboard, slides: Slides, media: Media };
    function show() { clear(body); body.appendChild(views[mode]()); }
    show();
    return h('div', {}, header('Remote', 'Control the Mac from here. Works on the same Wi-Fi.'),
      segmented([['trackpad', 'Trackpad'], ['keyboard', 'Keys'], ['slides', 'Slides'], ['media', 'Media']], mode, (v) => { mode = v; state.remoteMode = v; show(); }),
      body);
  }

  // ---------- Files ----------

  function fmtSize(n) {
    if (!(n >= 0)) return '';
    if (n < 1024) return n + ' bytes';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0) + ' MB';
  }

  function Files() {
    const field = h('input', { class: 'field', type: 'search', placeholder: 'Search files on your Mac', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search', 'aria-label': 'Search files' });
    const results = h('div', { style: 'margin-top:12px' }, h('p', { class: 'empty' }, 'Search by file name. Tap a file to download it to this iPhone.'));
    const saved = h('div', {});
    let seq = 0, timer = 0;
    const urls = [];
    onLeave(() => { clearTimeout(timer); for (const u of urls) URL.revokeObjectURL(u); });

    async function download(f) {
      const r = await call('files.get', { path: f.path }, { timeout: 180000 });
      const bytes = window.GlideCrypto.fromB64(r.data || '');
      const blob = new Blob([bytes], { type: r.type || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const name = r.name || f.name || 'file';
      const a = h('a', { class: 'btn btn-primary btn-block', href: url, download: name }, icon('download'), h('span', {}, 'Save ' + name));
      clear(saved);
      saved.appendChild(h('div', { class: 'panel stack', style: 'margin-top:12px' },
        h('div', { class: 'small muted' }, 'Downloaded ' + fmtSize(bytes.length) + '. Tap to save or share it.'), a));
      a.click();
    }

    async function search(q) {
      const my = ++seq;
      clear(results).appendChild(h('p', { class: 'empty' }, h('span', { class: 'spinner' }), '  Searching'));
      try {
        const r = await call('files.search', { query: q, limit: 40 }, { timeout: 20000 });
        if (my !== seq) return;
        clear(results);
        const files = (r && r.files) || [];
        if (!files.length) { results.appendChild(h('p', { class: 'empty' }, 'No files found for "' + q + '".')); return; }
        const ul = h('ul', { class: 'rows' });
        for (const f of files) {
          const folder = String(f.path || '').replace(/\/[^/]*$/, '').replace(/^\/Users\/[^/]+/, '~');
          const b = h('button', { class: 'rowbtn', type: 'button' }, h('span', { class: 'icon' }, icon('file')),
            h('span', { class: 'text' }, h('div', { class: 'title' }, f.name), h('div', { class: 'sub' }, [fmtSize(f.size), f.kind, folder].filter(Boolean).join(', '))),
            icon('download'));
          b.addEventListener('click', () => busy(b, () => download(f)));
          ul.appendChild(h('li', {}, b));
        }
        results.appendChild(h('div', { class: 'panel tight' }, ul));
      } catch (e) {
        if (my !== seq) return;
        clear(results);
        if (e.code === 'unpaired') return fail(e);
        results.appendChild(h('div', { class: 'notice' + (e.code === 'denied' ? '' : ' error') }, explain(e)));
      }
    }
    field.addEventListener('input', () => {
      clearTimeout(timer);
      const q = field.value.trim();
      if (q.length < 2) return;
      timer = setTimeout(() => search(q), 350);
    });
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); const q = field.value.trim(); if (q.length >= 2) search(q); field.blur(); } });
    return h('div', {}, header('Files', 'Find a file on your Mac and download it. Files up to 25 MB.'),
      h('div', { class: 'search-wrap' }, icon('search'), field), saved, results);
  }

  // ---------- Agent ----------

  function loadChat() {
    try { const c = JSON.parse(localStorage.getItem('glide.chat') || '[]'); return Array.isArray(c) ? c.slice(-40) : []; } catch (e) { return []; }
  }
  function saveChat() { try { localStorage.setItem('glide.chat', JSON.stringify(state.chat.slice(-40))); } catch (e) { /* ignore */ } }

  function Agent() {
    let mode = state.approveId ? 'approvals' : 'chat';
    const body = h('div', { style: 'margin-top:14px' });
    let seg;

    function approvalCard(p, after) {
      const focus = state.approveId && p.id === state.approveId;
      const answer = (decision, label, cls) => button(label, { class: cls }, async () => {
        const r = await call('approvals.respond', { id: p.id, decision }, { timeout: 120000 });
        toast(decision === 'deny' ? 'Denied' : 'Allowed', 'success');
        if (state.approveId === p.id) state.approveId = '';
        if (r && r.text) { state.chat.push({ who: 'them', text: String(r.text) }); saveChat(); }
        after(r);
      });
      const when = p.at ? new Date(p.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
      return h('div', { class: 'panel approval' + (focus ? ' focus' : ''), id: 'approval-' + p.id },
        h('div', { style: 'font-weight:600' }, p.title || p.action || 'Request'),
        p.summary ? h('div', { class: 'small', style: 'margin-top:4px;white-space:pre-wrap' }, String(p.summary)) : null,
        h('div', { class: 'small muted', style: 'margin-top:4px' }, [p.source === 'agent' ? 'Glide Agent' : p.deviceName, when].filter(Boolean).join(', ')),
        h('div', { class: 'grid3', style: 'margin-top:12px' },
          answer('allow', 'Allow', 'btn-primary'), p.source === 'agent' ? null : answer('always', 'Always', 'btn-soft'), answer('deny', 'Deny', 'btn-soft btn-error')));
    }

    async function Approvals() {
      const box = h('div', {}, h('p', { class: 'empty' }, h('span', { class: 'spinner' }), '  Loading'));
      clear(body).appendChild(box);
      try {
        const r = await call('approvals.list');
        const list = (r && r.pending) || [];
        clear(box);
        if (state.approveId && !list.some((p) => p.id === state.approveId)) {
          box.appendChild(h('div', { class: 'notice', style: 'margin-bottom:12px' }, 'That request was already answered or has expired.'));
          state.approveId = '';
        }
        if (!list.length) { box.appendChild(h('p', { class: 'empty' }, 'Nothing is waiting for your approval.')); return; }
        for (const p of list) box.appendChild(approvalCard(p, () => Approvals()));
        const f = state.approveId && document.getElementById('approval-' + state.approveId);
        if (f) f.scrollIntoView({ block: 'center' });
      } catch (e) {
        clear(box);
        if (e.code === 'unpaired') return fail(e);
        box.appendChild(h('div', { class: 'notice' }, e.code === 'not-found' ? "Approvals aren't available in the Glide on this Mac yet. Update Glide on the Mac." : explain(e)));
      }
    }

    function Chat() {
      const log = h('div', { class: 'chat' });
      const draw = () => {
        clear(log);
        if (!state.chat.length) log.appendChild(h('p', { class: 'empty' }, 'Ask Glide Agent to do something on your Mac. Anything that changes something asks you first.'));
        for (const m of state.chat) log.appendChild(h('div', { class: 'bubble ' + m.who + (m.pending ? ' pending' : '') }, m.text));
      };
      const input = h('textarea', { class: 'field short', placeholder: 'Ask Glide Agent', 'aria-label': 'Message for Glide Agent', enterkeyhint: 'send' });
      const pendingBox = h('div', { class: 'stack', style: 'margin-top:12px' });
      function showPending(list) {
        clear(pendingBox);
        for (const p of list || []) pendingBox.appendChild(approvalCard(Object.assign({ source: 'agent' }, p), (r) => { draw(); showPending(r && r.pending); }));
      }
      const ask = button('Ask', { icon: 'send', class: 'btn-primary btn-block' }, async () => {
        const prompt = input.value.trim();
        if (!prompt) { toast('Write a question first.', 'error'); return; }
        state.chat.push({ who: 'me', text: prompt });
        const thinking = { who: 'them', text: 'Thinking', pending: true };
        state.chat.push(thinking);
        input.value = '';
        draw();
        try {
          const r = await call('agent.ask', { prompt }, { timeout: 180000 });
          thinking.pending = false;
          thinking.text = (r && r.text) || (r && r.pending && r.pending.length ? 'Glide Agent needs your approval to continue.' : 'Done.');
          showPending(r && r.pending);
        } catch (e) {
          state.chat.splice(state.chat.indexOf(thinking), 1);
          if (e.code === 'not-found') toast("Glide Agent isn't available in the Glide on this Mac yet. Update Glide on the Mac.", 'error');
          else fail(e);
        }
        saveChat();
        draw();
      });
      draw();
      return h('div', {}, log, pendingBox, h('div', { class: 'stack', style: 'margin-top:16px' }, input, ask,
        state.chat.length ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { state.chat = []; saveChat(); draw(); } }, 'Clear conversation') : null));
    }

    function show() { if (mode === 'chat') clear(body).appendChild(Chat()); else Approvals(); }
    seg = segmented([['chat', 'Chat'], ['approvals', 'Approvals']], mode, (v) => { mode = v; show(); });
    show();
    return h('div', {}, header('Glide Agent', 'Ask the agent on your Mac, and approve what it wants to do.'), seg, body);
  }

  // ---------- More, Settings ----------

  function More() {
    const row = (route, ic, title, sub) => h('li', {}, h('a', { class: 'rowbtn', href: '#/' + route, style: 'color:inherit;text-decoration:none' },
      h('span', { class: 'icon' }, icon(ic)), h('span', { class: 'text' }, h('div', { class: 'title' }, title), h('div', { class: 'sub' }, sub)), icon('chevron')));
    return h('div', {}, header('More'),
      h('div', { class: 'panel tight' }, h('ul', { class: 'rows' },
        row('clipboard', 'clipboard', 'Clipboard', 'See and send the Mac clipboard'),
        row('files', 'files', 'Files', 'Find a file and download it'),
        row('agent', 'agent', 'Glide Agent', 'Chat and approvals'),
        row('settings', 'settings', 'Settings', 'This iPhone, your Mac, unpair'))));
  }

  function Settings() {
    const p = Pairing.load() || {};
    const name = h('input', { class: 'field', type: 'text', value: p.name || deviceName(), maxlength: '40', 'aria-label': 'Name of this iPhone', autocomplete: 'off' });
    const groupsBox = h('div', {});
    const macBox = h('div', {});

    function drawHello(r) {
      clear(macBox);
      const mac = (r && r.mac) || {};
      macBox.appendChild(h('div', { class: 'panel stack' },
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { style: 'font-weight:600' }, mac.name || p.mac || 'Mac'),
          h('div', { class: 'small muted' }, mac.version ? 'Glide ' + mac.version : ''))),
        h('div', {}, h('div', { class: 'label' }, 'Address'), h('div', { class: 'mono' }, location.host || p.base || '')),
        h('p', { class: 'small muted', style: 'margin:0' }, 'Glide Remote works when this iPhone is on the same Wi-Fi as the Mac.')));
      clear(groupsBox);
      if (r && r.groups) {
        groupsBox.appendChild(sectionTitle('Turned on in Glide'));
        const ul = h('ul', { class: 'rows' });
        for (const [id, label] of Object.entries(SWITCHES)) {
          const on = !!r.groups[id];
          ul.appendChild(h('li', {}, h('div', { class: 'rowbtn', style: 'cursor:default' }, h('span', { class: 'text' }, h('div', { class: 'title' }, label)),
            h('span', { class: 'badge ' + (on ? 'badge-success' : 'badge-ghost') }, on ? 'On' : 'Off'))));
        }
        groupsBox.appendChild(h('div', { class: 'panel tight' }, ul));
        groupsBox.appendChild(h('p', { class: 'small muted', style: 'margin:8px 4px' }, 'Change these on the Mac in Glide, then Settings, then iPhone.'));
      }
    }

    const homeScreen = h('div', {});
    const standalone = window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    if (!standalone) {
      homeScreen.appendChild(sectionTitle('Home Screen'));
      const info = h('p', { class: 'small', style: 'margin:0' }, 'A Home Screen icon opens Glide Remote like an app. The icon keeps its own copy of this pairing.');
      homeScreen.appendChild(h('div', { class: 'panel stack' }, info,
        button('Get ready to add to Home Screen', { class: 'btn-soft btn-block' }, async () => {
          const cur = Pairing.load();
          if (!cur) return;
          history.replaceState(null, '', '#pair=' + cur.deviceId + '.' + cur.key);
          info.textContent = 'Now tap the Share button, then Add to Home Screen. The link includes this pairing, so only add it on your own iPhone.';
          onLeave(() => { if (/^#pair=/.test(location.hash)) history.replaceState(null, '', '#/settings'); });
        })));
    }

    drawHello(state.hello);
    call('hello', { name: p.name || deviceName() }, { timeout: 15000 }).then((r) => { state.hello = r; drawHello(r); }).catch((e) => { if (e.code === 'unpaired') fail(e); });

    return h('div', {}, header('Settings'),
      sectionTitle('This iPhone'),
      h('div', { class: 'panel stack' }, h('label', { class: 'label', for: 'device-name' }, 'Name'), name,
        button('Save name', { class: 'btn-soft btn-block' }, async () => {
          const v = name.value.trim();
          if (!v) { toast('Enter a name.', 'error'); return; }
          const r = await call('hello', { name: v });
          Pairing.update({ name: v });
          state.hello = r;
          const macSide = r && r.device && r.device.name;
          toast(macSide && macSide !== v ? 'Saved here. The Mac calls it "' + macSide + '"; rename it in Glide, then Settings, then iPhone.' : 'Saved', 'success');
        })),
      sectionTitle('Mac'),
      macBox,
      groupsBox,
      homeScreen,
      sectionTitle('Unpair'),
      h('div', { class: 'panel stack' },
        h('p', { class: 'small', style: 'margin:0' }, 'Forget this Mac on this iPhone. To remove the iPhone from the Mac too, open Glide on the Mac, then Settings, then iPhone.'),
        h('button', { class: 'btn btn-error btn-soft btn-block', type: 'button', onclick: () => {
          if (!window.confirm('Unpair from ' + (p.mac || 'this Mac') + '?')) return;
          Pairing.clear();
          state.hello = null;
          toast('Unpaired');
          render();
        } }, 'Unpair')));
  }

  // ---------- boot ----------

  function readFragment() {
    const raw = location.hash.replace(/^#/, '');
    if (!raw || raw.startsWith('/')) return false;
    const params = new URLSearchParams(raw);
    if (params.get('pair')) {
      const p = Pairing.parse(params.get('pair'));
      // The key leaves the address bar right away; it lives only in this page's storage after pairing.
      history.replaceState(null, '', location.pathname + location.search + '#/home');
      if (p) { pairWith(p); return true; }
      toast("That pairing link isn't complete. Scan the code on the Mac again.", 'error');
      return false;
    }
    if (params.get('approve')) {
      state.approveId = params.get('approve').slice(0, 80);
      history.replaceState(null, '', location.pathname + location.search + '#/agent');
      return false;
    }
    return false;
  }

  window.addEventListener('hashchange', () => { if (!readFragment()) render(); });
  if (!readFragment()) render();

  // Test hooks for the headless browser E2E (no effect in normal use).
  window.GlideRemote = { state, render, go, copyText, explain };
})();
