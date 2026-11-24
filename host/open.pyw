"""Opens the PhoneBox Widgets setup page; starts the host first if it isn't running.

The Start Menu entry "PhoneBox Widgets" (made by install.cmd) runs this with pythonw, so no window appears.
    pythonw open.pyw            start the host if needed, then open http://127.0.0.1:8766/
    pythonw open.pyw --check    start the host if needed, don't open a browser (exit code 0 = host is up)
"""
import os
import subprocess
import sys
import time
import urllib.request
import webbrowser

PORT = int(os.environ.get("PBW_PORT", "8766"))
URL = f"http://127.0.0.1:{PORT}/"
HERE = os.path.dirname(os.path.abspath(__file__))


def up() -> bool:
    try:
        with urllib.request.urlopen(URL + "api/ping", timeout=1.5) as r:
            return r.status == 200
    except Exception:
        return False


def main():
    if not up():
        pythonw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
        exe = pythonw if os.path.isfile(pythonw) else sys.executable
        flags = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED_PROCESS | NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        # through the launcher when install.cmd built it: the host then shows as "PhoneBox Widgets" in Task Manager
        launcher = os.path.join(HERE, "launcher", "PhoneBoxWidgets.exe")
        cmd = [launcher, exe] if os.path.isfile(launcher) else [exe, os.path.join(HERE, "server.py")]
        subprocess.Popen(cmd, cwd=HERE, creationflags=flags, close_fds=True)
        for _ in range(40):  # up to 10 s
            time.sleep(0.25)
            if up():
                break
    ok = up()
    if "--check" not in sys.argv:
        if ok:
            webbrowser.open(URL)
        else:  # pythonw has no console: say so in a message box
            import ctypes
            log = os.path.join(os.environ.get("APPDATA", ""), "PhoneBoxWidgets", "host.log")
            ctypes.windll.user32.MessageBoxW(None, f"The PhoneBox Widgets host did not start.\n\nSee {log}\nor run dev.cmd to see the error.",
                                             "PhoneBox Widgets", 0x30)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
