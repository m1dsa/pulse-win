# Fire a synthetic mouseenter on the rail's slot, then report card state.
import json, urllib.request, websocket, time

targets = json.load(urllib.request.urlopen("http://localhost:9222/json", timeout=5))
panel = next(t for t in targets if 'panel.html' in t['url'])
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
                return 'EXC: ' + json.dumps(r['exceptionDetails'], ensure_ascii=False)[:600]
            return json.dumps(r.get('result', {}).get('value'), ensure_ascii=False)

print("expand:", ev("window.pulse.send('rail:collapse', false); 'ok'"))
time.sleep(0.8)
print("class:", ev("document.body.className"))
print("mouseenter:", ev("const s=document.querySelector('.slot'); s.dispatchEvent(new MouseEvent('mouseenter')); 'fired '+(s&&s.dataset.account)"))
time.sleep(2.0)
print("classes:", ev("document.body.className"))

# Now look at the card window
card = next(t for t in targets if 'card.html' in t['url'])
ws2 = websocket.create_connection(card['webSocketDebuggerUrl'], timeout=8, suppress_origin=True)
def ev2(expr):
    ws2.send(json.dumps({"id": 99, "method": "Runtime.evaluate",
                        "params": {"expression": expr, "returnByValue": True, "awaitPromise": True}}))
    while True:
        m = json.loads(ws2.recv())
        if m.get('id') == 99:
            r = m.get('result', {})
            if 'exceptionDetails' in r:
                return 'EXC: ' + json.dumps(r['exceptionDetails'], ensure_ascii=False)[:600]
            return json.dumps(r.get('result', {}).get('value'), ensure_ascii=False)

print("card title:", ev2("document.getElementById('htitle').textContent"))
print("card rows:", ev2("document.getElementById('rows').innerHTML.length"))
print("card updated:", ev2("document.getElementById('hupdated').textContent"))
ws.close(); ws2.close()
