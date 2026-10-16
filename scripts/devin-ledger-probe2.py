import sqlite3, json, sys
sys.stdout.reconfigure(encoding='utf-8')
db = r'C:\Users\34966\AppData\Roaming\devin\cli\sessions.db'
con = sqlite3.connect('file:' + db.replace('\\', '/') + '?mode=ro', uri=True)
rows = con.execute("SELECT chat_message FROM message_nodes WHERE chat_message LIKE '%\"input_tokens\"%' ORDER BY row_id DESC LIMIT 3").fetchall()
print('metric rows found:', len(rows))
for r in rows:
    d = json.loads(r[0])
    m = d.get('metadata', {})
    print('role:', d.get('role'), '| model:', m.get('generation_model'), '| created:', m.get('created_at'))
    print('  metrics:', json.dumps(m.get('metrics')))
# sessions sample
print('sessions:', con.execute("SELECT COUNT(*) FROM sessions").fetchone()[0])
s = con.execute("SELECT id, model, title, working_directory FROM sessions ORDER BY created_at DESC LIMIT 2").fetchall()
for row in s:
    print('  sess:', row[0][:12], '| model:', row[1], '| title:', (row[2] or '')[:30], '| dir:', (row[3] or '')[:40])
con.close()
