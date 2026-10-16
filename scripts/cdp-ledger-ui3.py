import json, urllib.request, websocket, time, ctypes, sys

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

want = sys.argv[1] if len(sys.argv) > 1 else 'claudeCode'

panel = next(t for t in targets() if 'panel.html' in t['url'])
pw = ws_for(panel)

# wait for the wanted provider's reading to land
snap = None
for _ in range(60):
    time.sleep(2)
    snap = ev(pw, "window.pulse.invoke('snapshot')", await_it=True)
    r = (snap or {}).get('state', {}).get('readings', {}).get(want)
    if r and r.get('observedAt'):
        break
r = snap['state']['readings'][want]
print(want, ':', r.get('state'), '| ledger?', bool(r.get('ledger')),
      '| month:', (r.get('ledger') or {}).get('month'))

geo = json.loads(ev(pw, "JSON.stringify({w:innerWidth,h:innerHeight,l:screenLeft,t:screenTop})"))
user32.SetCursorPos(geo['l'] + geo['w'] - 2, geo['t'] + geo['h'] // 2)
time.sleep(2)
geo = json.loads(ev(pw, "JSON.stringify({w:innerWidth,h:innerHeight,l:screenLeft,t:screenTop})"))

slot = ev(pw, f"""(() => {{
  const s = [...document.querySelectorAll('.slot')].find(e => e.dataset.account === '{want}');
  if (!s) return null;
  const r = s.getBoundingClientRect();
  return JSON.stringify({{x: r.x, y: r.y, w: r.width, h: r.height}});
}})()""")
print('slot:', slot)
if not slot:
    print('accounts:', ev(pw, "JSON.stringify([...document.querySelectorAll('.slot')].map(s=>s.dataset.account))"))
    raise SystemExit
s = json.loads(slot)
user32.SetCursorPos(int(geo['l'] + s['x'] + s['w']/2), int(geo['t'] + s['y'] + s['h']/2))
time.sleep(1.5)

card = next((t for t in targets() if 'card.html' in t['url']), None)
if card:
    cw = ws_for(card)
    txt = ev(cw, "document.body.innerText")
    print('CARD TEXT:')
    for line in (txt or '').split('\n'):
        print('  ', line.encode('unicode_escape').decode()[:160])
    cw.close()
else:
    print('no card')
pw.close()
