import json, urllib.request, websocket
ts = json.load(urllib.request.urlopen('http://localhost:9222/json', timeout=5))
card = next((t for t in ts if 'card.html' in t['url']), None)
print('card target:', bool(card))
if card:
    ws = websocket.create_connection(card['webSocketDebuggerUrl'], timeout=8, suppress_origin=True)
    expr = ("JSON.stringify({title:document.getElementById('htitle').textContent,"
            "rows:document.getElementById('rows').innerHTML.length,"
            "vis:document.visibilityState})")
    ws.send(json.dumps({'id': 1, 'method': 'Runtime.evaluate',
                        'params': {'expression': expr, 'returnByValue': True}}))
    while True:
        m = json.loads(ws.recv())
        if m.get('id') == 1:
            print(m.get('result', {}).get('result', {}).get('value'))
            break
    ws.close()
