"""Media widget, PC side: what's playing (Windows' media session, through the PhoneBox agent), its cover art, and the
controls: play/pause, previous/next, seek, and skipping back / forward a few seconds."""
import json
import re
import threading
import time
import urllib.request

import pbw
from pbw import Raw, UserError

META = {
    "name": "Media",
    "icon": "music",
    "description": "Now playing with big controls, a seek bar and ±5 s skips, without a volume slider.",
    "size": [6, 3],
}
HEX = re.compile(r"#[0-9a-fA-F]{6}")
SKIPS = (5, 10, 15, 30)


class Plugin:
    def __init__(self, ctx):
        self.ctx = ctx
        self._media, self._at = None, 0.0
        self._art = (None, None, None)  # (artId, bytes, mime)
        self._lock = threading.Lock()
        self.routes = {"GET state": self.state, "GET art": self.art, "POST action": self.action}

    # -------------------------------------------------------------- reading
    def media(self, max_age=0.4):
        """The agent's media snapshot; posMs is brought up to "now" (the agent says how old its reading is)."""
        with self._lock:
            if self._at and time.time() - self._at < max_age:
                return self._media
            m = pbw.agent_get("/state").get("media")
            if m:
                m = dict(m)
                if m.get("playing") and m.get("ageMs"):
                    m["posMs"] = m.get("posMs", 0) + m["ageMs"]
                    if m.get("durMs"):
                        m["posMs"] = min(m["posMs"], m["durMs"])
                m.pop("ageMs", None)
            self._media, self._at = m, time.time()
            return m

    def state(self, req):
        try:
            return {"ok": True, "media": self.media()}
        except Exception as e:
            return {"ok": False, "error": f"PhoneBox agent not reachable ({e.__class__.__name__})", "media": None}

    def art(self, req):
        # the cover changes with the track; ?v=<artId> lets the tablet cache each one
        m = self.media() or {}
        aid = m.get("artId")
        if self._art[0] != aid or self._art[1] is None:
            try:
                with urllib.request.urlopen(pbw.AGENT + "/art", timeout=3) as r:
                    self._art = (aid, r.read(), r.headers.get("Content-Type", "image/png"))
            except Exception:
                return Raw(b"", "image/png", status=404)
        return Raw(self._art[1], self._art[2], cache="public, max-age=86400")

    # -------------------------------------------------------------- controls
    def action(self, req):
        a = req.query.get("a", "")
        cfg = self.ctx.get(req.id) or {}
        ms = None
        if a in ("back", "forward"):
            m = self.media(max_age=0)
            if not m or not m.get("canSeek"):
                raise UserError("This player can't skip within the track")
            step = (cfg.get("skip") or 5) * 1000 * (-1 if a == "back" else 1)
            ms = max(0, m.get("posMs", 0) + step)
            if m.get("durMs"):
                ms = min(ms, max(0, m["durMs"] - 500))
            a = "seek"
        elif a == "seek":
            try:
                ms = max(0, int(req.query.get("ms", "")))
            except ValueError:
                raise UserError("seek needs ms")
        elif a not in ("playpause", "next", "prev"):
            raise UserError("unknown action")
        url = f"{pbw.AGENT}/media/{a}" + (f"?ms={ms}" if ms is not None else "")
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=b"", method="POST"), timeout=5) as r:
                res = json.loads(r.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError:
            raise UserError("The player did not accept that")
        self._at = 0  # next state is fresh
        return {"ok": True, "media": res.get("media")}

    # -------------------------------------------------------------- settings
    def clean_config(self, cfg):
        color = cfg.get("color")
        return {
            "skip": cfg.get("skip") if cfg.get("skip") in SKIPS else 5,
            "art": bool(cfg.get("art", True)),
            "app": bool(cfg.get("app", True)),
            "tint": bool(cfg.get("tint", True)),
            "progress": bool(cfg.get("progress", True)),
            "color": color.lower() if isinstance(color, str) and HEX.fullmatch(color) else "#eef2f6",
        }


def setup(ctx):
    return Plugin(ctx)
