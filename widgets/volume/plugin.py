"""Volume widget, PC side: per-app volume sliders with live levels, picked apps, and an auto-detected Games slider.

Reads app audio sessions from the PhoneBox agent's Control Deck API, groups them into each widget's sliders,
knows installed apps (Start Menu) and games (Steam, Epic, GOG, EA, Ubisoft, Xbox, Game Bar, your folders),
and sends volume / mute changes back through the agent.
"""
from __future__ import annotations

import ctypes
import glob
import json
import os
import re
import threading
import time
import winreg

from pbw import UserError, agent_command, agent_get

META = {
    "name": "Volume",
    "icon": "sliders-vertical",
    "description": "Per-app volume sliders with live levels; pick your apps or follow whatever game is running.",
    "size": [6, 4],
}
MAX_CHANNELS = 24
HEX = re.compile(r"#[0-9a-fA-F]{6}")
_ctx = None  # the plugin Context, set in setup()
APPDATA = os.environ.get("APPDATA", "")


class _Data:
    """Maps the settings names this code was written against onto the host's store."""

    DEFAULTS = {"apps": dict, "gameOverrides": dict, "gameFolders": list, "customApps": list}

    def __getitem__(self, key):
        if key == "widgets":
            return _ctx.instances()
        return _ctx.data.setdefault(key, self.DEFAULTS[key]())

    def __setitem__(self, key, value):
        _ctx.data[key] = value


class _Cfg:
    data = _Data()

    @property
    def lock(self):
        return _ctx.lock

    def touch(self):
        _ctx.changed()

    def save_now(self):
        _ctx.save_now()

    def flush(self, force=False):
        pass  # the host saves

    def widget(self, wid):
        return _ctx.get(wid)


Config = _Cfg
log = None


def valid_source(s: str) -> bool:
    return s in ("games", "system", "master") or (s.startswith(("app:", "dir:")) and len(s) > 4)


def clean_widget(body: dict) -> dict:
    """Validates a widget configuration sent by the editor."""
    layout = body.get("layout") if body.get("layout") in ("auto", "vertical", "horizontal") else "auto"
    channels, seen = [], set()
    for ch in (body.get("channels") or [])[:MAX_CHANNELS]:
        if not isinstance(ch, dict):
            continue
        cid = str(ch.get("id") or "")[:24]
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,24}", cid) or cid in seen:
            continue
        seen.add(cid)
        sources = []
        for s in (ch.get("sources") or [])[:200]:
            s = str(s)[:300]
            if valid_source(s) and s not in sources:
                sources.append(s.lower() if s.startswith("app:") else s)
        if "master" in sources:
            sources = ["master"]  # the whole-PC volume is its own slider
        level = ch.get("level", 100)
        color = str(ch.get("color") or "")
        channels.append({
            "id": cid,
            "name": str(ch.get("name") or "")[:40],
            "color": color.lower() if HEX.fullmatch(color) else "#2dd4bf",
            "sources": sources,
            "applyOnStart": bool(ch.get("applyOnStart")),
            "level": max(0, min(100, int(level))) if isinstance(level, (int, float)) else 100,
        })
    return {"layout": layout, "title": str(body.get("title") or "")[:40], "channels": channels}


