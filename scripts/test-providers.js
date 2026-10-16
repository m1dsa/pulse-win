// Provider smoke test — runs every registered provider's fetch() once, in
// plain Node (no Electron). Credential readers and parsers get exercised for
// real; whatever has no credential must come back 'unavailable', never throw.
'use strict';

const path = require('path');
const os = require('os');

const { PROVIDERS } = require('../src/main/providers/index.js');

const ctx = {
  home: os.homedir(),
  dataDir: path.join(os.tmpdir(), 'pulse-win-test'),
  account: null,
  key: null,
  site: 'international',
  basis: 'sinceTopUp',
  budget: null,
  currency: null,
};

(async () => {
  let failed = 0;
  for (const p of PROVIDERS) {
    const t0 = Date.now();
    try {
      const usage = await Promise.race([
        p.fetch({ ...ctx, account: p.id }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 45s')), 45000)),
      ]);
      const wins = (usage.windows || []).map((w) => `${w.kind}:${(w.usedFraction * 100).toFixed(0)}%`).join(' ');
      console.log(`${p.id.padEnd(12)} ${usage.state.padEnd(11)} ${(Date.now() - t0 + 'ms').padEnd(7)} ${usage.reason || ''} ${wins}${usage.plan ? '  plan=' + usage.plan : ''}${usage.creditBalance ? '  bal=' + usage.creditBalance : ''}`);
    } catch (e) {
      failed++;
      console.log(`${p.id.padEnd(12)} THREW       ${e && e.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
})();
