// Clock widget, tablet side: time, date and the tablet's battery. The gear switches to layout mode: drag a part to move
// it (it snaps to the center lines), drag its corner dot to resize it, "Style" for font, color and options.
PBW.mount('clock', async (ctx) => {
  const { h, btn, clamp, ui } = PBW;
  const root = ctx.root;
  const PARTS = { time: 'Time', date: 'Date', battery: 'Battery' };
  // keep in sync with plugin.py DEFAULTS (the plugin validates what gets saved)
  const DEFAULTS = {
    time: { show: true, x: 50, y: 40, size: 42, font: '', color: '#eef2f6', weight: 600, h24: true, seconds: false, blink: false },
    date: { show: true, x: 50, y: 72, size: 11, font: '', color: '#8a94a3', weight: 500, format: 'weekday-long', upper: false },
    battery: { show: true, x: 50, y: 88, size: 9, font: '', color: '#8a94a3', weight: 500, icon: true, percent: true },
  };
  const DATE_FORMATS = {
    'weekday-long': { weekday: 'long', day: 'numeric', month: 'long' },
    long: { day: 'numeric', month: 'long', year: 'numeric' },
    short: { weekday: 'short', day: 'numeric', month: 'short' },
    numeric: { day: '2-digit', month: '2-digit', year: 'numeric' },
    weekday: { weekday: 'long' },
    iso: null,
  };

  PBW.css('clock', `
.clk-el{position:absolute;transform:translate(-50%,-50%);white-space:nowrap;line-height:1;font-variant-numeric:tabular-nums;touch-action:none}
.clk-el[hidden]{display:none}
.clk-time .ap{font-size:.38em;margin-left:.18em;letter-spacing:.04em}
.clk-time .sec{font-size:.46em;margin-left:.08em;opacity:.75}
.clk-time .col{transition:opacity .2s}
.clk-time .col.off{opacity:.2}
.clk-battery .txt{display:inline-flex;align-items:center}
.bat{display:inline-block;position:relative;width:1.9em;height:.95em;border:.1em solid currentColor;border-radius:.22em;margin-right:.45em;flex:none}
.bat::after{content:'';position:absolute;right:-.3em;top:28%;height:44%;width:.16em;background:currentColor;border-radius:0 .1em .1em 0}
.bat i{position:absolute;left:.08em;top:.08em;bottom:.08em;width:calc((100% - .16em) * var(--lvl,0));background:currentColor;border-radius:.06em}
.bat.low i{background:#ef4444}
.bat .bolt{position:absolute;left:50%;top:50%;width:.62em;height:.86em;transform:translate(-50%,-50%);background:#facc15;
  clip-path:polygon(62% 0,0 58%,44% 58%,34% 100%,100% 38%,56% 38%);filter:drop-shadow(0 0 1px #000)}
.clk.editing .clk-el{outline:1px dashed rgba(255,255,255,.35);outline-offset:.12em;cursor:move}
.clk.editing .clk-el.sel{outline:2px solid var(--acc)}
.clk.editing .clk-el.ghost{display:block;opacity:.28}
.clk-handle{position:absolute;right:-11px;bottom:-11px;width:18px;height:18px;border-radius:50%;background:var(--acc);border:3px solid #0b0f14;cursor:nwse-resize;touch-action:none}
.clk-guide{position:absolute;background:rgba(45,212,191,.75);display:none;pointer-events:none;z-index:3}
.clk-guide.x{left:50%;top:0;bottom:0;width:1px}
.clk-guide.y{top:50%;left:0;right:0;height:1px}
.clk-guide.on{display:block}
.clk-bar{position:absolute;left:4px;right:4px;top:4px;z-index:6;display:flex;gap:4px;align-items:center;padding:3px;border-radius:10px;
  background:rgba(15,20,27,.9);font-size:11px;overflow-x:auto;scrollbar-width:none}
.clk-bar.bottom{top:auto;bottom:4px}
.clk-bar button{padding:5px 8px;border-radius:7px;background:rgba(255,255,255,.07);white-space:nowrap;flex:none}
.clk-bar button.on{background:#2b3442;color:var(--acc)}
.clk-bar button.pri{background:var(--acc);color:#06201c;font-weight:600}
.clk-bar .sp{flex:1}
`);
  root.classList.add('clk');

  // ------------------------------------------------------------------ the parts
  const els = {}, txt = {};
  for (const k of Object.keys(PARTS)) {
    txt[k] = h('span', 'txt');
    els[k] = h('div', 'clk-el clk-' + k, txt[k]);
    els[k].dataset.k = k;
  }
  const t = { h: h('span'), c1: h('span', 'col', ':'), m: h('span'), sec: h('span', 'sec'), ap: h('span', 'ap') };
  txt.time.append(t.h, t.c1, t.m, t.sec, t.ap);
  const batIcon = h('span', 'bat', h('i'), h('span', 'bolt'));
  const batPct = h('span');
  txt.battery.append(batIcon, batPct);
  const guideX = h('div', 'clk-guide x'), guideY = h('div', 'clk-guide y');
  const gear = ctx.gear(() => enterEdit());
  root.replaceChildren(...Object.values(els), guideX, guideY, gear);

  const merge = (c) => {
    const out = { background: c?.background || '', elements: {} };
    for (const k of Object.keys(DEFAULTS)) out.elements[k] = { ...DEFAULTS[k], ...(c?.elements?.[k] || {}) };
    return out;
  };
  let cfg = merge(null);
  let editing = false, selected = 'time', before = null; // layout mode state

  // ------------------------------------------------------------------ drawing
  function layout() {
    const H = root.clientHeight || 1;
    root.style.background = cfg.background || '';
    for (const [k, el] of Object.entries(els)) {
      const e = cfg.elements[k];
      el.style.left = e.x + '%';
      el.style.top = e.y + '%';
      el.style.fontSize = (e.size / 100) * H + 'px';
      el.style.fontFamily = PBW.useFont(e.font);
      el.style.fontWeight = e.weight;
      el.style.color = e.color;
      el.hidden = !e.show && !editing;
      el.classList.toggle('ghost', !e.show && editing);
    }
    tick(true);
    for (const k of Object.keys(els)) fit(k);
  }

  // a part never sticks out of the widget: if it is wider than the widget at its size, it shrinks to fit
  function fit(k) {
    const el = els[k], e = cfg.elements[k];
    const W = root.clientWidth, H = root.clientHeight || 1;
    const want = (e.size / 100) * H;
    el.style.fontSize = want + 'px';
    const w = el.offsetWidth;
    if (W && w > W * 0.96) el.style.fontSize = want * (W * 0.96) / w + 'px';
  }

  const pad = (n) => String(n).padStart(2, '0');
  let last = {};
  const set = (key, el, value) => { if (last[key] !== value) { last[key] = value; el.textContent = value; } };
  function tick(force) {
    if (force) last = {};
    const now = new Date();
    const te = cfg.elements.time, de = cfg.elements.date;
    const H = now.getHours();
    set('h', t.h, te.h24 ? pad(H) : String(H % 12 || 12));
    set('m', t.m, pad(now.getMinutes()));
    set('sec', t.sec, te.seconds ? pad(now.getSeconds()) : '');
    set('ap', t.ap, te.h24 ? '' : H < 12 ? 'AM' : 'PM');
    t.c1.classList.toggle('off', te.blink && now.getSeconds() % 2 === 1);
    let date = DATE_FORMATS[de.format]
      ? new Intl.DateTimeFormat(undefined, DATE_FORMATS[de.format]).format(now)
      : `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    if (de.upper) date = date.toUpperCase();
    if (last.date !== date || last.secShown !== te.seconds) { // new text: re-check that it fits (once a day / on change)
      set('date', txt.date, date);
      last.secShown = te.seconds;
      requestAnimationFrame(() => { fit('date'); fit('time'); });
    }
    paintBattery();
  }

  let battery = null;
  function paintBattery() {
    const be = cfg.elements.battery;
    const ok = battery && battery.available !== false;
    const lvl = ok ? battery.level : null;
    batIcon.hidden = !be.icon;
    batIcon.style.setProperty('--lvl', ok ? lvl / 100 : 0);
    batIcon.classList.toggle('low', ok && lvl <= 15 && !battery.charging);
    batIcon.querySelector('.bolt').hidden = !(ok && battery.charging);
    set('bat', batPct, be.percent || !be.icon ? (ok ? `${lvl}%` : '–%') : '');
    els.battery.title = ok ? `${lvl}% · ${battery.status}` : 'Battery unknown (is the tablet connected over USB?)';
  }
  async function loadBattery() {
    try { battery = await PBW.battery(); } catch (_) { battery = null; }
    paintBattery();
  }

  (function loop() { tick(); setTimeout(loop, 1000 - (Date.now() % 1000) + 15); })();
  loadBattery();
  setInterval(loadBattery, 30_000);
  new ResizeObserver(() => layout()).observe(root);

  try { cfg = merge((await ctx.loadConfig()).config); } catch (e) { ctx.error('Widget host offline: showing the default layout'); }
  layout();

  // ------------------------------------------------------------------ layout mode
  const handle = h('div', 'clk-handle');
  const chips = {};
  const bar = h('div', 'clk-bar');
  for (const k of Object.keys(PARTS)) bar.append(chips[k] = btn('', PARTS[k], () => select(k)));
  bar.append(h('span', 'sp'), btn('', PBW.label('palette', 'Style'), () => openStyle()), btn('', 'Cancel', () => leave(false)), btn('pri', 'Done', () => leave(true)));

  function enterEdit() {
    if (editing) return;
    editing = true;
    before = JSON.parse(JSON.stringify(cfg));
    root.classList.add('editing');
    gear.hidden = true;
    root.append(bar);
    select(selected);
    layout();
  }
  async function leave(save) {
    if (save) {
      try { cfg = merge(await ctx.saveConfig(cfg)); } catch (e) { ctx.error(e); return; }
    } else cfg = before;
    editing = false;
    root.classList.remove('editing');
    bar.remove(); handle.remove();
    Object.values(els).forEach((el) => el.classList.remove('sel'));
    gear.hidden = false;
    layout();
  }
  function select(k) {
    selected = k;
    for (const [n, el] of Object.entries(els)) el.classList.toggle('sel', n === k);
    for (const [n, c] of Object.entries(chips)) {
      c.classList.toggle('on', n === k);
      c.textContent = PARTS[n] + (cfg.elements[n].show ? '' : ' (hidden)');
    }
    els[k].append(handle);
    bar.classList.toggle('bottom', cfg.elements[k].y < 30); // keep the bar off the part being edited
  }

  // move: drag a part; it snaps to the vertical and horizontal center lines
  for (const [k, el] of Object.entries(els)) {
    el.addEventListener('pointerdown', (ev) => {
      if (!editing || ev.target === handle) return;
      ev.preventDefault();
      select(k);
      const r = root.getBoundingClientRect(), e = cfg.elements[k];
      const start = { px: ev.clientX, py: ev.clientY, x: e.x, y: e.y };
      try { el.setPointerCapture(ev.pointerId); } catch (_) {}
      // half the part's size, in % of the widget: its center stays far enough in for the whole part to stay visible
      const hw = Math.min(50, (el.offsetWidth / 2 / r.width) * 100), hh = Math.min(50, (el.offsetHeight / 2 / r.height) * 100);
      const move = (m) => {
        let x = clamp(start.x + ((m.clientX - start.px) / r.width) * 100, hw, 100 - hw);
        let y = clamp(start.y + ((m.clientY - start.py) / r.height) * 100, hh, 100 - hh);
        const sx = Math.abs(x - 50) < 1.6, sy = Math.abs(y - 50) < 1.6;
        if (sx) x = 50;
        if (sy) y = 50;
        guideX.classList.toggle('on', sx); guideY.classList.toggle('on', sy);
        e.x = Math.round(x * 10) / 10; e.y = Math.round(y * 10) / 10;
        el.style.left = e.x + '%'; el.style.top = e.y + '%';
      };
      const up = () => {
        el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
        guideX.classList.remove('on'); guideY.classList.remove('on');
        bar.classList.toggle('bottom', e.y < 30);
      };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    });
  }
  // resize: drag the corner dot away from / towards the part's center
  handle.addEventListener('pointerdown', (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    const el = els[selected], e = cfg.elements[selected];
    const b = el.getBoundingClientRect();
    const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    const d0 = Math.hypot(ev.clientX - cx, ev.clientY - cy) || 1, s0 = e.size;
    try { handle.setPointerCapture(ev.pointerId); } catch (_) {}
    const move = (m) => {
      e.size = Math.round(clamp(s0 * (Math.hypot(m.clientX - cx, m.clientY - cy) / d0), 2, 120) * 10) / 10;
      fit(selected);
    };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  });
  // mouse wheel resizes too (handy on the PC setup page)
  root.addEventListener('wheel', (ev) => {
    if (!editing || ctx.editor.isOpen) return;
    ev.preventDefault();
    const e = cfg.elements[selected];
    e.size = Math.round(clamp(e.size * (1 - ev.deltaY * 0.0012), 2, 120) * 10) / 10;
    layout();
  }, { passive: false });

  // ------------------------------------------------------------------ style sheet for the selected part
  async function openStyle() {
    const k = selected, e = cfg.elements[k];
    const fontName = (await PBW.fonts()).find((f) => f.id === (e.font || ''))?.name || e.font;
    const back = () => { ctx.editor.close(); select(k); layout(); };
    const opts = [];
    if (k === 'time') {
      opts.push(ui.check('24-hour clock', null, e.h24, (v) => { e.h24 = v; }),
        ui.check('Seconds', null, e.seconds, (v) => { e.seconds = v; }),
        ui.check('Blinking colon', null, e.blink, (v) => { e.blink = v; }));
    } else if (k === 'date') {
      const sample = new Date();
      opts.push(h('select', null, ...Object.keys(DATE_FORMATS).map((f) => {
        const o = h('option', null, DATE_FORMATS[f] ? new Intl.DateTimeFormat(undefined, DATE_FORMATS[f]).format(sample) : `${sample.getFullYear()}-${pad(sample.getMonth() + 1)}-${pad(sample.getDate())}`);
        o.value = f; o.selected = f === e.format; return o;
      })), ui.check('UPPERCASE', null, e.upper, (v) => { e.upper = v; }));
      opts[0].addEventListener('change', (ev) => { e.format = ev.target.value; });
    } else {
      opts.push(ui.check('Battery icon', 'Fills with the level, with a bolt while charging', e.icon, (v) => { e.icon = v; }),
        ui.check('Percentage', null, e.percent, (v) => { e.percent = v; }),
        ui.hint(battery?.available ? `Now: ${battery.level}% · ${battery.status}` : 'The tablet battery is read over USB (adb).'));
    }
    const pos = (axis) => ui.range(0, 100, 0.5, e[axis], (v) => { e[axis] = v; }, (v) => v + '%');
    ctx.editor.screen(`${PARTS[k]} style`, [btn('pill pri', 'Back', back)],
      ui.check('Show', null, e.show, (v) => { e.show = v; }),
      ui.section('Size'), ui.range(2, 120, 0.5, e.size, (v) => { e.size = v; }, (v) => v + '%'),
      ui.hint('Percent of the widget’s height. Tip: drag the corner dot on the widget.'),
      ui.section('Position (center)'), ui.row('Horizontal', null, pos('x')), ui.row('Vertical', null, pos('y')),
      ui.section('Font'),
      ui.row(fontName || 'Default', null, btn('pill', 'Change…', () => openFont(k))),
      ui.segmented([[300, 'Light'], [400, 'Regular'], [600, 'Semibold'], [800, 'Bold']], e.weight, (v) => { e.weight = v; }),
      ui.section('Color'), ui.colorPicker(e.color, (c) => { e.color = c; }),
      ui.section('Options'), ...opts,
      ui.section('Whole widget'),
      ui.check('Background color', 'Off: transparent (PhoneBox’s card shows through)', !!cfg.background, (v) => { cfg.background = v ? cfg.background || '#0b0f14' : ''; openStyle(); }),
      cfg.background ? ui.colorPicker(cfg.background, (c) => { cfg.background = c; }, ['#000000', '#0b0f14', '#111827', '#1e293b', '#312e81', '#3f1d38']) : null,
      btn('pill', 'Reset this part', () => { cfg.elements[k] = { ...DEFAULTS[k] }; openStyle(); }));
  }

  function openFont(k) {
    const e = cfg.elements[k];
    const sample = k === 'time' ? `${t.h.textContent}:${t.m.textContent}` : k === 'date' ? txt.date.textContent : '46%';
    ctx.editor.screen('Font', [btn('pill pri', 'Back', () => openStyle())],
      ui.hint('Any font installed on your PC. Install more in Windows and they show up here.'),
      ui.fontPicker(e.font, (id) => { e.font = id; }, sample));
  }
});