# ------------------------------------------------------------------------------------------------ library: apps and games
NOT_GAMES = {
    "steam.exe", "steamwebhelper.exe", "steamservice.exe", "gameoverlayui.exe", "epicgameslauncher.exe",
    "epicwebhelper.exe", "riotclientservices.exe", "riotclientux.exe", "riotclientuxrender.exe", "battle.net.exe",
    "eadesktop.exe", "eabackgroundservice.exe", "galaxyclient.exe", "galaxyclient helper.exe", "upc.exe",
    "ubisoftconnect.exe", "wallpaper32.exe", "wallpaper64.exe", "webwallpaper32.exe", "unitycrashhandler64.exe",
    "unitycrashhandler32.exe", "crashreportclient.exe", "easyanticheat_launcher.exe", "start_protected_game.exe",
    "playnite.desktopapp.exe", "playnite.fullscreenapp.exe", "xboxpcapp.exe", "gamebar.exe", "msedgewebview2.exe",
    "unrealeditor.exe", "unrealeditor-cmd.exe", "unrealinsights.exe", "quixelbridge.exe", "minecraftlauncher.exe",
    # everyday apps that end up in Game Bar's list (a browser game, an accidental "this is a game" tick)
    "firefox.exe", "chrome.exe", "msedge.exe", "opera.exe", "opera_gx.exe", "brave.exe", "vivaldi.exe", "zen.exe",
    "librewolf.exe", "discord.exe", "discordptb.exe", "discordcanary.exe", "spotify.exe", "teams.exe", "ms-teams.exe",
    "slack.exe", "zoom.exe", "teamspeak.exe", "ts3client_win64.exe", "obs64.exe", "vlc.exe", "mpv.exe", "itunes.exe",
    "tidal.exe", "wmplayer.exe", "music.ui.exe", "whatsapp.exe", "telegram.exe", "signal.exe", "parsecd.exe",
}
GAME_DIRS = (
    "\\steamapps\\common\\", "\\epic games\\", "\\epicgames\\", "\\xboxgames\\", "\\gog galaxy\\games\\", "\\gog games\\",
    "\\riot games\\", "\\ubisoft game launcher\\games\\", "\\ea games\\", "\\electronic arts\\", "\\amazon games\\library\\",
    "\\itch\\apps\\", "\\battlestate games\\", "\\rockstar games\\", "\\heroic\\", "\\games\\",
)
NOT_GAME_DIRS = ("\\steamapps\\common\\steamworks shared\\", "\\steamapps\\common\\steamvr\\",
                 "\\steamapps\\common\\wallpaper_engine\\", "\\epic games\\ue_", "\\epic games\\launcher\\",
                 "\\xboxgames\\gamesave\\")
NOT_GAME_NAMES = re.compile(r"redistributable|proton |steam linux runtime|steamworks|dedicated server|soundtrack|sdk\b", re.I)
SKIP_SHORTCUTS = re.compile(r"uninstall|deinstall|readme|read me|\bhelp\b|documentation|website|release notes|licen[cs]e|"
                            r"manual|support|safe mode|\bsetup\b|changelog|what's new|\burl\b", re.I)
GENERIC_DIRS = {"bin", "binaries", "win64", "win32", "x64", "x86", "game", "retail", "shipping", "client", "content",
                "app", "build", "release", "windows", "windowsnoeditor", "wingdk"}
LIBRARY_EVERY = 600  # seconds between full rescans


def norm(p: str) -> str:
    return os.path.normpath(p).rstrip("\\").lower()


def game_name_from_exe(path: str) -> str:
    d = os.path.dirname(path)
    while d and os.path.basename(d).lower() in GENERIC_DIRS or "binaries" in os.path.basename(d).lower():
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return os.path.basename(d) or os.path.splitext(os.path.basename(path))[0]


def _reg_subkeys(hive, path):
    try:
        with winreg.OpenKey(hive, path) as root:
            for i in range(winreg.QueryInfoKey(root)[0]):
                name = winreg.EnumKey(root, i)
                try:
                    with winreg.OpenKey(root, name) as k:
                        vals = {}
                        for j in range(winreg.QueryInfoKey(k)[1]):
                            n, v, _ = winreg.EnumValue(k, j)
                            vals[n] = v
                        yield name, vals
                except OSError:
                    continue
    except OSError:
        return


def read_lnk(path: str):
    """Minimal .lnk (MS-SHLLINK) reader: returns (target, arguments) or None. No COM needed."""
    try:
        with open(path, "rb") as f:
            d = f.read(1 << 16)
    except OSError:
        return None
    if len(d) < 0x4C or d[:4] != b"L\x00\x00\x00":
        return None
    u32 = lambda o: int.from_bytes(d[o:o + 4], "little")
    u16 = lambda o: int.from_bytes(d[o:o + 2], "little")

    def astr(o):
        e = d.find(b"\x00", o)
        return d[o:e if e >= 0 else len(d)].decode("mbcs", "ignore")

    def wstr(o):
        e = o
        while e + 1 < len(d) and d[e:e + 2] != b"\x00\x00":
            e += 2
        return d[o:e].decode("utf-16-le", "ignore")

    flags, pos, target, args, relpath = u32(0x14), 0x4C, "", "", ""
    if flags & 0x1:  # LinkTargetIDList
        pos += 2 + u16(pos)
    if flags & 0x2:  # LinkInfo
        li, size = pos, u32(pos)
        hsize, liflags = u32(li + 4), u32(li + 8)
        if liflags & 0x1:
            if hsize >= 0x24 and u32(li + 0x1C):
                target = wstr(li + u32(li + 0x1C))
            if not target and u32(li + 0x10):
                target = astr(li + u32(li + 0x10))
        pos += size
    unicode = flags & 0x80
    for bit in (0x4, 0x8, 0x10, 0x20, 0x40):  # name, relative path, working dir, arguments, icon
        if flags & bit:
            n = u16(pos)
            pos += 2
            if unicode:
                s, pos = d[pos:pos + 2 * n].decode("utf-16-le", "ignore"), pos + 2 * n
            else:
                s, pos = d[pos:pos + n].decode("mbcs", "ignore"), pos + n
            if bit == 0x20:
                args = s
            elif bit == 0x8:
                relpath = s
    if not target and relpath:
        target = os.path.normpath(os.path.join(os.path.dirname(path), relpath))
    return target, args


