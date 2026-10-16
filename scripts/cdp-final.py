# Final acceptance: toggle panel on, hover the slot via CDP input, report.
import json, urllib.request, websocket, time, ctypes
from ctypes import wintypes

user32 = ctypes.windll.user32

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
    if 'exceptionDetails' in r:
        return 'EXC:' + json.dumps(r['exceptionDetails'], ensure_ascii=False)[:300]
    return r.get('result', {}).get('value')

def mm(x, y):
    cmd("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none", "buttons": 0})

print("visible-ish check: cls =", ev("document.body.className"))
# panel:toggle to show if hidden
ev("window.pulse.send('panel:toggle')")
time.sleep(1.0)
print("after toggle cls:", ev("document.body.className"))
cls = ev("document.body.className") or ""
if 'collapsed' in cls:
    mm(4, 40)
    time.sleep(1.0)
    print("after sliver:", ev("document.body.className"))
mm(31, 41)
time.sleep(1.2)
print("after slot hover cls:", ev("document.body.className"))
ws.close()
