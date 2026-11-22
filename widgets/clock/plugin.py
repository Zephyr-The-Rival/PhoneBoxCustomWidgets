"""Clock widget, PC side: only validates the settings. Time and date come from the tablet itself; the battery comes
from the host's shared service (/api/phone/battery)."""
import re

META = {
    "name": "Clock",
    "icon": "clock",
    "description": "Time, date and the tablet's battery; drag, resize and restyle every part right on the widget.",
    "size": [4, 3],
}

HEX = re.compile(r"#[0-9a-fA-F]{6}")
DATE_FORMATS = ("weekday-long", "long", "short", "numeric", "iso", "weekday")
WEIGHTS = (200, 300, 400, 500, 600, 700, 800, 900)

DEFAULTS = {
    "time": {"show": True, "x": 50, "y": 40, "size": 42, "font": "", "color": "#eef2f6", "weight": 600,
             "h24": True, "seconds": False, "blink": False},
    "date": {"show": True, "x": 50, "y": 72, "size": 11, "font": "", "color": "#8a94a3", "weight": 500,
             "format": "weekday-long", "upper": False},
    "battery": {"show": True, "x": 50, "y": 88, "size": 9, "font": "", "color": "#8a94a3", "weight": 500,
                "icon": True, "percent": True},
}


def _num(v, lo, hi, default):
    return max(lo, min(hi, float(v))) if isinstance(v, (int, float)) and not isinstance(v, bool) else default


def clean_element(name, e):
    d = DEFAULTS[name]
    e = e if isinstance(e, dict) else {}
    out = {
        "show": bool(e.get("show", d["show"])),
        "x": round(_num(e.get("x"), 0, 100, d["x"]), 2),
        "y": round(_num(e.get("y"), 0, 100, d["y"]), 2),
        "size": round(_num(e.get("size"), 2, 120, d["size"]), 2),
        "font": str(e.get("font") or "")[:120],
        "color": e["color"].lower() if isinstance(e.get("color"), str) and HEX.fullmatch(e["color"]) else d["color"],
        "weight": e.get("weight") if e.get("weight") in WEIGHTS else d["weight"],
    }
    for k, v in d.items():  # the element's own options (booleans and the date format)
        if k in out:
            continue
        if isinstance(v, bool):
            out[k] = bool(e.get(k, v))
        elif k == "format":
            out[k] = e.get(k) if e.get(k) in DATE_FORMATS else v
    return out


class Plugin:
    routes = {}

    def clean_config(self, cfg):
        bg = cfg.get("background")
        return {
            "elements": {name: clean_element(name, (cfg.get("elements") or {}).get(name)) for name in DEFAULTS},
            "background": bg.lower() if isinstance(bg, str) and HEX.fullmatch(bg) else "",
        }


def setup(ctx):
    return Plugin()
