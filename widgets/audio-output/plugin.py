"""Audio output widget, PC side: the output devices you picked, which one is active, and switching Windows' default
output to one of them (through the PhoneBox agent's Control Deck, which uses Windows' own policy config API)."""
import re
import threading
import time

from pbw import UserError

META = {
    "name": "Audio output",
    "icon": "speaker",
    "description": "Buttons for the speakers / headsets you choose; tap one and Windows switches its output to it.",
    "size": [4, 2],
}
HEX = re.compile(r"#[0-9a-fA-F]{6}")
# Lucide icon names (host/icons) a device can show
ICONS = ("speaker", "headphones", "headset", "monitor", "tv", "laptop", "gamepad-2", "music", "radio", "sofa", "bluetooth", "car", "cable")
# settings saved before the widget used icons held emoji
EMOJI = {"🔊": "speaker", "🎧": "headphones", "🖥️": "monitor", "🖥": "monitor", "📺": "tv", "🎮": "gamepad-2", "🔈": "speaker",
         "🎵": "music", "🛋️": "sofa", "🛋": "sofa", "💻": "laptop", "📻": "radio"}
# Windows keeps a default per role: 0 console, 1 multimedia, 2 communications (calls)
ROLES = {"all": "", "media": "media"}


def icon_of(value) -> str:
    value = EMOJI.get(value, value)
    return value if value in ICONS else "speaker"


def guess_icon(name: str) -> str:
    n = name.lower()
    if any(w in n for w in ("headset", "headphone", "earphone", "earbud", "airpods", "hs80", "arctis")):
        return "headphones"
    if any(w in n for w in ("nvidia high definition", "hdmi", "displayport", "monitor", "ultragear")):
        return "monitor"
    if any(w in n for w in ("tv", "television")):
        return "tv"
    if "digital" in n or "spdif" in n or "optical" in n:
        return "cable"
    return "speaker"


class Plugin:
    def __init__(self, ctx):
        self.ctx = ctx
        self._audio, self._at = None, 0.0
        self._lock = threading.Lock()
        self.routes = {"GET state": self.state, "POST switch": self.switch}

    # -------------------------------------------------------------- data
    def audio(self, max_age=1.0):
        with self._lock:
            if self._audio is None or time.time() - self._at > max_age:
                self._audio = self.ctx.agent_get("/controls/state").get("audio") or {}
                self._at = time.time()
            return self._audio

    def outputs(self):
        a = self.audio()
        return [d for d in a.get("devices") or [] if d.get("direction") == "output"], a.get("defaults") or {}

    def state(self, req):
        cfg = self.ctx.get(req.id) or {"devices": []}
        try:
            outs, defaults = self.outputs()
            error = None
        except Exception as e:
            outs, defaults, error = [], {}, f"PhoneBox agent not reachable ({e.__class__.__name__})"
        by_id = {d["id"]: d for d in outs}
        media = defaults.get("output:1")
        names = {}
        for d in outs:  # Windows can show two devices with the same name: number them
            names.setdefault(d["name"], []).append(d["id"])
        tiles = []
        for t in cfg.get("devices", []):
            d = by_id.get(t["id"])
            tiles.append({**t, "icon": icon_of(t.get("icon")), "label": t.get("label") or (d and d["name"]) or t.get("name") or "Unknown device",
                          "present": d is not None, "active": t["id"] == media,
                          "volume": d and d.get("volume"), "muted": bool(d and d.get("muted"))})
        available = [{"id": d["id"], "name": d["name"], "icon": guess_icon(d["name"]), "active": d["id"] == media,
                      "twin": len(names[d["name"]]) > 1 and names[d["name"]].index(d["id"]) + 1}
                     for d in outs]
        return {"ok": error is None, "error": error, "saved": self.ctx.get(req.id) is not None, "config": cfg,
                "tiles": tiles, "available": available}

    def switch(self, req):
        dev = req.query.get("dev", "")
        cfg = self.ctx.get(req.id) or {}
        role = ROLES.get(cfg.get("role", "all"), "")
        outs, _ = self.outputs()
        if dev not in {d["id"] for d in outs}:
            raise UserError("That device is not connected right now")
        try:
            self.ctx.agent_command("default", id=dev, op=role)
        except RuntimeError as e:
            raise UserError(str(e))
        self._at = 0  # next state reads fresh
        self.ctx.log.info("output switched to %s (%s)", next((d["name"] for d in outs if d["id"] == dev), dev), role or "all roles")
        return {"ok": True}

    # -------------------------------------------------------------- settings
    def clean_config(self, cfg):
        devices, seen = [], set()
        for t in (cfg.get("devices") or [])[:16]:
            if not isinstance(t, dict):
                continue
            did = str(t.get("id") or "")[:200]
            if not did or did in seen:
                continue
            seen.add(did)
            devices.append({
                "id": did,
                "name": str(t.get("name") or "")[:120],      # Windows' name when it was added (for when it's unplugged)
                "label": str(t.get("label") or "")[:40],     # your own name, optional
                "icon": icon_of(t.get("icon")),
                "color": t["color"].lower() if isinstance(t.get("color"), str) and HEX.fullmatch(t["color"]) else "#2dd4bf",
            })
        return {
            "title": str(cfg.get("title") or "")[:40],
            "role": cfg.get("role") if cfg.get("role") in ROLES else "all",
            "layout": cfg.get("layout") if cfg.get("layout") in ("auto", "row", "column", "grid") else "auto",
            "showVolume": bool(cfg.get("showVolume", True)),
            "devices": devices,
        }


def setup(ctx):
    return Plugin(ctx)