class Library:
    """What is installed: apps from the Start Menu, games from the stores, Game Bar and your own folders."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.lock = threading.Lock()
        self.games: list[dict] = []   # {id, name, store, root?, exe?}
        self.apps: dict[str, dict] = {}  # exe key -> {key, name, path}
        self.roots: list[tuple[str, dict]] = []  # (normalized root + "\\", game), longest first
        self.extra_roots: list[str] = []  # your game folders themselves
        self.gc_paths: set[str] = set()
        self.gc_names: set[str] = set()
        self.at = 0.0
        self.scanning = False
        self.scan_lock = threading.Lock()

    # -------------------------------------------------------------- scanning
    def due(self):
        return not self.scanning and self.at and time.time() - self.at > LIBRARY_EVERY

    def scan(self):
        if not self.scan_lock.acquire(blocking=False):  # one scan at a time
            return
        self.scanning = True
        t0 = time.time()
        try:
            games: dict[str, dict] = {}

            def add_root(root, name, store):
                if not root or not os.path.isdir(root) or NOT_GAME_NAMES.search(name or ""):
                    return
                n = norm(root)
                if any(x in n + "\\" for x in NOT_GAME_DIRS):
                    return
                games.setdefault("dir:" + n, {"id": "dir:" + n, "name": name or os.path.basename(root), "store": store, "root": os.path.normpath(root)})

            for root, name in self._steam():
                add_root(root, name, "Steam")
            for root, name in self._epic():
                add_root(root, name, "Epic")
            for root, name in self._registry_stores():
                add_root(*root_name(root, name))
            for drive in self._drives():
                for d in glob.glob(drive + "XboxGames\\*\\"):
                    add_root(d, os.path.basename(d.rstrip("\\")), "Xbox")
            extra = []
            for folder in self.cfg.data["gameFolders"]:
                if os.path.isdir(folder):
                    extra.append(norm(folder) + "\\")
                    for d in glob.glob(os.path.join(glob.escape(folder), "*", "")):
                        add_root(d, os.path.basename(d.rstrip("\\")), "Your folder")
            roots = sorted(((g["id"][4:] + "\\", g) for g in games.values()), key=lambda r: -len(r[0]))

            # Windows' Game Bar list: exact exes. Folded into a store game when it lives inside one.
            gc_paths, gc_names = set(), set()
            for _, vals in _reg_subkeys(winreg.HKEY_CURRENT_USER, r"System\GameConfigStore\Children"):
                exe = vals.get("MatchedExeFullPath")
                if not exe:
                    continue
                key = os.path.basename(exe).lower()
                if key in NOT_GAMES:
                    continue
                gc_paths.add(exe.lower())
                gc_names.add(key)
                owner = next((g for r, g in roots if exe.lower().startswith(r)), None)
                if owner:
                    owner.setdefault("exe", exe)
                elif os.path.isfile(exe) and not any(x in exe.lower() for x in NOT_GAME_DIRS):
                    games.setdefault(key, {"id": key, "name": game_name_from_exe(exe), "store": "Game Bar", "exe": exe})

            apps = self._start_menu()
            with self.lock:
                self.games = sorted(games.values(), key=lambda g: g["name"].lower())
                self.roots, self.extra_roots = roots, extra
                self.gc_paths, self.gc_names = gc_paths, gc_names
                self.apps = apps
                self.at = time.time()
            log.info("library: %d games, %d apps (%.1fs)", len(games), len(apps), time.time() - t0)
        except Exception:
            log.exception("library scan failed")
            self.at = time.time()  # retry at the next interval, not in a loop
        finally:
            self.scanning = False
            self.scan_lock.release()

    @staticmethod
    def _drives():
        return [f"{c}:\\" for c in "CDEFGHIJKLMNOPQRSTUVWXYZ" if os.path.isdir(f"{c}:\\")]

    def _steam(self):
        steam = None
        for hive, path, value in ((winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam", "SteamPath"),
                                  (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath")):
            try:
                with winreg.OpenKey(hive, path) as k:
                    steam = winreg.QueryValueEx(k, value)[0]
                    break
            except OSError:
                continue
        if not steam:
            return
        libs = {os.path.normpath(steam)}
        try:
            with open(os.path.join(steam, "steamapps", "libraryfolders.vdf"), encoding="utf-8", errors="ignore") as f:
                for m in re.finditer(r'"path"\s+"([^"]+)"', f.read()):
                    libs.add(os.path.normpath(m.group(1).replace("\\\\", "\\")))
        except OSError:
            pass
        for lib in libs:
            for acf in glob.glob(os.path.join(glob.escape(lib), "steamapps", "appmanifest_*.acf")):
                try:
                    with open(acf, encoding="utf-8", errors="ignore") as f:
                        text = f.read()
                except OSError:
                    continue
                name = re.search(r'"name"\s+"([^"]*)"', text)
                inst = re.search(r'"installdir"\s+"([^"]*)"', text)
                if inst:
                    yield os.path.join(lib, "steamapps", "common", inst.group(1)), name.group(1) if name else inst.group(1)

    def _epic(self):
        folder = os.path.join(os.environ.get("ProgramData", r"C:\ProgramData"), r"Epic\EpicGamesLauncher\Data\Manifests")
        for item in glob.glob(os.path.join(glob.escape(folder), "*.item")):
            try:
                with open(item, encoding="utf-8") as f:
                    j = json.load(f)
            except Exception:
                continue
            if "games" in [str(c).lower() for c in j.get("AppCategories") or []]:  # skips engines and plugins
                yield j.get("InstallLocation"), j.get("DisplayName")

    def _registry_stores(self):
        hk = winreg.HKEY_LOCAL_MACHINE
        for _, v in _reg_subkeys(hk, r"SOFTWARE\WOW6432Node\GOG.com\Games"):
            yield ("GOG", v.get("path")), v.get("gameName")
        for base in (r"SOFTWARE\WOW6432Node\EA Games", r"SOFTWARE\EA Games"):
            for name, v in _reg_subkeys(hk, base):
                yield ("EA", v.get("Install Dir")), name
        for _, v in _reg_subkeys(hk, r"SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs"):
            d = v.get("InstallDir")
            yield ("Ubisoft", d), os.path.basename(str(d or "").rstrip("\\/"))

    def _start_menu(self) -> dict[str, dict]:
        apps = {}
        windir = norm(os.environ.get("WINDIR", r"C:\Windows")) + "\\"
        for base in (os.path.join(os.environ.get("ProgramData", r"C:\ProgramData"), r"Microsoft\Windows\Start Menu\Programs"),
                     os.path.join(APPDATA, r"Microsoft\Windows\Start Menu\Programs")):
            for dirpath, _, files in os.walk(base):
                for fn in files:
                    if not fn.lower().endswith(".lnk"):
                        continue
                    name = fn[:-4]
                    if SKIP_SHORTCUTS.search(name):
                        continue
                    res = read_lnk(os.path.join(dirpath, fn))
                    if not res:
                        continue
                    target, args = res
                    # Squirrel apps (Discord, Slack…): Update.exe --processStart Discord.exe
                    m = re.search(r'--processStart\s+"?([^"\s]+\.exe)', args or "", re.I)
                    if m:
                        target = os.path.join(os.path.dirname(target), m.group(1))
                    if not target.lower().endswith(".exe") or norm(target).startswith(windir):
                        continue
                    key = os.path.basename(target).lower()
                    if key in ("update.exe", "uninstall.exe", "unins000.exe", "setup.exe"):
                        continue
                    if key not in apps or len(name) < len(apps[key]["name"]):
                        apps[key] = {"key": key, "name": name, "path": target}
        return apps

    # -------------------------------------------------------------- classification
    def root_of(self, path_lower: str):
        for r, g in self.roots:
            if path_lower.startswith(r):
                return g
        return None

    def is_game(self, key: str, path: str) -> tuple[bool, bool]:
        """(game?, automatic answer) for a running exe."""
        overrides = self.cfg.data["gameOverrides"]
        if key.startswith("#") or not path:
            return False, False
        p = path.lower()
        owner = self.root_of(p)
        auto = self.auto_game(key, p, owner)
        ov = overrides.get(key)
        if isinstance(ov, bool):
            return ov, auto
        if owner is not None and isinstance(overrides.get(owner["id"]), bool):
            return overrides[owner["id"]], auto
        return auto, auto

    def auto_game(self, key, p, owner) -> bool:
        if key in NOT_GAMES or any(d in p for d in NOT_GAME_DIRS):
            return False
        if owner is not None or p in self.gc_paths or key in self.gc_names:
            return True
        if any(p.startswith(r) for r in self.extra_roots):
            return True
        return any(d in p for d in GAME_DIRS)


def root_name(store_root, name):
    store, root = store_root
    return root, name, store


# ------------------------------------------------------------------------------------------------ sessions
def dos_devices() -> list[tuple[str, str]]:
    """'\\device\\harddiskvolume3' -> 'C:' so session paths can be compared with normal paths."""
    out = []
    buf = ctypes.create_unicode_buffer(1024)
    for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        try:
            if ctypes.windll.kernel32.QueryDosDeviceW(letter + ":", buf, 1024):
                out.append((buf.value.lower() + "\\", letter + ":\\"))
        except Exception:
            break
    return out


DEVICES = dos_devices()


_PID_PATHS: dict[int, str] = {}


def exe_of_pid(pid) -> str:
    """The full exe path of a running process (cached per pid), or ""."""
    if not isinstance(pid, int) or pid <= 0:
        return ""
    if pid in _PID_PATHS:
        return _PID_PATHS[pid]
    path = ""
    k32 = ctypes.windll.kernel32
    h = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION: works without admin rights
    if h:
        try:
            buf = ctypes.create_unicode_buffer(1024)
            size = ctypes.c_uint32(len(buf))
            if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                path = buf.value
        finally:
            k32.CloseHandle(h)
    if len(_PID_PATHS) > 2000:
        _PID_PATHS.clear()
    _PID_PATHS[pid] = path
    return path


def session_path(sid: str, session: dict | None = None) -> str:
    """The exe behind an audio session.

    PhoneBox up to 0.9.26 put it in the session id:
        "{endpoint}|\\Device\\HarddiskVolume3\\Program Files\\Mozilla Firefox\\firefox.exe%b{guid}|4%b18740"
    0.9.27 and later group sessions per app ("application:mozilla firefox") and give only the pid and process name,
    so the path comes from the pid.
    """
    parts = sid.split("|")
    if len(parts) < 2:
        session = session or {}
        if session.get("pid") == 0 and "system" in str(session.get("name", "")).lower():
            return "#system"
        return exe_of_pid(session.get("pid"))
    raw = parts[1].split("%b")[0]
    if raw.startswith("#"):
        return "#system"
    low = raw.lower()
    for dev, drive in DEVICES:
        if low.startswith(dev):
            return drive + raw[len(dev):]
    return raw


def app_key(session: dict, path: str) -> str:
    if path == "#system" or (session.get("pid") == 0 and "system" in str(session.get("name", "")).lower()):
        return "#system"
    if path:
        return os.path.basename(path).lower()
    if session.get("processName"):  # the pid's exe was not readable (a protected process): its name still matches
        return str(session["processName"]).lower() + ".exe"
    return "name:" + str(session.get("name", "?")).lower()


# ------------------------------------------------------------------------------------------------ agent access
def matches(ch, s) -> bool:
    src = ch.get("sources") or []
    if "app:" + s["key"] in src:
        return True
    if "games" in src and s.get("game"):
        return True
    if "system" in src and s["key"] == "#system":
        return True
    p = (s.get("path") or "").lower()
    return bool(p) and any(x.startswith("dir:") and p.startswith(x[4:] + "\\") for x in src)


class Hub:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.lib = Library(cfg)
        self.lock = threading.Lock()
        self.poll_lock = threading.Lock()
        self.audio = None          # last audio block from the agent
        self.sessions: list = []   # enriched sessions
        self.error = None
        self.fetched_at = 0.0
        self.last_client = 0.0
        self.known_sessions: set[str] | None = None
        self.seq: dict[str, int] = {}
        self.set_lock = threading.Lock()
        self.hold: dict[tuple, tuple[float, int]] = {}  # (widget, channel) -> (until, value): echo the slider while the agent catches up

    # -------------------------------------------------------------- polling
    def run(self):
        while True:
            if self.lib.due():
                threading.Thread(target=self.lib.scan, daemon=True, name="library").start()
            active = time.time() - self.last_client < 6
            try:
                self.poll()
            except Exception as e:
                with self.lock:
                    self.error = f"PhoneBox agent not reachable ({e.__class__.__name__})"
            try:
                self.cfg.flush()
            except Exception as e:
                log.warning("saving config failed: %s", e)
            time.sleep(0.25 if active else 2.0)

    def poll(self):
        with self.poll_lock:
            self._poll()

    def _poll(self):
        data = agent_get("/controls/state")
        audio = data.get("audio") or {}
        sessions = []
        for s in audio.get("sessions") or []:
            path = session_path(s.get("id", ""), s)
            key = app_key(s, path)
            path = "" if path == "#system" else path
            game, auto = self.lib.is_game(key, path)
            name = "System sounds" if key == "#system" else s.get("name") or key
            sessions.append({**s, "name": name, "key": key, "path": path, "gameAuto": auto, "game": game})
        with self.lock:
            self.audio, self.sessions, self.fetched_at = audio, sessions, time.time()
            self.error = None if audio.get("available", True) else (audio.get("error") or "Audio unavailable")
        self.remember_apps(sessions)
        self.apply_on_start(sessions)

    def remember_apps(self, sessions):
        apps = self.cfg.data["apps"]
        now = int(time.time())
        with self.cfg.lock:
            for s in sessions:
                a = apps.get(s["key"])
                if a is None or a.get("name") != s["name"] or now - a.get("lastSeen", 0) > 3600:
                    apps[s["key"]] = {"name": s["name"], "path": s["path"], "lastSeen": now}
                    self.cfg.touch()

    def apply_on_start(self, sessions):
        ids = {s["id"] for s in sessions}
        if self.known_sessions is None:  # first look: leave already running apps alone
            self.known_sessions = ids
            return
        new = [s for s in sessions if s["id"] not in self.known_sessions]
        self.known_sessions = ids
        if not new:
            return
        done = set()
        for w in list(self.cfg.data["widgets"].values()):
            for ch in w.get("channels", []):
                if not ch.get("applyOnStart"):
                    continue
                for s in new:
                    if s["id"] not in done and matches(ch, s):
                        done.add(s["id"])
                        try:
                            agent_command("session", id=s["id"], value=ch.get("level", 100))
                            log.info("%s started: set to %s%% (slider '%s')", s["name"], ch.get("level"), ch.get("name"))
                        except Exception as e:
                            log.warning("could not set %s: %s", s["name"], e)

    # -------------------------------------------------------------- names
    def label(self, src: str) -> str:
        if src.startswith("app:"):
            key = src[4:]
            for s in self.sessions:
                if s["key"] == key:
                    return s["name"]
            g = next((g for g in self.lib.games if g["id"] == key), None)
            a = self.lib.apps.get(key) or self.cfg.data["apps"].get(key)
            return (g or a or {}).get("name") or re.sub(r"\.exe$", "", key)
        if src.startswith("dir:"):
            g = next((g for g in self.lib.games if g["id"] == src), None)
            return g["name"] if g else os.path.basename(src[4:])
        return {"games": "Games", "system": "System", "master": "Master"}.get(src, src)

    def auto_name(self, ch) -> str:
        src = ch.get("sources") or []
        if len(src) == 1:
            return self.label(src[0])
        return "Mix" if src else "Empty slider"

    # -------------------------------------------------------------- views
    def default_output(self):
        audio = self.audio or {}
        defaults = audio.get("defaults") or {}
        want = defaults.get("output:1") or defaults.get("output:0")
        devices = [d for d in audio.get("devices") or [] if d.get("direction") == "output"]
        return next((d for d in devices if d.get("id") == want), None) or next((d for d in devices if d.get("default")), None)

    def channel_view(self, wid, ch):
        if ch["sources"] == ["master"]:
            d = self.default_output()
            members = [d] if d else []
            labels = [d.get("name", "")] if d else []
        else:
            members = [s for s in self.sessions if matches(ch, s)]
            labels = []
            for s in members:
                if s["name"] not in labels:
                    labels.append(s["name"])
        running = bool(members)
        volume = max((m.get("volume", 0) for m in members), default=ch.get("level", 100))
        hold = self.hold.get((wid, ch["id"]))
        if hold and hold[0] > time.time():
            volume = hold[1]
        return {
            "id": ch["id"], "name": ch["name"] or self.auto_name(ch), "color": ch["color"], "sources": ch["sources"],
            "running": running, "volume": volume,
            "muted": running and all(m.get("muted") for m in members),
            "peak": max((m.get("peak") or 0 for m in members), default=0),
            "apps": labels[:6], "count": len(labels),
            "canControl": all(m.get("canControl", True) is not False for m in members),
        }

    def state(self, wid):
        self.last_client = time.time()
        if time.time() - self.fetched_at > 1.0:  # the poller was idle: fetch now so the first frame is fresh
            try:
                self.poll()
            except Exception as e:
                self.error = f"PhoneBox agent not reachable ({e.__class__.__name__})"
        w = self.cfg.widget(wid)
        saved = w is not None
        w = w or {"layout": "auto", "title": "", "channels": []}
        with self.lock:
            channels = [self.channel_view(wid, ch) for ch in w["channels"]]
        return {"ok": self.error is None, "error": self.error, "widget": wid, "saved": saved, "layout": w.get("layout", "auto"),
                "title": w.get("title", ""), "channels": channels, "config": w}

    def pickables(self):
        """Everything a slider can control: running apps, games (installed, by folder or exe), installed apps."""
        with self.lock:
            sessions = list(self.sessions)
        running_keys = {s["key"]: s for s in sessions}
        running_paths = [s["path"].lower() for s in sessions if s["path"]]
        out: dict[str, dict] = {}

        def put(src, name, detail, game, installed=False):
            if src in out:
                out[src]["installed"] = out[src]["installed"] or installed
                return
            if src.startswith("dir:"):
                running = any(p.startswith(src[4:] + "\\") for p in running_paths)
            else:
                running = src[4:] in running_keys
            out[src] = {"src": src, "name": name, "detail": detail, "running": running, "game": game, "installed": installed}

        for s in sessions:  # running first: their names are the most accurate
            if s["key"] != "#system" and not s["key"].startswith("name:"):
                put("app:" + s["key"], s["name"], s["key"], s["game"], False)
        for g in self.lib.games:
            ov = self.cfg.data["gameOverrides"].get(g["id"])
            if ov is False:
                continue
            if "root" in g:
                put(g["id"], g["name"], f'{g["store"]} · {g["root"]}', True, True)
            else:
                put("app:" + g["id"], g["name"], f'{g["store"]} · {g["id"]}', True, True)
        for key, a in self.lib.apps.items():
            game, _ = self.lib.is_game(key, a["path"])
            put("app:" + key, a["name"], key, game, True)
        for key in self.cfg.data["customApps"]:
            put("app:" + key, re.sub(r"\.exe$", "", key), key + " · added by you", False, False)
            out["app:" + key]["custom"] = True
        for key, a in self.cfg.data["apps"].items():
            if key != "#system" and not key.startswith("name:"):
                game, _ = self.lib.is_game(key, a.get("path", ""))
                put("app:" + key, a.get("name") or key, key, game, False)
        items = list(out.values())
        items.sort(key=lambda a: (not a["running"], not a["game"], a["name"].lower()))
        return items

    def game_list(self):
        """For the Game detection screen: every known game plus every app seen or installed, with its verdict."""
        overrides = self.cfg.data["gameOverrides"]
        with self.lock:
            sessions = list(self.sessions)
        running_paths = [s["path"].lower() for s in sessions if s["path"]]
        running_keys = {s["key"] for s in sessions}
        out, seen = [], set()
        for g in self.lib.games:
            ov = overrides.get(g["id"])
            root = g.get("root")
            auto = not (g["id"] in NOT_GAMES)
            running = any(p.startswith(norm(root) + "\\") for p in running_paths) if root else g["id"] in running_keys
            out.append({"id": g["id"], "name": g["name"], "detail": f'{g["store"]} · {root or g.get("exe", "")}', "running": running,
                        "auto": auto, "override": ov if isinstance(ov, bool) else None})
            seen.add(g["id"])
        others = {}
        for key, a in list(self.cfg.data["apps"].items()) + list(self.lib.apps.items()):
            if key in seen or key.startswith(("#", "name:")) or key in others:
                continue
            path = a.get("path", "")
            game, auto = self.lib.is_game(key, path)
            owner = self.lib.root_of(path.lower()) if path else None
            if owner is not None:  # covered by its store entry
                continue
            ov = overrides.get(key)
            others[key] = {"id": key, "name": a.get("name") or key, "detail": path or key, "running": key in running_keys,
                           "auto": auto, "override": ov if isinstance(ov, bool) else None}
        out += others.values()
        for e in out:
            e["game"] = e["override"] if e["override"] is not None else e["auto"]
        out.sort(key=lambda e: (not e["running"], not e["game"], e["name"].lower()))
        return {"games": out, "folders": self.cfg.data["gameFolders"], "scanning": self.lib.scanning,
                "scannedAt": int(self.lib.at)}

    # -------------------------------------------------------------- actions
    def set_channel(self, wid, cid, value=None, muted=None, seq=0):
        w = self.cfg.widget(wid)
        ch = next((c for c in (w or {}).get("channels", []) if c["id"] == cid), None)
        if ch is None:
            raise KeyError("unknown slider")
        with self.set_lock:  # newest value wins when several requests of a drag arrive out of order
            k = f"{wid}/{cid}"
            if value is not None and seq and seq < self.seq.get(k, 0):
                return
            if seq:
                self.seq[k] = seq
            if value is not None:
                value = max(0, min(100, int(value)))
                with self.cfg.lock:
                    ch["level"] = value
                    self.cfg.touch()
                self.hold[(wid, cid)] = (time.time() + 1.2, value)
            if ch["sources"] == ["master"]:
                d = self.default_output()
                if not d:
                    raise RuntimeError("no output device")
                agent_command("device", id=d["id"], value=value, muted=muted)
                return
            with self.lock:
                members = [s for s in self.sessions if matches(ch, s)]
            errors = []
            for s in members:
                try:
                    agent_command("session", id=s["id"], value=value, muted=muted)
                except Exception as e:
                    errors.append(str(e))
            if errors and len(errors) == len(members):
                raise RuntimeError(errors[0])

# ------------------------------------------------------------------------------------------------ plugin glue
class Plugin:
    def __init__(self, ctx):
        global log
        log = ctx.log
        self.cfg = _Cfg()
        self.hub = Hub(self.cfg)
        self.routes = {
            "GET state": lambda r: self.hub.state(r.id),
            "POST set": self.set,
            "GET apps": lambda r: {"apps": self.hub.pickables(), "scanning": self.hub.lib.scanning},
            "GET games": lambda r: self.hub.game_list(),
            "POST game": self.game,
            "POST folders": self.folders,
            "POST customapp": self.customapp,
            "POST customapp-remove": self.customapp_remove,
            "POST rescan": lambda r: (self.hub.lib.scan(), {"ok": True})[1],
        }

    def clean_config(self, cfg):
        return clean_widget(cfg)

    def start(self):
        threading.Thread(target=self.hub.lib.scan, daemon=True, name="volume-library").start()
        self.hub.run()

    # -------------------------------------------------------------- routes
    def set(self, r):
        q = r.query
        value = int(q["v"]) if "v" in q else None
        muted = {"1": True, "0": False}.get(q.get("m", ""))
        try:
            self.hub.set_channel(r.id, q.get("ch", ""), value, muted, int(q.get("seq", 0) or 0))
        except KeyError as e:
            raise UserError(str(e).strip("'\""))
        return {"ok": True}

    def game(self, r):
        key, v = r.query.get("id", "")[:300], r.query.get("v", "auto")
        key = r.query.get("app") or key
        with _ctx.lock:
            if v == "auto":
                self.cfg.data["gameOverrides"].pop(key, None)
            else:
                self.cfg.data["gameOverrides"][key] = v == "1"
        _ctx.save_now()
        return {"ok": True}

    def folders(self, r):
        folders = []
        for f in ((r.json({}) or {}).get("folders") or [])[:50]:
            f = os.path.normpath(str(f).strip().strip('"'))
            if f and f != "." and f not in folders:
                if not os.path.isdir(f):
                    raise UserError(f"folder not found: {f}")
                folders.append(f)
        with _ctx.lock:
            self.cfg.data["gameFolders"] = folders
        _ctx.save_now()
        self.hub.lib.scan()
        return self.hub.game_list()

    def customapp(self, r):
        key = os.path.basename(r.query.get("exe", "").strip().strip('"')).lower()[:120]
        if key and not key.endswith(".exe"):
            key += ".exe"
        if not re.fullmatch(r"[^\/:*?\"<>|]{1,120}\.exe", key or ""):
            raise UserError("enter an exe name like discord.exe")
        with _ctx.lock:
            if key not in self.cfg.data["customApps"]:
                self.cfg.data["customApps"].append(key)
        _ctx.save_now()
        return {"ok": True, "src": "app:" + key}

    def customapp_remove(self, r):
        key = r.query.get("exe", "").lower()
        with _ctx.lock:
            if key in self.cfg.data["customApps"]:
                self.cfg.data["customApps"].remove(key)
        _ctx.save_now()
        return {"ok": True}


def setup(ctx):
    global _ctx
    _ctx = ctx
    return Plugin(ctx)
