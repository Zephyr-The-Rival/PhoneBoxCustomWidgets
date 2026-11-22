"""PhoneBox Widgets host.

One small local service (Python standard library only) for all custom PhoneBox widgets. PhoneBox runs "Custom HTML"
widgets in a sandbox that cannot reach the PhoneBox agent; this host is their back end:

  * loads every widget from ../widgets/<type>/ (plugin.py for the PC side, widget.js for the tablet side),
  * serves the widget code (/widget/<type>.js = sdk.js + the widget) and the setup page (http://127.0.0.1:8766/),
  * stores each widget's settings (%APPDATA%\\PhoneBoxWidgets\\config.json),
  * shared services for widgets: tablet battery (adb), PC fonts, PhoneBox agent access,
  * keeps "adb reverse tcp:8766 tcp:8766" in place so the tablet reaches it over USB.

Run:  pythonw server.py     (install.cmd sets this up to start with Windows; dev.cmd runs it with a console)
"""
from __future__ import annotations

import importlib.util
import json
import logging
import logging.handlers
import os
import re
import sys
import threading
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HOST_DIR)
WIDGETS_DIR = os.path.join(ROOT, "widgets")
sys.path.insert(0, HOST_DIR)  # plugins import the "pbw" helper module

import pbw  # noqa: E402  (shared helpers: logging, store, agent, adb, fonts, phone)
from pbw import UserError, log  # noqa: E402

PORT = pbw.PORT
ID_RE = re.compile(r"[A-Za-z0-9_-]{1,32}")
TYPE_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,31}")


# ------------------------------------------------------------------------------------------------ plugins
class Widget:
    """One widget type: widgets/<type>/plugin.py (optional) + widgets/<type>/widget.js."""

    def __init__(self, wtype: str, folder: str):
        self.type, self.folder = wtype, folder
        self.meta = {"name": wtype.capitalize(), "icon": "🧩", "description": "", "size": [4, 3]}
        self.plugin = None
        self.routes: dict[str, tuple[str, callable]] = {}
        path = os.path.join(folder, "plugin.py")
        if os.path.isfile(path):
            spec = importlib.util.spec_from_file_location(f"pbw_widget_{wtype.replace('-', '_')}", path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            self.meta.update(getattr(mod, "META", {}))
            if hasattr(mod, "setup"):
                self.plugin = mod.setup(pbw.Context(wtype))
            if self.plugin is not None:
                for name, value in (getattr(self.plugin, "routes", None) or {}).items():
                    method, _, rname = name.partition(" ")
                    self.routes[rname] = (method.upper(), value)

    @property
    def script(self) -> str:
        return os.path.join(self.folder, "widget.js")

    def clean(self, cfg) -> dict:
        if not isinstance(cfg, dict):
            raise UserError("settings must be an object")
        if self.plugin is not None and hasattr(self.plugin, "clean_config"):
            return self.plugin.clean_config(cfg)
        if len(json.dumps(cfg)) > 64_000:
            raise UserError("settings are too large")
        return cfg

    def describe(self) -> dict:
        return {"type": self.type, **self.meta}


def load_widgets() -> dict[str, Widget]:
    found = {}
    for name in sorted(os.listdir(WIDGETS_DIR)):
        folder = os.path.join(WIDGETS_DIR, name)
        if name.startswith(("_", ".")) or not os.path.isfile(os.path.join(folder, "widget.js")):
            continue  # _template and friends
        if not TYPE_RE.fullmatch(name):
            log.warning("skipping widget folder %r: use lowercase letters, digits and -", name)
            continue
        try:
            found[name] = Widget(name, folder)
            log.info("widget %s loaded", name)
        except Exception:
            log.exception("widget %s failed to load", name)
    return found


WIDGETS: dict[str, Widget] = {}


# ------------------------------------------------------------------------------------------------ HTTP
ALLOWED_ORIGINS = {"null", f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"}
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}


class Request:
    """What a plugin route handler gets."""

    def __init__(self, handler: "Handler", query: dict, body: bytes):
        self.query, self.body, self._h = query, body, handler
        wid = query.get("id", "main")
        self.id = wid if ID_RE.fullmatch(wid) else "main"

    def json(self, default=None):
        try:
            return json.loads(self.body.decode("utf-8") or "null") or default
        except ValueError:
            raise UserError("the request body is not valid JSON")


class Handler(BaseHTTPRequestHandler):
    server_version = "PhoneBoxWidgets/2.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet unless PBW_DEBUG=1
        if os.environ.get("PBW_DEBUG"):
            log.info("%s %s", self.headers.get("Origin") if self.headers else "-", fmt % args)

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            self.close_connection = True  # the tablet left mid-request (page switch, screen off)

    # -------------------------------------------------------------- plumbing
    def guard(self) -> bool:
        # Only widgets (sandboxed frames: Origin "null") and the setup page may use the host; the Host check stops
        # DNS-rebinding pages.
        origin = self.headers.get("Origin")
        if self.headers.get("Host") not in ALLOWED_HOSTS or (origin is not None and origin not in ALLOWED_ORIGINS):
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return False
        return True

    def cors(self):
        origin = self.headers.get("Origin")
        self.send_header("Access-Control-Allow-Origin", origin if origin in ALLOWED_ORIGINS else "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Vary", "Origin")

    def reply(self, code, body, ctype="application/json; charset=utf-8", cache="no-store"):
        raw = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", cache)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(raw)

    def do_OPTIONS(self):
        if not self.guard():
            return
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def dispatch(self, method):
        if not self.guard():
            return
        u = urllib.parse.urlsplit(self.path)
        query = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        body = b""
        if method == "POST":
            body = self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 512_000))
        try:
            self.route(method, u.path, Request(self, query, body))
        except UserError as e:
            self.reply(400, {"error": str(e)})
        except FileNotFoundError:
            self.reply(404, {"error": "not found"})
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            raise
        except Exception as e:
            log.error("%s %s failed:\n%s", method, u.path, traceback.format_exc())
            self.reply(500, {"error": f"{e.__class__.__name__}: {e}"})

    # -------------------------------------------------------------- routes
    def route(self, method, path, req: Request):
        store = pbw.STORE
        if method == "GET" and path in ("/", "/setup"):
            return self.reply(200, read(os.path.join(HOST_DIR, "setup.html")), "text/html; charset=utf-8")
        if method == "GET" and path == "/sdk.js":
            return self.reply(200, read(os.path.join(HOST_DIR, "sdk.js")), "text/javascript; charset=utf-8")
        # the widget code: the SDK and the widget in one script, read from disk on every load (edit, reload, done)
        m = re.fullmatch(r"/widget/([a-z0-9-]+)\.js", path)
        if method == "GET" and (m or path == "/widget.js"):  # /widget.js: the first Volume Slider snippet
            w = WIDGETS.get(m.group(1) if m else "volume")
            if not w:
                raise FileNotFoundError
            code = icons_js() + read(os.path.join(HOST_DIR, "sdk.js")) + b"\n;\n" + read(w.script)
            return self.reply(200, code, "text/javascript; charset=utf-8")
        if method == "GET" and path == "/api/ping":
            return self.reply(200, {"ok": True})
        if method == "GET" and path == "/api/icons":
            return self.reply(200, {"icons": icons()})
        if method == "GET" and path == "/api/types":
            return self.reply(200, {"types": [w.describe() for w in WIDGETS.values()]})
        if method == "GET" and path == "/api/phone/battery":
            return self.reply(200, pbw.PHONE.battery() or {"available": False})
        if method == "GET" and path == "/api/fonts":
            return self.reply(200, {"fonts": pbw.FONTS.list()})
        m = re.fullmatch(r"/fonts/([a-z0-9_.-]+)", path)
        if method == "GET" and m:
            data, ctype = pbw.FONTS.file(m.group(1))
            return self.reply(200, data, ctype, cache="public, max-age=604800")

        m = re.fullmatch(r"/api/w/([a-z0-9-]+)/(.+)", path)
        if not m or m.group(1) not in WIDGETS:
            raise FileNotFoundError
        w, name = WIDGETS[m.group(1)], m.group(2)
        # settings of one widget instance, for every widget type
        if name == "instances" and method == "GET":
            return self.reply(200, {"instances": sorted(store.instances(w.type))})
        if name == "config" and method == "GET":
            cfg = store.get(w.type, req.id)
            return self.reply(200, {"id": req.id, "saved": cfg is not None, "config": cfg})
        if name == "config" and method == "POST":
            cfg = w.clean(req.json({}))
            store.put(w.type, req.id, cfg)
            return self.reply(200, {"id": req.id, "saved": True, "config": cfg})
        if name == "delete" and method == "POST":
            store.delete(w.type, req.id)
            return self.reply(200, {"ok": True, "instances": sorted(store.instances(w.type))})
        # the widget's own routes (plugin.py: routes = {"GET state": handler, ...})
        route = w.routes.get(name)
        if not route or route[0] != method:
            raise FileNotFoundError
        result = route[1](req)
        if isinstance(result, pbw.Raw):
            return self.reply(result.status, result.data, result.ctype, cache=result.cache)
        if isinstance(result, tuple):
            return self.reply(result[0], result[1])
        return self.reply(200, result if result is not None else {"ok": True})


