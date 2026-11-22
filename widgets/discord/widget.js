// Discord widget, tablet side: mute / deafen / leave buttons and a volume slider for everyone in your call.
// PC side: plugin.py (talks to the Discord app over its local RPC pipe, with your own Discord application).
PBW.mount('discord', async (ctx) => {
  const { h, btn, ui, clamp } = PBW;
  const root = ctx.root;
  const DEFAULTS = { title: '', showDeafen: true, showLeave: true, confirmLeave: true, showMembers: true, showSelf: false, maxVolume: 200, color: '#5865f2', layout: 'rows' };

  PBW.css('discord', `
.dc{--acc2:#5865f2;--red:#da373c;--talk:#23a55a;display:flex;flex-direction:column;gap:8px;padding:8px 10px 10px;font-size:14px}
.dc-head{display:flex;align-items:center;gap:8px;height:20px;flex:none;padding-right:26px}
.dc-title{flex:1;min-width:0;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dc-stat{font-size:11px;color:var(--dim);white-space:nowrap}
.dc-stat.bad{color:#f87171}
/* your controls, at the bottom: big finger-sized buttons */
.dc-bar{display:flex;gap:8px;flex:none;height:64px}
.dc.big .dc-bar{flex:1;height:auto}
.dc.msg .dc-bar{display:none}
.dc-btn{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;gap:.5em;border-radius:14px;background:rgba(255,255,255,.07);
  font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;transition:background .15s,color .15s,transform .1s}
.dc-btn:active{transform:scale(.96);background:rgba(255,255,255,.14)}
.dc-btn .ico{width:24px;height:24px}
.dc.big .dc-btn{flex-direction:column;gap:.35em;font-size:1em}
.dc.big .dc-btn .ico{width:2.2em;height:2.2em}
.dc.tight .dc-btn span{display:none}
.dc-btn.on{background:var(--red);color:#fff}
.dc-btn.busy{opacity:.7}
.dc-leave{color:#f87171}
.dc-leave.armed{background:var(--red);color:#fff}
.dc-btn:disabled{opacity:.28;pointer-events:none}
/* call members */
.dc-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:6px;-webkit-overflow-scrolling:touch}
.dc.big .dc-body{display:none}
.dc-row{display:grid;grid-template-columns:auto minmax(70px,28%) minmax(0,1fr) 3.4em auto;grid-template-areas:"av who track pct mb";
  align-items:center;gap:12px;padding:8px 10px;border-radius:14px;background:rgba(255,255,255,.04);min-height:62px;flex:none}
.dc.lay-rows.narrow .dc-row{grid-template-columns:auto minmax(0,1fr) auto auto;grid-template-areas:"av who pct mb" "track track track track";row-gap:8px}
.dc.lay-rows.narrow .dc-row.me{grid-template-areas:"av who pct mb"}
.dc.lay-rows.narrow .dc-row.me .dc-track{display:none}
.dc-av{grid-area:av;width:42px;height:42px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:17px;color:#fff;
  overflow:hidden;box-shadow:0 0 0 3px transparent;transition:box-shadow .1s}
.dc-av img{width:100%;height:100%;object-fit:cover;display:block}
.dc-row.talk .dc-av{box-shadow:0 0 0 3px var(--talk),0 0 12px var(--talk)}
.dc-who{grid-area:who;display:flex;align-items:center;gap:6px;min-width:0}
.dc-name{font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.dc-you{color:var(--dim);font-weight:400;flex:none}
.dc-flags{display:flex;gap:4px;color:#f87171;flex:none}
.dc-flags .ico{width:17px;height:17px}
.dc-track{grid-area:track;position:relative;height:42px;border-radius:12px;background:var(--track);overflow:hidden;touch-action:none;cursor:pointer}
.dc-fill{position:absolute;left:0;top:0;bottom:0;width:calc(var(--v,.5)*100%);background:var(--acc2);opacity:.85}
.dc-row.drag .dc-fill{opacity:1}
.dc-knob{position:absolute;top:20%;bottom:20%;width:4px;border-radius:2px;background:#fff;left:calc(var(--v,.5)*100% - 2px);pointer-events:none}
.dc-mark{position:absolute;top:0;bottom:0;left:var(--mk);width:2px;margin-left:-1px;background:rgba(255,255,255,.28);z-index:1;pointer-events:none}
.dc-pct{grid-area:pct;text-align:right;font-size:15px;font-variant-numeric:tabular-nums;font-weight:600}
.dc-mb{grid-area:mb;width:50px;height:44px;border-radius:12px;background:var(--track);display:grid;place-items:center}
.dc-mb .ico{width:22px;height:22px}
.dc-row.muted .dc-mb{background:#7f1d1d;color:#fecaca}
.dc-row.muted .dc-fill{background:repeating-linear-gradient(135deg,#4b5563 0 6px,#374151 6px 12px)}
.dc-row.muted .dc-pct{color:var(--dim)}
.dc-row.me .dc-track,.dc-row.me .dc-pct,.dc-row.me .dc-mb{visibility:hidden}
/* layout: columns (side by side, vertical faders) */
.dc.lay-cols .dc-body{flex-direction:row;overflow-x:auto;overflow-y:hidden;gap:8px}
.dc.lay-cols .dc-row{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(50px,1fr) auto auto auto;grid-template-areas:"pct" "track" "av" "who" "mb";
  justify-items:center;width:clamp(84px,24%,128px);min-height:0;height:100%;padding:10px 8px;gap:8px}
.dc.lay-cols .dc-track{width:46px;height:100%}
.dc.lay-cols .dc-fill{top:auto;right:0;width:auto;height:calc(var(--v,.5)*100%)}
.dc.lay-cols .dc-knob{top:auto;left:20%;right:20%;width:auto;height:4px;bottom:calc(var(--v,.5)*100% - 2px)}
.dc.lay-cols .dc-mark{top:auto;left:0;right:0;width:auto;height:2px;margin:0 0 -1px;bottom:var(--mk)}
.dc.lay-cols .dc-pct{text-align:center}
.dc.lay-cols .dc-av{width:36px;height:36px;font-size:15px}
.dc.lay-cols .dc-who{max-width:100%;justify-content:center}
.dc.lay-cols .dc-name{font-size:13px}
.dc.lay-cols .dc-you{display:none!important}
.dc.lay-cols .dc-mb{width:100%;max-width:56px}
/* centered: a single entry sits in the middle; auto margins (not justify-content:center) keep long lists scrollable */
.dc.lay-rows .dc-row:first-child{margin-top:auto}
.dc.lay-rows .dc-row:last-child{margin-bottom:auto}
.dc.lay-cols .dc-row:first-child{margin-left:auto}
.dc.lay-cols .dc-row:last-child{margin-right:auto}
/* layout: tiles, sized by tileGrid() to fill the space; a partly filled last line is centered */
.dc.lay-tiles .dc-body{flex-direction:row;flex-wrap:wrap;justify-content:center;align-content:center;gap:8px}
.dc.lay-tiles .dc-body.scroll{align-content:flex-start}
.dc.lay-tiles .dc-row{width:var(--tw);height:var(--th);grid-template-columns:minmax(0,1fr) auto;grid-template-rows:minmax(0,1fr) auto auto auto;
  grid-template-areas:"av av" "who who" "track track" "pct mb";justify-items:center;min-height:0;padding:12px 10px 10px;gap:8px}
.dc.lay-tiles .dc-av{width:var(--av);height:var(--av);font-size:calc(var(--av) * .4);align-self:center}
.dc.lay-tiles .dc-who{max-width:100%;justify-content:center}
.dc.lay-tiles .dc-name{font-size:var(--tf)}
.dc.lay-tiles .dc-track{width:100%}
.dc.lay-tiles .dc-pct{justify-self:start;text-align:left;padding-left:4px}
.dc-note{color:var(--dim);text-align:center;padding:10px;margin:auto 0;font-size:15px}
.dc-msg{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;color:var(--dim);padding:8px}
.dc-msg .ico{width:30px;height:30px}
.dc-msg b{color:var(--fg);font-size:16px}
.dc-msg button{padding:12px 20px;border-radius:12px;background:var(--track);color:var(--fg);font-size:15px;font-weight:600}
.dc-msg .row{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
.dc-msg.pulse b{animation:dc-p .9s ease-in-out infinite alternate}
@keyframes dc-p{to{opacity:.45}}
.ed input[type=password]{width:100%;padding:8px 10px;border-radius:9px;border:1px solid var(--line);background:#161d27;color:var(--fg);font:inherit;outline:none}
.ed input[type=password]:focus{border-color:var(--acc)}
`);

  root.classList.add('dc');
  const title = h('span', 'dc-title'), stat = h('span', 'dc-stat');
  const bMute = btn('dc-btn', '', () => toggle('mute'), 'Mute / unmute your microphone');
  const bDeaf = btn('dc-btn', '', () => toggle('deaf'), 'Deafen / undeafen');
  const bLeave = btn('dc-btn dc-leave', '', () => leave(), 'Leave the call');
  const bar = h('div', 'dc-bar', bMute, bDeaf, bLeave);
  const body = h('div', 'dc-body');
  root.replaceChildren(h('div', 'dc-head', title, stat), body, bar, ctx.gear(() => openEditor()));

  let st = null, cfg = { ...DEFAULTS }, fails = 0, leaveArmed = 0, bodyMode = '';
  const over = {}; // optimistic mute / deaf while the request is on its way: {mute: {v, until}}
  const val = (k) => (over[k] && Date.now() < over[k].until ? over[k].v : !!st?.[k]);
  const ready = () => st?.status === 'ready';

  // ------------------------------------------------------------------ your own controls
  function setBtn(b, ico, text, on) {
    const key = ico + '|' + text;
    if (b.dataset.k !== key) { b.dataset.k = key; b.replaceChildren(PBW.icon(ico), h('span', null, text)); }
    b.classList.toggle('on', !!on);
  }

  async function toggle(k) {
    if (!ready()) return;
    const v = !val(k);
    over[k] = { v, until: Date.now() + 3000 };
    render();
    try { const r = await ctx.post(k, { on: v ? 1 : 0 }); st.mute = r.mute; st.deaf = r.deaf; }
    catch (e) { ctx.error(e); }
    delete over[k];
    render();
  }

  async function leave() {
    if (!ready() || !st.channel) return;
    if (cfg.confirmLeave && Date.now() > leaveArmed) {
      leaveArmed = Date.now() + 3000;
      render();
      setTimeout(render, 3100);
      return;
    }
    leaveArmed = 0;
    try { await ctx.post('leave'); await poll(); } catch (e) { ctx.error(e); }
  }

  // ------------------------------------------------------------------ call members
  const rows = new Map();
  const tint = (id) => `hsl(${[...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7)} 45% 42%)`;

  function makeRow(id) {
    const av = h('div', 'dc-av'), name = h('span', 'dc-name'), you = h('span', 'dc-you', '(you)'), flags = h('span', 'dc-flags');
    const fill = h('div', 'dc-fill'), mark = h('div', 'dc-mark'), track = h('div', 'dc-track', mark, fill, h('div', 'dc-knob'));
    const pct = h('span', 'dc-pct');
    const r = { id, m: null, local: null, holdUntil: 0, drag: false, lastSend: 0, timer: 0, avKey: null, flagKey: null };
    const mb = btn('dc-mb', PBW.icon('volume-2'), () => muteUser(r), 'Mute for me');
    const el = h('div', 'dc-row', av, h('div', 'dc-who', name, you, flags), track, pct, mb);
    Object.assign(r, { el, av, name, you, flags, track, mark, pct, mb });

    const setFrom = (e) => {
      const b = track.getBoundingClientRect();
      const f = cfg.layout === 'cols' ? (b.bottom - e.clientY) / b.height : (e.clientX - b.left) / b.width;
      r.local = Math.round(clamp(f, 0, 1) * cfg.maxVolume);
      const snap = Math.abs(r.local - 100) <= cfg.maxVolume * 0.025; // snaps to 100 %, with a buzz on the way in
      if (snap) r.local = 100;
      if (snap && !r.snapped) PBW.haptic();
      r.snapped = snap;
      paintRow(r);
      sendVolume(r, false);
    };
    track.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { track.setPointerCapture(e.pointerId); } catch (_) {}
      r.drag = true; el.classList.add('drag');
      r.snapped = false;
      setFrom(e);
    });
    track.addEventListener('pointermove', (e) => { if (r.drag) setFrom(e); });
    const end = () => {
      if (!r.drag) return;
      r.drag = false; el.classList.remove('drag');
      r.holdUntil = Date.now() + 1500;
      sendVolume(r, true);
    };
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
    return r;
  }

  function sendVolume(r, final) {
    clearTimeout(r.timer);
    const wait = final ? 0 : Math.max(0, 110 - (Date.now() - r.lastSend));
    r.timer = setTimeout(() => {
      r.lastSend = Date.now();
      ctx.post('volume', { user: r.id, volume: r.local }).catch((e) => ctx.error(e));
    }, wait);
  }

  async function muteUser(r) {
    const on = !r.m.mute;
    r.m.mute = on; paintRow(r);
    try { await ctx.post('usermute', { user: r.id, on: on ? 1 : 0 }); } catch (e) { ctx.error(e); }
  }

  function paintRow(r) {
    const m = r.m;
    const v = (r.drag || Date.now() < r.holdUntil) && r.local != null ? r.local : m.volume;
    r.el.style.setProperty('--v', clamp(v / cfg.maxVolume, 0, 1));
    r.el.style.setProperty('--mk', (100 / cfg.maxVolume) * 100 + '%');
    r.mark.style.display = cfg.maxVolume > 100 ? '' : 'none';
    r.pct.textContent = v + '%';
    r.el.classList.toggle('muted', !!m.mute);
    r.el.classList.toggle('talk', !!m.speaking);
    r.el.classList.toggle('me', !!m.me);
    r.name.textContent = m.name;
    r.you.style.display = m.me ? '' : 'none';
    const fk = `${m.selfMute}|${m.selfDeaf}`;
    if (r.flagKey !== fk) {
      r.flagKey = fk;
      r.flags.replaceChildren(...(m.selfDeaf ? [PBW.icon('headphone-off')] : []), ...(m.selfMute && !m.selfDeaf ? [PBW.icon('mic-off')] : []));
    }
    const mbIco = m.mute ? 'volume-x' : 'volume-2';
    if (r.mb.dataset.i !== mbIco) { r.mb.dataset.i = mbIco; r.mb.replaceChildren(PBW.icon(mbIco)); r.mb.title = m.mute ? 'Unmute for me' : 'Mute for me'; }
    const avKey = m.avatar || '';
    if (r.avKey !== avKey) {
      r.avKey = avKey;
      const initials = () => { r.av.replaceChildren(m.name.trim().slice(0, 1).toUpperCase() || '?'); r.av.style.background = tint(m.id); };
      if (avKey) {
        const img = h('img');
        img.alt = '';
        img.onerror = initials;
        img.src = `${PBW.BASE}/api/w/discord/avatar?${PBW.q({ user: m.id, h: avKey })}`;
        r.av.style.background = tint(m.id);
        r.av.replaceChildren(img);
      } else initials();
    }
  }

  // ------------------------------------------------------------------ render
  function message(icon, text, sub, buttons = [], pulse = false) {
    const key = 'msg|' + icon + text + sub + buttons.length;
    if (bodyMode === key) return;
    bodyMode = key;
    rows.clear();
    const m = h('div', 'dc-msg' + (pulse ? ' pulse' : ''), PBW.icon(icon), h('b', null, text), sub ? h('div', null, sub) : null,
      buttons.length ? h('div', 'row', ...buttons) : null);
    body.replaceChildren(m);
  }

  function render() {
    if (!st) return;
    cfg = { ...DEFAULTS, ...(st.config || {}) };
    root.style.setProperty('--acc2', cfg.color);
    const ok = ready();
    const W = root.clientWidth, H = root.clientHeight;
    const inCall = ok && !!st.channel;
    const list = inCall ? st.members.filter((m) => cfg.showSelf || !m.me) : [];
    const lay = ['rows', 'cols', 'tiles'].includes(cfg.layout) ? cfg.layout : 'rows';
    for (const l of ['rows', 'cols', 'tiles']) root.classList.toggle('lay-' + l, l === lay);
    // no room for the members: just the buttons, bigger
    const big = ok && (!cfg.showMembers || H < { rows: 175, cols: 270, tiles: 300 }[lay]);
    root.classList.toggle('msg', !ok);
    root.classList.toggle('big', big);
    root.classList.toggle('narrow', W < 380);
    const nBtn = 1 + cfg.showDeafen + cfg.showLeave;
    root.classList.toggle('tight', W / nBtn < (big ? 70 : 105));
    root.style.fontSize = big ? clamp(Math.round(Math.min((H - 36) / 4.6, W / nBtn / 5.5)), 13, 24) + 'px' : '';

    title.textContent = cfg.title || (inCall ? st.channel.name : 'Discord');
    stat.classList.toggle('bad', !ok && st.status !== 'setup');
    stat.textContent = !ok ? '' : inCall ? `${st.members.length} in call` : 'not in a call';

    // buttons
    const mute = val('mute'), deaf = val('deaf');
    setBtn(bMute, mute || deaf ? 'mic-off' : 'mic', mute || deaf ? 'Muted' : 'Mute', mute || deaf);
    setBtn(bDeaf, deaf ? 'headphone-off' : 'headphones', deaf ? 'Deafened' : 'Deafen', deaf);
    const armed = Date.now() < leaveArmed;
    setBtn(bLeave, 'phone-off', armed ? 'Tap again' : 'Leave', false);
    bLeave.classList.toggle('armed', armed);
    bMute.classList.toggle('busy', 'mute' in over);
    bDeaf.classList.toggle('busy', 'deaf' in over);
    bDeaf.style.display = cfg.showDeafen ? '' : 'none';
    bLeave.style.display = cfg.showLeave ? '' : 'none';
    bLeave.disabled = !inCall;

    if (!ok) {
      const s = st.status;
      if (s === 'setup') return message('headset', 'Connect Discord', 'Needs your own Discord application (Client ID and Secret).', [btn('', 'Set up', () => openEditor('connect'))]);
      if (s === 'authorize') return message('headset', 'Click “Authorize” in Discord', 'Discord shows a window on your PC asking to allow this app.', [], true);
      if (s === 'connecting') return message('refresh-cw', 'Connecting to Discord…', '');
      if (s === 'closed') return message('wifi-off', st.message || 'Discord isn’t running', 'Connects by itself once Discord is open.');
      return message('x', st.message || 'Something went wrong', '', [btn('', 'Try again', retry), btn('', 'Settings', () => openEditor('connect'))]);
    }
    if (big) { bodyMode = ''; return; }
    if (!inCall || !list.length) {
      const key = 'note|' + inCall;
      if (bodyMode !== key) {
        bodyMode = key; rows.clear();
        body.replaceChildren(h('div', 'dc-note', inCall ? 'Nobody else is here yet' : 'Not in a voice channel'));
      }
      return;
    }
    if (bodyMode !== 'list') { bodyMode = 'list'; body.replaceChildren(); }
    const nodes = list.map((m) => {
      let r = rows.get(m.id);
      if (!r) { r = makeRow(m.id); rows.set(m.id, r); }
      r.m = m;
      paintRow(r);
      return r.el;
    });
    for (const id of [...rows.keys()]) if (!list.some((m) => m.id === id)) rows.delete(id);
    if (nodes.length !== body.children.length || nodes.some((n, i) => body.children[i] !== n)) body.replaceChildren(...nodes);
    if (lay === 'tiles') tileGrid(nodes.length);
  }

  // tiles fill the whole area: picks columns × lines so the tiles come out as large and square-ish as possible.
  // Too many people to fit at the smallest size: fixed-size tiles that scroll.
  const TILE_MIN_W = 140, TILE_MIN_H = 205, GAP = 8; // 205: name, slider and buttons (~150 px) + an avatar
  function tileGrid(n) {
    const W = body.clientWidth, H = body.clientHeight;
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const lines = Math.ceil(n / cols);
      const w = (W - (cols - 1) * GAP) / cols, h = (H - (lines - 1) * GAP) / lines;
      if (w < TILE_MIN_W || h < TILE_MIN_H) continue;
      const score = Math.min(w, h * 1.1) - (cols * lines - n) * 6; // big, not too flat, few empty spots
      if (!best || score > best.score) best = { score, w, h };
    }
    const scroll = !best;
    if (scroll) {
      const cols = Math.max(1, Math.floor((W + GAP) / (TILE_MIN_W + GAP)));
      best = { w: (W - (cols - 1) * GAP) / cols, h: TILE_MIN_H };
    }
    body.classList.toggle('scroll', scroll);
    body.style.setProperty('--tw', Math.floor(best.w) + 'px');
    body.style.setProperty('--th', Math.floor(best.h) + 'px');
    // the avatar and name grow with the tile; the rest stays finger-sized
    body.style.setProperty('--av', Math.round(clamp(Math.min(best.w * 0.45, best.h - 165), 40, 160)) + 'px');
    body.style.setProperty('--tf', Math.round(clamp(Math.min(best.w, best.h) / 14, 15, 24)) + 'px');
  }

  async function poll() {
    try { st = await ctx.api('state'); fails = 0; }
    catch (_) { fails++; stat.textContent = '● widget host offline'; stat.classList.add('bad'); return; }
    render();
  }
  (async function loop() {
    if (!document.hidden) await poll();
    const fast = ready() && st.channel;
    setTimeout(loop, fails ? Math.min(8000, 1500 * fails) : fast ? 400 : 1500);
  })();
  new ResizeObserver(() => render()).observe(root);

  const retry = async () => { try { await ctx.post('retry'); await poll(); } catch (e) { ctx.error(e); } };

  // ------------------------------------------------------------------ settings
  let draft = null;
  async function openEditor(screen) {
    await poll();
    draft = { ...DEFAULTS, ...(st?.config || {}) };
    if (screen === 'connect') showConnect(); else showMain();
  }
  const close = () => { ctx.editor.close(); draft = null; render(); };
  const save = async () => { try { await ctx.saveConfig(draft); await poll(); close(); } catch (e) { ctx.error(e); } };

  function connectionText() {
    if (!st) return '';
    if (st.status === 'ready') return `Connected${st.user?.name ? ' as ' + st.user.name : ''}`;
    if (st.status === 'setup') return 'Not set up yet';
    return st.message || st.status;
  }

  function showMain() {
    ctx.editor.screen('Discord', [btn('pill', 'Cancel', close), btn('pill pri', 'Save', save)],
      ui.section('Connection'),
      ui.row(PBW.label('headset', 'Discord app'), connectionText(), btn('pill', st?.clientId ? 'Change' : 'Set up', showConnect)),
      ui.section('Buttons'),
      ui.check('Deafen button', null, draft.showDeafen, (v) => { draft.showDeafen = v; }),
      ui.check('Leave button', null, draft.showLeave, (v) => { draft.showLeave = v; }),
      ui.check('Tap Leave twice', 'So you don’t leave a call by accident', draft.confirmLeave, (v) => { draft.confirmLeave = v; }),
      ui.section('Call members'),
      ui.check('Show members', 'A volume slider for everyone in your call. Small widgets show only the buttons.', draft.showMembers, (v) => { draft.showMembers = v; }),
      ui.check('Show myself', 'Your own entry, with the speaking ring', draft.showSelf, (v) => { draft.showSelf = v; }),
      ui.segmented([['rows', 'Rows'], ['cols', 'Columns'], ['tiles', 'Tiles']], draft.layout, (v) => { draft.layout = v; }),
      ui.hint('Rows: one below the other, sliders across. Columns: side by side, sliders up and down. Tiles: a card per person.'),
      ui.segmented([[100, 'Volume 0–100%'], [200, 'Volume 0–200%']], draft.maxVolume, (v) => { draft.maxVolume = v; }),
      ui.hint('These volumes only change what you hear, like the user volume in Discord.'),
      ui.section('Slider color'), ui.colorPicker(draft.color, (c) => { draft.color = c; }, ['#5865f2', ...PBW.COLORS]),
      ui.section('Title'), ui.input(draft.title, 'Default: the channel’s name', (v) => { draft.title = v; }));
  }

  function showConnect() {
    let cid = st?.clientId || '', secret = '';
    const sec = ui.input('', st?.hasSecret ? 'Saved. Leave empty to keep it.' : 'Client Secret', (v) => { secret = v.trim(); });
    sec.type = 'password';
    sec.autocomplete = 'off';
    const go = async () => {
      try { await ctx.post('connect', {}, { clientId: cid.trim(), clientSecret: secret }); await poll(); showMain(); }
      catch (e) { ctx.error(e); }
    };
    const forget = async () => {
      try { await ctx.post('forget'); await poll(); showMain(); } catch (e) { ctx.error(e); }
    };
    ctx.editor.screen('Discord app', [btn('pill', 'Back', showMain), btn('pill pri', 'Connect', go)],
      ui.hint('Your own application from discord.com/developers › Applications.'),
      ui.section('Client ID'), ui.input(cid, 'Application ID (a long number)', (v) => { cid = v; }),
      ui.section('Client Secret'), sec,
      ui.hint('From the app’s OAuth2 page. It’s stored encrypted on this PC and never sent back to widgets. Typing it on the PC’s setup page (http://127.0.0.1:8766/) is easier than on the tablet.'),
      ui.hint('After Connect, Discord asks once whether to allow the app. Click “Authorize” there.'),
      ...(st?.clientId ? [ui.section('Remove'), btn('pill', 'Forget this app', forget)] : []));
  }
});
