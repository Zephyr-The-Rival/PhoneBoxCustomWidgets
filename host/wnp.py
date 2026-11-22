"""WebNowPlaying adapter: exact position, length and seeking for media in the browser.

Firefox doesn't keep Windows' media session up to date (the position is only right at play / pause). The WebNowPlaying
browser extension (https://wnp.keifufu.dev, Firefox and Chrome) reads the page's player directly and sends it to
"adapters", local WebSocket servers. This is one, on 127.0.0.1:8767 ("Add custom adapter" in the extension's settings).

Protocol (revision 3, from the extension's source: src/extension/sw/socket.ts, port.ts, content/content.ts):
  * the extension connects; the adapter speaks first: "ADAPTER_VERSION <v>;WNPLIB_REVISION 3"
  * extension -> adapter, text frames "<type> <args>":
      0 <id> <fields>   player added        1 <id> <fields>   player updated (empty field = unchanged)
      2 <id>            player removed      3 <eventId> <1 ok | 2 failed>        4 <0|1>  (desktop players setting)
    <fields>: "id|name|title|artist|album|cover|state|position|duration|volume|...|", "\\|" is a literal "|",
    "\\x01" an empty string; state 0 playing, 1 paused, 2 stopped; position / duration in seconds; booleans 1 / 0.
    Binary frames carry cover images (ignored here).
  * adapter -> extension: "<playerId> <eventId> <event> [data]"; event 3 = set position (whole seconds, absolute).

Only browser extensions may connect (their Origin is moz-extension:// or chrome-extension://): a web page could
otherwise open a WebSocket to 127.0.0.1 and feed fake players.
"""
from __future__ import annotations

import base64
import hashlib
import os
import re
import socket
import struct
import threading
import time
import uuid

PORT = int(os.environ.get("PBW_WNP_PORT", "8767"))
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"  # RFC 6455
FIELDS = ["id", "name", "title", "artist", "album", "cover", "state", "position", "duration", "volume", "rating",
          "repeat", "shuffle", "ratingSystem", "availableRepeat", "canSetState", "canSkipPrevious", "canSkipNext",
          "canSetPosition", "canSetVolume", "canSetRating", "canSetRepeat", "canSetShuffle", "createdAt",
          "updatedAt", "activeAt"]
EV_SET_POSITION = 3


def split_fields(s: str) -> list[str]:
    out, cur, i = [], [], 0
    while i < len(s):
        c = s[i]
        if c == "\\" and s[i + 1:i + 2] == "|":
            cur.append("|")
            i += 2
            continue
        if c == "|":
            out.append("".join(cur))
            cur = []
        else:
            cur.append(c)
        i += 1
    if cur:
        out.append("".join(cur))
    return out


def norm(title) -> str:
    return re.sub(r"\s+", " ", str(title or "")).strip().casefold()


