"""Media widget, PC side: what's playing (Windows' media session, through the PhoneBox agent), its cover art, and the
controls: play/pause, previous/next, seek, and skipping back / forward a few seconds.

Position and length come from Windows, except for media in the browser when the WebNowPlaying extension is connected
(host/wnp.py): it reads the page's player directly, which Firefox's Windows integration doesn't keep up to date."""
import json
import re
import threading
import time
import urllib.request

import pbw
import wnp
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
        self._tl = None              # the last real position report (see timeline())
        self._own_seek_until = 0.0   # a counter restart before this is our own skip, not the user's
        self._lock = threading.Lock()
        self.wnp = wnp.Adapter(ctx.log)
        self.routes = {"GET state": self.state, "GET art": self.art, "POST action": self.action}

    def start(self):
        self.wnp.serve()  # runs for good (its own thread, started by the host)

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
                w = self.wnp.match(m.get("title"))
                if w:  # the browser extension knows this one exactly
                    m.update(posMs=w["posMs"], durMs=w["durMs"], canSeek=w["canSeek"], wnp=w["id"])
                else:
                    m = self.timeline(m)
            self._media, self._at = m, time.time()
            return m

    def timeline(self, m):
        """Fills in the position for players that only report it now and then (Firefox).

        Firefox tells Windows the real position and length when playback starts or pauses. A second or two later it
        drops them: no length, and a counter that restarts at 0 (and restarts again whenever you jump in the video).
        So the last real report is the anchor, and the position is counted on from it while playing. A restart of the
        counter means a jump to an unknown spot: the position is unknown until the next real report, unless it was
        our own skip, whose target we know."""
        now = time.time()
        key = (m.get("app"), m.get("title"), m.get("artist"))
        if (m.get("durMs") or 0) > 0:  # a real report
            tl = self._tl
            if tl and tl["key"] == key and now < self._own_seek_until and abs(m.get("posMs", 0) - self._tl_pos(tl, now)) > 2000:
                return dict(m, posMs=self._tl_pos(tl, now))  # still the position from before our skip: stale
            self._tl = {"key": key, "pos": m.get("posMs", 0), "dur": m["durMs"], "at": now,
                        "playing": bool(m.get("playing")), "base": None}
            return m
        tl = self._tl
        if not tl or tl["key"] != key:
            return m  # nothing to go on: the widget shows no position
        playing = bool(m.get("playing"))
        counter = m.get("posMs", 0)
        if tl["base"] is not None:
            c0, t0, was_playing = tl["base"]
            expected = c0 + ((now - t0) * 1000 if was_playing else 0)
            if counter < expected - 1500 or counter > expected + 2500:  # the counter jumped: a seek
                if now > self._own_seek_until:
                    self._tl = None  # the user jumped in the player itself: position unknown
                    return m
        if playing != tl["playing"]:  # paused / resumed without a real report: carry the position over
            tl["pos"] = self._tl_pos(tl, now)
            tl["at"], tl["playing"] = now, playing
        tl["base"] = (counter, now, playing)
        return dict(m, posMs=self._tl_pos(tl, now), durMs=tl["dur"])

    @staticmethod
    def _tl_pos(tl, now):
        return min(tl["dur"], round(tl["pos"] + ((now - tl["at"]) * 1000 if tl["playing"] else 0)))

    def state(self, req):
        try:
            return {"ok": True, "media": self.media(), "wnp": self.wnp.connected}
        except Exception as e:
            return {"ok": False, "error": f"PhoneBox agent not reachable ({e.__class__.__name__})", "media": None,
                    "wnp": self.wnp.connected}

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
        if a in ("back", "seek", "forward"):
            m = self.media(max_age=0)
            if not m or not m.get("canSeek"):
                raise UserError("This player can't skip within the track")
            # No track length (Firefox): the player doesn't tell Windows its position either; the agent's posMs is
            # then its own count since the last change, and seeking from it throws the video back to the start.
            if not (m.get("durMs") or 0) > 0:
                raise UserError("Position unknown (Firefox): play / pause once, or connect the WebNowPlaying extension")
        if a in ("back", "forward"):
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
        if a == "seek" and m.get("wnp"):  # the browser extension jumps exactly
            if not self.wnp.seek(m["wnp"], ms / 1000):
                raise UserError("The browser tab is gone")
            self._at = 0
            return {"ok": True, "media": self.media(max_age=0)}
        url = f"{pbw.AGENT}/media/{a}" + (f"?ms={ms}" if ms is not None else "")
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=b"", method="POST"), timeout=5) as r:
                res = json.loads(r.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError:
            raise UserError("The player did not accept that")
        if ms is not None:
            with self._lock:  # we know where we sent it: the new anchor, until the player reports again
                if self._tl:
                    self._tl.update(pos=ms, at=time.time(), base=None)
                self._own_seek_until = time.time() + 3
        self._at = 0  # next state is fresh
        if ms is None:
            return {"ok": True, "media": res.get("media")}
        try:
            return {"ok": True, "media": self.media(max_age=0)}  # with the position we just set
        except Exception:
            return {"ok": True, "media": None}

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