def read(path) -> bytes:
    with open(path, "rb") as f:
        return f.read()


# ------------------------------------------------------------------------------------------------ icons
ICON_DIR = os.path.join(HOST_DIR, "icons")


def icons() -> dict:
    """Lucide icons (ISC license, see icons/LICENSE), the set PhoneBox itself uses: {name: inner SVG markup}.
    Add one by dropping its .svg from https://lucide.dev into host/icons/."""
    out = {}
    for fn in sorted(os.listdir(ICON_DIR)):
        if fn.endswith(".svg"):
            m = re.search(r"<svg[^>]*>(.*)</svg>", read(os.path.join(ICON_DIR, fn)).decode("utf-8"), re.S)
            if m:
                out[fn[:-4]] = re.sub(r"\s+", " ", m.group(1)).strip()
    return out


def icons_js() -> bytes:
    return ("window.PBW_ICONS = " + json.dumps(icons(), separators=(",", ":")) + ";\n").encode("utf-8")


def main():
    WIDGETS.update(load_widgets())
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as e:
        log.error("port %s is busy (is the host already running?): %s", PORT, e)
        sys.exit(1)
    server.daemon_threads = True
    pbw.start_services()
    for w in WIDGETS.values():
        if w.plugin is not None and hasattr(w.plugin, "start"):
            threading.Thread(target=w.plugin.start, daemon=True, name=f"widget-{w.type}").start()
    log.info("PhoneBox Widgets host on http://127.0.0.1:%s (%s)", PORT, ", ".join(WIDGETS) or "no widgets")
    try:
        server.serve_forever()
    finally:
        pbw.STORE.flush(force=True)


if __name__ == "__main__":
    main()
