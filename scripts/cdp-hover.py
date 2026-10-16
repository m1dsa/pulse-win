# Fire mouseenter while the real cursor sits inside the rail, so the card stays.
import json, urllib.request, websocket, time
targets = json.load(urllib.request.urlopen("http://localhost:9222/json", timeout=5))
panel = next(t for t in targets if 'panel.html' in t['url'])
ws = websocket.create_connection(panel['webSocketDebuggerUrl'], timeout=8, suppress_origin=True)
ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {
    "expression": "document.querySelector('.slot').dispatchEvent(new MouseEvent('mouseenter')); 'fired'",
    "returnByValue": True}}))
while True:
    m = json.loads(ws.recv())
    if m.get('id') == 1:
        print(m.get('result', {}).get('result', {}).get('value'))
        break
ws.close()
time.sleep(0.5)
