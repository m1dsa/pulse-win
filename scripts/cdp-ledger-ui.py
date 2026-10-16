import json, urllib.request, websocket, time, ctypes

user32 = ctypes.windll.user32
class PT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

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

# wait until devin reading has landed (auto-refresh on launch)
snap = None
for _ in range(40):
    time.sleep(2)
    snap = ev(pw, "window.pulse.invoke('snapshot')", await_it=True)
    if snap and snap.get('state', {}).get('readings', {}).get('devin', {}).get('observedAt'):
        break
dev = snap['state']['readings']['devin']
print('devin:', dev.get('state'), '| ledger?', bool(dev.get('ledger')),
      '| today:', (dev.get('ledger') or {}).get('today'))

# expand panel: park OS cursor inside rail then wait for expanded geometry
geo = ev(pw, "JSON.stringify({w:innerWidth,h:innerHeight,l:screenLeft,t:screenTop})")
print('panel geo:', geo)
g = json.loads(geo)
user32.SetCursorPos(g['l'] + g['w'] - 2, g['t'] + g['h'] // 2)
time.sleep(2)
geo2 = ev(pw, "JSON.stringify({w:innerWidth,h:innerHeight,l:screenLeft,t:screenTop})")
print('expanded geo:', geo2)

# find devin ring position and park cursor on it -> card opens
slots = ev(pw, """JSON.stringify([...document.querySelectorAll('.ring')].map((el,i)=>({
  i, id: el.dataset.id || el.getAttribute('data-id') || '',
  r: el.getBoundingClientRect().toJSON() })))""")
print('slots:', slots)
ss = json.loads(slots)
dv = next((s for s in ss if 'devin' in s['id']), None)
g2 = json.loads(geo2)
if dv:
    cx, cy = g2['l'] + dv['r']['x'] + dv['r']['width']/2, g2['t'] + dv['r']['y'] + dv['r']['height']/2
    user32.SetCursorPos(int(cx), int(cy))
    time.sleep(1.5)
    # inspect card window DOM
    card = next((t for t in targets() if 'card.html' in t['url']), None)
    if card:
        cw = ws_for(card)
        info = ev(cw, """JSON.stringify({
          prov: document.querySelector('.head .name, h1, .title')?.textContent,
          ledger: !!document.querySelector('.ledger, .activity, [class*=ledger]'),
          text: document.body.innerText.slice(0, 400) })""")
        print('CARD:', info)
        cw.close()
    else:
        print('no card target')
else:
    print('devin slot not found')
pw.close()
