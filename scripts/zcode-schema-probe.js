'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const os = require('os');

const db = new DatabaseSync(path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite'), { readOnly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
console.log('tables:', tables.join(', '));
for (const t of tables) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    const n = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    console.log(`\n${t} (${n} rows): ${cols.join(', ')}`);
    // one sample row's keys only
    if (['messages', 'usage', 'requests', 'sessions'].some((k) => t.includes(k))) {
      const row = db.prepare(`SELECT * FROM ${t} LIMIT 1`).get();
      if (row) console.log('  sample keys:', Object.keys(row).join(', '));
    }
  } catch (e) { console.log(t, 'ERR', e.message); }
}
db.close();
