"""Discord widget, PC side: mute / deafen yourself, leave the call, and set the volume of everyone in it.

Talks to the Discord app on this PC over its local RPC pipe (\\\\.\\pipe\\discord-ipc-N), the same way stream-deck
plugins do. Discord only allows that for an application it knows, so you use your own (discord.com/developers):
its Client ID and Client Secret go into the widget's settings once, Discord asks you to "Authorize" once, and the
host keeps the token. The secret and the tokens are encrypted with Windows DPAPI (readable by your Windows account
only) and are never sent back to widgets.

Threads: start() runs the connection (connect, log in, subscribe, reload the channel when woken); a reader thread
reads the pipe and dispatches answers and events; HTTP threads send commands through call().
"""
from __future__ import annotations

import base64
import ctypes
import ctypes.wintypes as wt
import json
import msvcrt
import re
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from pbw import UserError

META = {
    "name": "Discord",
    "icon": "headset",
    "description": "Mute and deafen yourself, leave the call, and set the volume of everyone in it.",
    "size": [4, 4],
}

SCOPES = ["rpc", "rpc.voice.read", "rpc.voice.write"]
TOKEN_URL = "https://discord.com/api/oauth2/token"
REDIRECT = "http://localhost"
UA = "PhoneBoxWidgets (local widget host, 1.0)"
CHANNEL_EVENTS = ("VOICE_STATE_CREATE", "VOICE_STATE_UPDATE", "VOICE_STATE_DELETE", "SPEAKING_START", "SPEAKING_STOP")
OP_HANDSHAKE, OP_FRAME, OP_CLOSE, OP_PING, OP_PONG = range(5)
HEX = re.compile(r"#[0-9a-fA-F]{6}")
SNOWFLAKE = re.compile(r"\d{5,25}")


class AuthError(Exception):
    """Needs the user (wrong Client ID / secret, authorization declined): no automatic retry until they act."""


class RpcError(Exception):
    def __init__(self, code, message):
        super().__init__(f"{message} ({code})" if code else message)
        self.code = code


# ------------------------------------------------------------------------------------------------ Windows bits
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
kernel32.PeekNamedPipe.argtypes = [wt.HANDLE, ctypes.c_void_p, wt.DWORD, ctypes.c_void_p, ctypes.POINTER(wt.DWORD), ctypes.c_void_p]
kernel32.PeekNamedPipe.restype = wt.BOOL
kernel32.LocalFree.argtypes = [ctypes.c_void_p]


class _Blob(ctypes.Structure):
    _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _dpapi(data: bytes, protect: bool) -> bytes:
    buf = ctypes.create_string_buffer(data, len(data))
    src, out = _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), _Blob()
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    if not fn(ctypes.byref(src), None, None, None, None, 0x1, ctypes.byref(out)):  # 0x1: CRYPTPROTECT_UI_FORBIDDEN
        raise OSError(f"DPAPI error {ctypes.get_last_error()}")
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(ctypes.cast(out.pbData, ctypes.c_void_p))


def seal(text: str) -> str:
    return base64.b64encode(_dpapi(text.encode("utf-8"), True)).decode("ascii")


def unseal(blob: str) -> str:
    return _dpapi(base64.b64decode(blob), False).decode("utf-8")


