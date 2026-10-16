# Full timeline probe: instrument panel sends, drive cursor, sample both pages.
import json, urllib.request, websocket, time, ctypes
from ctypes import wintypes

user32 = ctypes.windll.user32

def setpos(x, y):
    user32.SetCursorPos(x, y)

def cursor():
    p = wintypes.POINT(); user32.GetCursorPos(ctypes.byref(p)); return (p.x, p.y)

targets = json.load(urllib.request.urlopen("http://localhost:9222/json", timeout=5))
panel = next(t for t in targets if 'panel.html' in t['url'])
ws = websocket.create_connection(panel['webSocketDebuggerUrl'], timeout=8, suppress_origin=True)
_id = [0]

def ev(expr):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": "Runtime.evaluate",
                        "params": {"expression": expr, "returnByValue": True}}))
    while True:
        m = json.loads(ws.recv())
        if m.get('id') == _id[0]:
            r = m.get('result', {})
            if 'exceptionDetails' in r:
                return 'EXC:' + json.dumps(r['exceptionDetails'], ensure_ascii=False)[:300]
            return r.get('result', {}).get('value')

# wrap send + record slot events
ev("""
window.__log = [];
const t0 = performance.now();
window.__t0 = t0;
const _s = window.pulse.send.bind(window.pulse);
window.pulse.send = (ch, ...a) => { window.__log.push(((performance.now()-t0)|0) + ' SEND ' + ch + ' ' + JSON.stringify(a)); return _s(ch, ...a); };
const _on = window.pulse.on.bind(window.pulse);
window.pulse.on = (ch, cb) => _on(ch, (...a) => { window.__log.push(((performance.now()-t0)|0) + ' RECV ' + ch); return cb(...a); });
document.querySelectorAll('.slot').forEach(s => {
  s.addEventListener('mouseenter', () => window.__log.push(((performance.now()-t0)|0) + ' SLOT enter ' + s.dataset.account));
  s.addEventListener('mouseleave', () => window.__log.push(((performance.now()-t0)|0) + ' SLOT leave'));
});
document.getElementById('sliver').addEventListener('mouseenter', () => window.__log.push(((performance.now()-t0)|0) + ' SLIVER enter'));
document.getElementById('rail').addEventListener('mouseleave', () => window.__log.push(((performance.now()-t0)|0) + ' RAIL leave'));
document.getElementById('rail').addEventListener('mouseenter', () => window.__log.push(((performance.now()-t0)|0) + ' RAIL enter'));
'armed'
""")

time.sleep(0.3)
print("start cls:", ev("document.body.className"), "cursor:", cursor())
setpos(400, 500)
time.sleep(1.2)
setpos(1277, 333)
time.sleep(0.9)
print("after edge cls:", ev("document.body.className"), "cursor:", cursor())
setpos(1250, 335)
for i in range(7):
    time.sleep(0.8)
    print(f"+{i}: cls =", ev("document.body.className"), "| cursor:", cursor())
print("--- log ---")
for l in (ev("window.__log") or []):
    print(l)
ws.close()
