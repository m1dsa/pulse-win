// JSONL transcript ledgers for Claude Code and Codex — a compact port of
// UsageLedgerReader.swift, the same "本机用量" the card shows for Devin.
//
// Claude Code (~/.claude/projects/**\/*.jsonl): one assistant reply is written
// over several lines, each carrying the usage so far — kept by message id
// with the last line's counts, which also absorbs retries within a file and
// copies in other files.
//
// Codex (~/.codex/sessions + ~/.codex/archived_sessions, rollout-*.jsonl):
// `token_count` events carry the session's RUNNING total, so each reading is
// differenced against the previous one. A forked rollout opens with its
// parent's total and replays its history — the fork's first reading counts
// only its own request, replayed `rollout-N` turns count nothing, and a
// reading whose running total a non-fork already reached is a parent's copy.
//
// Money is tokens at API list prices (models.dev); unpriced models are
// counted but never given a dollar figure.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const rl = require('readline');
const zlib = require('zlib');
const prices = require('./prices.js');
const agg = require('./ledgerAggregate.js');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* older node */ }

const SOURCES = {
  claudeCode: {
    roots: (home) => [path.join(home, '.claude', 'projects')],
    archivedRoots: () => [],
    parse: parseClaudeFile,
  },
  codex: {
    roots: (home) => [path.join(home, '.codex', 'sessions')],
    archivedRoots: (home) => [path.join(home, '.codex', 'archived_sessions')],
    parse: parseCodexFile,
  },
  // DeepSeek Harness: ~/.dsh/sessions/<cwd>/<id>/session*.jsonl[.zstd] —
  // one zstd frame per event line, appended as the session runs.
  dsh: {
    roots: (home) => [path.join(home, '.dsh', 'sessions')],
    archivedRoots: () => [],
    parse: parseDshFile,
    match: (name) => name.endsWith('.jsonl') || name.endsWith('.jsonl.zstd'),
  },
};

function int(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

async function* linesOf(file) {
  const r = rl.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const l of r) yield l;
}

