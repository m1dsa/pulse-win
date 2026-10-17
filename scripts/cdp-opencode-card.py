import json, urllib.request, websocket, time, ctypes

user32 = ctypes.windll.user32

def targets():
    return json.load(urllib.request.urlopen('http://localhost:9223/json', timeout=5))

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
pw = ws_for(panel)
dpr = ev(pw, "devicePixelRatio")
print('dpr:', dpr)

def geo():
    return json.loads(ev(pw, "JSON.stringify({w:innerWidth,h:innerHeight,l:screenLeft,t:screenTop})"))

def phys(dx, dy):  # screenLeft and SetCursorPos share one coordinate space
    return int(round(dx)), int(round(dy))

# 1) move away first (a parked cursor can't expand — collapseCursor guard),
#    then onto the spot the sweep proved expands the rail
user32.SetCursorPos(700, 400)
time.sleep(0.6)
user32.SetCursorPos(1300, 300)
time.sleep(2)

slots = json.loads(ev(pw, """JSON.stringify([...document.querySelectorAll('.slot')].map(s => {
  const r = s.getBoundingClientRect();
  return { account: s.dataset.account, x: r.x, y: r.y, w: r.width, h: r.height };
}))"""))
print('SLOTS:', json.dumps(slots, ensure_ascii=False))
g = geo()
print('GEO:', g)

oc = next((s for s in slots if s['account'] == 'openCodeGo' and s['h'] > 0), None)
if not oc:
    print('openCodeGo ring not expanded/missing'); raise SystemExit

# 2) real move onto the openCodeGo ring — two hops so it registers
cx, cy = g['l'] + oc['x'] + oc['w'] / 2, g['t'] + oc['y'] + oc['h'] / 2
px, py = phys(cx - 30, cy)
user32.SetCursorPos(px, py)
time.sleep(0.5)
px, py = phys(cx, cy)
user32.SetCursorPos(px, py)
time.sleep(2.5)

card = next((t for t in targets() if 'card.html' in t['url']), None)
if card:
    cw = ws_for(card)
    txt = ev(cw, "document.body.innerText")
    print('CARD TEXT:')
    for line in (txt or '').split('\n'):
        print('  ', line.encode('unicode_escape').decode()[:160])
    cw.close()
else:
    print('no card window')
pw.close()
