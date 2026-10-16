# Drive the rail with CDP Input.dispatchMouseEvent — synthetic input that hits
# the renderer directly, independent of the physical cursor.
import json, urllib.request, websocket, time

targets = json.load(urllib.request.urlopen("http://localhost:9222/json", timeout=5))
panel = next(t for t in targets if 'panel.html' in t['url'])
card_t = next(t for t in targets if 'card.html' in t['url'])
ws = websocket.create_connection(panel['webSocketDebuggerUrl'], timeout=8, suppress_origin=True)
ws2 = websocket.create_connection(card_t['webSocketDebuggerUrl'], timeout=8, suppress_origin=True)
_id = [0]

def cmd(sock, method, params=None, wait=True):
    _id[0] += 1
    sock.send(json.dumps({"id": _id[0], "method": method, "params": params or {}}))
    if not wait:
        return None
    while True:
        m = json.loads(sock.recv())
        if m.get('id') == _id[0]:
            return m.get('result', {})

def ev(expr, sock=None):
    r = cmd(sock or ws, "Runtime.evaluate", {"expression": expr, "returnByValue": True})
    if 'exceptionDetails' in r:
        return 'EXC:' + json.dumps(r['exceptionDetails'], ensure_ascii=False)[:400]
    return r.get('result', {}).get('value')

def mousemove(x, y):
    cmd(ws, "Input.dispatchMouseEvent",
        {"type": "mouseMoved", "x": x, "y": y, "button": "none", "buttons": 0}, wait=False)

print("cls0:", ev("document.body.className"))
print("slots:", ev("document.querySelectorAll('.slot').length"))
# Where is the slot in window coords?
print("slot rect:", ev("JSON.stringify(document.querySelector('.slot').getBoundingClientRect())"))
print("sliver rect:", ev("JSON.stringify(document.getElementById('sliver').getBoundingClientRect())"))

# If collapsed, enter the sliver area first (sliver is 6px on the right edge).
cls = ev("document.body.className") or ""
if 'collapsed' in cls:
    mousemove(4, 40)
    time.sleep(0.8)
    print("after sliver:", ev("document.body.className"))

# Now move into the slot (window-local coords: slot starts y=10, center ~41).
mousemove(31, 41)
time.sleep(1.6)
print("cls1:", ev("document.body.className"))
print("card title:", ev("document.getElementById('htitle').textContent", ws2))
print("card h:", ev("document.getElementById('card').offsetHeight", ws2))
time.sleep(1.5)
print("cls2:", ev("document.body.className"), "(card should still be visible while cursor in rail)")
ws.close(); ws2.close()