function listJsonl(root, match) {
  const test = match || ((name) => name.endsWith('.jsonl'));
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (test(e.name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

function toDateMs(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function tallyTotal(t) { return t.input + t.cacheWrite + t.cacheRead + t.output; }

function addRaw(day, model, tally) {
  // The file-level bucket of the scanned entry — priced later, at merge time.
  const m = day[model] || { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, recordedCache: false };
  m.input += tally.input; m.cacheWrite += tally.cacheWrite;
  m.cacheRead += tally.cacheRead; m.output += tally.output;
  m.recordedCache = m.recordedCache || tally.recordedCache;
  day[model] = m;
}

// ------------------------------------------------------------------ Claude

// Per file: { firstMs, days, replies } where days/replies hold raw tallies.
async function parseClaudeFile(file) {
  const days = new Map();       // dayKey -> { model -> tally }
  const replies = new Map();    // message.id -> { slot, model, tally }
  let firstMs = Infinity;

  for await (const line of linesOf(file)) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let root;
    try { root = JSON.parse(line); } catch { continue; }
    if (!root || root.type !== 'assistant') continue;
    const message = root.message;
    const usage = message && message.usage;
    const model = message && message.model;
    if (!usage || typeof usage !== 'object' || typeof model !== 'string') continue;
    if (model === '<synthetic>') continue; // error placeholders — no request was made
    const at = typeof root.timestamp === 'string' ? toDateMs(root.timestamp) : null;
    if (!at) continue;
    firstMs = Math.min(firstMs, at);
    const slot = agg.startOfLocalDay(at);

    const tally = {
      input: int(usage.input_tokens),
      cacheWrite: int(usage.cache_creation_input_tokens),
      cacheRead: int(usage.cache_read_input_tokens),
      output: int(usage.output_tokens),
      recordedCache: 'cache_read_input_tokens' in usage || 'cache_creation_input_tokens' in usage,
    };
    const id = message.id;
    if (typeof id === 'string' && id) {
      // Streamed lines share the id and carry climbing usage — the last wins;
      // the reply stays placed at its first line's day.
      const prev = replies.get(id);
      replies.set(id, { slot: prev ? prev.slot : slot, model, tally });
    } else if (tallyTotal(tally) > 0) {
      const day = days.get(slot) || {};
      addRaw(day, model, tally);
      days.set(slot, day);
    }
  }
  return { firstMs: firstMs === Infinity ? null : firstMs, days, replies, forked: false, runningTotals: [] };
}

// ------------------------------------------------------------------- Codex

function codexCounts(usage) {
  return {
    input: int(usage && usage.input_tokens),
    cached: int(usage && usage.cached_input_tokens),
    cacheWrite: int(usage && usage.cache_write_input_tokens),
    output: int(usage && usage.output_tokens),
  };
}

async function parseCodexFile(file) {
  const days = new Map();
  const replies = new Map();    // codex:session:runningTotal -> { slot, model, tally, runningTotal }
  const runningTotals = [];
  let firstMs = Infinity;
  let headed = false;
  let session = path.basename(file, '.jsonl');
  let forked = false;
  let replaying = false;
  let model = null;
  let previous = null;

  for await (const line of linesOf(file)) {
    // The rollout's own header is its first; any later one is history.
    if (!headed && line.includes('"session_meta"')) {
      try {
        const root = JSON.parse(line);
        const payload = root && root.type === 'session_meta' ? root.payload : null;
        if (payload) {
          headed = true;
          if (typeof payload.id === 'string' && payload.id) session = payload.id;
          if (typeof payload.forked_from_id === 'string' && payload.forked_from_id) forked = true;
        }
      } catch { }
    }

    // A turn begins; in a fork the `rollout-N` turns replay the parent's work.
    if (line.includes('"task_started"')) {
      try {
        const root = JSON.parse(line);
        const payload = root && root.payload;
        if (payload && payload.type === 'task_started') {
          const turn = typeof payload.turn_id === 'string' ? payload.turn_id : '';
          replaying = forked && turn.startsWith('rollout-');
        }
      } catch { }
      continue;
    }

    // The model in force comes from turn_context; readings before the first
    // one are dropped, as upstream's are.
    if (line.includes('"turn_context"')) {
      try {
        const payload = JSON.parse(line).payload;
        if (payload && typeof payload.model === 'string' && payload.model) model = payload.model;
      } catch { }
      continue;
    }

    if (!line.includes('"token_count"')) continue;
    let root;
    try { root = JSON.parse(line); } catch { continue; }
    const payload = root && root.payload;
    const info = payload && payload.type === 'token_count' ? payload.info : null;
    const totals = info && info.total_token_usage;
    const at = root && typeof root.timestamp === 'string' ? toDateMs(root.timestamp) : null;
    if (!totals || typeof totals !== 'object' || !at || !model) continue;
    firstMs = Math.min(firstMs, at);
    const slot = agg.startOfLocalDay(at);

    const current = codexCounts(totals);
    // A fork's first reading is its parent's total plus its own first
    // request; only the request is the fork's.
    if (previous == null && forked) {
      const last = codexCounts(info.last_token_usage);
      previous = {
        input: Math.max(current.input - last.input, 0),
        cached: Math.max(current.cached - last.cached, 0),
        cacheWrite: Math.max(current.cacheWrite - last.cacheWrite, 0),
        output: Math.max(current.output - last.output, 0),
      };
    }
    const delta = {
      input: current.input - (previous ? previous.input : 0),
      cached: current.cached - (previous ? previous.cached : 0),
      cacheWrite: current.cacheWrite - (previous ? previous.cacheWrite : 0),
      output: current.output - (previous ? previous.output : 0),
    };
    previous = current;
    if (replaying) continue;

    // Codex counts cached tokens inside its input figure; the price list
    // treats them as two separate rates.
    const tally = {
      input: Math.max(delta.input - delta.cached, 0),
      cacheWrite: delta.cacheWrite,
      cacheRead: delta.cached,
      output: delta.output,
      recordedCache: true,
    };
    if (tallyTotal(tally) <= 0) continue;

    // The running total this reading brought the session to — its identity.
    const total = `${current.input}:${current.cached}:${current.output}:${int(totals.total_tokens)}`;
    if (forked) {
      const id = `codex:${session}:${total}`;
      if (!replies.has(id)) replies.set(id, { slot, model, tally, runningTotal: total });
    } else {
      const day = days.get(slot) || {};
      addRaw(day, model, tally);
      days.set(slot, day);
      runningTotals.push(total);
    }
  }
  return { firstMs: firstMs === Infinity ? null : firstMs, days, replies, forked, runningTotals };
}

// --------------------------------------------------------------------- dsh

const ZSTD_MAGIC = 0xfd2fb528;

// dsh appends one zstd frame per event; Node decodes only the first, so the
// file is split at every frame magic and each frame is decompressed alone. A
// torn tail frame (session still writing) is skipped, never fatal.
function decodeTranscript(file) {
  const raw = fs.readFileSync(file);
  if (raw.length < 4 || raw.readUInt32LE(0) !== ZSTD_MAGIC) {
    return raw.toString('utf8').split('\n');
  }
  const offsets = [];
  for (let i = 0; i + 4 <= raw.length; i++) {
    if (raw.readUInt32LE(i) === ZSTD_MAGIC) offsets.push(i);
  }
  const parts = [];
  for (let i = 0; i < offsets.length; i++) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : raw.length;
    try { parts.push(zlib.zstdDecompressSync(raw.subarray(offsets[i], end))); } catch { }
  }
  return Buffer.concat(parts).toString('utf8').split('\n');
}

// Events whose seq is below the session header's seedLength were inherited
// verbatim from a fork and are skipped. Reasoning is a subset of output, so
// it is not added. The dedup key carries the event's identity and counts, so
// a call copied into a fork collapses with its original — even across files.
async function parseDshFile(file) {
  const replies = new Map();
  let firstMs = Infinity;
  let seedLength = 0;
  let headerProvider = null;
  let headerModel = null;

  for (const line of decodeTranscript(file)) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const type = event && event.type;
    const data = event && event.data;
    const seq = int(event && event.seq);

    if (type === 'session') {
      if (!seedLength) seedLength = int(event.seedLength);
      continue;
    }
    if (type === 'request/header') {
      const config = data && data.header && data.header.config;
      if (config && typeof config.provider === 'string') headerProvider = config.provider;
      if (config && typeof config.model === 'string') headerModel = config.model;
      continue;
    }
    if (type !== 'assistant/message' && type !== 'compaction/summary') continue;
    if (seq < seedLength) continue;
    const usage = data && data.usage;
    if (!usage || typeof usage !== 'object') continue;

    const message = data && data.message;
    const source = message && message.source;
    const response = source && source.replayState && source.replayState.response;
    const model = (response && response.responseModel)
      || (source && source.model) || headerModel;
    if (!model) continue;
    const at = int(event.time);
    if (!at) continue;
    firstMs = Math.min(firstMs, at);

    const reasoning = int(usage.reasoningTokens);
    const tally = {
      input: int(usage.inputTokens),
      cacheWrite: int(usage.cacheWriteTokens),
      cacheRead: int(usage.cacheReadTokens),
      output: int(usage.outputTokens), // reasoningTokens is inside outputTokens
      recordedCache: true,
    };
    if (tallyTotal(tally) <= 0) continue;

    let identity;
    if (type === 'compaction/summary') {
      identity = data.compactionId ? `summary:cmp:${data.compactionId}` : `seq:${seq}`;
    } else {
      identity = message && message.id ? `msg:${message.id}` : `assistant:seq:${seq}`;
    }
    const provider = (source && source.provider) || headerProvider || '';
    const key = `dsh:${identity}:${at}:${provider}:${model}:` +
      `${tally.input}:${tally.output}:${tally.cacheRead}:${tally.cacheWrite}:${reasoning}`;
    if (!replies.has(key)) {
      replies.set(key, { slot: agg.startOfLocalDay(at), model, tally });
    }
  }
  return { firstMs: firstMs === Infinity ? null : firstMs, days: new Map(), replies, forked: false, runningTotals: [] };
}

// ------------------------------------------------------------------- zcode

// ZCode's v2 store: ~/.zcode/cli/db/db.sqlite, `model_usage`. The schema
// documents input_tokens as cache-inclusive and output_tokens as
// reasoning-inclusive, so the cache overlap leaves input and reasoning is
// never added twice. A computed_total beyond input+output is unclassified.
function zcodeDays(table) {
  if (!DatabaseSync) return null;
  const file = path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
  if (!fs.existsSync(file)) return null;
  const days = new Map();
  const seen = new Set();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT id, model_id, started_at, completed_at,
      input_tokens, output_tokens, cache_read_input_tokens,
      cache_creation_input_tokens, computed_total_tokens
      FROM model_usage`).all();
    for (const row of rows) {
      const at = Number(row.started_at) || Number(row.completed_at);
      if (!Number.isFinite(at) || at <= 0) continue;
      if (row.id != null && !seen.add(String(row.id))) continue;

      const rawInput = int(row.input_tokens);
      const rawOutput = int(row.output_tokens);
      const computed = Number(row.computed_total_tokens);
      const tally = {
        input: Math.max(0, rawInput - int(row.cache_read_input_tokens) - int(row.cache_creation_input_tokens)),
        cacheWrite: int(row.cache_creation_input_tokens),
        cacheRead: int(row.cache_read_input_tokens),
        output: rawOutput,
        unclassified: Number.isFinite(computed) ? Math.max(0, computed - (rawInput + rawOutput)) : 0,
        recordedCache: true,
      };
      const key = agg.startOfLocalDay(at);
      const day = days.get(key) || agg.emptyDay();
      agg.addTally(day, row.model_id || 'auto', tally, table);
      days.set(key, day);
    }
  } finally { db.close(); }
  return days;
}

// ---------------------------------------------------------------- opencode

// OpenCode's store: ~/.local/share/opencode/opencode.db, `message`. Each
// assistant row's data JSON carries its own `tokens` — input/output/
// reasoning/cache.{read,write}, which sum to `total` (reasoning is a
// separate column there, not inside output). Rows without a tokens object,
// and user rows, count nothing.
function opencodeDays(table) {
  if (!DatabaseSync) return null;
  const file = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
  if (!fs.existsSync(file)) return null;
  const days = new Map();
  const seen = new Set();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare('SELECT id, time_created, data FROM message').all();
    for (const row of rows) {
      if (row.id != null && !seen.add(String(row.id))) continue;
      let data;
      try { data = JSON.parse(row.data); } catch { continue; }
      const tokens = data && data.tokens;
      if (!tokens || typeof tokens !== 'object') continue;
      const at = Number(row.time_created);
      if (!Number.isFinite(at) || at <= 0) continue;

      const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
      const input = int(tokens.input);
      const output = int(tokens.output);
      const read = int(cache.read);
      const write = int(cache.write);
      const total = int(tokens.total);
      // Reasoning bills as output; where a total is reported, never let the
      // parts overrun it (a provider may already fold reasoning into output).
      let reasoning = int(tokens.reasoning);
      if (total > 0) reasoning = Math.min(reasoning, Math.max(total - (input + output + read + write), 0));
      const tally = {
        input,
        cacheWrite: write,
        cacheRead: read,
        output: output + reasoning,
        unclassified: total > 0 ? Math.max(total - (input + output + reasoning + read + write), 0) : 0,
        recordedCache: true,
      };
      const key = agg.startOfLocalDay(at);
      const day = days.get(key) || agg.emptyDay();
      const model = (typeof data.modelID === 'string' && data.modelID) || 'unknown';
      agg.addTally(day, model, tally, table);
      days.set(key, day);
    }
  } finally { db.close(); }
  return days;
}

// ------------------------------------------------------------------- cache

// A log file only ever grows by appending; size + mtime say it is unchanged.
// Parsed per-file results are kept so a refresh rereads only what moved.
function cacheFile(dataDir, source) {
  return path.join(dataDir, `agent-ledger-${source}.json`);
}

function loadCache(dataDir, source) {
  try {
    const o = JSON.parse(fs.readFileSync(cacheFile(dataDir, source), 'utf8'));
    if (o && o.files && typeof o.files === 'object') return o.files;
  } catch { }
  return {};
}

function saveCache(dataDir, source, files) {
  try { fs.writeFileSync(cacheFile(dataDir, source), JSON.stringify({ files })); } catch { }
}

// entries on disk serialize Maps as plain objects.
function serialize(entry) {
  return {
    stamp: entry.stamp, firstMs: entry.firstMs, forked: entry.forked,
    days: Object.fromEntries([...entry.days].map(([k, v]) => [k, v])),
    replies: Object.fromEntries([...entry.replies].map(([k, v]) => [k, v])),
    runningTotals: entry.runningTotals,
  };
}

function deserialize(o) {
  return {
    stamp: o.stamp, firstMs: o.firstMs, forked: !!o.forked,
    days: new Map(Object.entries(o.days || {}).map(([k, v]) => [Number(k), v])),
    replies: new Map(Object.entries(o.replies || {})),
    runningTotals: Array.isArray(o.runningTotals) ? o.runningTotals : [],
  };
}

// ------------------------------------------------------------------- merge

// Every counted reply once, for the file it appeared in first. Files go
// oldest work first, then by name, then by path; Codex forks go after every
// session that is not one, so a parent's running totals are already claimed
// when the fork's copies come by.
function merge(entries, table) {
  const ordered = [...entries.values()].sort((a, b) => {
    if (!!a.forked !== !!b.forked) return a.forked ? 1 : -1;
    if ((a.firstMs || Infinity) !== (b.firstMs || Infinity)) return (a.firstMs || Infinity) - (b.firstMs || Infinity);
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  const days = new Map();
  const claimed = new Set();
  const totals = new Set();

  const add = (slot, model, tally) => {
    if (!Number.isFinite(slot)) return;
    const day = days.get(slot) || agg.emptyDay();
    agg.addTally(day, model, tally, table);
    days.set(slot, day);
  };

  for (const e of ordered) {
    for (const t of e.runningTotals) totals.add(t);
    for (const [slot, models] of e.days) {
      for (const [model, t] of Object.entries(models)) add(slot, model, t);
    }
    for (const [id, reply] of e.replies) {
      if (reply.runningTotal && totals.has(reply.runningTotal)) continue;
      if (claimed.has(id)) continue;
      claimed.add(id);
      if (reply.runningTotal) totals.add(reply.runningTotal);
      add(reply.slot, reply.model, reply.tally);
    }
  }
  return days;
}

async function readLedger(source, dataDir) {
  // ZCode's store is one small SQLite query — straight to days, no cache.
  if (source === 'zcode') {
    const table = await prices.table(dataDir);
    const days = zcodeDays(table);
    return days ? agg.build(days, Date.now(), table) : null;
  }
  // OpenCode's is the same shape: one table, every message row self-contained.
  if (source === 'opencode') {
    const table = await prices.table(dataDir);
    const days = opencodeDays(table);
    return days ? agg.build(days, Date.now(), table) : null;
  }

  const cfg = SOURCES[source];
  if (!cfg) return null;
  const home = os.homedir();

  // Live roots win over archived ones carrying the same rollout name — Codex
  // moves a session it archives; it is still the same file.
  let files = [];
  const liveNames = new Set(listJsonl(cfg.roots(home)[0] || '__none__', cfg.match).map((p) => path.basename(p)));
  for (const root of cfg.roots(home)) files.push(...listJsonl(root, cfg.match));
  for (const root of cfg.archivedRoots(home)) {
    for (const p of listJsonl(root, cfg.match)) if (!liveNames.has(path.basename(p))) files.push(p);
  }
  if (!files.length) return null;

  const table = await prices.table(dataDir);
  const cached = loadCache(dataDir, source);
  const entries = new Map();
  const fresh = {};
  const livePaths = new Set(files);

  for (const file of files) {
    let stamp;
    try {
      const s = fs.statSync(file);
      stamp = { size: s.size, mtimeMs: Math.floor(s.mtimeMs) };
    } catch { continue; }
    const known = cached[file];
    if (known && known.stamp && known.stamp.size === stamp.size && known.stamp.mtimeMs === stamp.mtimeMs) {
      const entry = deserialize(known);
      entry.path = file;
      entries.set(file, entry);
      fresh[file] = known;
      continue;
    }
    let entry;
    try { entry = await cfg.parse(file); } catch { continue; }
    entry.path = file;
    entry.stamp = stamp;
    entries.set(file, entry);
    fresh[file] = serialize(entry);
  }

  // A file gone since the last scan was still work done on this machine —
  // keep counting it unless its name is live elsewhere (a move, not a
  // deletion) or it lived outside the folders this reader reads.
  const allRoots = [...cfg.roots(home), ...cfg.archivedRoots(home)];
  for (const [p, known] of Object.entries(cached)) {
    if (livePaths.has(p)) continue;
    if (!allRoots.some((r) => p.startsWith(r + path.sep))) continue;
    if (liveNames.has(path.basename(p))) continue;
    const entry = deserialize(known);
    entry.path = p;
    entries.set(p, entry);
    fresh[p] = known;
  }

  saveCache(dataDir, source, fresh);
  const days = merge(entries, table);
  return agg.build(days, Date.now(), table);
}

module.exports = { readLedger };
