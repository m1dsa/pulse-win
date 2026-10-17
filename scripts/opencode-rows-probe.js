const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'), { readOnly: true });

const sessions = db.prepare(
  "SELECT id, parent_id, agent, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created FROM session"
).all();
for (const s of sessions) {
  console.log(JSON.stringify(s), '| created', new Date(s.time_created).toISOString());
}

console.log('\n-- message data keys --');
const msgs = db.prepare('SELECT id, session_id, time_created, data FROM message ORDER BY time_created DESC LIMIT 4').all();
for (const m of msgs) {
  const d = JSON.parse(m.data);
  console.log(m.id, '| top keys:', Object.keys(d).join(','));
  if (d.tokens) console.log('   tokens:', JSON.stringify(d.tokens));
  if (d.usage) console.log('   usage:', JSON.stringify(d.usage));
  if (d.modelID || d.providerID) console.log('   model:', d.providerID, d.modelID);
  if (d.cost !== undefined) console.log('   cost:', d.cost);
}

console.log('\n-- part types --');
const types = db.prepare("SELECT json_extract(data,'$.type') AS t, COUNT(*) n FROM part GROUP BY t").all();
console.log(types);
