import json, urllib.request, websocket, time, ctypes

user32 = ctypes.windll.user32

def targets():
    return json.load(urllib.request.urlopen('http://localhost:9222/json', timeout=5))

def ws_for(t):
    return websocket.create_connection(t['webSocketDebuggerUrl'], timeout=10, suppress_origin=True)

_id = [0]
def cmd(ws, method, params=None):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": method, "params": params or {}}))
    while True:
        m = json.loads(ws.recv())
        if m.get('id') == _id[0]:
            return m.get('result', {})

def ev(ws, expr, await_it=False):
    r = cmd(ws, "Runtime.evaluate",
            {"expression": expr, "returnByValue": True, "awaitPromise": await_it})
    return r.get('result', {}).get('value')

panel = next(t for t in targets() if 'panel.html' in t['url'])
ws = ws_for(panel)

ev(ws, "window.pulse.send('provider:toggle','devin',true)")
print('enabled devin; waiting for refresh')
snap = None
for _ in range(30):
    time.sleep(2)
    snap = ev(ws, "window.pulse.invoke('snapshot').then(s=>s)", await_it=True)
    dev = (snap or {}).get('state', {}).get('readings', {}).get('devin')
    if dev and dev.get('observedAt'):
        break
dev = (snap or {}).get('state', {}).get('readings', {}).get('devin') or {}
print('devin state:', dev.get('state'), '| ledger:', bool(dev.get('ledger')),
      '| month:', (dev.get('ledger') or {}).get('month'))
ws.close()
