# Fire slot mouseenter then immediately report card window visibility+position.
import json, urllib.request, websocket, time, ctypes, subprocess, re
from ctypes import wintypes

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

cls = ev("document.body.className") or ""
print("start:", cls)
if 'collapsed' in cls:
    mm(4, 40); time.sleep(1.0)
    print("expanded:", ev("document.body.className"))
mm(31, 41)
# poll EnumWindows rapidly for the card window while it should be up
for i in range(10):
    time.sleep(0.25)
    out = subprocess.run([
        "powershell", "-NoProfile", "-Command",
        "Add-Type -AssemblyName System.Runtime.InteropServices;"  # placeholder
    ], capture_output=True, text=True)
    break
# simpler: use the card target's reported bounds via CDP Browser.getWindowForTarget
t2 = json.load(urllib.request.urlopen("http://localhost:9222/json", timeout=5))
card = next(t for t in t2 if 'card.html' in t['url'])
ws2 = websocket.create_connection(card['webSocketDebuggerUrl'], timeout=8, suppress_origin=True)
ws2.send(json.dumps({"id": 50, "method": "Browser.getWindowForTarget"}))
while True:
    m = json.loads(ws2.recv())
    if m.get('id') == 50:
        print("card window bounds:", m.get('result'))
        break
ws2.send(json.dumps({"id": 51, "method": "Runtime.evaluate", "params": {
    "expression": "JSON.stringify({vis: document.visibilityState, title: document.getElementById('htitle').textContent, h: document.getElementById('card').offsetHeight})",
    "returnByValue": True}}))
while True:
    m = json.loads(ws2.recv())
    if m.get('id') == 51:
        print("card page:", m.get('result', {}).get('result', {}).get('value'))
        break
ws.close(); ws2.close()
