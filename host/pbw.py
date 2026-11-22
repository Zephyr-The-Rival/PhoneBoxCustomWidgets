"""Shared helpers for the PhoneBox Widgets host and its widget plugins.

A plugin gets a `Context` in its `setup(ctx)`:

    ctx.type                       the widget type ("clock")
    ctx.log                        a logger
    ctx.instances()                {id: settings} of every saved widget of this type (live dict, read only please)
    ctx.get(id) / ctx.put(id, cfg) one widget's settings
    ctx.data                       a dict the plugin owns, saved with the settings (call ctx.changed() after edits)
    ctx.changed() / ctx.save_now() mark data dirty (saved within ~2 s) / save right away
    ctx.lock                       lock around data / settings edits
    ctx.agent_get(path)            GET  http://127.0.0.1:8765/api<path> of the PhoneBox agent (JSON)
    ctx.agent_command(kind, **q)   POST /api/controls/command/<kind> of the agent
    ctx.phone.battery()            {level, charging, plugged, ...} of the tablet, through adb
    ctx.adb(*args)                 run adb against the tablet; returns stdout or None
    ctx.Raw(bytes, content_type)   return this from a route to send an image or file instead of JSON
"""
from __future__ import annotations

import json
import logging
import logging.handlers
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import winreg

PORT = int(os.environ.get("PBW_PORT", "8766"))
APPDATA = os.environ.get("APPDATA", os.path.expanduser("~"))
DATA_DIR = os.path.join(APPDATA, "PhoneBoxWidgets")
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
OLD_CONFIG = os.path.join(APPDATA, "PhoneBoxVolumeSlider", "config.json")  # the Volume Slider before the host
PB_CONFIG = os.path.join(APPDATA, "PhoneBox", "config.json")
NO_WINDOW = 0x08000000  # CREATE_NO_WINDOW: no console flashes when adb runs under pythonw

os.makedirs(DATA_DIR, exist_ok=True)
log = logging.getLogger("pbw")
log.setLevel(logging.INFO)
_fh = logging.handlers.RotatingFileHandler(os.path.join(DATA_DIR, "host.log"), maxBytes=512_000, backupCount=1, encoding="utf-8")
_fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s"))
log.addHandler(_fh)
if sys.stderr is not None:
    log.addHandler(logging.StreamHandler())


class UserError(Exception):
    """Raise from a route handler: the widget gets HTTP 400 with this message."""


class Raw:
    """Return from a route handler to send bytes instead of JSON (an image, for example)."""

    def __init__(self, data: bytes, ctype: str, cache: str = "no-store", status: int = 200):
        self.data, self.ctype, self.cache, self.status = data, ctype, cache, status


def phonebox_settings() -> dict:
    try:
        with open(PB_CONFIG, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


# ------------------------------------------------------------------------------------------------ settings store
class Store:
    """config.json: {"widgets": {"<type>": {"instances": {"<id>": settings}, "data": {...plugin's own...}}}}"""

    def __init__(self):
        self.lock = threading.RLock()
        self.data = {"widgets": {}}
        self._dirty_at = 0.0
        try:
            with open(CONFIG_PATH, encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded.get("widgets"), dict):
                self.data = loaded
        except FileNotFoundError:
            self._migrate_volume_slider()
        except Exception as e:
            log.warning("config unreadable (%s); starting empty, the old file is kept as config.json.broken", e)
            try:
                shutil.copy(CONFIG_PATH, CONFIG_PATH + ".broken")
            except Exception:
                pass

    def _migrate_volume_slider(self):
        try:
            with open(OLD_CONFIG, encoding="utf-8") as f:
                old = json.load(f)
        except Exception:
            return
        self.section("volume")["instances"] = old.get("widgets") or {}
        self.section("volume")["data"] = {k: old[k] for k in ("apps", "gameOverrides", "gameFolders", "customApps") if k in old}
        self.touch()
        self.flush(force=True)
        log.info("imported the Volume Slider settings from %s", OLD_CONFIG)

    def section(self, wtype) -> dict:
        with self.lock:
            sec = self.data["widgets"].setdefault(wtype, {})
            sec.setdefault("instances", {})
            sec.setdefault("data", {})
            return sec

    def instances(self, wtype) -> dict:
        return self.section(wtype)["instances"]

    def get(self, wtype, wid):
        return self.instances(wtype).get(wid)

    def put(self, wtype, wid, cfg):
        with self.lock:
            self.instances(wtype)[wid] = cfg
        self.save_now()

    def delete(self, wtype, wid):
        with self.lock:
            self.instances(wtype).pop(wid, None)
        self.save_now()

    def touch(self):
        self._dirty_at = self._dirty_at or time.time()

    def save_now(self):
        self.touch()
        self.flush(force=True)

    def flush(self, force=False):
        with self.lock:
            if not self._dirty_at or (not force and time.time() - self._dirty_at < 1.5):
                return
            self._dirty_at = 0.0
            tmp = CONFIG_PATH + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.data, f, indent=2, ensure_ascii=False)
            os.replace(tmp, CONFIG_PATH)


