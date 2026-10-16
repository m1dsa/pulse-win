// Devin's local spend ledger — port of DevinCLIStore.swift + the UsageLedger
// aggregation the card shows as "本机用量".
//
// The CLI keeps its transcripts in <APPDATA>\devin\cli\sessions.db:
// message_nodes.chat_message is one message's JSON, and an assistant's
// metadata.metrics carries input_tokens / output_tokens / cache_read_tokens /
// cache_creation_tokens. One message can be two sibling nodes with the same
// message_id — counted once.
//
// Money is tokens at API list prices (models.dev), not a bill — the card says
// so. A model with no published price is counted, never priced.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const prices = require('./prices.js');
const agg = require('./ledgerAggregate.js');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* older node */ }

function databases() {
  const out = [];
  if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, 'devin', 'cli', 'sessions.db'));
  out.push(path.join(os.homedir(), '.local', 'share', 'devin', 'cli', 'sessions.db'));
  return out.filter((f) => fs.existsSync(f));
}

function int(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

// Each assistant reply, deduplicated, with its own price applied — a
// long-context request is priced at its tier, whole.
function scan(file, table) {
  const db = new DatabaseSync(file, { readOnly: true });
  const days = new Map();
  const seen = new Set();
  try {
    const rows = db.prepare(
      "SELECT session_id, chat_message, created_at FROM message_nodes WHERE chat_message LIKE '%\"input_tokens\"%'").all();
    for (const row of rows) {
      let root;
      try { root = JSON.parse(row.chat_message); } catch { continue; }
      const meta = root && root.metadata;
      const metrics = meta && meta.metrics;
      if (!metrics || typeof metrics !== 'object') continue;

      const tally = {
        input: int(metrics.input_tokens),
        cacheWrite: int(metrics.cache_creation_tokens),
        cacheRead: int(metrics.cache_read_tokens),
        output: int(metrics.output_tokens),
        recordedCache: 'cache_read_tokens' in metrics || 'cache_creation_tokens' in metrics,
      };
      const mid = root.message_id || meta.request_id;
      if (mid && !seen.add(mid)) continue;

      const s = Number(row.created_at);
      const at = Number.isFinite(s) && s > 0 ? (s > 1e10 ? s : s * 1000) : 0;
      if (!at) continue;

      const model = (typeof meta.generation_model === 'string' && meta.generation_model) || 'devin';
      const key = agg.startOfLocalDay(at);
      const day = days.get(key) || agg.emptyDay();
      agg.addTally(day, model, tally, table);
      days.set(key, day);
    }
  } finally { db.close(); }
  return days;
}

async function readLedger(dataDir) {
  if (!DatabaseSync) return null;
  const file = databases()[0];
  if (!file) return null;

  const table = await prices.table(dataDir);
  let days;
  try { days = scan(file, table); } catch { return null; }
  return agg.build(days, Date.now(), table);
}

module.exports = { readLedger };
