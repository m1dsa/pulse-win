// Probe opencode's local sqlite db schema + token fields.
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
const db = new DatabaseSync(dbPath, { readOnly: true });

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log('tables:', tables.map((t) => t.name).join(', '));

for (const { name } of tables) {
  const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all();
  console.log(`\n== ${name} ==`);
  console.log('  cols:', cols.map((c) => `${c.name}:${c.type}`).join(', '));
  const n = db.prepare(`SELECT COUNT(*) AS n FROM ${JSON.stringify(name)}`).get();
  console.log('  rows:', n.n);
}
