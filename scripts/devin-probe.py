import sqlite3, os, json
db = r'C:\Users\34966\AppData\Roaming\Devin\User\globalStorage\state.vscdb'
uri = 'file:' + db.replace('\\', '/') + '?mode=ro'
con = sqlite3.connect(uri, uri=True)
cur = con.execute(
    "SELECT key, value FROM ItemTable WHERE key LIKE 'windsurf.reactSettings.cachedPlanInfoData%' "
    "OR key LIKE 'windsurf.settings.cachedPlanInfo%'")
rows = cur.fetchall()
print('rows:', len(rows))
for k, v in rows:
    print('KEY:', k)
    try:
        print('VAL:', v[:400] if isinstance(v, str) else v[:400])
    except Exception as e:
        print('VAL err', e)
con.close()
logs = r'C:\Users\34966\AppData\Roaming\Devin\logs'
print('logs dirs:', sorted(os.listdir(logs))[-3:] if os.path.isdir(logs) else 'none')
