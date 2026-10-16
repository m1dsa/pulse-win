# Sliver state helper: prints body class / collapsed flag; optional expand poke.
# Usage: python cdp-sliver-test.py [state|expand]
import json, sys, time, urllib.request, websocket

def targets():
    return json.load(urllib.request.urlopen('http://localhost:9223/json', timeout=5))

panel = next(t for t in targets() if 'panel.html' in t['url'])
ws = websocket.create_connection(panel['webSocketDebuggerUrl'], timeout=8, suppress_origin=True)

def ev(mid, expr):
    ws.send(json.dumps({'id': mid, 'method': 'Runtime.evaluate',
                        'params': {'expression': expr, 'returnByValue': True}}))
    while True:
        m = json.loads(ws.recv())
        if m.get('id') == mid:
            return m.get('result', {}).get('result', {}).get('value')

cmd = sys.argv[1] if len(sys.argv) > 1 else 'state'
if cmd == 'expand':
    ev(0, "window.pulse.send('rail:collapse', false)")
    time.sleep(0.3)
if cmd == 'collapse':
    ev(0, "window.pulse.send('rail:collapse', true)")
    time.sleep(0.3)
if cmd == 'quit':
    ev(0, "window.pulse.send('quit')")
    time.sleep(0.3)
print('class:', ev(1, "document.body.className"), '| collapsed:',
      ev(2, "document.body.classList.contains('collapsed')"))
ws.close()
