import json, urllib.request, websocket, time, ctypes

user32 = ctypes.windll.user32

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

# sweep the real cursor across the screen at a few heights; watch innerWidth
for y in (300, 500, 700):
    for x in range(1100, 1930, 40):
        user32.SetCursorPos(x, y)
        time.sleep(0.7)
        w = ev(pw, "innerWidth")
        if w and w > 6:
            print(f"EXPANDED at physical ({x},{y}) -> innerWidth={w}")
            pw.close()
            raise SystemExit
    print(f"row y={y} done")
print("never expanded")
pw.close()
