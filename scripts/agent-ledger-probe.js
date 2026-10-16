'use strict';
// Exercise agentLedger.readLedger against the real transcript stores.
const path = require('path');
const os = require('os');
const fs = require('fs');

const dataDir = path.join(os.tmpdir(), 'pulse-ledger-probe');
fs.mkdirSync(dataDir, { recursive: true });
// Reuse the app's price cache if present so the probe doesn't refetch.
const appCache = path.join(process.env.APPDATA || '', 'Pulse', 'model-prices-5.json');
if (fs.existsSync(appCache)) fs.copyFileSync(appCache, path.join(dataDir, 'model-prices-5.json'));

const { readLedger } = require('../src/main/agentLedger.js');

(async () => {
  for (const src of ['claudeCode', 'codex', 'zcode', 'dsh']) {
    const t0 = Date.now();
    const ledger = await readLedger(src, dataDir);
    const ms = Date.now() - t0;
    if (!ledger) { console.log(src, '-> null (' + ms + 'ms)'); continue; }
    console.log(`${src} (${ms}ms):`);
    console.log('  today:', fmt(ledger.today));
    console.log('  week :', fmt(ledger.week));
    console.log('  month:', fmt(ledger.month));
    console.log('  bars :', ledger.bars.length, 'peak', Math.max(...ledger.bars));
    console.log('  top  :', JSON.stringify(ledger.topModel));
    console.log('  cache:', ledger.cacheHit);
  }
  function fmt(f) { return f ? `${f.tokens} tok $${f.cost.toFixed(2)} unpriced=${f.unpriced}` : 'null'; }
})().catch((e) => { console.error('THREW', e); process.exit(1); });
