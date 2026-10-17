import json, urllib.request, websocket, time

def targets():
    return json.load(urllib.request.urlopen('http://localhost:9223/json', timeout=5))

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
pw = websocket.create_connection(panel['webSocketDebuggerUrl'], timeout=10, suppress_origin=True)

for i in range(30):
    snap = ev(pw, "window.pulse.invoke('snapshot')", await_it=True)
    g = (snap or {}).get('state', {}).get('readings', {}).get('glmCoding')
    if g and g.get('observedAt'):
        break
    time.sleep(2)

if not g:
    print('glmCoding reading never arrived')
else:
    print('state:', g.get('state'), '| reason:', g.get('reason'),
          '| windows:', len(g.get('windows', [])),
          '| ledger?', bool(g.get('ledger')))
    for w in g.get('windows', []):
        print('  win:', w.get('kind'), round(w.get('usedFraction', 0) * 100, 1), '%')
pw.close()
