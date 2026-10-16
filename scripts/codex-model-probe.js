'use strict';
// Which line types in a Codex rollout actually carry payload.model?
const fs = require('fs');
const rl = require('readline');

(async () => {
  const file = process.argv[2];
  const types = {};
  const r = rl.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let scanned = 0;
  for await (const line of r) {
    scanned++;
    if (!line.includes('"model"')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const p = j.payload || {};
    if (typeof p.model === 'string') {
      const k = `${j.type}/${p.type || '-'}`;
      types[k] = (types[k] || 0) + 1;
      if (!types['__sample__' + k]) { types['__sample__' + k] = p.model; }
    }
    if (scanned > 400000) break; // head sample only
  }
  r.close();
  for (const [k, v] of Object.entries(types)) {
    if (k.startsWith('__')) continue;
    console.log(k, '×' + v, '→', types['__sample__' + k]);
  }
  console.log('lines scanned:', scanned);
})();
