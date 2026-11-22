// PhoneBox Widgets SDK: the shared toolkit every widget gets. The host serves it in front of each widget's code
// (/widget/<type>.js), so a widget simply calls PBW.mount('<type>', (ctx) => { ... }).
//
//   PBW.mount(type, setup)        finds the widget's element and calls setup(ctx) with:
//     ctx.root, ctx.type, ctx.id    the element, the widget type, this widget's id (data-id in the snippet)
//     ctx.api(name, params)         GET  /api/w/<type>/<name>?id=..  (the plugin's routes)
//     ctx.post(name, params, body)  POST /api/w/<type>/<name>?id=..
//     ctx.loadConfig()              -> {saved, config}   this widget's settings (config is null until saved)
//     ctx.saveConfig(config)        -> config            (the plugin may clean it up)
//     ctx.error(err)                a short red toast
//     ctx.editor                    full-size editor overlay: open(), close(), isOpen, screen(title, actions, ...body)
//     ctx.gear(onClick)             the small gear button (position it yourself, or use .pbw-gear's default: top right)
//   PBW.h(tag, cls, ...kids), PBW.btn(cls, label, onClick, title), PBW.clamp, PBW.q(obj)
//   PBW.icon(name), PBW.label(icon, text)      Lucide icons as inline SVG (names: host/icons/*.svg, PBW.ICON_NAMES)
//   PBW.api(path), PBW.post(path, body)        any host route
//   PBW.ui.*                                  editor building blocks: section, hint, row, check, segmented, range,
//                                             input, colorPicker, fontPicker
//   PBW.fonts(), PBW.useFont(id)               the PC's fonts: list them / get a CSS font-family that loads one
//   PBW.battery()                              the tablet's battery {level, charging, status, plugged}
(() => {
  'use strict';
  if (window.PBW) return;
  const BASE = new URL(document.currentScript.src).origin;
  const COLORS = ['#2dd4bf', '#60a5fa', '#a78bfa', '#f472b6', '#fb923c', '#facc15', '#4ade80', '#e5e7eb'];

  // ------------------------------------------------------------------ basics
  const h = (tag, cls, ...kids) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    for (const k of kids) if (k != null && k !== false) e.append(k);
    return e;
  };
  const btn = (cls, label, onClick, title) => {
    const b = h('button', cls, label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
    return b;
  };
  // Lucide line icons (lucide.dev, ISC), the set PhoneBox draws its own interface with. The host bundles host/icons/*.svg
  // in front of the SDK as window.PBW_ICONS; icon() returns an inline SVG in the text color, 1em big.
  const ICONS = window.PBW_ICONS || {};
  const icon = (name, cls = '') => {
    const t = document.createElement('template');
    t.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
    const s = t.content.firstElementChild;
    s.setAttribute('class', 'ico' + (cls ? ' ' + cls : ''));
    s.dataset.icon = name;
    return s;
  };
  // an icon followed by a label, for buttons
  const label = (name, text) => { const f = document.createDocumentFragment(); f.append(icon(name, 'm'), text); return f; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const q = (o) => Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  const api = async (path, opts = {}) => {
    const r = await fetch(BASE + path, { cache: 'no-store', ...opts });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    return j;
  };
  // text/plain keeps the request "simple" (no CORS preflight); the host parses the JSON body anyway
  const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body == null ? '' : JSON.stringify(body) });
  const css = (key, text) => {
    if (document.getElementById('pbw-css-' + key)) return;
    const s = h('style', null, text); s.id = 'pbw-css-' + key; document.head.append(s);
  };

  // ------------------------------------------------------------------ shared look: root, gear, toast, editor
  css('sdk', `
.pbw{--fg:#eef2f6;--dim:#8a94a3;--line:rgba(255,255,255,.08);--track:rgba(255,255,255,.07);--acc:#2dd4bf;
  position:relative;box-sizing:border-box;height:100%;width:100%;color:var(--fg);overflow:hidden;
  font:12px/1.25 Roboto,"Segoe UI",system-ui,sans-serif;user-select:none;-webkit-user-select:none}
.pbw *{box-sizing:border-box}
.pbw button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
.pbw .ico{width:1em;height:1em;vertical-align:-.15em;flex:none}
.pbw .ico.m{margin-right:.4em}
.pbw-gear{position:absolute;top:3px;right:3px;z-index:4;width:24px;height:22px;display:grid;place-items:center;opacity:.45;font-size:14px;border-radius:6px}
.pbw-gear:active{background:var(--track);opacity:1}
.pbw-toast{position:absolute;left:8px;right:8px;bottom:8px;z-index:20;color:#fecaca;background:#7f1d1d;border-radius:8px;font-size:11px;text-align:center;padding:6px}
.pbw-fail{height:100%;display:grid;place-items:center;text-align:center;color:#f87171;padding:8px;font-size:11px}

.ed{position:absolute;inset:0;z-index:10;background:#0f141b;display:flex;flex-direction:column;font-size:12px}
.ed-head{display:flex;align-items:center;gap:6px;padding:7px 8px;border-bottom:1px solid var(--line);flex:none}
.ed-head b{flex:1;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ed-body{flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:8px;-webkit-overflow-scrolling:touch}
.ed .pill{padding:6px 11px;border-radius:9px;background:var(--track);white-space:nowrap}
.ed .pill.pri{background:var(--acc);color:#06201c;font-weight:600}
.ed .pill:disabled{opacity:.4}
.ed-sec{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin-top:4px}
.ed-sub{font-size:10.5px;color:var(--dim);margin:4px 2px 0}
.ed-hint{color:var(--dim);font-size:11px;line-height:1.4}
.ed-col{display:flex;flex-direction:column;gap:6px}
.ed-inline{display:flex;gap:6px;align-items:center}
.ed-inline input{flex:1;min-width:0}
.ed-seg{display:flex;background:var(--track);border-radius:9px;padding:2px;gap:2px}
.ed-seg button{flex:1;padding:6px 4px;border-radius:7px;color:var(--dim)}
.ed-seg button.on{background:#2b3442;color:var(--fg)}
.ed-row{display:flex;align-items:center;gap:6px;padding:6px;border-radius:9px;background:rgba(255,255,255,.035);min-height:36px}
.ed-row .grow{flex:1;min-width:0}
.ed-row .t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ed-row .s{font-size:10.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ed-row .ib{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;background:var(--track);flex:none}
.ed-row.check{cursor:pointer}
.ed-row.check.on{background:rgba(45,212,191,.13);outline:1px solid rgba(45,212,191,.45)}
.ed-row.check.dis{opacity:.35;pointer-events:none}
.ed-box{width:18px;height:18px;border-radius:5px;border:2px solid #4b5563;flex:none;display:grid;place-items:center;font-size:12px;font-weight:700}
.ed-row.on .ed-box{background:var(--acc);border-color:var(--acc);color:#06201c}
.ed-dot{width:10px;height:10px;border-radius:50%;flex:none}
.ed input[type=text],.ed select{width:100%;padding:8px 10px;border-radius:9px;border:1px solid var(--line);background:#161d27;color:var(--fg);font:inherit;outline:none}
.ed input[type=text]:focus{border-color:var(--acc)}
.ed-range{display:flex;align-items:center;gap:8px}
.ed-range input{flex:1;accent-color:var(--acc)}
.ed-range b{min-width:42px;text-align:right;font-variant-numeric:tabular-nums}
.ed-sw{display:flex;gap:8px;flex-wrap:wrap}
.ed-sw button{width:26px;height:26px;border-radius:50%;border:2px solid transparent}
.ed-sw button.on{border-color:#fff}
.ed-badge{font-size:10px;padding:1px 6px;border-radius:6px;background:#2b3442;color:#c4b5fd;flex:none}
.ed-tri{display:flex;gap:2px;background:var(--track);border-radius:8px;padding:2px;flex:none}
.ed-tri button{padding:4px 7px;border-radius:6px;color:var(--dim);font-size:11px}
.ed-tri button.on{background:#2b3442;color:var(--fg)}
.cp{display:flex;flex-direction:column;gap:8px}
.cp-row{display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap}
.cp-native{width:40px;height:36px;padding:0;border:0;border-radius:9px;background:none;cursor:pointer;flex:none}
.cp-native::-webkit-color-swatch-wrapper{padding:0}
.cp-native::-webkit-color-swatch{border:2px solid rgba(255,255,255,.25);border-radius:9px}
.cp-f{display:flex;flex-direction:column;gap:2px;font-size:10px;color:var(--dim)}
.ed .cp input.cp-hex{width:84px;font-family:Consolas,monospace}
.ed .cp-n{width:54px;padding:8px 6px;border-radius:9px;border:1px solid var(--line);background:#161d27;color:var(--fg);font:inherit;outline:none}
.ed .cp-n:focus{border-color:var(--acc)}
.ed .cp input.cp-hex.bad{border-color:#f87171}
.fp-row{font-size:15px}
.fp-row .s{font-family:Roboto,"Segoe UI",sans-serif}
`);

  function makeEditor(root) {
    let el = null;
    const ed = {
      get isOpen() { return !!el; },
      open() { if (!el) { el = h('div', 'ed'); root.append(el); } return ed; },
      close() { el?.remove(); el = null; },
      // replaces the editor's content; keeps the scroll position when the same screen is drawn again
      screen(title, actions, ...body) {
        ed.open();
        const old = el.querySelector('.ed-body');
        const keep = old?.dataset.screen === title ? old.scrollTop : 0;
        const b = h('div', 'ed-body', ...body);
        b.dataset.screen = title;
        el.replaceChildren(h('div', 'ed-head', h('b', null, title), ...actions), b);
        b.scrollTop = keep;
        return b;
      },
    };
    return ed;
  }

  // ------------------------------------------------------------------ editor building blocks
  const ui = {
    section: (text) => h('div', 'ed-sec', text),
    hint: (text) => h('div', 'ed-hint', text),
    row: (title, sub, ...extra) => h('div', 'ed-row', h('div', 'grow', h('div', 't', title), sub ? h('div', 's', sub) : null), ...extra),
    // a checkbox row; onChange(newValue)
    check(title, sub, value, onChange) {
      const box = h('span', 'ed-box', value ? icon('check') : '');
      const row = h('div', 'ed-row check' + (value ? ' on' : ''), box, h('div', 'grow', h('div', 't', title), sub ? h('div', 's', sub) : null));
      row.addEventListener('click', () => { value = !value; row.classList.toggle('on', value); box.replaceChildren(value ? icon('check') : ''); onChange(value); });
      return row;
    },
    // segmented choice: options [[value, label], ...]
    segmented(options, value, onChange) {
      const wrap = h('div', 'ed-seg');
      for (const [v, label] of options) {
        const b = btn(v === value ? 'on' : '', label, () => { wrap.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); onChange(v); });
        wrap.append(b);
      }
      return wrap;
    },
    // slider with a value readout; onInput fires while dragging
    range(min, max, step, value, onInput, fmt = (v) => String(v)) {
      const input = h('input'); input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = value;
      const out = h('b', null, fmt(+value));
      input.addEventListener('input', () => { out.textContent = fmt(+input.value); onInput(+input.value); });
      const wrap = h('div', 'ed-range', input, out);
      wrap.set = (v) => { input.value = v; out.textContent = fmt(+v); };
      return wrap;
    },
    input(value, placeholder, onInput) {
      const i = h('input'); i.type = 'text'; i.value = value || ''; i.placeholder = placeholder || ''; i.spellcheck = false;
      i.addEventListener('input', () => onInput(i.value));
      return i;
    },
    colorPicker,
  };

  // color wheel (the system picker), hex, R G B and presets
  function colorPicker(initial, onChange, presets = COLORS) {
    const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const toHex = (rgb) => '#' + rgb.map((v) => clamp(Math.round(v) || 0, 0, 255).toString(16).padStart(2, '0')).join('');
    let cur = /^#[0-9a-f]{6}$/i.test(initial || '') ? initial.toLowerCase() : presets[0];
    const native = h('input', 'cp-native'); native.type = 'color'; native.title = 'Pick a color';
    const hex = h('input', 'cp-hex'); hex.type = 'text'; hex.maxLength = 7; hex.spellcheck = false;
    const rgb = ['R', 'G', 'B'].map(() => { const n = h('input', 'cp-n'); n.type = 'number'; n.min = 0; n.max = 255; n.inputMode = 'numeric'; return n; });
    const sw = h('div', 'ed-sw');
    const set = (c, from) => {
      cur = c;
      if (from !== 'native') native.value = c;
      if (from !== 'hex') hex.value = c;
      if (from !== 'rgb') toRgb(c).forEach((v, i) => { rgb[i].value = v; });
      sw.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.c === c));
      if (from) onChange(c);
    };
    native.addEventListener('input', () => set(native.value.toLowerCase(), 'native'));
    hex.addEventListener('input', () => {
      let v = hex.value.trim();
      if (!v.startsWith('#')) v = '#' + v;
      if (/^#[0-9a-f]{3}$/i.test(v)) v = '#' + [...v.slice(1)].map((x) => x + x).join('');
      const ok = /^#[0-9a-f]{6}$/i.test(v);
      hex.classList.toggle('bad', !ok);
      if (ok) set(v.toLowerCase(), 'hex');
    });
    hex.addEventListener('blur', () => { hex.value = cur; hex.classList.remove('bad'); });
    rgb.forEach((n) => n.addEventListener('input', () => set(toHex(rgb.map((x) => +x.value)), 'rgb')));
    rgb.forEach((n) => n.addEventListener('blur', () => toRgb(cur).forEach((v, i) => { rgb[i].value = v; })));
    for (const c of presets) {
      const b = btn('', '', () => set(c, 'preset'));
      b.dataset.c = c; b.style.background = c; b.title = c;
      sw.append(b);
    }
    set(cur);
    return h('div', 'cp',
      h('div', 'cp-row', native, h('label', 'cp-f', h('span', null, 'Hex'), hex), ...rgb.map((n, i) => h('label', 'cp-f', h('span', null, 'RGB'[i]), n))),
      sw);
  }

  // ------------------------------------------------------------------ fonts: the PC's installed fonts, loaded on demand
  const GENERIC = [
    { id: '', name: 'Default (Roboto)', family: 'Roboto,"Segoe UI",system-ui,sans-serif' },
    { id: 'generic:serif', name: 'Serif', family: 'serif' },
    { id: 'generic:mono', name: 'Monospace', family: 'monospace' },
    { id: 'generic:condensed', name: 'Condensed', family: '"sans-serif-condensed","Arial Narrow",sans-serif' },
  ];
  let fontCache = null;
  const loadedFonts = new Set();
  const fonts = () => fontCache || (fontCache = api('/api/fonts').then((r) => [...GENERIC, ...r.fonts]).catch(() => GENERIC));
  function useFont(id) {
    const g = GENERIC.find((f) => f.id === (id || ''));
    if (g) return g.family;
    const fam = 'pbw-' + id.replace(/[^a-z0-9-]/gi, '-');
    if (!loadedFonts.has(id)) {
      loadedFonts.add(id);
      css('font-' + fam, `@font-face{font-family:"${fam}";src:url("${BASE}/fonts/${encodeURIComponent(id)}");font-display:swap}`);
    }
    return `"${fam}",Roboto,sans-serif`;
  }
  // a searchable list; each visible row previews itself in its font (only visible fonts get downloaded)
  ui.fontPicker = function fontPicker(current, onPick, sample = '12:34') {
    const search = ui.input('', 'Search fonts', () => fill());
    const list = h('div', 'ed-col');
    const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { const r = e.target; r.querySelector('.t').style.fontFamily = useFont(r.dataset.id); io.unobserve(r); }
    }) : null;
    let all = [];
    const fill = () => {
      const f = search.value.toLowerCase();
      list.replaceChildren(...all.filter((x) => !f || x.name.toLowerCase().includes(f)).slice(0, 400).map((x) => {
        const row = h('div', 'ed-row check fp-row' + (x.id === (current || '') ? ' on' : ''), h('span', 'ed-box', x.id === (current || '') ? icon('check') : ''),
          h('div', 'grow', h('div', 't', sample), h('div', 's', x.name)));
        row.dataset.id = x.id;
        row.addEventListener('click', () => { current = x.id; onPick(x.id, x.name); fill(); });
        if (io) io.observe(row); else row.querySelector('.t').style.fontFamily = useFont(x.id);
        return row;
      }));
    };
    fonts().then((l) => { all = l; fill(); });
    return h('div', 'ed-col', search, list);
  };

  // ------------------------------------------------------------------ mount
  function mount(type, setup) {
    const root = document.getElementById('pbw') || document.getElementById('vs') || document.body.appendChild(h('div'));
    if (root.__pbw) return; // loaded twice (a loader retry raced a slow load)
    root.__pbw = true;
    // data-id names this widget's settings; the first Volume Slider snippet used data-widget for that
    const id = ((root.dataset.id || root.dataset.widget || 'main').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)) || 'main';
    root.classList.add('pbw', 'pbw-' + type);
    if (!root.style.height) root.style.height = '100%';
    let toastTimer = 0, toast = null;
    const base = `/api/w/${type}`;
    const ctx = {
      type, id, root, BASE,
      api: (name, params = {}) => api(`${base}/${name}?${q({ id, ...params })}`),
      post: (name, params = {}, body) => post(`${base}/${name}?${q({ id, ...params })}`, body),
      loadConfig: () => api(`${base}/config?${q({ id })}`),
      saveConfig: (config) => post(`${base}/config?${q({ id })}`, config).then((r) => r.config),
      error(e) {
        toast?.remove();
        toast = h('div', 'pbw-toast', String((e && e.message) || e));
        root.append(toast);
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast?.remove(), 3500);
      },
      editor: makeEditor(root),
      gear: (onClick) => btn('pbw-gear', icon('settings'), onClick, 'Settings'),
    };
    try {
      const r = setup(ctx);
      if (r && r.catch) r.catch((e) => { console.error(e); ctx.error(e); });
    } catch (e) {
      console.error(e);
      root.replaceChildren(h('div', 'pbw-fail', `${type} widget failed: ${e.message}`));
    }
    return ctx;
  }

  window.PBW = {
    BASE, COLORS, h, btn, clamp, q, api, post, css, ui, fonts, useFont, mount, icon, label, ICON_NAMES: Object.keys(ICONS),
    battery: () => api('/api/phone/battery'),
  };
})();