class Pipe:
    """One connection to Discord's IPC pipe. Frames: <opcode u32><length u32><JSON>.

    Windows serializes reads and writes on a synchronous pipe handle, so the reader never blocks waiting: it peeks
    until a whole header is there, and only then reads."""

    def __init__(self):
        for i in range(10):  # discord-ipc-0 is the first Discord running (Stable, PTB or Canary)
            try:
                self.f = open(rf"\\.\pipe\discord-ipc-{i}", "r+b", buffering=0)
                break
            except OSError:
                continue
        else:
            raise FileNotFoundError("Discord isn't running")
        self.handle = msvcrt.get_osfhandle(self.f.fileno())
        self.wlock = threading.Lock()

    def send(self, op, payload):
        data = json.dumps(payload).encode("utf-8")
        with self.wlock:
            self.f.write(struct.pack("<II", op, len(data)) + data)

    def _available(self) -> int:
        n = wt.DWORD()
        if not kernel32.PeekNamedPipe(self.handle, None, 0, None, ctypes.byref(n), None):
            raise ConnectionError("Discord closed the connection")
        return n.value

    def _read(self, n) -> bytes:
        buf = b""
        while len(buf) < n:
            chunk = self.f.read(n - len(buf))
            if not chunk:
                raise ConnectionError("Discord closed the connection")
            buf += chunk
        return buf

    def recv(self, timeout):
        """The next frame as (op, message), or None after `timeout` seconds."""
        end = time.time() + timeout
        while self._available() < 8:
            if time.time() > end:
                return None
            time.sleep(0.03)
        op, n = struct.unpack("<II", self._read(8))
        return op, json.loads(self._read(n).decode("utf-8") or "null")

    def close(self):
        try:
            self.f.close()
        except OSError:
            pass


def member(vs: dict) -> dict:
    """A voice state from Discord -> what the widget shows."""
    u, v = vs.get("user") or {}, vs.get("voice_state") or {}
    return {"id": str(u.get("id") or ""), "name": vs.get("nick") or u.get("global_name") or u.get("username") or "?",
            "avatar": u.get("avatar"), "bot": bool(u.get("bot")),
            "volume": round(vs.get("volume", 100)), "mute": bool(vs.get("mute")),  # your local mute / volume for them
            "selfMute": bool(v.get("self_mute") or v.get("mute") or v.get("suppress")),
            "selfDeaf": bool(v.get("self_deaf") or v.get("deaf"))}


