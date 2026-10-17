# Timeline capture: hover edge -> expand+card -> parked -> card dies ~3s ->
# refresh under parked cursor must not reopen -> rail folds ~6s idle.
# Real OS cursor moves. Pulse on --remote-debugging-port=9223.
import json, time, urllib.request, websocket, ctypes

def move(x, y):
    ctypes.windll.user32.SetCursorPos(x, y)

def targets():
    return json.load(urllib.request.urlopen('http://localhost:9223/json', timeout=8))

def conn(sub):
    t = next(t for t in targets() if sub in t['url'])
    ws = websocket.create_connection(t['webSocketDebuggerUrl'], timeout=8, suppress_origin=True)
    ws.settimeout(3)
    return ws

wsP, wsC = conn('panel.html'), conn('card.html')
mid = [0]
def ev(ws, expr):
    mid[0] += 1
    ws.send(json.dumps({'id': mid[0], 'method': 'Runtime.evaluate',
                        'params': {'expression': expr, 'returnByValue': True}}))
    t0 = time.time()
    while time.time() - t0 < 3:
        try:
            m = json.loads(ws.recv())
        except Exception:
            return '?'
        if m.get('id') == mid[0]:
            return m.get('result', {}).get('result', {}).get('value')
    return '?'

def snap():
    return (ev(wsP, "document.body.classList.contains('collapsed')"),
            ev(wsC, "document.visibilityState"))

t0 = time.time()
def log(tag):
    c, v = snap()
    print(f"t+{time.time()-t0:5.2f}s  {tag:34s} collapsed={c} card={v}", flush=True)

# 1) expand via real hover
move(1277, 360)
for i in range(14):
    time.sleep(0.3)
    log(f'dwell+hover #{i}')
    if snap() == (False, 'visible'): break
# 2) park — card must die ~3s after its last show
time.sleep(3.4); log('parked, card should be hidden by TTL')
# 3) refresh under parked cursor — must NOT reopen
ev(wsP, "window.pulse.send('refresh')")
time.sleep(2.0); log('post-refresh, still parked')
# 4) rail folds ~6s after last real move
time.sleep(4.5); log('idle should have folded rail')
# 5) wiggle 1px — real move, must dwell-expand again
move(1278, 360); time.sleep(0.9); log('nudged 1px')
