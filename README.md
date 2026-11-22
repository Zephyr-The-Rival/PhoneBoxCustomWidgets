# PhoneBox Widgets

Custom widgets for [PhoneBox](https://github.com/ersinkoc/phonebox), plus a small PC-side host that powers them.

| Widget | What it does |
|---|---|
| **Volume** | Per-app volume sliders with live amplitude bars and mute buttons. You pick which apps each slider controls (running or not), and an **All games** slider finds games on its own. |
| **Clock** | Time, date and the tablet's battery and charging state. Drag, resize and restyle every part right on the widget, with any font installed on your PC. |
| **Audio output** | Tiles for the speakers and headsets you choose. Tap one and Windows switches its output to it. |
| **Media** | Now playing with big controls, a seek bar and ±5 s skip buttons. No volume slider. |
| **Discord** | Mute, deafen and leave buttons, and a volume slider for everyone in your voice call. |
| **Clipboard** | Your clipboard history (Win+V). Tap an entry and it's pasted into the active window on the PC. |

Every widget's buttons make the tablet vibrate briefly when tapped, like PhoneBox's own (see **Vibration** below).

## Why there is a host

PhoneBox runs "Custom HTML" widgets in a sandbox. They get a few read-only values and can't reach the PhoneBox agent, the PC or the tablet. The **host** (`host/server.py`, Python standard library only) runs on the PC at `127.0.0.1:8766` and fills that gap for every widget:

```
tablet: PhoneBox ─ Custom HTML widget ──USB (adb reverse 8766)──► PC: host/server.py ─┬─► widgets/<type>/plugin.py
                     (snippet loads /widget/<type>.js)                                 ├─► PhoneBox agent (audio, …)
                                                                                       ├─► adb (tablet battery, vibration)
                                                                                       ├─► Discord app (its local RPC pipe)
                                                                                       ├─► WebNowPlaying browser extension
                                                                                       └─► Windows (fonts, games, apps)
```

The snippet you paste into PhoneBox stays tiny. It loads the widget's code from the host, so changes to a widget never need a re-paste.

## Install

1. Requirements: Windows, Python 3 (python.org), and PhoneBox connected **over USB**.
2. Double-click **`install.cmd`**. It starts the host now and on every sign-in (Startup-folder shortcut, no window), then opens the setup page.
3. On the setup page (<http://127.0.0.1:8766/>), pick a widget type, copy its snippet, and paste it into a **Custom HTML** widget in PhoneBox's settings.
4. Configure it with ⚙ on the widget or on the setup page. Both edit the same settings.

**Opening the setup page later:** use **PhoneBox Widgets** in the Start Menu (press Windows and type "widgets"; you can pin it). It opens <http://127.0.0.1:8766/>, and starts the host first if it isn't running. You don't need `install.cmd` for that. Only rerun it after updating the files or changing a `plugin.py`.

A widget's `data-id` in the snippet names its settings. Two clocks with different ids can look different. The setup page's **New…** button creates one.

`uninstall.cmd` stops the host and removes the autostart. Your settings stay in `%APPDATA%\PhoneBoxWidgets\`.

## Folder layout

```
host/
  icons/         Lucide icons (SVG) bundled into every widget
  server.py      HTTP server, plugin loader, routing, security checks
  pbw.py         helpers for plugins: settings store, PhoneBox agent, adb + tablet battery, PC fonts
  wnp.py         WebNowPlaying adapter: exact position and seeking for media in the browser (port 8767)
  sdk.js         toolkit for widgets: PBW.mount, editor building blocks, color picker, font picker, API calls
  setup.html     the setup page: widget types, ids, snippet, live preview
widgets/
  volume/        plugin.py (PC side) + widget.js (tablet side)
  clock/
  audio-output/
  media/
  discord/
  clipboard/     plugin.py + widget.js + helper.ps1 (Windows' clipboard history API, through PowerShell)
  _template/     what tools/new-widget.py copies (folders starting with _ are not loaded)
tools/new-widget.py
install.cmd · uninstall.cmd · dev.cmd
```

## Building a new widget

```
python tools/new-widget.py "Now Playing"     →  widgets/now-playing/plugin.py + widget.js
dev.cmd                                       →  host in a console window, every request logged
http://127.0.0.1:8766/?type=now-playing       →  live preview while you work
```

- **`widget.js`** (runs on the tablet) is read from disk on every load. Edit it, then reload the preview or switch PhoneBox pages. No restart needed.
- **`plugin.py`** (runs on the PC) is loaded at startup. After changing it, restart `dev.cmd` (or run `install.cmd`).

### Tablet side: `widget.js`

```js
PBW.mount('now-playing', async (ctx) => {
  const { h, btn, ui } = PBW;
  PBW.css('now-playing', `.now-playing-title{font-size:18px}`);   // prefix classes with your type
  const title = h('div', 'now-playing-title');
  ctx.root.replaceChildren(title, ctx.gear(openSettings));         // ⚙ top right

  let cfg = { color: '#2dd4bf', ...(await ctx.loadConfig()).config };  // settings: null until first save
  const r = await ctx.api('track');                               // your plugin's route: GET /api/w/now-playing/track
  title.textContent = r.title;

  function openSettings() {                                       // full-size editor overlay
    ctx.editor.screen('Now Playing', [btn('pill pri', 'Save', async () => { cfg = await ctx.saveConfig(cfg); ctx.editor.close(); })],
      ui.section('Color'), ui.colorPicker(cfg.color, (c) => { cfg.color = c; }));
  }
});
```

What the SDK provides (full list at the top of `host/sdk.js`):
- `ctx.api(name)`, `ctx.post(name, params, body)`: your plugin's routes.
- `ctx.loadConfig()`, `ctx.saveConfig(cfg)`: this widget's settings.
- `ctx.error(e)`: a red toast.
- `ctx.editor.screen(title, actions, …)`, `ctx.gear(fn)`: the ⚙ editor.
- Editor building blocks `PBW.ui.*`: `section`, `hint`, `row`, `check`, `segmented`, `range`, `input`, `colorPicker`, `fontPicker`.
- `PBW.useFont(id)`: a CSS font-family that loads one of the PC's fonts.
- `PBW.icon(name)`, `PBW.label(name, text)`: icons (see **Icons** below).
- `PBW.battery()`: the tablet's battery.
- `PBW.haptic()`: a short vibration on the tablet. Buttons (and editor checkbox rows) already vibrate on touch, so this is only for your own touch elements, like a slider snapping into place.

Widgets that need PhoneBox's own data can also use `window.phonebox.on('state', fn)` from PhoneBox's sandbox.

### Icons

Widgets use [Lucide](https://lucide.dev) line icons, the same set PhoneBox draws its own interface with (ISC license, see `host/icons/LICENSE`). The icons live in `host/icons/` and are bundled into every widget, so they work offline. `PBW.icon('headphones')` returns the icon as an inline SVG in the current text color, 1em in size. To add one, download its SVG from lucide.dev into `host/icons/`. A widget's `META["icon"]` is an icon name too.

### PC side: `plugin.py` (optional)

```python
META = {"name": "Now Playing", "icon": "music", "description": "…", "size": [6, 2]}

class Plugin:
    def __init__(self, ctx):
        self.ctx = ctx
        self.routes = {"GET track": self.track}           # → /api/w/now-playing/track?id=…
    def clean_config(self, cfg):                         # validate what the widget saves
        return {"color": cfg.get("color", "#2dd4bf")}
    def track(self, req):                                # req.id, req.query, req.json()
        return self.ctx.agent_get("/state")["media"]     # anything JSON-able
    def start(self):                                     # optional background loop (own thread)
        ...

def setup(ctx):
    return Plugin(ctx)
```

`ctx` (documented at the top of `host/pbw.py`) provides:
- this widget type's settings and a private `ctx.data` store,
- `ctx.agent_get` and `ctx.agent_command` for the PhoneBox agent,
- `ctx.adb(...)` and `ctx.phone.battery()` for the tablet,
- `ctx.UserError` to send an error message back to the widget.

## Widget details

### Vibration (all widgets)

- **Every button vibrates the tablet** for 40 ms when your finger touches it, like PhoneBox's own buttons. Only touches count: clicking the preview on the PC doesn't buzz the tablet.
- **How:** the host keeps one `adb shell` open to the tablet and sends it Android's vibrate command, which takes a few milliseconds per tap. This works over USB only, like the widgets.
- **Setup page › All widgets:** switch it on or off, pick Light (20 ms), Normal (40 ms) or Strong (70 ms), and **Test**.

### Volume

- **Sliders:** each slider controls any mix of:
  - **All games** (auto-detected),
  - system sounds,
  - specific apps or games (installed or running; a game is matched by its folder),
  - Master volume, which is a slider of its own.
- **Moving a slider** sets all of its apps to that level. Its amplitude bar shows the loudest one.
- **Games are found** from Steam, Epic (games only, no Unreal Engine), GOG, EA, Ubisoft, Xbox, Windows Game Bar's list, and your own folders (⚙ › Game detection). Launchers, browsers and chat apps never count. You can correct any app with **Game** or **Not**.
- **Apps** come from your Start Menu. Anything missing can be added by its exe name.
- **Set this level when an app starts:** new games start at the slider's level.

### Clock

- **⚙ opens layout mode.** Tap a part (Time, Date or Battery) to select it, drag it to move it (it snaps to the center lines), and drag its corner dot to resize it. The mouse wheel also resizes on the PC. **Done** saves, **Cancel** reverts.
- **Style** sets each part's visibility, size, exact position, font, weight and color, plus:
  - Time: 24-hour, seconds, blinking colon.
  - Date: format, uppercase.
  - Battery: icon, percentage.
  - The whole widget's background.
- **Fonts:** any TTF/OTF installed in Windows, served by the host, so the tablet needs no internet. Install a font in Windows and it shows up in the list.
- **Battery:** the host reads it from the tablet over adb every 30 s. The icon fills with the level, shows ⚡ while charging, and turns red when low.
- **Fit:** a part that's wider than the widget shrinks to fit.

### Audio output

- **Gear › Add devices** lists the outputs Windows sees. Give each one a name, icon and color. Devices you've added stay on the widget, dimmed, while they're unplugged.
- **Tap a tile** to make it Windows' default output. The active tile glows in its color.
- **Switch: Everything or Media only.** Windows keeps a separate default for calls. "Media only" leaves Discord and Teams calls on their device.
- **Layout:** auto, tiles, one row, or a list. The volume can optionally appear under each name.

### Media

- **Controls:** skip back, previous, play/pause, next, skip forward. The skip amount (5, 10, 15 or 30 s) is set in the gear settings. Skipping and seeking work with players that share their position with Windows: Spotify, Chrome, Edge, most video players. Firefox only does at play / pause; see **Firefox** below.
- **Seek bar:** shows when the player reports the track's length and position. Drag it to pick a time; it seeks on release.
- **Layout:** the cover and title are kept small so the controls get the room. Wide widgets put the controls on the right, and tall ones use two rows.
- **Settings:** cover art, player name, seek bar, background tint (from the cover's color), button color.
- **Source:** the same "now playing" information as PhoneBox's own widget (Windows' media session, through the PhoneBox agent).
- **Firefox:** Firefox tells Windows the position only when playback starts or pauses. Without help, the widget counts on from there, and after you jump in the video in the browser it hides the seek bar and turns the skips off until the next play / pause. For exact positions and skips, install the [WebNowPlaying](https://addons.mozilla.org/firefox/addon/webnowplaying/) extension. In its settings, **Add custom adapter** with port **8767** and reload the tab. The host (`host/wnp.py`) then gets the position straight from the page and skips through the extension. It also works in Chrome.

### Discord

- **Your controls** (bottom row): **Mute**, **Deafen** and **Leave**. Leave asks for a second tap by default (⚙ › Tap Leave twice).
- **Call members:** each person gets an avatar (with a green ring while they talk), a volume slider from 0 to 200 % that snaps to 100 % with a buzz, and a button that mutes them for you. These are the same as Discord's own user volume and mute: they only change what **you** hear.
- **Layouts:** **Rows** (one person per line), **Columns** (side by side, with vertical faders) or **Tiles** (a card per person; tiles grow to fill the widget, so one other person fills all of it). A single entry sits in the middle. Widgets too short for the members show just the three buttons, bigger.
- **Settings:** which buttons to show, whether to list members (and yourself), the volume range (100 % or 200 %), the slider color and a title (default: the channel's name).

**Setup (once):** Discord only lets apps it knows control voice settings, so the widget uses your own Discord application:

1. Open <https://discord.com/developers/applications>, click **New Application** and give it any name (Discord shows it when asking for permission).
2. On **General Information**, copy the **Application ID** (the Client ID).
3. On **OAuth2**, click **Reset Secret** and copy the **Client Secret** (it's only shown once). Under **Redirects**, add `http://localhost` and save.
4. On the widget (easier on the setup page on the PC): ⚙ › Discord app › **Set up**. Paste both values and click **Connect**.
5. Discord asks whether to authorize the app. Click **Authorize**. The host remembers the login, so this happens only once.

How it works: the host talks to the Discord app on the same PC through Discord's local RPC pipe (`\\.\pipe\discord-ipc-0`), the same way stream-deck plugins do. Nothing goes through a server except the one-time login (Discord's OAuth token endpoint). If Discord isn't running, the widget says so and reconnects by itself when it starts.

Not possible through Discord's RPC: answering or declining incoming calls (Discord doesn't report them to apps) and playing your own sounds into a call.

### Clipboard

- **The list** is Windows' clipboard history, the same as Win+V: newest first, up to 25 entries, text shown as you copied it (1–4 lines per entry, ⚙). Copied images (screenshots, "Copy image") show as a preview.
- **Copied files** show up too, with Explorer's thumbnails: the picture for images, a frame for videos, the first page for PDFs, the icon for anything else. Win+V doesn't keep files, so the host watches the clipboard and remembers your last 25 file copies itself. It stores only the paths (in `%APPDATA%\PhoneBoxWidgets\config.json`), never the files. Tapping one puts the same files on the clipboard again, always as a copy (even if you originally cut them), and pastes them: into an Explorer window, that copies the files; into a chat, it attaches them. Files that were moved or deleted since show as "no longer there".
- **Tap an entry:** it becomes the current clipboard content (like picking it in Win+V, so it also moves to the top), and the host presses **Ctrl+V** on the PC. It's pasted into whatever window is active there. A green "Pasted" and a buzz confirm it.
- **Hold an entry for half a second** to only copy it (no Ctrl+V). A fill runs across the card while you hold; "Copied" and a buzz confirm it.
- **Needs clipboard history switched on** (Windows Settings › System › Clipboard). If it's off, the widget says so and has a button that opens that page.
- **Limits:** Windows doesn't let normal programs type into windows running as administrator, so pasting there doesn't work. Password managers keep passwords out of the history, so they never show up.
- **How:** reading the history and picking an entry are Windows Runtime APIs, which Python's standard library can't call. The host keeps one small hidden PowerShell process running (`widgets/clipboard/helper.ps1`) and asks it. Clipboard text is never logged or saved by the host. It only goes to the widget. Thumbnails are kept in memory only.

## Troubleshooting

- **"Widget host offline – retrying…" on the tablet:** check that <http://127.0.0.1:8766/> opens on the PC. If not, run `install.cmd`. If it opens, check that `adb reverse --list` shows `tcp:8766 tcp:8766` (the host re-adds it every 10 s).
- **A widget shows an error, or nothing:** run `dev.cmd` and watch the console. The log is in `%APPDATA%\PhoneBoxWidgets\host.log`.
- **A change doesn't show on the tablet** (new SDK features like vibration, a new widget version): PhoneBox keeps a widget's code until it reloads it. Switch to another PhoneBox page and back.
- **Discord widget stays on "Connecting…" or "Discord didn't answer"** although Discord is open: the widget retries every 5 s by itself. Discord can stop answering for a while, for example while one of its Authorize windows is open. If it doesn't recover, restart Discord.
- **Discord widget: authorization failed or was declined:** ⚙ › Discord app › **Connect** asks again. **Forget this app** removes the Client ID, secret and login from this PC.
- **Media: wrong position or no skips with Firefox:** see **Firefox** in the Media section (WebNowPlaying).
- **Wi-Fi mode:** not supported. The snippet loads the widget from `127.0.0.1`, which on the tablet is the tablet itself. Over USB, `adb reverse` forwards that to the PC. Over Wi-Fi there's no such route, and opening the host to the network would let anyone on it control your PC's audio and Discord.
- **Migration:** the earlier Volume Slider snippet (`/widget.js`, `id="vs"`) keeps working. Its settings were imported from `%APPDATA%\PhoneBoxVolumeSlider\`, which is left in place as a backup.

## Security

The host listens on `127.0.0.1` only. It answers requests whose `Host` is `127.0.0.1:8766` or `localhost:8766` and whose `Origin` is missing, `null` (sandboxed widgets) or the setup page. Pages from other websites get 403. Fonts are served read-only from the Windows font list.

- **Discord:** the Client Secret and the login tokens are stored in `%APPDATA%\PhoneBoxWidgets\config.json`, encrypted with Windows DPAPI, so only your Windows account can read them. The host never sends them to widgets, and they're never in this repository. To revoke the widget's access, remove the app in Discord under *Settings › Authorized Apps*.
- **WebNowPlaying (port 8767):** only accepts WebSocket connections from browser extensions (`moz-extension://` or `chrome-extension://` origins). A web page that tries to connect gets 403, so it can't feed the Media widget fake players.
