# Watch the rail's collapse state over ~15s while probing card window visibility.
import json, urllib.request, websocket, time, subprocess

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
            return r.get('result', {}).get('value')

# instrument: log every collapse signal
print(ev("""
window.__log = [];
const _send = window.pulse.send.bind(window.pulse);
window.pulse.send = (ch, ...a) => { window.__log.push(Date.now()%100000 + ' send ' + ch + ' ' + JSON.stringify(a)); return _send(ch, ...a); };
window.__log.push('instrumented');
'instrumented'
"""))

t0 = time.time()
while time.time() - t0 < 16:
    cls = ev("document.body.className")
    print(f"{time.time()-t0:5.1f}s  {cls}")
    time.sleep(1)

print("--- send log ---")
for line in (ev("window.__log") or []):
    print(line)
ws.close()