STORE = Store()


# ------------------------------------------------------------------------------------------------ PhoneBox agent
AGENT = f"http://127.0.0.1:{os.environ.get('PBW_AGENT_PORT') or phonebox_settings().get('port') or 8765}/api"


def agent_get(path: str, timeout=3.0):
    with urllib.request.urlopen(AGENT + path, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def agent_command(kind: str, **params):
    q = urllib.parse.urlencode({k: (str(v).lower() if isinstance(v, bool) else v) for k, v in params.items() if v is not None})
    req = urllib.request.Request(f"{AGENT}/controls/command/{kind}?{q}", method="POST", data=b"")
    with urllib.request.urlopen(req, timeout=3.0) as r:
        res = json.loads(r.read().decode("utf-8") or "{}")
    if isinstance(res, dict) and res.get("ok") is False:
        raise RuntimeError(res.get("error") or res.get("message") or "the agent refused")
    return res


# ------------------------------------------------------------------------------------------------ adb / tablet
def find_adb():
    configured = phonebox_settings().get("adbPath")
    cands = [configured] if configured else []
    w = shutil.which("adb")
    if w:
        cands.append(w)
    local = os.environ.get("LOCALAPPDATA", "")
    cands += [os.path.join(local, "Android", "Sdk", "platform-tools", "adb.exe"),
              os.path.join(local, "PhoneBox", "app", "platform-tools", "adb.exe"),
              os.path.join(local, "Microsoft", "WinGet", "Links", "adb.exe")]
    return next((c for c in cands if c and os.path.isfile(c)), None)


class Phone:
    """The tablet over adb: the USB route for widgets (adb reverse) and its battery."""

    def __init__(self):
        self.serials: list[str] = []
        self._battery = None
        self._battery_at = 0.0
        self._lock = threading.Lock()

    def adb(self, *args, serial=None, timeout=8):
        adb = find_adb()
        if not adb:
            return None
        cmd = [adb] + (["-s", serial] if serial else []) + list(args)
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, creationflags=NO_WINDOW)
        except Exception:
            return None
        return r.stdout if r.returncode == 0 else None

    def refresh_devices(self):
        out = self.adb("devices") or ""
        self.serials = [l.split("\t")[0] for l in out.splitlines()[1:] if l.endswith("\tdevice")]
        return self.serials

    def battery(self, max_age=20):
        with self._lock:
            if self._battery is not None and time.time() - self._battery_at < max_age:
                return self._battery
            self._battery_at = time.time()
            serial = (self.serials or self.refresh_devices() or [None])[0]
            out = self.adb("shell", "dumpsys", "battery", serial=serial) if serial else None
            if not out:
                self._battery = None
                return None
            vals = dict(re.findall(r"^\s*([A-Za-z ]+):\s*(.+?)\s*$", out, re.M))
            status = {"2": "charging", "3": "discharging", "4": "not charging", "5": "full"}.get(vals.get("status"), "unknown")
            level, scale = int(vals.get("level", 0)), int(vals.get("scale", 100)) or 100
            plugged = [k.split()[0].lower() for k in ("AC powered", "USB powered", "Wireless powered") if vals.get(k) == "true"]
            self._battery = {"available": True, "level": round(level * 100 / scale), "status": status,
                             "charging": status == "charging", "plugged": plugged,
                             "temperature": int(vals.get("temperature", 0)) / 10, "at": int(time.time())}
            return self._battery

    def keep_reverse(self):
        rule = f"tcp:{PORT}"
        announced = set()
        while True:
            try:
                for d in self.refresh_devices():
                    if f"{rule} {rule}" not in (self.adb("reverse", "--list", serial=d) or ""):
                        if self.adb("reverse", rule, rule, serial=d) is not None and d not in announced:
                            log.info("%s: adb reverse %s set up", d, rule)
                            announced.add(d)
            except Exception as e:
                log.debug("adb: %s", e)
            time.sleep(10)


PHONE = Phone()


# ------------------------------------------------------------------------------------------------ haptics
HAPTIC_DEFAULTS = {"haptics": True, "hapticMs": 40}  # 40 ms: what PhoneBox's own buttons use


def host_settings() -> dict:
    with STORE.lock:
        s = STORE.data.get("host") or {}
    return {"haptics": bool(s.get("haptics", HAPTIC_DEFAULTS["haptics"])),
            "hapticMs": max(10, min(150, int(s.get("hapticMs", HAPTIC_DEFAULTS["hapticMs"]))))}


def save_host_settings(new: dict) -> dict:
    cur = host_settings()
    if "haptics" in new:
        cur["haptics"] = bool(new["haptics"])
    if isinstance(new.get("hapticMs"), (int, float)):
        cur["hapticMs"] = max(10, min(150, int(new["hapticMs"])))
    with STORE.lock:
        STORE.data["host"] = {**(STORE.data.get("host") or {}), **cur}
    STORE.save_now()
    return cur


