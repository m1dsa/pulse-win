# CDP probe: attach to the panel renderer and dump its DOM/bridge state.
import json, urllib.request, websocket, sys

targets = json.load(urllib.request.urlopen("http://localhost:9222/json", timeout=5))
name = sys.argv[1] if len(sys.argv) > 1 else 'panel.html'
panel = next(t for t in targets if name in t['url'])
ws = websocket.create_connection(panel['webSocketDebuggerUrl'], timeout=8, suppress_origin=True)
_id = [0]

def ev(expr):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": "Runtime.evaluate",
                        "params": {"expression": expr, "returnByValue": True, "awaitPromise": True}}))
    while True:
        m = json.loads(ws.recv())
        if m.get('id') == _id[0]:
            r = m.get('result', {})
            if 'exceptionDetails' in r:
                return 'EXC: ' + json.dumps(r['exceptionDetails'].get('exception', {}).get('description', r['exceptionDetails']), ensure_ascii=False)[:500]
            return r.get('result', {})

for expr in json.loads(open(sys.argv[2], encoding='utf8').read()) if len(sys.argv) > 2 else []:
    r = ev(expr)
    print(expr[:80], '=>', json.dumps(r.get('value', r.get('description', r)), ensure_ascii=False)[:400])
ws.close()
