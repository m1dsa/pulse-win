import sqlite3, json, sys
sys.stdout.reconfigure(encoding='utf-8')
db = r'C:\Users\34966\AppData\Roaming\devin\cli\sessions.db'
con = sqlite3.connect('file:' + db.replace('\\', '/') + '?mode=ro', uri=True)
print('tables:', [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")])
try:
    print('sessions cols:', [r[1] for r in con.execute("PRAGMA table_info(sessions)")])
except Exception as e:
    print('sessions err', e)
try:
    print('msg cols:', [r[1] for r in con.execute("PRAGMA table_info(message_nodes)")])
except Exception as e:
    print('message_nodes err', e)
row = con.execute("SELECT chat_message FROM message_nodes WHERE chat_message LIKE '%metrics%' LIMIT 1").fetchone()
if row:
    d = json.loads(row[0])
    meta = d.get('metadata', {})
    print('meta keys:', sorted(meta.keys()))
    print('metrics:', json.dumps(meta.get('metrics')))
    print('model:', meta.get('generation_model'), '| created:', meta.get('created_at'))
    print('role:', d.get('role'))
print('node count:', con.execute("SELECT COUNT(*) FROM message_nodes").fetchone()[0])
con.close()