class Conn:
    """One WebSocket connection (server side: we send unmasked frames, the extension's are masked)."""

    def __init__(self, sock):
        self.sock = sock
        self.wlock = threading.Lock()

    def _read(self, n) -> bytes:
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("closed")
            buf += chunk
        return buf

    def frame(self):
        b1, b2 = self._read(2)
        n = b2 & 0x7F
        if n == 126:
            n = struct.unpack(">H", self._read(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", self._read(8))[0]
        if n > 16_000_000:
            raise ConnectionError("frame too large")
        mask = self._read(4) if b2 & 0x80 else None
        data = self._read(n)
        if mask and n:
            m = (mask * (n // 4 + 1))[:n]
            data = (int.from_bytes(data, "big") ^ int.from_bytes(m, "big")).to_bytes(n, "big")
        return bool(b1 & 0x80), b1 & 0x0F, data

    def message(self):
        """The next whole message as (opcode, bytes); answers pings on the way."""
        op, parts = None, []
        while True:
            fin, o, data = self.frame()
            if o == 0x9:
                self.send(data, 0xA)
                continue
            if o == 0xA:
                continue
            if o == 0x8:
                return 0x8, data
            if o != 0x0:
                op, parts = o, []
            parts.append(data)
            if fin:
                return op, b"".join(parts)

    def send(self, data: bytes, op=0x1):
        n = len(data)
        head = bytes([0x80 | op]) + (bytes([n]) if n < 126 else b"\x7e" + struct.pack(">H", n) if n < 65536
                                     else b"\x7f" + struct.pack(">Q", n))
        with self.wlock:
            self.sock.sendall(head + data)

    def text(self, s: str):
        self.send(s.encode("utf-8"))


class Adapter:
    def __init__(self, log, port=PORT):
        self.log, self.port = log, port
        self.lock = threading.Lock()
        self.players: dict[str, dict] = {}  # id -> fields (+ _conn, _at)
        self.conns = 0

    # -------------------------------------------------------------- server
    def serve(self):
        try:
            srv = socket.create_server(("127.0.0.1", self.port))
        except OSError as e:
            self.log.warning("WebNowPlaying adapter: port %s busy (%s); browser media uses Windows' data only", self.port, e)
            return
        self.log.info("WebNowPlaying adapter on ws://127.0.0.1:%s", self.port)
        while True:
            sock, _ = srv.accept()
            threading.Thread(target=self.handle, args=(sock,), daemon=True, name="wnp").start()

    def handle(self, sock):
        conn = None
        try:
            sock.settimeout(10)
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = sock.recv(4096)
                if not chunk or len(data) > 32768:
                    return
                data += chunk
            lines = data.split(b"\r\n\r\n", 1)[0].decode("latin-1").split("\r\n")
            headers = {k.strip().lower(): v.strip() for k, _, v in (l.partition(":") for l in lines[1:])}
            origin = headers.get("origin")
            key = headers.get("sec-websocket-key")
            if not key or "websocket" not in headers.get("upgrade", "").lower() or (
                    origin is not None and not origin.startswith(("moz-extension://", "chrome-extension://"))):
                sock.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                return
            accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
            sock.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                          f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
            sock.settimeout(None)
            conn = Conn(sock)
            conn.text("ADAPTER_VERSION 1.0.0;WNPLIB_REVISION 3")
            with self.lock:
                self.conns += 1
            self.log.info("WebNowPlaying connected (%s)", (origin or "?").split("://")[0])
            while True:
                op, data = conn.message()
                if op == 0x8:
                    break
                if op == 0x1:
                    self.on_text(conn, data.decode("utf-8", "replace"))
        except (OSError, ConnectionError, ValueError):
            pass
        finally:
            if conn:
                with self.lock:
                    self.conns -= 1
                    for pid in [p for p, v in self.players.items() if v.get("_conn") is conn]:
                        del self.players[pid]
                self.log.info("WebNowPlaying disconnected")
            try:
                sock.close()
            except OSError:
                pass

    def on_text(self, conn, text):
        typ, _, rest = text.partition(" ")
        if typ in ("0", "1"):
            pid, _, fields = rest.partition(" ")
            now = time.time()
            with self.lock:
                p = {} if typ == "0" else self.players.setdefault(pid, {})
                for name, v in zip(FIELDS, split_fields(fields)):
                    if v == "":
                        continue  # unchanged
                    p[name] = "" if v == "\x01" else v
                    if name in ("position", "state"):
                        p["_at"] = now
                p["_conn"] = conn
                p.setdefault("_at", now)
                self.players[pid] = p
        elif typ == "2":
            with self.lock:
                self.players.pop(rest.strip(), None)
        elif typ == "3":
            eid, _, status = rest.partition(" ")
            if status.strip() == "2":
                self.log.info("WebNowPlaying: the page refused event %s", eid)

    # -------------------------------------------------------------- for the media widget
    @property
    def connected(self) -> bool:
        return self.conns > 0

    @staticmethod
    def _view(pid, p):
        def num(k):
            try:
                return float(p.get(k) or 0)
            except ValueError:
                return 0.0
        playing = p.get("state") == "0"
        pos = num("position") + ((time.time() - p.get("_at", time.time())) if playing else 0)
        dur = num("duration")
        return {"id": pid, "site": p.get("name", ""), "title": p.get("title", ""), "playing": playing,
                "posMs": round(min(pos, dur) * 1000 if dur else pos * 1000), "durMs": round(dur * 1000),
                "canSeek": p.get("canSetPosition") == "1" and dur > 0, "activeAt": num("activeAt")}

    def match(self, title):
        """The browser player showing this title (what Windows says is playing), or None."""
        t = norm(title)
        if not t:
            return None
        with self.lock:
            views = [self._view(pid, p) for pid, p in self.players.items() if p.get("title")]
        exact = [v for v in views if norm(v["title"]) == t]
        loose = [v for v in views if len(t) >= 8 and (t in norm(v["title"]) or norm(v["title"]) in t)]
        found = exact or loose
        return max(found, key=lambda v: (v["playing"], v["activeAt"])) if found else None

    def seek(self, pid, seconds) -> bool:
        """Jumps the browser player to an absolute position (whole seconds)."""
        with self.lock:
            p = self.players.get(pid)
            conn = p and p.get("_conn")
        if not conn:
            return False
        s = max(0, int(seconds))
        conn.text(f"{pid} {uuid.uuid4().hex[:8]} {EV_SET_POSITION} {s}")
        with self.lock:  # optimistic: the page reports the new position within a moment anyway
            if pid in self.players:
                self.players[pid].update(position=str(s), _at=time.time())
        return True