class Haptics:
    """A short buzz on the tablet when a widget button is tapped. Starting adb for every tap takes ~150 ms, so this
    keeps one `adb shell` open and writes the vibrate command into it (a few ms)."""

    def __init__(self):
        self.proc = None
        self.serial = None
        self.cmd = ""
        self.last = 0.0
        self.lock = threading.Lock()

    def _shell(self):
        serial = (PHONE.serials or PHONE.refresh_devices() or [None])[0]
        adb = find_adb()
        if not serial or not adb:
            return None
        if self.proc and self.proc.poll() is None and self.serial == serial:
            return self.proc
        self.close()
        sdk = (PHONE.adb("shell", "getprop", "ro.build.version.sdk", serial=serial) or "").strip()
        # Android 12+ replaced "cmd vibrator" with "cmd vibrator_manager"
        self.cmd = ("cmd vibrator_manager synced -f oneshot {ms}" if sdk.isdigit() and int(sdk) >= 31
                    else "cmd vibrator vibrate -f {ms} phonebox-widgets")
        self.proc = subprocess.Popen([adb, "-s", serial, "shell"], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, creationflags=NO_WINDOW)
        self.serial = serial
        log.info("%s: haptics ready (Android SDK %s)", serial, sdk or "?")
        return self.proc

    def buzz(self, ms=None, force=False) -> bool:
        """force: buzz even when haptics are switched off (the setup page's Test button)."""
        s = host_settings()
        if not s["haptics"] and not force:
            return False
        ms = max(10, min(150, int(ms or s["hapticMs"])))
        with self.lock:
            if time.time() - self.last < 0.04:  # a double event from one tap
                return True
            for _ in range(2):  # a dead shell (tablet replugged): open a new one once
                p = self._shell()
                if not p:
                    return False
                try:
                    p.stdin.write((self.cmd.format(ms=ms) + " >/dev/null 2>&1\n").encode("ascii"))
                    p.stdin.flush()
                    self.last = time.time()
                    return True
                except OSError:
                    self.close()
        return False

    def close(self):
        p, self.proc = self.proc, None
        if p:
            try:
                p.kill()
            except OSError:
                pass


HAPTICS = Haptics()


# ------------------------------------------------------------------------------------------------ PC fonts
class Fonts:
    """The PC's installed fonts (TTF / OTF), so widgets can use any of them without internet on the tablet."""

    def __init__(self):
        self._fonts: dict[str, dict] = {}
        self._at = 0.0

    def _scan(self):
        if time.time() - self._at < 300 and self._fonts:
            return
        fonts = {}
        windir = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(hive, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts") as k:
                    for i in range(winreg.QueryInfoKey(k)[1]):
                        name, file, _ = winreg.EnumValue(k, i)
                        if not isinstance(file, str) or not file.lower().endswith((".ttf", ".otf")):
                            continue  # .ttc collections and bitmap .fon files don't work in a browser
                        path = file if os.path.isabs(file) else os.path.join(windir, file)
                        if not os.path.isfile(path):
                            continue
                        fid = re.sub(r"[^a-z0-9_.-]", "-", os.path.basename(path).lower())
                        label = re.sub(r"\s*\((TrueType|OpenType)\)\s*$", "", name, flags=re.I)
                        fonts.setdefault(fid, {"id": fid, "name": label, "path": path})
            except OSError:
                continue
        self._fonts, self._at = fonts, time.time()

    def list(self):
        self._scan()
        return sorted(({"id": f["id"], "name": f["name"]} for f in self._fonts.values()), key=lambda f: f["name"].lower())

    def file(self, fid):
        self._scan()
        f = self._fonts.get(fid)
        if not f:
            raise FileNotFoundError(fid)
        with open(f["path"], "rb") as fh:
            return fh.read(), "font/otf" if f["path"].lower().endswith(".otf") else "font/ttf"


FONTS = Fonts()


# ------------------------------------------------------------------------------------------------ plugin context
class Context:
    def __init__(self, wtype: str):
        self.type = wtype
        self.log = logging.getLogger(f"pbw.{wtype}")
        self.lock = STORE.lock
        self.phone = PHONE
        self.agent_get = agent_get
        self.agent_command = agent_command
        self.UserError = UserError
        self.Raw = Raw

    @property
    def data(self) -> dict:
        return STORE.section(self.type)["data"]

    def instances(self) -> dict:
        return STORE.instances(self.type)

    def get(self, wid):
        return STORE.get(self.type, wid)

    def put(self, wid, cfg):
        STORE.put(self.type, wid, cfg)

    def changed(self):
        STORE.touch()

    def save_now(self):
        STORE.save_now()

    def adb(self, *args, timeout=8):
        serial = (PHONE.serials or PHONE.refresh_devices() or [None])[0]
        return PHONE.adb(*args, serial=serial, timeout=timeout) if serial else None


def start_services():
    threading.Thread(target=PHONE.keep_reverse, daemon=True, name="adb").start()

    def flusher():
        while True:
            time.sleep(1)
            try:
                STORE.flush()
            except Exception as e:
                log.warning("saving settings failed: %s", e)
    threading.Thread(target=flusher, daemon=True, name="store").start()
