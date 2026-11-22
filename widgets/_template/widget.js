// __NAME__ widget, tablet side. Runs inside PhoneBox's Custom HTML sandbox; the host serves it together with the SDK
// (host/sdk.js: PBW.*). Edit, then reload the widget (or the setup page): no restart needed for this file.
PBW.mount('__TYPE__', async (ctx) => {
  const { h, btn, ui } = PBW;
  const root = ctx.root;

  // styles: prefix your classes with the widget type so widgets never clash
  PBW.css('__TYPE__', `
.__TYPE__-box{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:10px;text-align:center}
.__TYPE__-text{font-size:20px;font-weight:600}
.__TYPE__-info{font-size:11px;color:var(--dim)}
`);
  const text = h('div', '__TYPE__-text');
  const info = h('div', '__TYPE__-info', '…');
  root.replaceChildren(h('div', '__TYPE__-box', text, info), ctx.gear(openSettings));

  // settings: null until the first save, so start from defaults
  let cfg = { text: 'Hello from the PC', color: '#2dd4bf' };
  try { cfg = { ...cfg, ...(await ctx.loadConfig()).config }; } catch (e) { ctx.error(e); }
  const draw = () => { text.textContent = cfg.text; text.style.color = cfg.color; };
  draw();

  // the plugin's own route (plugin.py "GET hello")
  const refresh = async () => {
    try { const r = await ctx.api('hello'); info.textContent = `${r.pc} · ${r.time}`; } catch (_) { info.textContent = 'host offline'; }
  };
  refresh();
  setInterval(refresh, 5000);

  // the gear's editor: a full-size overlay built from PBW.ui blocks
  function openSettings() {
    const draft = { ...cfg };
    ctx.editor.screen('__NAME__', [btn('pill', 'Cancel', () => ctx.editor.close()), btn('pill pri', 'Save', async () => {
      try { cfg = await ctx.saveConfig(draft); draw(); ctx.editor.close(); } catch (e) { ctx.error(e); }
    })],
    ui.section('Text'), ui.input(draft.text, 'Text', (v) => { draft.text = v; }),
    ui.section('Color'), ui.colorPicker(draft.color, (c) => { draft.color = c; }));
  }
});
