// Volume widget, tablet side: per-app volume sliders with live levels. PC side: plugin.py next to this file.
PBW.mount('volume', (ctx) => {
  'use strict';
  const { h, btn, clamp, q, COLORS } = PBW;
  const root = ctx.root;
  const WID = ctx.id;
  const POLL_MS = 250;
  const showError = (e) => ctx.error(e);

  // linear peak (0..1) -> meter position, -54 dB .. 0 dB, so quiet audio still shows
  const meterOf = (p) => (p > 0.0005 ? clamp((20 * Math.log10(p) + 54) / 54, 0, 1) : 0);
  const iconOf = (src) => (src.includes('master') ? 'volume-2' : src.includes('games') && src.length === 1 ? 'gamepad-2' : src.length === 1 && src[0] === 'system' ? 'bell' : null);
  const autoName = (src) => {
    if (!src.length) return 'Empty slider';
    if (src[0] === 'master') return 'Master';
    if (src.length === 1 && src[0] === 'games') return 'Games';
    if (src.length === 1 && src[0] === 'system') return 'System';
    if (src.length === 1) return labelOf(src[0]);
    return 'Mix';
  };
  let appsCache = []; // [{src, name, detail, running, game, installed}] from /api/apps
  const labelOf = (src) => (appsCache.find((a) => a.src === src)?.name)
    || (src.startsWith('dir:') ? src.slice(4).split('\\').pop() : src.slice(4).replace(/\.exe$/i, ''));

  // ------------------------------------------------------------------ styles
  const css = `
.vs{--bg:transparent;--fg:#eef2f6;--dim:#8a94a3;--line:rgba(255,255,255,.08);--track:rgba(255,255,255,.07);
  position:relative;box-sizing:border-box;height:100%;width:100%;display:flex;flex-direction:column;color:var(--fg);
  font:12px/1.25 Roboto,"Segoe UI",system-ui,sans-serif;user-select:none;-webkit-user-select:none;overflow:hidden;padding:6px 8px 8px}
.vs-head{display:flex;align-items:center;gap:6px;height:18px;flex:none;margin-bottom:4px}
.vs-title{flex:1;min-width:0;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vs-off{display:none;font-size:10px;color:#f87171}.vs.offline .vs-off{display:inline}
.vs.offline .vs-list{opacity:.35;pointer-events:none}
.vs-gear{width:24px;height:22px;margin:-2px -5px -2px 0;display:grid;place-items:center;opacity:.45;font-size:14px;border-radius:6px;flex:none;
  -webkit-text-size-adjust:100%;text-size-adjust:100%}
.vs .vs-gear .ico{width:14px;height:14px}
.vs-gear:active{background:var(--track);opacity:1}
.vs-list{flex:1;min-height:0;display:flex;gap:8px}
.vs-v .vs-list{flex-direction:row;overflow-x:auto;overflow-y:hidden}
.vs-h .vs-list{display:grid;gap:6px 14px;align-content:center;overflow-y:auto;overflow-x:hidden}
.vs-compact{padding:4px 30px 4px 8px}
.vs-compact .vs-head{position:absolute;top:4px;right:4px;height:auto;margin:0;z-index:2}
.vs-compact .vs-title{display:none}
.vs-empty{flex:1;display:grid;place-items:center;text-align:center;color:var(--dim)}
.vs-empty button{margin-top:8px;padding:8px 14px;border-radius:10px;background:var(--track);color:var(--fg)}
/* one fader */
.ch{--c:#2dd4bf;--v:0;--m:0;--hold:0;display:grid;min-width:0;min-height:0;transition:opacity .3s}
.ch.off{opacity:.42}
.vs-v .ch{flex:1 1 0;min-width:52px;max-width:140px;grid-template-rows:auto 1fr auto auto;grid-template-areas:"pct" "body" "name" "mute";gap:5px;margin:0 auto}
.vs-h .ch{min-height:22px;max-height:64px;grid-template-columns:minmax(64px,30%) 1fr 30px auto;grid-template-areas:"name body pct mute";align-items:center;gap:8px}
.vs .ch-mute{grid-area:mute;display:grid;place-items:center;border-radius:8px;background:var(--track);font-size:1em;line-height:1;touch-action:manipulation}
.vs-v .ch-mute{height:max(26px,1.9em);width:100%;max-width:64px;justify-self:center}
.vs-h .ch-mute{width:max(28px,2em);height:max(22px,1.6em);align-self:center}
.vs .ch-mute:active{filter:brightness(1.4)}
.vs .ch.muted .ch-mute{background:#7f1d1d;color:#fecaca}
.vs-compact .ch-sub{display:none}
.ch-pct{grid-area:pct;text-align:center;font-variant-numeric:tabular-nums;font-weight:600;font-size:1.05em}
.vs-h .ch-pct{text-align:right}
.ch-body{grid-area:body;display:flex;gap:4px;min-width:0;min-height:0}
.vs-v .ch-body{flex-direction:row;justify-content:center}
.vs-h .ch-body{flex-direction:column;justify-content:center;height:100%}
.ch-track{position:relative;background:var(--track);border-radius:9px;overflow:hidden;touch-action:none;cursor:pointer}
.vs-v .ch-track{width:clamp(26px,55%,58px);height:100%}
.vs-h .ch-track{height:clamp(18px,60%,30px);width:100%}
.ch-fill{position:absolute;left:0;bottom:0;background:var(--c);opacity:.9;border-radius:inherit;transition:background .2s}
.vs-v .ch-fill{right:0;height:calc(var(--v)*100%)}
.vs-h .ch-fill{top:0;width:calc(var(--v)*100%)}
.ch-knob{position:absolute;background:#fff;border-radius:2px;opacity:.9;pointer-events:none}
.vs-v .ch-knob{left:22%;right:22%;height:3px;bottom:calc(var(--v)*100% - 1.5px)}
.vs-h .ch-knob{top:22%;bottom:22%;width:3px;left:calc(var(--v)*100% - 1.5px)}
.ch.muted .ch-fill{background:repeating-linear-gradient(135deg,#4b5563 0 6px,#374151 6px 12px)}
.ch.drag .ch-fill{opacity:1}
/* the amplitude bar */
.ch-meter{position:relative;background:var(--track);border-radius:3px;overflow:hidden;flex:none}
.vs-v .ch-meter{width:7px;height:100%}
.vs-h .ch-meter{height:6px;width:100%}
.ch-lvl{position:absolute;inset:0;transition:clip-path 90ms linear}
.vs-v .ch-lvl{background:linear-gradient(to top,#22c55e 0%,#22c55e 62%,#eab308 82%,#ef4444 100%);clip-path:inset(calc((1 - var(--m))*100%) 0 0 0)}
.vs-h .ch-lvl{background:linear-gradient(to right,#22c55e 0%,#22c55e 62%,#eab308 82%,#ef4444 100%);clip-path:inset(0 calc((1 - var(--m))*100%) 0 0)}
.ch-hold{position:absolute;background:#fff;opacity:.75}
.vs-v .ch-hold{left:0;right:0;height:2px;bottom:calc(var(--hold)*100% - 2px)}
.vs-h .ch-hold{top:0;bottom:0;width:2px;left:calc(var(--hold)*100% - 2px)}
.ch.muted .ch-lvl{filter:grayscale(1);opacity:.5}
/* name / mute button */
.ch-name{grid-area:name;display:flex;flex-direction:column;align-items:center;min-width:0;padding:3px 2px;border-radius:8px;text-align:center}
.vs-h .ch-name{align-items:flex-start;text-align:left;padding:2px 4px}
.ch-row{display:flex;align-items:center;gap:5px;max-width:100%;min-width:0}
.ch-dot{width:8px;height:8px;border-radius:50%;background:var(--c);flex:none;opacity:.35;transition:opacity .25s,box-shadow .25s}
.ch.live .ch-dot{opacity:1;box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 30%,transparent),0 0 10px var(--c)}
.ch-ico{flex:none;font-size:1.05em;line-height:1}
.ch-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;min-width:0}
.ch-sub{font-size:.82em;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;min-height:1.2em}
.ch.muted .ch-label{color:#f87171}

`;
  PBW.css('volume', css);

  // ------------------------------------------------------------------ fader view
  root.classList.add('vs');
  const title = h('span', 'vs-title');
  const off = h('span', 'vs-off', '● offline');
  const gear = btn('vs-gear', PBW.icon('settings'), () => openEditor(), 'Choose sliders');
  const list = h('div', 'vs-list');
  root.replaceChildren(h('div', 'vs-head', title, off, gear), list);

  let state = null;
  let editor = null;
  const views = new Map();
  let seq = Date.now();

  function makeView(id) {
    const v = { id, m: 0, hold: 0, holdAt: 0, liveAt: 0, drag: false, local: null, localUntil: 0, mute: null, muteUntil: 0, lastSend: 0, timer: 0, ch: null, cache: {} };
    const pct = h('div', 'ch-pct');
    const fill = h('div', 'ch-fill'), knob = h('div', 'ch-knob');
    const track = h('div', 'ch-track', fill, knob);
    const meter = h('div', 'ch-meter', h('div', 'ch-lvl'), h('div', 'ch-hold'));
    const ico = h('span', 'ch-ico'), label = h('span', 'ch-label'), sub = h('div', 'ch-sub');
    const name = h('div', 'ch-name', h('div', 'ch-row', h('span', 'ch-dot'), ico, label), sub);
    const muteBtn = btn('ch-mute', PBW.icon('volume-2'), () => toggleMute(v), 'Mute');
    const el = h('div', 'ch', pct, h('div', 'ch-body', track, meter), name, muteBtn);
    Object.assign(v, { el, pct, track, ico, label, sub, name, muteBtn });

    const setFrom = (e) => {
      const r = track.getBoundingClientRect();
      const vertical = root.classList.contains('vs-v');
      const f = vertical ? (r.bottom - e.clientY) / r.height : (e.clientX - r.left) / r.width;
      v.local = Math.round(clamp(f, 0, 1) * 100);
      paint(v);
      sendLevel(v, false);
    };
    track.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { track.setPointerCapture(e.pointerId); } catch (_) {}
      v.drag = true;
      el.classList.add('drag');
      setFrom(e);
    });
    track.addEventListener('pointermove', (e) => { if (v.drag) setFrom(e); });
    const end = () => {
      if (!v.drag) return;
      v.drag = false;
      el.classList.remove('drag');
      v.localUntil = Date.now() + 1500;
      sendLevel(v, true);
    };
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
    track.addEventListener('lostpointercapture', end);
    return v;
  }

  function sendLevel(v, final) {
    clearTimeout(v.timer);
    const now = Date.now();
    const go = () => {
      v.lastSend = Date.now();
      ctx.post('set', { ch: v.id, v: v.local, seq: ++seq }).catch(showError);
    };
    if (final || now - v.lastSend > 80) go();
    else v.timer = setTimeout(go, 80 - (now - v.lastSend));
  }

  function toggleMute(v) {
    if (!v.ch) return;
    const muted = !(v.mute != null && Date.now() < v.muteUntil ? v.mute : v.ch.muted);
    v.mute = muted;
    v.muteUntil = Date.now() + 1500;
    paint(v);
    ctx.post('set', { ch: v.id, m: muted ? 1 : 0 }).catch(showError);
  }

  const setVar = (v, k, val) => { if (v.cache[k] !== val) { v.cache[k] = val; v.el.style.setProperty(k, val); } };
  const setText = (v, k, el, val) => { if (v.cache[k] !== val) { v.cache[k] = val; el.textContent = val; } };
  const setIcon = (v, k, el, name) => { if (v.cache['i' + k] !== name) { v.cache['i' + k] = name; el.replaceChildren(name ? PBW.icon(name) : ''); } };
  const setClass = (v, k, on) => { if (v.cache['c' + k] !== on) { v.cache['c' + k] = on; v.el.classList.toggle(k, on); } };

  function paint(v) {
    const ch = v.ch;
    if (!ch) return;
    const now = Date.now();
    const vol = v.drag || now < v.localUntil ? v.local : ch.volume;
    const muted = v.mute != null && now < v.muteUntil ? v.mute : ch.muted;
    setVar(v, '--v', String(vol / 100));
    setVar(v, '--c', ch.color);
    setText(v, 'pct', v.pct, String(vol));
    setText(v, 'label', v.label, ch.name);
    const icon = muted ? 'volume-x' : iconOf(ch.sources);
    setIcon(v, 'ico', v.ico, icon);
    v.ico.hidden = !icon;
    let sub = '';
    if (!ch.running) sub = ch.sources.includes('games') && ch.sources.length === 1 ? 'no game running' : 'not running';
    else if (ch.sources[0] === 'master' || ch.sources.length > 1 || ch.sources[0] === 'games') sub = ch.count > 2 ? `${ch.apps[0]} +${ch.count - 1}` : ch.apps.join(', ');
    if (sub === ch.name) sub = '';
    setText(v, 'sub', v.sub, sub);
    setClass(v, 'muted', !!muted);
    setClass(v, 'off', !ch.running && ch.sources[0] !== 'master');
    v.name.title = ch.name + (ch.apps.length ? ' — ' + ch.apps.join(', ') : '');
    setIcon(v, 'muteBtn', v.muteBtn, muted ? 'volume-x' : 'volume-2');
    v.muteBtn.title = (muted ? 'Unmute ' : 'Mute ') + ch.name;
    v.muteBtn.setAttribute('aria-pressed', String(!!muted));
  }

  // Picks the orientation (and, for horizontal faders, how many columns) that gives the longest usable fader.
  function layoutOf(n) {
    n = Math.max(1, n);
    const pref = state?.layout || 'auto';
    const w = list.clientWidth || root.clientWidth, hgt = list.clientHeight || root.clientHeight - 28;
    const vertical = { mode: 'vertical', cols: n, score: w / n >= 50 ? (hgt - 86) * 1.25 : -1 }; // a mixer look wins ties
    let horizontal = { mode: 'horizontal', cols: 1, score: -1 };
    for (let k = 1; k <= n; k++) {
      const rows = Math.ceil(n / k);
      const rowH = (hgt - (rows - 1) * 6) / rows, colW = (w - (k - 1) * 14) / k;
      const score = rowH >= 22 && colW >= 180 ? colW * 0.7 - 76 : -1;
      if (score > horizontal.score) horizontal = { mode: 'horizontal', cols: k, score };
    }
    // a chosen layout is used whenever it fits; on a widget too small for it, the automatic choice takes over
    if (pref === 'vertical' && hgt - 86 >= 40) return { ...vertical, score: 1 };
    if (pref === 'horizontal' && horizontal.score > 0) return horizontal;
    if (vertical.score <= 0 && horizontal.score <= 0) return { mode: 'horizontal', cols: 1 };
    return vertical.score >= horizontal.score ? vertical : horizontal;
  }

  function render() {
    if (!state) return;
    title.textContent = state.title || '';
    const chans = state.channels || [];
    root.classList.toggle('vs-compact', root.clientHeight < 84);
    const lay = layoutOf(chans.length), mode = lay.mode;
    root.classList.toggle('vs-v', mode === 'vertical');
    root.classList.toggle('vs-h', mode !== 'vertical');
    list.style.gridTemplateColumns = mode === 'vertical' ? '' : `repeat(${lay.cols}, minmax(0, 1fr))`;
    if (!chans.length) {
      views.clear();
      if (!list.querySelector('.vs-empty'))
        list.replaceChildren(h('div', 'vs-empty', h('div', null, 'No sliders yet', h('br'), btn('', '+ Choose sliders', () => openEditor()))));
      return;
    }
    const nodes = chans.map((ch) => {
      let v = views.get(ch.id);
      if (!v) { v = makeView(ch.id); views.set(ch.id, v); }
      v.ch = ch;
      if (ch.peak > 0.0015) v.liveAt = Date.now();
      paint(v);
      return v.el;
    });
    for (const id of [...views.keys()]) if (!chans.some((c) => c.id === id)) views.delete(id);
    // keep existing nodes (a drag must survive a refresh)
    if (nodes.length !== list.children.length || nodes.some((n, i) => list.children[i] !== n)) list.replaceChildren(...nodes);
    // a single slider gets bigger text
    const per = mode === 'vertical' ? list.clientWidth / chans.length : list.clientHeight / Math.ceil(chans.length / lay.cols);
    root.style.fontSize = clamp(Math.round(per / (mode === 'vertical' ? 7 : 3.4)), 11, chans.length === 1 ? 20 : 15) + 'px';
  }

  // meters: smooth between polls, fast attack / slow release, with a peak-hold line
  function frame() {
    const now = Date.now();
    for (const v of views.values()) {
      if (!v.ch) continue;
      const muted = v.mute != null && now < v.muteUntil ? v.mute : v.ch.muted;
      const target = muted ? 0 : meterOf(v.ch.peak);
      v.m += (target - v.m) * (target > v.m ? 0.6 : 0.09);
      if (v.m < 0.004) v.m = 0;
      if (v.m >= v.hold) { v.hold = v.m; v.holdAt = now; } else if (now - v.holdAt > 900) v.hold = Math.max(v.m, v.hold - 0.012);
      setVar(v, '--m', v.m.toFixed(3));
      setVar(v, '--hold', v.hold.toFixed(3));
      setClass(v, 'live', !muted && now - v.liveAt < 1200);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  let fails = 0, pollTimer = 0;
  async function poll() {
    clearTimeout(pollTimer);
    if (document.hidden) { pollTimer = setTimeout(poll, 1000); return; }
    try {
      state = await ctx.api('state');
      fails = 0;
      root.classList.remove('offline');
      off.textContent = '● ' + (state.error ? 'PhoneBox agent offline' : 'offline');
      root.classList.toggle('offline', !!state.error);
      render();
    } catch (_) {
      fails++;
      off.textContent = '● bridge offline';
      root.classList.add('offline');
    }
    pollTimer = setTimeout(poll, fails ? Math.min(5000, 600 * fails) : POLL_MS);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  new ResizeObserver(() => render()).observe(root);
  poll();


  // ------------------------------------------------------------------ editor
  function openEditor() {
    if (editor) return;
    const draft = JSON.parse(JSON.stringify(state?.config || { layout: 'auto', title: '', channels: [] }));
    draft.channels = draft.channels || [];
    const el = h('div', 'ed');
    root.append(el);
    editor = { el, draft };
    loadApps();
    showList();
  }
  const loadApps = () => ctx.api('apps').then((r) => { appsCache = r.apps || []; if (editor && editor.screen) editor.screen(); }).catch(() => {});
  const closeEditor = () => { editor?.el.remove(); editor = null; render(); };

  function screen(titleText, actions, ...body) {
    const b = h('div', 'ed-body', ...body);
    const old = editor.el.querySelector('.ed-body');
    const keep = old?.dataset.screen === titleText ? old.scrollTop : 0;
    b.dataset.screen = titleText;
    editor.el.replaceChildren(h('div', 'ed-head', h('b', null, titleText), ...actions), b);
    b.scrollTop = keep;
  }

  function summary(ch) {
    const parts = ch.sources.map((s) => s === 'games' ? 'all games' : s === 'system' ? 'system sounds' : s === 'master' ? 'whole PC' : labelOf(s));
    return parts.length ? parts.join(', ') : 'nothing selected';
  }

  function showList() {
    const d = editor.draft;
    editor.screen = showList;
    const seg = h('div', 'ed-seg', ...[['auto', 'Auto'], ['vertical', 'Vertical'], ['horizontal', 'Horizontal']].map(([k, l]) =>
      btn(k === d.layout ? 'on' : '', l, () => { d.layout = k; showList(); })));
    const titleIn = h('input');
    titleIn.type = 'text'; titleIn.placeholder = 'Title (optional)'; titleIn.value = d.title || ''; titleIn.maxLength = 40;
    titleIn.addEventListener('input', () => { d.title = titleIn.value; });
    const rows = d.channels.map((ch, i) => {
      const dot = h('span', 'ed-dot'); dot.style.background = ch.color;
      const row = h('div', 'ed-row check', dot,
        h('div', 'grow', h('div', 't', ch.name || autoName(ch.sources)), h('div', 's', summary(ch))),
        btn('ib', PBW.icon('chevron-up'), () => { if (i) { d.channels.splice(i - 1, 0, d.channels.splice(i, 1)[0]); showList(); } }, 'Move up'),
        btn('ib', PBW.icon('chevron-down'), () => { if (i < d.channels.length - 1) { d.channels.splice(i + 1, 0, d.channels.splice(i, 1)[0]); showList(); } }, 'Move down'),
        btn('ib', PBW.icon('x'), () => { d.channels.splice(i, 1); showList(); }, 'Remove'));
      row.addEventListener('click', () => showChannel(i));
      return row;
    });
    const save = btn('pill pri', 'Save', async () => {
      save.disabled = true;
      try { await ctx.saveConfig(d); state = await ctx.api('state'); views.clear(); closeEditor(); }
      catch (e) { save.disabled = false; showError(e); }
    });
    screen('Volume sliders', [btn('pill', 'Cancel', closeEditor), save],
      h('div', 'ed-sec', 'Sliders'),
      ...(rows.length ? rows : [h('div', 'ed-hint', 'No sliders yet. Add one for your games, your browser, music, voice chat…')]),
      btn('pill', '+ Add slider', () => {
        const used = new Set(d.channels.map((c) => c.color));
        d.channels.push({ id: 'c' + Math.random().toString(36).slice(2, 9), name: '', color: COLORS.find((c) => !used.has(c)) || COLORS[0], sources: [], applyOnStart: false, level: 100, _new: true });
        showChannel(d.channels.length - 1);
      }),
      h('div', 'ed-sec', 'Layout'), seg,
      h('div', 'ed-sec', 'Title'), titleIn,
      h('div', 'ed-sec', 'Games'),
      btn('pill', PBW.label('gamepad-2', 'Game detection…'), showGames),
      h('div', 'ed-hint', `Widget id “${WID}” · settings are kept by the bridge on the PC.`));
  }

  function showChannel(i) {
    const d = editor.draft;
    const orig = d.channels[i];
    const ch = editor.chDraft && editor.chIndex === i ? editor.chDraft : JSON.parse(JSON.stringify(orig));
    editor.chDraft = ch; editor.chIndex = i;
    editor.screen = () => showChannel(i);
    const has = (s) => ch.sources.includes(s);
    const check = (s, ico, t, sub, extra) => {
      const row = h('div', 'ed-row check' + (has(s) ? ' on' : '') + (s !== 'master' && has('master') ? ' dis' : ''),
        h('span', 'ed-box', has(s) ? PBW.icon('check') : ''), ico ? h('span', null, ico) : null,
        h('div', 'grow', h('div', 't', t), sub ? h('div', 's', sub) : null), extra || null);
      row.addEventListener('click', () => {
        if (s === 'master') ch.sources = has('master') ? [] : ['master'];
        else ch.sources = has(s) ? ch.sources.filter((x) => x !== s) : [...ch.sources.filter((x) => x !== 'master'), s];
        if (s === 'games' && has('games') && ch._new) ch.applyOnStart = true;
        const on = has(s);
        row.classList.toggle('on', on); row.querySelector('.ed-box').replaceChildren(on ? PBW.icon('check') : '');
        if (s === 'master' || has('master') !== editor.hadMaster) showChannel(i); // other rows enable / disable
        editor.hadMaster = has('master');
        name.placeholder = 'Name: ' + autoName(ch.sources);
      });
      return row;
    };
    editor.hadMaster = has('master');
    const name = h('input');
    name.type = 'text'; name.maxLength = 40; name.value = ch.name; name.placeholder = 'Name: ' + autoName(ch.sources);
    name.addEventListener('input', () => { ch.name = name.value; });
    const picker = PBW.ui.colorPicker(ch.color, (c) => { ch.color = c; });
    const runningGames = appsCache.filter((a) => a.running && a.game).map((a) => a.name);

    const search = h('input');
    search.type = 'text'; search.placeholder = 'Search apps and games'; search.value = editor.filter || '';
    const appRows = h('div', 'ed-col');
    const fillApps = () => {
      const f = (editor.filter || '').toLowerCase();
      const hit = (a) => !f || a.name.toLowerCase().includes(f) || a.detail.toLowerCase().includes(f);
      // picked earlier but unknown now (uninstalled, typed in…): still listed so they can be removed
      const missing = ch.sources.filter((s) => (s.startsWith('app:') || s.startsWith('dir:')) && !appsCache.some((a) => a.src === s))
        .map((s) => ({ src: s, name: labelOf(s), detail: s.slice(4), running: false, game: false }));
      const groups = [
        ['Selected', missing],
        ['Running now', appsCache.filter((a) => a.running && hit(a))],
        ['Games', appsCache.filter((a) => !a.running && a.game && hit(a))],
        ['Installed apps', appsCache.filter((a) => !a.running && !a.game && hit(a))],
      ];
      const kids = [];
      for (const [label, items] of groups) {
        if (!items.length) continue;
        kids.push(h('div', 'ed-sub', `${label} · ${items.length}`));
        for (const a of items) {
          const extra = a.custom
            ? btn('ib', PBW.icon('x'), async () => {
              try { await ctx.post('customapp-remove', { exe: a.src.slice(4) }); ch.sources = ch.sources.filter((x) => x !== a.src); await loadApps(); showChannel(i); }
              catch (e) { showError(e); }
            }, 'Forget this exe')
            : a.game ? h('span', 'ed-badge', 'game') : null;
          kids.push(check(a.src, null, a.name, (a.running ? '● ' : '') + a.detail, extra));
        }
      }
      if (!kids.length) kids.push(h('div', 'ed-hint', appsCache.length ? 'No match. Add it by its exe name below.' : 'Loading…'));
      appRows.replaceChildren(...kids);
    };
    search.addEventListener('input', () => { editor.filter = search.value; fillApps(); });
    fillApps();

    const exe = h('input'); exe.type = 'text'; exe.placeholder = 'e.g. discord.exe'; exe.spellcheck = false;
    const addExe = btn('pill', 'Add', async () => {
      try {
        const r = await ctx.post('customapp', { exe: exe.value });
        if (!ch.sources.includes(r.src)) ch.sources = [...ch.sources.filter((x) => x !== 'master'), r.src];
        exe.value = '';
        await loadApps();
        showChannel(i);
      } catch (e) { showError(e); }
    });

    const apply = h('div', 'ed-row check' + (ch.applyOnStart ? ' on' : ''), h('span', 'ed-box', ch.applyOnStart ? PBW.icon('check') : ''),
      h('div', 'grow', h('div', 't', 'Set this level when an app starts'), h('div', 's', 'New game / app sessions start at the slider’s level')));
    apply.addEventListener('click', () => { ch.applyOnStart = !ch.applyOnStart; apply.classList.toggle('on', ch.applyOnStart); apply.querySelector('.ed-box').replaceChildren(ch.applyOnStart ? PBW.icon('check') : ''); });
    const leave = () => { editor.chDraft = null; editor.filter = ''; showList(); };
    const done = () => { delete ch._new; d.channels[i] = ch; leave(); };
    const back = () => { if (orig._new) d.channels.splice(i, 1); leave(); };
    screen(orig._new ? 'New slider' : 'Edit slider', [btn('pill', 'Back', back), btn('pill pri', 'OK', done)],
      name,
      h('div', 'ed-sec', 'Color'), picker,
      h('div', 'ed-sec', 'Controls'),
      check('games', PBW.icon('gamepad-2'), 'All games (auto-detected)', runningGames.length ? '● ' + runningGames.join(', ') : 'Follows whatever game is running'),
      check('system', PBW.icon('bell'), 'System sounds', null),
      check('master', PBW.icon('volume-2'), 'Master volume', 'The whole PC (default output device)'),
      h('div', 'ed-sec', 'Apps & games'), search, appRows,
      h('div', 'ed-sec', 'Not listed?'),
      h('div', 'ed-inline', exe, addExe),
      h('div', 'ed-hint', 'Type the program’s exe name (Task Manager › Details shows it).'),
      h('div', 'ed-sec', 'Options'), apply);
  }

  // ---------------------------------------------------------------- game detection
  async function showGames() {
    editor.screen = showGames;
    if (!editor.games) {
      screen('Game detection', [btn('pill pri', 'Back', () => { editor.games = null; showList(); })], h('div', 'ed-hint', 'Loading…'));
      try { editor.games = await ctx.api('games'); } catch (e) { showError(e); return; }
      if (!editor || editor.screen !== showGames) return;
    }
    const g = editor.games;
    const refresh = async (p) => { try { editor.games = await p; } catch (e) { showError(e); } if (editor) { loadApps(); showGames(); } };

    const folderRows = g.folders.map((f, idx) => h('div', 'ed-row', PBW.icon('folder'), h('div', 'grow', h('div', 't', f)),
      btn('ib', PBW.icon('x'), () => refresh(ctx.post('folders', {}, { folders: g.folders.filter((_, j) => j !== idx) })), 'Remove folder')));
    const folderIn = h('input'); folderIn.type = 'text'; folderIn.placeholder = 'e.g. D:\\Games'; folderIn.spellcheck = false;
    const addFolder = btn('pill', 'Add', () => { if (folderIn.value.trim()) refresh(ctx.post('folders', {}, { folders: [...g.folders, folderIn.value.trim()] })); });
    const rescan = btn('pill', PBW.label('refresh-cw', 'Rescan'), async () => { rescan.disabled = true; await ctx.post('rescan').catch(showError); refresh(ctx.api('games')); });

    const search = h('input'); search.type = 'text'; search.placeholder = 'Search'; search.value = editor.gfilter || '';
    const list = h('div', 'ed-col');
    const fill = () => {
      const f = (editor.gfilter || '').toLowerCase();
      const items = g.games.filter((e) => (editor.gall || e.game || e.override != null) && (!f || e.name.toLowerCase().includes(f) || e.detail.toLowerCase().includes(f)));
      list.replaceChildren(...items.map((e) => {
        const set = async (v) => {
          try {
            await ctx.post('game', { app: e.id, v });
            e.override = v === 'auto' ? null : v === '1'; e.game = e.override ?? e.auto;
            fill(); loadApps();
          } catch (err) { showError(err); }
        };
        const cur = e.override == null ? 'auto' : e.override ? '1' : '0';
        return h('div', 'ed-row',
          h('div', 'grow', h('div', 't', e.game ? PBW.icon('gamepad-2', 'm') : null, e.name), h('div', 's', (e.running ? '● running · ' : '') + e.detail)),
          h('div', 'ed-tri',
            btn(cur === 'auto' ? 'on' : '', e.auto ? 'Auto: game' : 'Auto', () => set('auto'), 'Use automatic detection'),
            btn(cur === '1' ? 'on' : '', 'Game', () => set('1')),
            btn(cur === '0' ? 'on' : '', 'Not', () => set('0'))));
      }));
      if (!items.length) list.append(h('div', 'ed-hint', 'Nothing found.'));
    };
    search.addEventListener('input', () => { editor.gfilter = search.value; fill(); });
    const all = h('div', 'ed-row check' + (editor.gall ? ' on' : ''), h('span', 'ed-box', editor.gall ? PBW.icon('check') : ''),
      h('div', 'grow', h('div', 't', 'Show all apps'), h('div', 's', 'To mark an app as a game')));
    all.addEventListener('click', () => { editor.gall = !editor.gall; showGames(); });
    fill();
    screen('Game detection', [btn('pill pri', 'Back', () => { editor.games = null; showList(); })],
      h('div', 'ed-hint', 'Found automatically: Steam, Epic, GOG, EA, Ubisoft and Xbox libraries, Windows’ Game Bar list, and store folders. Fixes here apply to every “All games” slider.'),
      h('div', 'ed-sec', 'Your game folders'),
      ...folderRows,
      h('div', 'ed-inline', folderIn, addFolder),
      h('div', 'ed-hint', 'Every subfolder counts as a game, and anything running from the folder is detected.'),
      h('div', 'ed-sec', `Detected · ${g.games.filter((e) => e.game).length} games`),
      h('div', 'ed-inline', search, rescan), all, list);
  }
});
