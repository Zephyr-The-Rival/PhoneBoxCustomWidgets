// Clipboard widget, tablet side: Windows' clipboard history (Win+V), newest first. Tap an entry and it's pasted into
// the active window on the PC. PC side: plugin.py (+ helper.ps1 for Windows' clipboard history API).
PBW.mount('clipboard', async (ctx) => {
  const { h, btn, ui } = PBW;
  const root = ctx.root;
  const DEFAULTS = { title: '', lines: 2, showTime: true };
  const HOLD_MS = 500;

  PBW.css('clipboard', `
.cb{display:flex;flex-direction:column;gap:8px;padding:8px 10px 10px;font-size:14px}
.cb-head{display:flex;align-items:center;gap:8px;height:20px;flex:none;padding-right:26px}
.cb-title{flex:1;min-width:0;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cb-stat{font-size:11px;color:var(--dim);white-space:nowrap}
.cb-stat.bad{color:#f87171}
.cb-list{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:6px;-webkit-overflow-scrolling:touch}
/* an entry: a big finger-sized card (a div, not a button: scrolling the list mustn't buzz, only a real tap does) */
.cb-item{position:relative;display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:14px;background:rgba(255,255,255,.05);
  min-height:52px;flex:none;cursor:pointer;transition:background .15s,transform .1s;overflow:hidden}
.cb-item:active{background:rgba(255,255,255,.1);transform:scale(.985)}
.cb-item .ico{width:20px;height:20px;flex:none;margin-top:1px;color:var(--dim)}
.cb-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.cb-text{font-size:15px;line-height:1.35;white-space:pre-wrap;word-break:break-word;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:var(--lines,2)}
.cb-text.dim{color:var(--dim);font-style:italic}
.cb-time{font-size:11px;color:var(--dim)}
.cb-item.busy{opacity:.6}
/* previews: an image entry's picture; copied files as Explorer thumbnails (one big, or a row of small ones) */
.cb-img{display:block;max-width:100%;max-height:150px;border-radius:9px;background:rgba(255,255,255,.04);object-fit:contain}
.cb-thumbs{display:flex;gap:6px;align-items:center}
.cb-th{width:56px;height:56px;border-radius:9px;background:rgba(255,255,255,.06);display:grid;place-items:center;flex:none;overflow:hidden;position:relative}
.cb-th img{width:100%;height:100%;object-fit:cover;display:block}
.cb-th.icon img{object-fit:contain;padding:4px}
.cb-th .ico{width:24px;height:24px;margin:0}
.cb-th.gone{opacity:.35}
.cb-th.big{width:auto;height:auto;max-width:100%;background:none}
.cb-th.big img{max-height:150px;width:auto;max-width:100%;border-radius:9px}
.cb-more{font-weight:700;color:var(--dim);font-size:14px;padding:0 4px}
.cb-names{font-size:14px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cb-missing{color:#f87171;font-size:11px}
/* holding an entry: a fill runs across it for HOLD_MS, then it's copied (not pasted) */
.cb-item::before{content:'';position:absolute;inset:0;background:rgba(96,165,250,.22);transform:scaleX(0);transform-origin:left;pointer-events:none}
.cb-item.holding::before{transform:scaleX(1);transition:transform var(--hold) linear}
.cb-item.done{background:rgba(35,165,90,.28)}
.cb-done{position:absolute;right:10px;top:50%;transform:translateY(-50%);display:flex;align-items:center;gap:5px;font-weight:700;color:#4ade80;
  background:rgba(12,15,22,.85);padding:5px 10px;border-radius:10px;font-size:13px}
.cb-done .ico{width:16px;height:16px;color:#4ade80;margin:0}
.cb-msg{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;color:var(--dim);padding:8px}
.cb-msg .ico{width:30px;height:30px}
.cb-msg b{color:var(--fg);font-size:16px}
.cb-msg button{padding:12px 20px;border-radius:12px;background:var(--track);color:var(--fg);font-size:15px;font-weight:600}
`);

  root.classList.add('cb');
  root.style.setProperty('--hold', HOLD_MS + 'ms');
  const title = h('span', 'cb-title'), stat = h('span', 'cb-stat');
  const list = h('div', 'cb-list');
  root.replaceChildren(h('div', 'cb-head', title, stat), list, ctx.gear(() => openEditor()));

  let st = null, cfg = { ...DEFAULTS }, fails = 0, mode = '';
  const cards = new Map(); // id -> {el, key}

  const ago = (ms) => {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return new Date(ms).toLocaleDateString();
  };

  // copyOnly (holding the entry): it becomes the clipboard content, without Ctrl+V
  async function paste(item, el, copyOnly = false) {
    el.classList.add('busy');
    try {
      await ctx.post('paste', { item: item.id, copy: copyOnly ? 1 : null });
      PBW.haptic(); // the buzz confirms it happened (a failure shows an error instead)
      el.classList.remove('busy');
      el.classList.add('done');
      const badge = h('div', 'cb-done', PBW.icon('check'), copyOnly ? 'Copied' : 'Pasted');
      el.append(badge);
      setTimeout(() => { el.classList.remove('done'); badge.remove(); }, 900);
      setTimeout(poll, 300); // the entry moved to the top
    } catch (e) {
      el.classList.remove('busy');
      ctx.error(e);
    }
  }

  const thumbUrl = (params) => `${PBW.BASE}/api/w/clipboard/thumb?${PBW.q(params)}`;
  // an <img> that falls back to an icon when there's no preview
  function preview(src, fallbackIcon, cls) {
    const box = h('div', cls);
    const img = h('img'); img.alt = ''; img.loading = 'lazy'; img.draggable = false;
    img.onerror = () => { box.classList.remove('big'); box.classList.add('cb-th'); box.replaceChildren(PBW.icon(fallbackIcon)); };
    img.src = src;
    box.append(img);
    return box;
  }
  const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|heic|avif|tiff?)$/i;

  function body(item) {
    const time = cfg.showTime ? h('div', 'cb-time', ago(item.time)) : null;
    if (item.kind === 'text') {
      const blank = !item.text.trim();
      return [null, h('div', 'cb-body', h('div', 'cb-text' + (blank ? ' dim' : ''), blank ? '(only spaces / line breaks)' : item.text.trim()), time)];
    }
    if (item.kind === 'image') { // a picture in Windows' history (screenshot, "Copy image")
      const img = h('img', 'cb-img'); img.alt = 'Image'; img.loading = 'lazy'; img.draggable = false;
      const label = h('div', 'cb-text dim', 'Image');
      img.onerror = () => img.replaceWith(label);
      img.src = thumbUrl({ item: item.id });
      return [null, h('div', 'cb-body', img, time)];
    }
    if (item.kind === 'filelist') { // copied files (the host remembers them; Win+V doesn't)
      const files = item.files || [];
      const fid = item.id.slice(2);
      const thumb = (f, i, cls) => {
        if (!f.exists) { const t = h('div', 'cb-th gone', PBW.icon('x')); return t; }
        const t = preview(thumbUrl({ f: fid, i }), 'folder', cls + (IMAGE_EXT.test(f.name) ? '' : ' icon'));
        return t;
      };
      const single = files.length === 1 && files[0].exists && IMAGE_EXT.test(files[0].name);
      const thumbs = single ? h('div', 'cb-thumbs', thumb(files[0], 0, 'cb-th big'))
        : h('div', 'cb-thumbs', ...files.slice(0, 4).map((f, i) => thumb(f, i, 'cb-th')),
          files.length > 4 ? h('span', 'cb-more', '+' + (files.length - 4)) : null);
      const missing = files.filter((f) => !f.exists).length;
      const names = (files.length > 1 ? files.length + ' files · ' : '') + files.map((f) => f.name).join(', ');
      return [null, h('div', 'cb-body', thumbs, h('div', 'cb-names', names),
        missing ? h('div', 'cb-missing', missing === files.length ? 'No longer there' : `${missing} no longer there`) : null, time)];
    }
    return [PBW.icon(item.kind === 'files' ? 'folder' : 'clipboard'),
      h('div', 'cb-body', h('div', 'cb-text dim', item.kind === 'files' ? 'Files' : 'Other content'), time)];
  }

  function card(item) {
    const [ico, content] = body(item);
    const el = h('div', 'cb-item', ico, content);
    el.setAttribute('role', 'button');
    el.title = 'Tap: paste into the active window on the PC. Hold: copy only.';
    // tap = paste, hold HOLD_MS = copy only; moving the finger (scrolling) cancels both
    let timer = 0, start = null, held = false;
    const cancel = () => { clearTimeout(timer); timer = 0; start = null; el.classList.remove('holding'); };
    el.addEventListener('pointerdown', (e) => {
      held = false;
      start = { x: e.clientX, y: e.clientY };
      el.classList.add('holding');
      timer = setTimeout(() => { held = true; cancel(); paste(item, el, true); }, HOLD_MS);
    });
    el.addEventListener('pointermove', (e) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) { cancel(); held = true; } // a scroll, not a tap
    });
    el.addEventListener('pointerup', () => { if (start) cancel(); });
    el.addEventListener('pointercancel', () => { cancel(); held = true; });
    el.addEventListener('contextmenu', (e) => e.preventDefault()); // Android's long-press menu
    el.addEventListener('click', () => { if (!held) paste(item, el); held = false; });
    return el;
  }

  function message(icon, text, sub, buttons = []) {
    const key = 'msg|' + icon + text + sub;
    if (mode === key) return;
    mode = key;
    cards.clear();
    list.replaceChildren(h('div', 'cb-msg', PBW.icon(icon), h('b', null, text), sub ? h('div', null, sub) : null, ...buttons));
  }

  function render() {
    if (!st) return;
    cfg = { ...DEFAULTS, ...(st.config || {}) };
    root.style.setProperty('--lines', cfg.lines);
    title.textContent = cfg.title || 'Clipboard';
    stat.classList.toggle('bad', !st.ok);
    if (!st.ok) { stat.textContent = ''; return message('x', 'Can’t read the clipboard history', st.error || ''); }
    if (!st.enabled) {
      stat.textContent = '';
      return message('clipboard', 'Clipboard history is off', 'Windows only keeps a history when it’s switched on (Win+V).',
        [btn('', 'Open Windows settings', () => ctx.post('settings').catch((e) => ctx.error(e)))]);
    }
    const items = st.items || [];
    stat.textContent = items.length ? `${items.length}` : '';
    if (!items.length) return message('clipboard', 'Nothing copied yet', 'Copy something on the PC and it shows up here.');
    if (mode !== 'list') { mode = 'list'; list.replaceChildren(); cards.clear(); }
    const nodes = items.map((it) => {
      const key = `${it.kind}|${it.text || ''}|${(it.files || []).map((f) => f.name + f.exists).join('/')}|${cfg.showTime ? ago(it.time) : ''}`;
      let c = cards.get(it.id);
      if (!c || (c.key !== key && !c.el.classList.contains('done'))) { // (keeps the "Pasted" feedback until it fades)
        c = { el: card(it), key };
        cards.set(it.id, c);
      }
      return c.el;
    });
    for (const id of [...cards.keys()]) if (!items.some((it) => it.id === id)) cards.delete(id);
    if (nodes.length !== list.children.length || nodes.some((n, i) => list.children[i] !== n)) list.replaceChildren(...nodes);
  }

  async function poll() {
    try { st = await ctx.api('state'); fails = 0; }
    catch (_) { fails++; stat.textContent = '● widget host offline'; stat.classList.add('bad'); return; }
    render();
  }
  (async function loop() {
    if (!document.hidden) await poll();
    setTimeout(loop, fails ? Math.min(8000, 1500 * fails) : 1500);
  })();

  // ------------------------------------------------------------------ settings
  let draft = null;
  async function openEditor() {
    await poll();
    draft = { ...DEFAULTS, ...(st?.config || {}) };
    ctx.editor.screen('Clipboard', [btn('pill', 'Cancel', close), btn('pill pri', 'Save', save)],
      ui.section('Each entry shows'),
      ui.segmented([[1, '1 line'], [2, '2 lines'], [3, '3 lines'], [4, '4 lines']], draft.lines, (v) => { draft.lines = v; }),
      ui.check('Show copy time', null, draft.showTime, (v) => { draft.showTime = v; }),
      ui.section('Title'), ui.input(draft.title, 'Clipboard', (v) => { draft.title = v; }),
      ui.section('How it works'),
      ui.hint('The list is Windows’ clipboard history (Win+V), newest first, up to 25 entries. Tapping an entry makes it the current clipboard content and presses Ctrl+V on the PC, so it’s pasted into whatever window is active there. Holding an entry for half a second only copies it, without pasting.'),
      ui.hint('Copied files show up too (with Explorer’s previews). Win+V doesn’t keep them, so the PC remembers your last 25 file copies itself: just the file paths, not the files. Tapping one pastes the files again, as a copy.'),
      ui.hint('Windows doesn’t let normal programs type into windows running as administrator, so pasting into those doesn’t work. Password managers keep passwords out of the history, so they don’t show up here.'));
  }
  const close = () => { ctx.editor.close(); draft = null; render(); };
  const save = async () => { try { await ctx.saveConfig(draft); await poll(); close(); } catch (e) { ctx.error(e); } };
});
