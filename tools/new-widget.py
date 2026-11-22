"""Creates a new widget from widgets/_template.

    python tools/new-widget.py "Weather Mini"      -> widgets/weather-mini/ (type "weather-mini")

Then restart the host (dev.cmd while developing, or install.cmd) and open http://127.0.0.1:8766/.
"""
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    name = " ".join(sys.argv[1:]).strip()
    wtype = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:32]
    if not wtype or not wtype[0].isalnum():
        sys.exit("Use a name with letters or digits.")
    target = os.path.join(ROOT, "widgets", wtype)
    if os.path.exists(target):
        sys.exit(f"widgets/{wtype} already exists.")
    shutil.copytree(os.path.join(ROOT, "widgets", "_template"), target)
    for fn in os.listdir(target):
        path = os.path.join(target, fn)
        with open(path, encoding="utf-8") as f:
            text = f.read()
        # CSS classes and JS strings use the type; the setup page shows the name
        text = text.replace("__TYPE__", wtype).replace("__NAME__", name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
    print(f"Created widgets/{wtype}/ (plugin.py + widget.js).")
    print("Restart the host (dev.cmd or install.cmd), then open http://127.0.0.1:8766/?type=" + wtype)


if __name__ == "__main__":
    main()
