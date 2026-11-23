// Media widget, tablet side: cover, title, a seek bar and big controls (skip back, previous, play/pause, next, skip
// forward). No volume slider: there's a widget for that. PC side: plugin.py (talks to the PhoneBox agent).
PBW.mount('media', async (ctx) => {
  const { h, btn, ui, clamp, icon } = PBW;
  const root = ctx.root;

  PBW.css('media', `
.md{display:grid;grid-template-rows:minmax(0,1.2fr) auto minmax(0,1fr);gap:6px;padding:9px 10px 8px;transition:background .6s}
/* every part has its own row, so a hidden seek bar doesn't shift the controls into its slot */
.md-top{grid-row:1;display:flex;gap:10px;min-height:0;align-items:center;padding-right:18px}
.md-prog{grid-row:2}
.md-ctl{grid-row:3}
.md-art{height:100%;max-height:150px;aspect-ratio:1;border-radius:9px;object-fit:cover;background:rgba(255,255,255,.06);flex:none;display:none}
.md-art.on{display:block}
.md-noart{height:100%;max-height:150px;aspect-ratio:1;border-radius:9px;background:rgba(255,255,255,.06);display:grid;place-items:center;color:var(--dim);flex:none}
.md-noart .ico{width:40%;height:40%}
.md.no-art .md-art,.md.no-art .md-noart{display:none!important}
.md-info{min-width:0;display:flex;flex-direction:column;gap:2px}
.md-title{font-weight:600;font-size:1.2em;line-height:1.2;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.md-artist{color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.md-app{color:var(--dim);opacity:.75;font-size:.85em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.md.no-app .md-app{display:none}
.md-prog{display:flex;align-items:center;gap:8px;font-size:.82em;color:var(--dim);font-variant-numeric:tabular-nums}
.md-prog[hidden]{display:none}
.md-bar{position:relative;flex:1;height:18px;touch-action:none;cursor:pointer}
.md-bar::before{content:'';position:absolute;left:0;right:0;top:7px;height:4px;border-radius:2px;background:rgba(255,255,255,.12)}
.md-fill{position:absolute;left:0;top:7px;height:4px;border-radius:2px;background:var(--btn)}
.md-knob{position:absolute;top:3px;width:12px;height:12px;margin-left:-6px;border-radius:50%;background:var(--btn);opacity:0;transition:opacity .15s}
.md-bar:active .md-knob,.md-bar.scrub .md-knob{opacity:1}
.md-ctl{display:flex;align-items:center;justify-content:space-evenly;min-height:0;color:var(--btn)}
.md-ctl button{position:relative;display:grid;place-items:center;height:100%;max-height:100%;aspect-ratio:1;border-radius:50%;transition:transform .1s,background .15s}
.md-ctl button:active{transform:scale(.9);background:rgba(255,255,255,.08)}
.md-ctl button:disabled{opacity:.3}
.md-ctl .ico{width:var(--ic);height:var(--ic)}
.md-ctl .play{background:var(--btn);color:#0b0f14}
.md-ctl .play .ico{width:var(--icp);height:var(--icp);fill:currentColor}
.md-ctl .play:active{background:var(--btn)}
.md-ctl .skip b{position:absolute;font-size:calc(var(--ic) * .3);font-weight:700;top:50%;left:50%;transform:translate(-50%,-38%)}
.md-empty{color:var(--dim)}
/* tall and narrow: controls in two rows, previous / play / next on top, the skips below */
.md.md-tall{grid-template-rows:minmax(0,1fr) auto minmax(0,1.45fr)}
.md-tall .md-ctl{display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:1fr 1fr;place-items:center}
.md-tall .md-ctl .back{grid-area:2/1}
.md-tall .md-ctl .fwd{grid-area:2/3}
/* short and wide: title on the left, controls on the right using the full height */
.md.md-wide{grid-template-columns:minmax(0,1fr) auto;grid-template-rows:minmax(0,1fr) auto;column-gap:12px}
.md-wide .md-top{grid-column:1;grid-row:1;padding-right:0}
.md-wide .md-prog{grid-column:1;grid-row:2}
.md-wide .md-ctl{grid-column:2;grid-row:1 / span 2;gap:2px;padding-right:20px}
`);
  root.classList.add('md');

  // ------------------------------------------------------------------ view
  const art = h('img', 'md-art'); art.alt = '';
  art.crossOrigin = 'anonymous'; // lets the tint read the cover's colors (the host allows it)
  const noart = h('div', 'md-noart', icon('music'));
  const title = h('div', 'md-title'), artist = h('div', 'md-artist'), app = h('div', 'md-app');
  const fill = h('div', 'md-fill'), knob = h('div', 'md-knob'), bar = h('div', 'md-bar', fill, knob);
  const pos = h('span'), dur = h('span');
  const prog = h('div', 'md-prog', pos, bar, dur);
  const skipBtn = (dir) => {
    const b = btn('skip ' + (dir === -1 ? 'back' : 'fwd'), '', () => act(dir === -1 ? 'back' : 'forward'), dir === -1 ? 'Skip back' : 'Skip forward');
    b.append(icon(dir === -1 ? 'rotate-ccw' : 'rotate-cw'), h('b'));
    return b;
  };
  const back = skipBtn(-1), fwd = skipBtn(1);
  const prev = btn('', icon('skip-back'), () => act('prev'), 'Previous');
  const next = btn('', icon('skip-forward'), () => act('next'), 'Next');
  const play = btn('play', icon('play'), () => act('playpause'), 'Play / pause');
  const ctl = h('div', 'md-ctl', back, prev, play, next, fwd);
  root.replaceChildren(h('div', 'md-top', art, noart, h('div', 'md-info', title, artist, app)), prog, ctl, ctx.gear(openSettings));

  let cfg = { skip: 5, art: true, app: true, tint: true, progress: true, color: '#eef2f6' };
  let m = null, mAt = 0, artId = null, hold = 0, scrub = null;
  const fmt = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return (s >= 3600 ? Math.floor(s / 3600) + ':' + String(Math.floor(s / 60) % 60).padStart(2, '0') : Math.floor(s / 60)) + ':' + String(s % 60).padStart(2, '0'); };
  const nowPos = () => (m ? Math.min(m.durMs || Infinity, m.posMs + (m.playing ? Date.now() - mAt : 0)) : 0);

  function apply() {
    root.style.setProperty('--btn', cfg.color);
    root.classList.toggle('no-art', !cfg.art);
    root.classList.toggle('no-app', !cfg.app);
    back.querySelector('b').textContent = fwd.querySelector('b').textContent = String(cfg.skip);
    if (!cfg.tint) root.style.background = '';
    size();
    draw();
  }

  // the controls get the bigger share of the height; icons scale with the buttons
  function size() {
    const H = root.clientHeight, W = root.clientWidth;
    const wide = W > H * 2.8, tall = !wide && W < H * 1.15;
    root.classList.toggle('md-wide', wide);
    root.classList.toggle('md-tall', tall);
    // wide: the controls take the full height, but at most ~55% of the width; tall: two rows of three;
    // otherwise: one row across the full width
    const ctlH = wide ? H - 18 : ctl.clientHeight || H * 0.4;
    const btnW = wide ? (W * 0.52) / 5.3 : tall ? W / 3.5 : W / 5.4;
    const b = Math.min(tall ? ctlH / 2 - 4 : ctlH, btnW, 96) * 0.86;
    // the cover never crowds out the title
    const artMax = wide ? Math.min(H - 18, W * 0.17) : 150;
    for (const el of [art, noart]) el.style.maxHeight = el.style.maxWidth = Math.round(artMax) + 'px';
    root.style.setProperty('--ic', Math.round(b * 0.5) + 'px');
    root.style.setProperty('--icp', Math.round(b * 0.46) + 'px');
    root.style.fontSize = clamp(Math.round(Math.min(H / 11.5, W / 22)), 10, 19) + 'px';
    for (const el of ctl.children) el.style.width = el.style.height = Math.round(b) + 'px';
  }

  function draw() {
    const has = !!(m && (m.title || m.app));
    title.textContent = has ? m.title || m.app : 'Nothing playing';
    title.classList.toggle('md-empty', !has);
    artist.textContent = has ? [m.artist, m.album].filter(Boolean).join(' · ') : '';
    app.textContent = has && m.title ? m.app : '';
    play.replaceChildren(icon(m && m.playing ? 'pause' : 'play'));
    // Without a track length (Firefox) the player doesn't share its position either: the time would be a guess that
    // resets whenever you jump in the video, and skipping from it lands at the start. So: no bar, no skips.
    const timed = !!(m && m.durMs > 0);
    const seekable = !!(m && m.canSeek) && timed;
    back.disabled = fwd.disabled = !seekable;
    const why = has && !timed ? ' (this player doesn’t share its position with Windows)' : '';
    back.title = `Back ${cfg.skip} s${why}`; fwd.title = `Forward ${cfg.skip} s${why}`;
    prev.disabled = next.disabled = !has;
    prog.hidden = !cfg.progress || !has || !timed;
    bar.toggleAttribute('data-haptic', seekable); // buzzes when a drag starts, only while seeking is possible
    // the cover: a new artId means a new picture
    const want = has && m.artId ? m.artId : null;
    if (want !== artId) {
      artId = want;
      art.classList.remove('on');
      if (want) art.src = `${PBW.BASE}/api/w/media/art?${PBW.q({ id: ctx.id, v: want })}`;
      else if (cfg.tint) root.style.background = '';
    }
    noart.style.display = cfg.art && !art.classList.contains('on') ? '' : 'none';
    paintPos();
  }

  function paintPos() {
    if (!m || prog.hidden) return;
    const p = scrub ? scrub.ms : nowPos();
    const f = clamp(p / m.durMs, 0, 1) * 100;
    fill.style.width = f + '%';
    knob.style.left = f + '%';
    dur.textContent = fmt(m.durMs);
    pos.textContent = fmt(p);
  }

  art.addEventListener('load', () => {
    art.classList.add('on');
    noart.style.display = 'none';
    if (cfg.tint) tint();
  });
  art.addEventListener('error', () => { art.classList.remove('on'); noart.style.display = cfg.art ? '' : 'none'; });
  function tint() { // the cover's average color, faintly behind everything
    try {
      const c = document.createElement('canvas'); c.width = c.height = 12;
      const g = c.getContext('2d'); g.drawImage(art, 0, 0, 12, 12);
      const d = g.getImageData(0, 0, 12, 12).data;
      let r = 0, gr = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; gr += d[i + 1]; b += d[i + 2]; }
      const n = d.length / 4;
      root.style.background = `radial-gradient(120% 140% at 0% 0%, rgba(${r / n | 0},${gr / n | 0},${b / n | 0},.42), transparent 70%)`;
    } catch (_) { /* a cover we may not read: no tint */ }
  }

  // ------------------------------------------------------------------ actions
  async function act(a) {
    if (a === 'playpause' && m) { m.playing = !m.playing; m.posMs = nowPos(); mAt = Date.now(); hold = Date.now() + 1500; draw(); }
    if ((a === 'back' || a === 'forward') && m) { // show the jump right away
      const step = cfg.skip * 1000 * (a === 'back' ? -1 : 1);
      m.posMs = clamp(nowPos() + step, 0, m.durMs || Infinity); mAt = Date.now(); hold = Date.now() + 1500; paintPos();
    }
    try {
      const r = await ctx.post('action', { a });
      if (r.media && Date.now() > hold - 1000) take(r.media);
      setTimeout(poll, 400);
    } catch (e) { ctx.error(e); }
  }

  // seek bar: drag to pick a time, it seeks on release
  const msAt = (x) => { const r = bar.getBoundingClientRect(); return Math.round(clamp((x - r.left) / r.width, 0, 1) * (m?.durMs || 0)); };
  bar.addEventListener('pointerdown', (e) => {
    if (!m || !m.canSeek || !(m.durMs > 0)) return;
    scrub = { ms: msAt(e.clientX) }; bar.classList.add('scrub'); paintPos();
    try { bar.setPointerCapture(e.pointerId); } catch (_) {}
  });
  bar.addEventListener('pointermove', (e) => { if (scrub) { scrub.ms = msAt(e.clientX); paintPos(); } });
  const endScrub = async (commit) => {
    if (!scrub) return;
    const ms = scrub.ms; scrub = null; bar.classList.remove('scrub');
    if (!commit) { paintPos(); return; }
    m.posMs = ms; mAt = Date.now(); hold = Date.now() + 2000; paintPos();
    try { await ctx.post('action', { a: 'seek', ms }); } catch (e) { ctx.error(e); }
  };
  bar.addEventListener('pointerup', () => endScrub(true));
  bar.addEventListener('pointercancel', () => endScrub(false));

  // ------------------------------------------------------------------ data
  function take(media) {
    m = media; mAt = Date.now();
    draw();
  }
  let fails = 0;
  async function poll() {
    try {
      const r = await ctx.api('state');
      fails = 0;
      if (Date.now() > hold) take(r.media);
    } catch (_) { fails++; }
  }
  (async function loop() { if (!document.hidden) await poll(); setTimeout(loop, fails ? Math.min(8000, 1500 * fails) : 1000); })();
  setInterval(paintPos, 250);
  new ResizeObserver(() => size()).observe(root);

  try { cfg = { ...cfg, ...((await ctx.loadConfig()).config || {}) }; } catch (e) { ctx.error(e); }
  apply();

  // ------------------------------------------------------------------ settings
  function openSettings() {
    const d = { ...cfg };
    ctx.editor.screen('Media', [btn('pill', 'Cancel', () => ctx.editor.close()), btn('pill pri', 'Save', async () => {
      try { cfg = { ...cfg, ...(await ctx.saveConfig(d)) }; ctx.editor.close(); apply(); } catch (e) { ctx.error(e); }
    })],
    ui.section('Skip buttons'),
    ui.segmented([[5, '5 s'], [10, '10 s'], [15, '15 s'], [30, '30 s']], d.skip, (v) => { d.skip = v; }),
    ui.hint('Works with players that share their position with Windows: Spotify, Chrome, Edge, most video players. Not Firefox: it only reports play / pause.'),
    ui.section('Show'),
    ui.check('Cover art', null, d.art, (v) => { d.art = v; }),
    ui.check('Player name', 'e.g. Spotify, Firefox', d.app, (v) => { d.app = v; }),
    ui.check('Progress bar', 'With seeking, for players that share their position (Spotify, Chrome, Edge…). Hidden for Firefox, which doesn’t', d.progress, (v) => { d.progress = v; }),
    ui.check('Background tint', 'A soft glow in the cover’s color', d.tint, (v) => { d.tint = v; }),
    ui.section('Button color'),
    ui.colorPicker(d.color, (c) => { d.color = c; }, ['#eef2f6', '#2dd4bf', '#60a5fa', '#a78bfa', '#f472b6', '#fb923c', '#facc15', '#4ade80']));
  }
});
