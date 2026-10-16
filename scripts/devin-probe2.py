import sqlite3, json, sys
sys.stdout.reconfigure(encoding='utf-8')
db = r'C:\Users\34966\AppData\Roaming\Devin\User\globalStorage\state.vscdb'
con = sqlite3.connect('file:' + db.replace('\\', '/') + '?mode=ro', uri=True)
v = con.execute("SELECT value FROM ItemTable WHERE key LIKE 'windsurf.reactSettings.cachedPlanInfoData%'").fetchone()[0]
d = json.loads(v)
keep = {k: d[k] for k in sorted(d) if 'ercent' in k or 'eset' in k.lower() or k in
        ('planName', 'billingStrategy', 'startTimestamp', 'endTimestamp', 'duration',
         'remainingMessages', 'totalMessages', 'overageBalanceMicros',
         'dailyResetAtUnix', 'weeklyResetAtUnix', 'hideDailyQuota', 'hideWeeklyQuota')}
print(json.dumps(keep, indent=1))
con.close()
