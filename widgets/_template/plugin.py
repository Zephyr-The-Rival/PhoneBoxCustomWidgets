"""__NAME__ widget, PC side.

Optional: a widget without plugin.py works too (settings are then stored as sent). Use this file for
  * META             how the widget shows up on the setup page
  * clean_config()   validate / fill in the settings the widget saves (never trust what comes in)
  * routes           your own API: "GET name" / "POST name" -> handler(req), served at /api/w/__TYPE__/<name>
                     req.id (widget id), req.query (dict), req.json() (POST body); return a dict (sent as JSON),
                     or raise ctx.UserError("message") for a 400 the widget shows
  * start()          a background loop, if the widget needs one (runs in its own thread)
The ctx you get in setup() is documented at the top of host/pbw.py (settings, agent access, adb, battery, ...).
"""
import os
import time

META = {
    "name": "__NAME__",
    "icon": "puzzle",  # a Lucide icon name (host/icons)
    "description": "Describe what __NAME__ shows.",
    "size": [4, 2],  # default preview size on the setup page, in PhoneBox grid cells
}


class Plugin:
    def __init__(self, ctx):
        self.ctx = ctx
        self.routes = {
            "GET hello": self.hello,
        }

    def clean_config(self, cfg):
        text = str(cfg.get("text") or "Hello from the PC")[:200]
        color = cfg.get("color") if isinstance(cfg.get("color"), str) and len(cfg["color"]) == 7 else "#2dd4bf"
        return {"text": text, "color": color}

    def hello(self, req):
        # an example of data only the PC has
        return {"pc": os.environ.get("COMPUTERNAME", "PC"), "time": time.strftime("%H:%M:%S"), "id": req.id}


def setup(ctx):
    return Plugin(ctx)
