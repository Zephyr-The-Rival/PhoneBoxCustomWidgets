// Audio output widget, tablet side: one tile per output device you picked; tap a tile and Windows switches to it.
// PC side: plugin.py (reads devices and switches through the PhoneBox agent).
PBW.mount('audio-output', async (ctx) => {
  const { h, btn, ui, clamp } = PBW;
  const root = ctx.root;
  // Lucide icon names (host/icons); keep in sync with plugin.py ICONS
  const ICONS = ['speaker', 'headphones', 'headset', 'monitor', 'tv', 'laptop', 'gamepad-2', 'music', 'radio', 'sofa', 'bluetooth', 'car', 'cable'];

  PBW.css('audio-output', `
.ao{display:flex;flex-direction:column;padding:6px 8px 8px}
.ao-head{display:flex;align-items:center;height:18px;flex:none;margin-bottom:5px;padding-right:22px}
.ao-title{flex:1;min-width:0;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ao-off{font-size:10px;color:#f87171}
.ao.compact{padding:4px 30px 4px 6px}
.ao.compact .ao-head{display:none}
.ao-grid{flex:1;min-height:0;display:grid;gap:6px}
.ao-tile{--c:#2dd4bf;position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.25em;min-width:0;min-height:0;
  padding:.4em;border-radius:12px;background:rgba(255,255,255,.05);border:2px solid transparent;transition:background .2s,border-color .2s,box-shadow .2s,transform .1s;text-align:center;overflow:hidden}
.ao-tile:active{transform:scale(.97)}
.ao-tile .ico-slot{display:flex;flex:none}
.ao-tile .ico{width:1.9em;height:1.9em}
.ao-tile .txt{display:flex;flex-direction:column;align-items:center;gap:.15em;min-width:0;max-width:100%}
.ao-tile .lbl{font-weight:600;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ao-tile .sub{font-size:.8em;color:var(--dim);white-space:nowrap}
.ao-tile.on{border-color:var(--c);background:color-mix(in srgb,var(--c) 18%,transparent);box-shadow:0 0 14px color-mix(in srgb,var(--c) 35%,transparent)}
.ao-tile.on .sub{color:var(--c)}
.ao-tile.gone{opacity:.35}
.ao-tile.busy{animation:ao-pulse .7s ease-in-out infinite alternate}
@keyframes ao-pulse{to{background:color-mix(in srgb,var(--c) 22%,transparent)}}
.ao-row .ao-tile{flex-direction:row;justify-content:flex-start;gap:.6em;padding:.3em .7em;text-align:left}
.ao-row .ao-tile .txt{align-items:flex-start}
.ao-row .ao-tile .ico{width:1.5em;height:1.5em}
.ao-empty{flex:1;display:grid;place-items:center;text-align:center;color:var(--dim)}
.ao-empty button{margin-top:8px;padding:8px 14px;border-radius:10px;background:var(--track);color:var(--fg)}
.ao-pick{width:36px;height:36px;border-radius:9px;background:var(--track);display:grid;place-items:center}
.ao-pick .ico{width:20px;height:20px}
.ao-pick.on{outline:2px solid var(--acc)}
`);
  root.classList.add('ao');
  const title = h('span', 'ao-title'), off = h('span', 'ao-off');
  const grid = h('div', 'ao-grid');
  root.replaceChildren(h('div', 'ao-head', title, off), grid, ctx.gear(() => openEditor()));

  let state = null, pending = null; // pending: {id, until} while a switch is on its way
  const tiles = new Map();

  // ------------------------------------------------------------------ tiles
  function makeTile(id) {
    const ico = h('span', 'ico-slot'), lbl = h('span', 'lbl'), sub = h('span', 'sub');
    const el = btn('ao-tile', '', () => choose(id));
    el.append(ico, h('span', 'txt', lbl, sub));
    return { el, ico, lbl, sub, icon: null };
  }

  async function choose(id) {
    const t = state?.tiles.find((x) => x.id === id);
    if (!t) return;
    if (!t.present) { ctx.error(`${t.label} is not connected`); return; }
    if (t.active) return;
    pending = { id, until: Date.now() + 4000 };
    render();
    try { await ctx.post('switch', { dev: id }); await poll(); }
    catch (e) { ctx.error(e); }
    pending = null;
    render();
  }

  // picks columns × rows so the tiles come out as close to a comfortable shape as possible
  function arrange(n, W, H) {
    const pref = state?.config?.layout || 'auto';
    if (pref === 'row') return { cols: n, rows: 1, row: false };
    if (pref === 'column') return { cols: 1, rows: n, row: true };
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols), w = (W - (cols - 1) * 6) / cols, h = (H - (rows - 1) * 6) / rows;
      const score = Math.min(w, h * 1.5) - (rows * cols - n) * 4; // square-ish tiles, few empty cells
      if (!best || score > best.score) best = { cols, rows, score, w, h };
    }
    // wide, flat tiles read better as icon + text in a row
    return { ...best, row: pref === 'grid' ? false : best.w > best.h * 2.4 && best.h < 70 };
  }

  function render() {
    if (!state) return;
    const cfg = state.config || {};
    title.textContent = cfg.title || '';
    off.textContent = state.ok ? '' : '● PhoneBox agent offline';
    root.classList.toggle('compact', root.clientHeight < 90 && !cfg.title && state.ok);
    const list = state.tiles || [];
    if (!list.length) {
      tiles.clear();
      if (!grid.querySelector('.ao-empty'))
        grid.replaceChildren(h('div', 'ao-empty', h('div', null, 'No devices yet', h('br'), btn('', '+ Choose devices', () => openEditor()))));
      grid.style.gridTemplateColumns = '1fr';
      return;
    }
    const W = grid.clientWidth || root.clientWidth, H = grid.clientHeight || root.clientHeight - 28;
    const lay = arrange(list.length, W, H);
    grid.style.gridTemplateColumns = `repeat(${lay.cols}, minmax(0, 1fr))`;
    grid.style.gridTemplateRows = `repeat(${lay.rows}, minmax(0, 1fr))`;
    grid.classList.toggle('ao-row', lay.row);
    const tileH = (H - (lay.rows - 1) * 6) / lay.rows, tileW = (W - (lay.cols - 1) * 6) / lay.cols;
    root.style.fontSize = clamp(Math.round(Math.min(tileH / (lay.row ? 2.6 : 4.6), tileW / 7.5)), 10, 18) + 'px';
    const nodes = list.map((t) => {
      let v = tiles.get(t.id);
      if (!v) { v = makeTile(t.id); tiles.set(t.id, v); }
      const busy = pending && pending.id === t.id && Date.now() < pending.until;
      const on = pending ? busy : t.active;
      v.el.style.setProperty('--c', t.color);
      v.el.classList.toggle('on', !!on);
      v.el.classList.toggle('busy', !!busy);
      v.el.classList.toggle('gone', !t.present);
      if (v.icon !== t.icon) { v.icon = t.icon; v.ico.replaceChildren(PBW.icon(t.icon)); }
      v.lbl.textContent = t.label;
      v.sub.textContent = !t.present ? 'not connected' : busy ? 'switching…' : t.active ? 'active' + (cfg.showVolume && t.volume != null ? ` · ${t.muted ? 'muted' : t.volume + '%'}` : '')
        : cfg.showVolume && t.volume != null ? (t.muted ? 'muted' : t.volume + '%') : '';
      v.el.title = t.present ? `Switch Windows' output to ${t.label}` : `${t.label} is not connected`;
      return v.el;
    });
    for (const id of [...tiles.keys()]) if (!list.some((t) => t.id === id)) tiles.delete(id);
    if (nodes.length !== grid.children.length || nodes.some((n, i) => grid.children[i] !== n)) grid.replaceChildren(...nodes);
  }

  let fails = 0;
  async function poll() {
    try { state = await ctx.api('state'); fails = 0; }
    catch (_) { fails++; off.textContent = '● widget host offline'; return; }
    if (!ctx.editor.isOpen) render();
  }
  (async function loop() { if (!document.hidden) await poll(); setTimeout(loop, fails ? Math.min(8000, 1500 * fails) : 2000); })();
  new ResizeObserver(() => render()).observe(root);

  // ------------------------------------------------------------------ settings
  let draft = null;
  async function openEditor() {
    await poll();
    draft = JSON.parse(JSON.stringify(state?.config || {}));
    draft.devices = draft.devices || [];
    draft.role = draft.role || 'all'; draft.layout = draft.layout || 'auto';
    if (draft.showVolume == null) draft.showVolume = true;
    showList();
  }
  const close = () => { ctx.editor.close(); draft = null; render(); };
  const save = async () => {
    try { await ctx.saveConfig(draft); await poll(); close(); } catch (e) { ctx.error(e); }
  };
  const nameOf = (id) => state.available.find((a) => a.id === id);
  const availLabel = (a) => a.name + (a.twin ? ` (${a.twin})` : '');

  function showList() {
    const rows = draft.devices.map((d, i) => {
      const live = nameOf(d.id);
      const dot = h('span', 'ed-dot'); dot.style.background = d.color;
      const row = h('div', 'ed-row check', PBW.icon(d.icon), dot,
        h('div', 'grow', h('div', 't', d.label || (live ? availLabel(live) : d.name)), h('div', 's', live ? (live.active ? '● active now' : 'connected') : 'not connected')),
        btn('ib', PBW.icon('pencil'), () => showDevice(i), 'Edit'),
        btn('ib', PBW.icon('chevron-up'), () => { if (i) { draft.devices.splice(i - 1, 0, draft.devices.splice(i, 1)[0]); showList(); } }, 'Move up'),
        btn('ib', PBW.icon('chevron-down'), () => { if (i < draft.devices.length - 1) { draft.devices.splice(i + 1, 0, draft.devices.splice(i, 1)[0]); showList(); } }, 'Move down'),
        btn('ib', PBW.icon('x'), () => { draft.devices.splice(i, 1); showList(); }, 'Remove'));
      row.addEventListener('click', () => showDevice(i));
      return row;
    });
    ctx.editor.screen('Audio outputs', [btn('pill', 'Cancel', close), btn('pill pri', 'Save', save)],
      ui.section('Devices'),
      ...(rows.length ? rows : [ui.hint('No devices yet: add the outputs you switch between.')]),
      btn('pill', '+ Add devices', showAdd),
      ui.section('When I tap a device, switch'),
      ui.segmented([['all', 'Everything'], ['media', 'Media only']], draft.role, (v) => { draft.role = v; }),
      ui.hint('Windows keeps a separate default device for calls. “Media only” leaves calls (Discord, Teams…) where they are.'),
      ui.section('Layout'),
      ui.segmented([['auto', 'Auto'], ['grid', 'Tiles'], ['row', 'One row'], ['column', 'List']], draft.layout, (v) => { draft.layout = v; }),
      ui.check('Show volume', 'The device’s volume under its name', draft.showVolume, (v) => { draft.showVolume = v; }),
      ui.section('Title'), ui.input(draft.title, 'Title (optional)', (v) => { draft.title = v; }));
  }

  function showAdd() {
    const picked = new Set(draft.devices.map((d) => d.id));
    const rows = state.available.map((a) => {
      const on = picked.has(a.id);
      return ui.check(PBW.label(a.icon, availLabel(a)), a.active ? '● active now' : '', on, (v) => {
        if (v && !draft.devices.some((d) => d.id === a.id)) {
          const used = new Set(draft.devices.map((d) => d.color));
          draft.devices.push({ id: a.id, name: a.name, label: '', icon: a.icon, color: PBW.COLORS.find((c) => !used.has(c)) || PBW.COLORS[0] });
        } else if (!v) draft.devices = draft.devices.filter((d) => d.id !== a.id);
      });
    });
    ctx.editor.screen('Add devices', [btn('pill pri', 'Done', showList)],
      ui.hint('Outputs Windows sees right now. Unplugged devices stay on the widget (dimmed) once added.'),
      ...(rows.length ? rows : [ui.hint(state.ok ? 'No output devices found.' : state.error)]));
  }

  function showDevice(i) {
    const d = draft.devices[i];
    const live = nameOf(d.id);
    const picks = h('div', 'ed-sw', ...ICONS.map((ic) => {
      const b = btn('ao-pick' + (ic === d.icon ? ' on' : ''), PBW.icon(ic), () => { d.icon = ic; picks.querySelectorAll('.ao-pick').forEach((x) => x.classList.toggle('on', x === b)); });
      return b;
    }));
    ctx.editor.screen('Device', [btn('pill pri', 'Back', showList)],
      ui.hint(live ? availLabel(live) : `${d.name} (not connected)`),
      ui.section('Name on the widget'), ui.input(d.label, live ? live.name : d.name, (v) => { d.label = v; }),
      ui.section('Icon'), picks,
      ui.section('Color'), ui.colorPicker(d.color, (c) => { d.color = c; }));
  }
});
