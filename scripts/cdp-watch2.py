# Clean sequence: instrument, move cursor out, wait, move onto rail, log events.
import json, urllib.request, websocket, time
import ctypes

SetCursorPos = ctypes.windll.user32.SetCursorPos
GetCursorPos = ctypes.windll.user32.GetCursorPos

class PT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

def cursor():
    p = PT(); GetCursorPos(ctypes.byref(p)); return (p.x, p.y)

targets = json.load(urllib.request.urlopen("http://localhost:9222/json", timeout=5))
panel = next(t for t in targets if 'panel.html' in t['url'])
card_t = next(t for t in targets if 'card.html' in t['url'])
ws = websocket.create_connection(panel['webSocketDebuggerUrl'], timeout=8, suppress_origin=True)
ws2 = websocket.create_connection(card_t['webSocketDebuggerUrl'], timeout=8, suppress_origin=True)
_id = [0]

def ev(expr, sock=None):
    sock = sock or ws
    _id[0] += 1
    sock.send(json.dumps({"id": _id[0], "method": "Runtime.evaluate",
                          "params": {"expression": expr, "returnByValue": True}}))
    while True:
        m = json.loads(sock.recv())
        if m.get('id') == _id[0]:
            return m.get('result', {}).get('result', {}).get('value')

ev("""
window.__log = [];
const _s = window.pulse.send.bind(window.pulse);
window.pulse.send = (ch, ...a) => { window.__log.push((performance.now()|0) + ' send ' + ch + ' ' + JSON.stringify(a)); return _s(ch, ...a); };
const _on = window.pulse.on.bind(window.pulse);
window.pulse.on = (ch, cb) => _on(ch, (...a) => { window.__log.push((performance.now()|0) + ' recv ' + ch + ' ' + JSON.stringify(a).slice(0,120)); return cb(...a); });
document.querySelector('#rail').addEventListener('mouseenter', () => window.__log.push((performance.now()|0) + ' rail mouseenter'));
'armed'""")

print("cursor ->", cursor())
SetCursorPos(500, 500)   # off the rail
time.sleep(1.5)
print("t0 off-rail; cls =", ev("document.body.className"))
SetCursorPos(1277, 333)  # onto sliver/rail edge
time.sleep(0.9)
print("t+0.9 after edge; cls =", ev("document.body.className"), "cursor", cursor())
SetCursorPos(1248, 333)  # into the slot
for i in range(6):
    time.sleep(1)
    print(f"t+{i+2}s cls =", ev("document.body.className"), "card title =", ev("document.getElementById('htitle').textContent", ws2))

print("--- log ---")
for line in (ev("window.__log") or []):
    print(line)
ws.close(); ws2.close()
