"""Clipboard widget, PC side: Windows' clipboard history (Win+V) on the tablet; tapping an entry pastes it.

Reading the history and picking an entry are Windows Runtime APIs, which Python's standard library can't call, so
this keeps one small PowerShell process running (helper.ps1) and asks it over stdin / stdout. Pasting is Ctrl+V,
pressed by this process with keybd_event, into whatever window is active on the PC. Windows doesn't let normal
programs send keys to admin windows, so pasting there doesn't work.

Copied files: Win+V doesn't keep them, so this watches the clipboard and remembers the last FILE_ENTRIES file copies
itself (their paths, in the widget's data in config.json; never the files). Tapping one puts the same files on the
clipboard again (as a copy) and presses Ctrl+V. Previews are Explorer's thumbnails, made by the helper.

Clipboard text is never logged or stored by the host; it only goes to the widget that asks.
"""
import base64
import ctypes
import json
import os
import queue
import re
import subprocess
import threading
import time
import uuid

import pbw
from pbw import UserError

META = {
    "name": "Clipboard",
    "icon": "clipboard",
    "description": "Your clipboard history (Win+V). Tap an entry and it's pasted into the active window on the PC.",
    "size": [4, 5],
}
HELPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "helper.ps1")
ITEM_ID = re.compile(r"[A-Za-z0-9{}:-]{1,80}")  # Windows' ids, or "f:<id>" for a file copy
FILE_ENTRIES = 25
THUMBS_KEPT = 300

user32 = ctypes.WinDLL("user32")
user32.GetClipboardSequenceNumber.restype = ctypes.c_uint32
user32.MapVirtualKeyW.restype = ctypes.c_uint
VK_CONTROL, VK_V, KEYEVENTF_KEYUP = 0x11, 0x56, 0x2


