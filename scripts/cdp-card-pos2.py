# Real OS cursor parked on the rail + CDP mouseenter on the slot → card shows
# and STAYS because the hover watch sees the real cursor inside the rail.
import json, urllib.request, websocket, time, ctypes
from ctypes import wintypes

user32 = ctypes.windll.user32

def setpos(x, y):
    user32.SetCursorPos(x, y)

targets = json.load(urllib.request.urlopen("http://localhost:9222/json", timeout=5))
panel = next(t for t in targets if 'panel.html' in t['url'])
ws = websocket.create_connection(panel['webSocketDebuggerUrl'], timeout=8, suppress_origin=True)
_id = [0]

def cmd(method, params=None):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": method, "params": params or {}}))
    while True:
        m = json.loads(ws.recv())
        if m.get('id') == _id[0]:
            return m.get('result', {})

def ev(expr):
    r = cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True})
    return r.get('result', {}).get('value')

def mm(x, y):
    cmd("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none", "buttons": 0})

# park the OS cursor over the rail's ring (screen coords)
setpos(1248, 335)
time.sleep(0.4)
cls = ev("document.body.className") or ""
print("cls:", cls)
if 'collapsed' in cls:
    mm(4, 40)
    time.sleep(1.0)
mm(31, 41)
print("hover fired; card window should now be alive while cursor is on rail")
ws.close()
