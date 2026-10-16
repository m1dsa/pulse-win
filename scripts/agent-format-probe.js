'use strict';
// Peek at real transcript shapes: first few usage/token_count lines of one
// Claude project file and one Codex rollout. Prints only numeric fields.
const fs = require('fs');
const path = require('path');
const rl = require('readline');
const os = require('os');

async function* lines(file) {
  const r = rl.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const l of r) yield l;
}

function biggest(dir) {
  let best = null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const b = biggest(p); if (b && (!best || b.size > best.size)) best = b; }
    else if (e.name.endsWith('.jsonl')) { const s = fs.statSync(p).size; if (!best || s > best.size) best = { p, size: s }; }
  }
  return best;
}

(async () => {
  const home = os.homedir();

  const cf = biggest(path.join(home, '.claude', 'projects'));
  console.log('CLAUDE file:', cf.p.slice(home.length), (cf.size / 1e6).toFixed(1) + 'MB');
  let n = 0;
  for await (const l of lines(cf.p)) {
    if (!l.includes('"usage"') || !l.includes('"assistant"')) continue;
    try {
      const j = JSON.parse(l);
      const m = j.message || {};
      if (j.type !== 'assistant' || !m.usage) continue;
      console.log(' id:', m.id, '| model:', m.model, '| usage:', JSON.stringify(m.usage), '| ts:', j.timestamp);
      if (++n >= 3) break;
    } catch { }
  }

  const xf = biggest(path.join(home, '.codex', 'sessions'));
  console.log('\nCODEX file:', xf.p.slice(home.length), (xf.size / 1e6).toFixed(1) + 'MB');
  n = 0; let meta = false;
  for await (const l of lines(xf.p)) {
    if (!meta && l.includes('"session_meta"')) {
      try {
        const j = JSON.parse(l);
        if (j.type === 'session_meta') { console.log(' meta id:', j.payload?.id, '| forked_from:', j.payload?.forked_from_id); meta = true; }
      } catch { }
    }
    if (l.includes('"token_count"')) {
      try {
        const j = JSON.parse(l);
        const u = j.payload && j.payload.info;
        if (u && u.total_token_usage) {
          console.log(' total:', JSON.stringify(u.total_token_usage), '| last:', JSON.stringify(u.last_token_usage));
          if (++n >= 3) break;
        }
      } catch { }
    }
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