def b64(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def press_ctrl_v():
    for vk, flags in ((VK_CONTROL, 0), (VK_V, 0), (VK_V, KEYEVENTF_KEYUP), (VK_CONTROL, KEYEVENTF_KEYUP)):
        user32.keybd_event(vk, user32.MapVirtualKeyW(vk, 0), flags, 0)


class Helper:
    """The PowerShell process (started on first use, restarted if it dies or hangs)."""

    def __init__(self, log):
        self.log = log
        self.proc = None
        self.lines = None
        self.lock = threading.Lock()

    def _start(self):
        self.proc = subprocess.Popen(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", HELPER],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=pbw.NO_WINDOW)
        self.lines = queue.Queue()

        def pump(proc, lines):
            for line in proc.stdout:
                lines.put(line)
            lines.put(None)
        threading.Thread(target=pump, args=(self.proc, self.lines), daemon=True, name="clipboard-helper").start()

    def close(self):
        p, self.proc = self.proc, None
        if p:
            try:
                p.kill()
            except OSError:
                pass

    def ask(self, cmd: str, timeout=8) -> dict:
        with self.lock:
            for _ in range(2):
                fresh = not self.proc or self.proc.poll() is not None
                if fresh:
                    self._start()
                try:
                    self.proc.stdin.write((cmd + "\n").encode("utf-8"))
                    self.proc.stdin.flush()
                    line = self.lines.get(timeout=max(20, timeout) if fresh else timeout)  # PowerShell takes a moment to start
                except (OSError, queue.Empty):
                    line = None
                if line:
                    return json.loads(line.decode("utf-8-sig"))
                self.log.warning("clipboard helper didn't answer; restarting it")
                self.close()  # a late answer must not be taken for the next command's
        raise UserError("The clipboard helper isn't answering")


class Plugin:
    def __init__(self, ctx):
        self.ctx = ctx
        self.helper = Helper(ctx.log)
        self._hist, self._seq, self._at = None, None, 0.0
        self._lock = threading.Lock()
        self._thumbs: dict[tuple, tuple] = {}  # key -> (bytes, mime)
        self.routes = {"GET state": self.state, "POST paste": self.paste, "POST settings": self.open_settings,
                       "GET thumb": self.thumb}

    # -------------------------------------------------------------- watching for file copies
    def start(self):
        """Win+V doesn't keep copied files: notice them here, whether or not a widget is looking."""
        seq = None
        while True:
            time.sleep(0.4)
            try:
                now = user32.GetClipboardSequenceNumber()
                if now == seq:
                    continue
                seq = now
                files = self.helper.ask("current").get("files")
                if files:
                    self.remember_files([str(f) for f in files])
            except Exception as e:  # never let the watcher die
                self.ctx.log.debug("clipboard watch: %s", e)

    def file_entries(self) -> list:
        return self.ctx.data.setdefault("files", [])

    def remember_files(self, paths):
        with self.ctx.lock:
            entries = self.file_entries()
            same = next((e for e in entries if e["paths"] == paths), None)
            if same:  # copied again (or pasted from the widget): to the top, like Win+V does
                entries.remove(same)
            entry = same or {"id": uuid.uuid4().hex[:12], "paths": paths}
            entry["time"] = int(time.time() * 1000)
            entries.insert(0, entry)
            del entries[FILE_ENTRIES:]
        self.ctx.changed()
        self._at = 0

    def find_files(self, item):
        return next((e for e in self.file_entries() if "f:" + e["id"] == item), None)

    # -------------------------------------------------------------- reading
    def history(self):
        """The history, re-read when the clipboard changed, or every few seconds (deleting in Win+V doesn't count
        as a change)."""
        with self._lock:
            seq = user32.GetClipboardSequenceNumber()
            if self._hist is None or seq != self._seq or time.time() - self._at > 4:
                self._hist, self._seq, self._at = self.helper.ask("list"), seq, time.time()
            return self._hist

    def state(self, req):
        cfg = self.ctx.get(req.id) or self.clean_config({})
        try:
            h = self.history()
        except UserError as e:
            return {"ok": False, "error": str(e), "config": cfg}
        if h.get("error"):
            return {"ok": False, "error": h["error"], "config": cfg}
        items = list(h.get("items") or [])
        for e in list(self.file_entries()):
            items.append({"id": "f:" + e["id"], "kind": "filelist", "time": e["time"],
                          "files": [{"name": os.path.basename(p.rstrip("\\")) or p, "exists": os.path.exists(p)}
                                    for p in e["paths"]]})
        items.sort(key=lambda it: it.get("time") or 0, reverse=True)
        return {"ok": True, "enabled": bool(h.get("enabled")), "items": items, "config": cfg}

    def thumb(self, req):
        """A preview: Explorer's thumbnail of a copied file (?f=<entry>&i=<n>), or an image entry (?item=<id>)."""
        if "item" in req.query:
            item = req.query["item"]
            if not ITEM_ID.fullmatch(item) or item.startswith("f:"):
                raise FileNotFoundError
            key, cmd = ("h", item), "image " + item
        else:
            entry = self.find_files("f:" + req.query.get("f", ""))
            try:
                path = entry["paths"][int(req.query.get("i", "0"))]
                key = ("f", path, os.stat(path).st_mtime)
            except (TypeError, ValueError, IndexError, OSError):
                raise FileNotFoundError
            cmd = "thumb " + b64(path)
        if key not in self._thumbs:
            r = self.helper.ask(cmd, timeout=25)  # Windows may have to make the thumbnail first
            if not r.get("ok"):
                raise FileNotFoundError
            if len(self._thumbs) >= THUMBS_KEPT:
                self._thumbs.clear()
            self._thumbs[key] = (base64.b64decode(r["data"]), r.get("mime") or "image/png")
        data, mime = self._thumbs[key]
        return self.ctx.Raw(data, mime, cache="public, max-age=86400")

    # -------------------------------------------------------------- pasting
    def paste(self, req):
        item = req.query.get("item", "")
        if not ITEM_ID.fullmatch(item):
            raise UserError("bad entry")
        if item.startswith("f:"):
            entry = self.find_files(item)
            if not entry:
                raise UserError("That entry is gone")
            paths = [p for p in entry["paths"] if os.path.exists(p)]
            if not paths:
                raise UserError("Those files don't exist anymore")
            r = self.helper.ask("setfiles " + b64(json.dumps(paths)))
        else:
            r = self.helper.ask("set " + item)
        if not r.get("ok"):
            raise UserError(r.get("error") or f"Windows didn't take that entry ({r.get('status')})")
        if req.query.get("copy") != "1":  # copy=1 (holding the entry): only make it the clipboard content
            time.sleep(0.08)  # let the new clipboard content settle before the target app reads it
            press_ctrl_v()
        self._at = 0  # the entry moved to the top: read the list again
        return {"ok": True}

    def open_settings(self, req):
        os.startfile("ms-settings:clipboard")  # where clipboard history is switched on
        return {"ok": True}

    def clean_config(self, cfg):
        lines = cfg.get("lines")
        return {
            "title": str(cfg.get("title") or "")[:40],
            "lines": lines if lines in (1, 2, 3, 4) else 2,
            "showTime": bool(cfg.get("showTime", True)),
        }


def setup(ctx):
    return Plugin(ctx)
