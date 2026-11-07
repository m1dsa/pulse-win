// All local ledgers merged into one per-day series — feeds the total panel's
// heatmap and the all-time figure. Same dedup/pricing as each provider's own
// card; nothing here is fetched over the network.
'use strict';

const agentLedger = require('./agentLedger.js');
const devinLedger = require('./devinLedger.js');

// Qoder is absent on purpose: its local ledger counts billed credits, which
// are not tokens and would quietly distort this panel's totals.
const SOURCES = [
  ['claudeCode', 'Claude Code'],
  ['codex', 'Codex'],
  ['devin', 'Devin'],
  ['dsh', 'DeepSeek'],
  ['zcode', 'GLM Coding (ZCode)'],
  ['opencode', 'OpenCode'],
  ['mimo', 'MiMo Code'],
  ['codebuddy', 'CodeBuddy'],
];

function readDaysOf(id, dataDir) {
  return id === 'devin'
    ? devinLedger.readDays(dataDir)
    : agentLedger.readLedgerDays(id, dataDir);
}

// -> { sources: {id: {name, tokens, cost}}, days: {slotMs: {t, c}}, tokens, cost }
async function readAll(dataDir) {
  const merged = new Map();
  const sources = {};
  for (const [id, name] of SOURCES) {
    let days;
    try { days = await readDaysOf(id, dataDir); } catch { days = null; }
    if (!days) continue;
    let tokens = 0, cost = 0;
    for (const [slot, d] of days) {
      tokens += d.tokens;
      cost += d.cost;
      const m = merged.get(slot) || { tokens: 0, cost: 0 };
      m.tokens += d.tokens;
      m.cost += d.cost;
      merged.set(slot, m);
    }
    sources[id] = { name, tokens, cost };
  }

  const days = {};
  let tokens = 0, cost = 0;
  for (const [slot, d] of merged) {
    days[slot] = { t: d.tokens, c: d.cost };
    tokens += d.tokens;
    cost += d.cost;
  }
  return { sources, days, tokens, cost, generatedAt: Date.now() };
}

module.exports = { readAll };