# ------------------------------------------------------------------------------------------------ plugin
class Plugin:
    def __init__(self, ctx):
        self.ctx = ctx
        self.lock = threading.Lock()  # guards st / members / speaking
        self.wake = threading.Event()
        self.pipe: Pipe | None = None
        self.pending: dict[str, dict] = {}
        self.blocked = False   # after an AuthError: wait for the user instead of popping up Discord again and again
        self.restart = False   # the user changed something: reconnect right away, quietly
        self.sub_channel = None
        self.st = {"status": "connecting", "message": "", "user": None, "mute": False, "deaf": False, "channel": None}
        self.members: dict[str, dict] = {}
        self.speaking: set[str] = set()
        self.avatars: dict[tuple, bytes] = {}
        self.routes = {
            "GET state": self.state, "GET avatar": self.avatar,
            "POST mute": self.mute, "POST deaf": self.deaf, "POST leave": self.leave,
            "POST volume": self.user_volume, "POST usermute": self.user_mute,
            "POST connect": self.connect, "POST forget": self.forget, "POST retry": self.retry,
        }

    # -------------------------------------------------------------- stored credentials
    def creds(self):
        d = self.ctx.data
        if not d.get("clientId") or not d.get("secret"):
            return None
        try:
            return d["clientId"], unseal(d["secret"])
        except (OSError, ValueError):
            return None  # sealed by another Windows account: enter it again

    def tokens(self):
        try:
            return json.loads(unseal(self.ctx.data["tokens"]))
        except (KeyError, OSError, ValueError):
            return None

    def save_tokens(self, tok):
        with self.ctx.lock:
            self.ctx.data["tokens"] = seal(json.dumps(tok))
        self.ctx.save_now()

    # -------------------------------------------------------------- status
    def status(self, status, message=""):
        with self.lock:
            changed = (self.st["status"], self.st["message"]) != (status, message)
            self.st["status"], self.st["message"] = status, message
        if changed:
            self.ctx.log.info("discord: %s%s", status, f" ({message})" if message else "")

    # -------------------------------------------------------------- connection loop
    def start(self):
        while True:
            self.wake.clear()
            creds = self.creds()
            if not creds:
                self.status("setup", "Enter your Discord application's Client ID and Client Secret")
                self.wake.wait()
                continue
            if self.blocked:
                self.wake.wait()
                continue
            self.restart = False
            try:
                self.session(*creds)
            except FileNotFoundError:
                self.status("closed", "Discord isn't running")
            except AuthError as e:
                self.blocked = True
                self.status("auth", str(e))
            except (ConnectionError, TimeoutError) as e:
                if not self.restart:
                    self.status("closed", str(e) or "Lost the connection to Discord")
            except Exception as e:
                if not self.restart:
                    self.ctx.log.exception("discord connection failed")
                    self.status("error", f"{e.__class__.__name__}: {e}")
            finally:
                self.drop()
            if not self.restart and not self.blocked:
                self.wake.wait(5)

    def session(self, cid, secret):
        self.status("connecting", "Connecting to Discord…")
        pipe = self.pipe = Pipe()
        pipe.send(OP_HANDSHAKE, {"v": 1, "client_id": cid})
        frame = pipe.recv(10)
        if frame is None:
            raise ConnectionError("Discord didn't answer")
        op, msg = frame
        if op == OP_CLOSE:
            if (msg or {}).get("code") == 4000:
                raise AuthError("Discord doesn't know this Client ID. Check it in the widget's settings.")
            raise ConnectionError(f"Discord refused the connection: {(msg or {}).get('message')}")
        if (msg or {}).get("evt") != "READY":
            raise ConnectionError("Discord sent something unexpected")
        link = {"dead": threading.Event(), "why": ""}
        threading.Thread(target=self.reader, args=(pipe, link), daemon=True, name="discord-rpc").start()

        self.login(cid, secret)
        for evt in ("VOICE_SETTINGS_UPDATE", "VOICE_CHANNEL_SELECT"):
            self.call("SUBSCRIBE", evt=evt)
        self.apply_settings(self.call("GET_VOICE_SETTINGS") or {})
        self.load_channel()
        self.status("ready")
        while True:
            self.wake.wait(30)
            self.wake.clear()
            if link["dead"].is_set() or self.pipe is not pipe:
                raise ConnectionError(link["why"] or "Lost the connection to Discord")
            self.load_channel()

    def reader(self, pipe, link):
        try:
            while self.pipe is pipe:
                frame = pipe.recv(1.0)
                if frame is None:
                    continue
                op, msg = frame
                if op == OP_PING:
                    pipe.send(OP_PONG, msg)
                elif op == OP_CLOSE:
                    link["why"] = f"Discord closed the connection: {(msg or {}).get('message')}"
                    break
                elif op == OP_FRAME and isinstance(msg, dict):
                    slot = self.pending.pop(msg.get("nonce"), None) if msg.get("nonce") else None
                    if slot:
                        slot["res"] = msg
                        slot["ev"].set()
                    elif msg.get("cmd") == "DISPATCH":
                        self.on_event(msg.get("evt"), msg.get("data") or {})
        except Exception as e:
            if self.pipe is pipe:
                link["why"] = str(e) or "Lost the connection to Discord"
        finally:
            link["dead"].set()
            self.wake.set()

    def drop(self):
        pipe, self.pipe = self.pipe, None
        if pipe:
            pipe.close()
        for slot in list(self.pending.values()):
            slot["ev"].set()  # res stays None: the caller sees a lost connection
        self.pending.clear()
        self.sub_channel = None
        with self.lock:
            self.st.update(channel=None, user=None)
            self.members, self.speaking = {}, set()

    def call(self, cmd, args=None, evt=None, timeout=5.0):
        pipe = self.pipe
        if pipe is None:
            raise ConnectionError("Not connected to Discord")
        nonce = uuid.uuid4().hex
        slot = self.pending[nonce] = {"ev": threading.Event(), "res": None}
        msg = {"cmd": cmd, "args": args or {}, "nonce": nonce}
        if evt:
            msg["evt"] = evt
        try:
            pipe.send(OP_FRAME, msg)
        except OSError:
            self.pending.pop(nonce, None)
            raise ConnectionError("Lost the connection to Discord")
        if not slot["ev"].wait(timeout):
            self.pending.pop(nonce, None)
            raise TimeoutError(f"Discord didn't answer ({cmd})")
        res = slot["res"]
        if res is None:
            raise ConnectionError("Lost the connection to Discord")
        if res.get("evt") == "ERROR":
            d = res.get("data") or {}
            raise RpcError(d.get("code"), d.get("message") or "error")
        return res.get("data")

    # -------------------------------------------------------------- login
    def login(self, cid, secret):
        tok = self.tokens()
        if tok and tok.get("clientId") == cid:
            if tok.get("expires", 0) - time.time() > 3600:
                try:
                    return self.authenticate(tok["access"])
                except RpcError as e:
                    self.ctx.log.info("discord: the saved login was refused (%s), renewing it", e)
            if tok.get("refresh"):
                try:
                    tok = self.oauth(cid, secret, grant_type="refresh_token", refresh_token=tok["refresh"])
                    return self.authenticate(tok["access"])
                except (AuthError, RpcError) as e:
                    self.ctx.log.info("discord: renewing the login failed (%s), asking Discord again", e)
        self.status("authorize", "Click “Authorize” in Discord to let the widget control it")
        try:
            code = (self.call("AUTHORIZE", {"client_id": cid, "scopes": SCOPES}, timeout=300) or {}).get("code")
        except RpcError as e:
            raise AuthError(f"Discord didn't authorize the widget: {e}")
        except TimeoutError:
            raise AuthError("Nobody clicked “Authorize” in Discord")
        if not code:
            raise AuthError("Discord didn't authorize the widget")
        try:
            tok = self.oauth(cid, secret, grant_type="authorization_code", code=code)
        except ConnectionError as e:
            raise AuthError(str(e))
        try:
            self.authenticate(tok["access"])
        except RpcError as e:
            raise AuthError(f"Discord refused the new login: {e}")

    def authenticate(self, access):
        d = self.call("AUTHENTICATE", {"access_token": access}) or {}
        u = d.get("user") or {}
        with self.lock:
            self.st["user"] = {"id": str(u.get("id") or ""), "name": u.get("global_name") or u.get("username") or ""}

    def oauth(self, cid, secret, **params):
        """Discord's token endpoint: an authorization code or a refresh token -> access + refresh token."""
        body = {"client_id": cid, "client_secret": secret, **params}
        # Discord may or may not want the redirect URL here for RPC codes: try with it (it's registered), then without
        attempts = [dict(body, redirect_uri=REDIRECT), body] if params.get("grant_type") == "authorization_code" else [body]
        for i, b in enumerate(attempts):
            req = urllib.request.Request(TOKEN_URL, data=urllib.parse.urlencode(b).encode("ascii"), method="POST",
                                         headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA})
            try:
                with urllib.request.urlopen(req, timeout=20) as r:
                    j = json.loads(r.read().decode("utf-8"))
                break
            except urllib.error.HTTPError as e:
                try:
                    j = json.loads(e.read().decode("utf-8"))
                except ValueError:
                    j = {}
                if i + 1 < len(attempts) and "redirect" in json.dumps(j).lower():
                    continue
                if j.get("error") == "invalid_client":
                    raise AuthError("Discord says the Client Secret (or Client ID) is wrong. Check them in the widget's settings.")
                raise AuthError(f"Discord refused the login: {j.get('error_description') or j.get('error') or f'HTTP {e.code}'}")
            except urllib.error.URLError as e:
                raise ConnectionError(f"Can't reach discord.com ({e.reason})")
        tok = {"clientId": cid, "access": j["access_token"], "refresh": j.get("refresh_token"),
               "expires": time.time() + int(j.get("expires_in") or 604800)}
        self.save_tokens(tok)
        return tok

    # -------------------------------------------------------------- Discord's state
    def apply_settings(self, d):
        with self.lock:
            for k in ("mute", "deaf"):
                if k in d:
                    self.st[k] = bool(d[k])

    def on_event(self, evt, data):  # runs on the reader thread: no call() here
        if evt == "VOICE_SETTINGS_UPDATE":
            self.apply_settings(data)
        elif evt == "VOICE_CHANNEL_SELECT":
            self.wake.set()  # the session thread reloads the channel and moves the subscriptions
        elif evt in ("VOICE_STATE_CREATE", "VOICE_STATE_UPDATE"):
            m = member(data)
            if m["id"]:
                with self.lock:
                    self.members.setdefault(m["id"], {}).update(m)
        elif evt == "VOICE_STATE_DELETE":
            uid = str((data.get("user") or {}).get("id") or "")
            with self.lock:
                self.members.pop(uid, None)
                self.speaking.discard(uid)
        elif evt in ("SPEAKING_START", "SPEAKING_STOP"):
            uid = str(data.get("user_id") or "")
            with self.lock:
                (self.speaking.add if evt == "SPEAKING_START" else self.speaking.discard)(uid)

    def load_channel(self):
        d = self.call("GET_SELECTED_VOICE_CHANNEL")
        cid = d and d.get("id")
        if cid != self.sub_channel:
            if self.sub_channel:
                for evt in CHANNEL_EVENTS:
                    try:
                        self.call("UNSUBSCRIBE", {"channel_id": self.sub_channel}, evt=evt)
                    except RpcError:
                        pass
                self.sub_channel = None
            if cid:
                for evt in CHANNEL_EVENTS:
                    self.call("SUBSCRIBE", {"channel_id": cid}, evt=evt)
                self.sub_channel = cid
                d = self.call("GET_SELECTED_VOICE_CHANNEL")  # again: nothing missed between reading and subscribing
                cid = d and d.get("id")
        with self.lock:
            if cid != (self.st["channel"] or {}).get("id"):
                self.speaking = set()
            self.st["channel"] = {"id": cid, "name": d.get("name") or "Call", "guildId": d.get("guild_id")} if cid else None
            self.members = {m["id"]: m for m in map(member, d.get("voice_states") or []) if m["id"]} if cid else {}

    # -------------------------------------------------------------- routes: reading
    def state(self, req):
        saved = self.ctx.get(req.id)
        with self.lock:
            st = dict(self.st)
            me = (st.get("user") or {}).get("id")
            members = [dict(m, speaking=m["id"] in self.speaking, me=m["id"] == me) for m in self.members.values()]
        members.sort(key=lambda m: not m["me"])  # you first, then Discord's order
        return {**st, "members": members, "clientId": self.ctx.data.get("clientId") or "",
                "hasSecret": bool(self.ctx.data.get("secret")), "saved": saved is not None,
                "config": saved or self.clean_config({})}

    def avatar(self, req):
        uid = req.query.get("user", "")
        with self.lock:
            h = (self.members.get(uid) or {}).get("avatar")
        if not h or not re.fullmatch(r"(a_)?[0-9a-f]{32}", h):
            raise FileNotFoundError
        key = (uid, h)
        if key not in self.avatars:
            r = urllib.request.Request(f"https://cdn.discordapp.com/avatars/{uid}/{h}.png?size=64", headers={"User-Agent": UA})
            try:
                with urllib.request.urlopen(r, timeout=8) as resp:
                    data = resp.read(300_000)
            except (urllib.error.URLError, TimeoutError):
                raise FileNotFoundError
            if len(self.avatars) > 300:
                self.avatars.clear()
            self.avatars[key] = data
        return self.ctx.Raw(self.avatars[key], "image/png", cache="public, max-age=86400")

    # -------------------------------------------------------------- routes: controls
    def act(self, cmd, args):
        if self.st["status"] != "ready":
            raise UserError("Discord isn't connected")
        try:
            return self.call(cmd, args) or {}
        except RpcError as e:
            raise UserError(f"Discord: {e}")
        except (ConnectionError, TimeoutError) as e:
            raise UserError(str(e))

    @staticmethod
    def flag(req, name="on"):
        v = req.query.get(name)
        return None if v is None else v.lower() in ("1", "true", "on", "yes")

    def voice_reply(self):
        with self.lock:
            return {"ok": True, "mute": self.st["mute"], "deaf": self.st["deaf"]}

    def mute(self, req):
        on = self.flag(req)
        self.apply_settings(self.act("SET_VOICE_SETTINGS", {"mute": (not self.st["mute"]) if on is None else on}))
        return self.voice_reply()

    def deaf(self, req):
        on = self.flag(req)
        self.apply_settings(self.act("SET_VOICE_SETTINGS", {"deaf": (not self.st["deaf"]) if on is None else on}))
        return self.voice_reply()

    def leave(self, req):
        self.act("SELECT_VOICE_CHANNEL", {"channel_id": None})
        self.wake.set()
        return {"ok": True}

    def call_member(self, req):
        uid = req.query.get("user", "")
        if not SNOWFLAKE.fullmatch(uid) or uid not in self.members:
            raise UserError("That person isn't in the call anymore")
        return uid

    def update_member(self, uid, d):
        with self.lock:
            m = self.members.get(uid)
            if m:
                if "volume" in d:
                    m["volume"] = round(d["volume"])
                if "mute" in d:
                    m["mute"] = bool(d["mute"])

    def user_volume(self, req):
        uid = self.call_member(req)
        try:
            vol = max(0, min(200, int(float(req.query.get("volume", "")))))
        except ValueError:
            raise UserError("volume must be a number from 0 to 200")
        self.update_member(uid, self.act("SET_USER_VOICE_SETTINGS", {"user_id": uid, "volume": vol}))
        return {"ok": True}

    def user_mute(self, req):
        uid = self.call_member(req)
        on = self.flag(req)
        if on is None:
            on = not self.members.get(uid, {}).get("mute")
        self.update_member(uid, self.act("SET_USER_VOICE_SETTINGS", {"user_id": uid, "mute": on}))
        return {"ok": True}

    # -------------------------------------------------------------- routes: setup
    def reconnect(self):
        self.blocked, self.restart = False, True
        self.drop()
        self.wake.set()

    def connect(self, req):
        body = req.json({}) or {}
        cid = str(body.get("clientId") or "").strip()
        secret = str(body.get("clientSecret") or "").strip()
        if not SNOWFLAKE.fullmatch(cid):
            raise UserError("The Client ID is the long number on your app's General Information page")
        if secret and not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", secret):
            raise UserError("That doesn't look like a Client Secret")
        with self.ctx.lock:
            d = self.ctx.data
            if not secret and not d.get("secret"):
                raise UserError("Enter the Client Secret too")
            if cid != d.get("clientId"):
                d.pop("tokens", None)
            d["clientId"] = cid
            if secret:
                d["secret"] = seal(secret)
        self.ctx.save_now()
        self.reconnect()
        return {"ok": True}

    def forget(self, req):
        with self.ctx.lock:
            for k in ("clientId", "secret", "tokens"):
                self.ctx.data.pop(k, None)
        self.ctx.save_now()
        self.reconnect()
        return {"ok": True}

    def retry(self, req):
        self.reconnect()
        return {"ok": True}

    # -------------------------------------------------------------- settings
    def clean_config(self, cfg):
        def b(key, default):
            return bool(cfg.get(key, default))
        return {
            "title": str(cfg.get("title") or "")[:40],
            "showDeafen": b("showDeafen", True),
            "showLeave": b("showLeave", True),
            "confirmLeave": b("confirmLeave", True),
            "showMembers": b("showMembers", True),
            "showSelf": b("showSelf", False),
            "maxVolume": 100 if cfg.get("maxVolume") == 100 else 200,
            "layout": cfg.get("layout") if cfg.get("layout") in ("rows", "cols", "tiles") else "rows",
            "color": cfg["color"].lower() if isinstance(cfg.get("color"), str) and HEX.fullmatch(cfg["color"]) else "#5865f2",
        }


def setup(ctx):
    return Plugin(ctx)
