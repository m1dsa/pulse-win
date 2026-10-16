// Model price list — port of ModelPrices.swift.
// Downloads https://models.dev/api.json once a day, keeps the providers Pulse
// can see transcripts for, caches the filtered table in the app data dir.
// Rates are per MILLION tokens; a missing cache rate falls back to input.
'use strict';

const fs = require('fs');
const path = require('path');
const { request } = require('./http.js');

const SOURCE = 'https://models.dev/api.json';
const CACHE_FILE = 'model-prices-5.json';
const REFRESH_MS = 24 * 3600 * 1000;
const RETRY_MS = 5 * 60 * 1000;

const PROVIDERS = [
  'anthropic', 'openai', 'xai', 'moonshotai', 'zhipuai', 'minimax',
  'deepseek', 'google', 'xiaomi', 'alibaba', 'mistral', 'meta',
];
// Plan vendors, namespaced `vendor|id`, consulted only when asked for that vendor.
const VENDORS = ['opencode-go', 'kilo', 'cline-pass'];

let memory = null;       // { fetchedAt, prices }
let nextFetchAt = 0;
let inFlight = null;

function cacheFile(dataDir) { return path.join(dataDir, CACHE_FILE); }

function readCache(dataDir) {
  try {
    const o = JSON.parse(fs.readFileSync(cacheFile(dataDir), 'utf8'));
    if (o && typeof o.fetchedAt === 'number' && o.prices) return o;
  } catch { /* none */ }
  return null;
}

function tiersIn(cost) {
  const found = [];
  for (const entry of cost.tiers || []) {
    const shape = entry && entry.tier;
    if (!shape || shape.type !== 'context') continue;
    let size = Number(shape.size);
    if (!Number.isFinite(size) || size <= 1) continue;
    const threshold = (size - 1) % 1000 === 0 ? size - 1 : size;
    const input = Number(entry.input), output = Number(entry.output);
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    found.push({
      threshold, input, output,
      cacheRead: Number.isFinite(Number(entry.cache_read)) ? Number(entry.cache_read) : null,
      cacheWrite: Number.isFinite(Number(entry.cache_write)) ? Number(entry.cache_write) : null,
    });
  }
  const over = cost.context_over_200k;
  if (!found.length && over && Number.isFinite(Number(over.input)) && Number.isFinite(Number(over.output))) {
    found.push({
      threshold: 200000, input: Number(over.input), output: Number(over.output),
      cacheRead: Number.isFinite(Number(over.cache_read)) ? Number(over.cache_read) : null,
      cacheWrite: Number.isFinite(Number(over.cache_write)) ? Number(over.cache_write) : null,
    });
  }
  found.sort((a, b) => a.threshold - b.threshold);
  return found.length ? found : null;
}

async function download() {
  const res = await request(SOURCE, { timeoutMs: 30000, retries: 1 });
  if (res.status !== 200 || !res.json) return null;
  const root = res.json;
  const prices = {};

  const collect = (group, prefix) => {
    const models = root[group] && root[group].models;
    if (!models || typeof models !== 'object') return;
    for (const [id, model] of Object.entries(models)) {
      if (prices[prefix + id]) continue;
      const cost = model && model.cost;
      if (!cost) continue;
      const input = Number(cost.input), output = Number(cost.output);
      if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
      prices[prefix + id] = {
        input, output,
        cacheRead: Number.isFinite(Number(cost.cache_read)) ? Number(cost.cache_read) : null,
        cacheWrite: Number.isFinite(Number(cost.cache_write)) ? Number(cost.cache_write) : null,
        name: typeof model.name === 'string' ? model.name : null,
        tiers: tiersIn(cost),
      };
    }
  };
  for (const p of PROVIDERS) collect(p, '');
  for (const v of VENDORS) collect(v, v + '|');
  return Object.keys(prices).length ? prices : null;
}

// The price table, fresh where the network allows; a stale or absent one is
// better than none and a model it misses is simply left unpriced.
async function table(dataDir) {
  const now = Date.now();
  if (memory && now < nextFetchAt) return memory.prices;
  if (inFlight) return inFlight;

  if (!memory) {
    const saved = readCache(dataDir);
    if (saved) {
      memory = saved;
      if (now < saved.fetchedAt + REFRESH_MS) {
        nextFetchAt = saved.fetchedAt + REFRESH_MS;
        return saved.prices;
      }
    }
  }

  inFlight = (async () => {
    const fetched = await download();
    if (fetched) {
      memory = { fetchedAt: now, prices: fetched };
      nextFetchAt = now + REFRESH_MS;
      try { fs.writeFileSync(cacheFile(dataDir), JSON.stringify(memory)); } catch { }
    } else {
      nextFetchAt = now + RETRY_MS;
    }
    inFlight = null;
    return memory ? memory.prices : {};
  })();
  return inFlight;
}

// ---------------------------------------------------------------- lookup

// digit-dash-digit is a version spelled with the wrong separator:
// gpt-5-6-sol is gpt-5.6-sol.
function dotted(model) {
  return model.replace(/(\d)-(\d)/g, '$1.$2');
}

function aliases(model) {
  const out = [];
  if (model.endsWith('-build') && model !== 'grok-build-0.1') {
    out.push(model.slice(0, -6));
  }
  for (const effort of ['-medium', '-high', '-low', '-minimal']) {
    if (model.endsWith(effort)) {
      const base = model.slice(0, -effort.length);
      out.push(base, dotted(base));
    }
  }
  out.push(dotted(model));

  const m = /-\d+[kKmM]$/.exec(model);
  if (m) {
    const base = model.slice(0, m.index);
    out.push(base, ...aliases(base));
  }
  if (/^k[\dp]+$/.test(model)) out.push('kimi-' + model.replace(/p/g, '.'));
  return out.filter((c) => c !== model);
}

function priceFor(model, table, vendor) {
  if (!model || !table) return null;
  const exact = (k) => table[k] || null;
  const folded = (k) => {
    const low = k.toLowerCase();
    for (const key of Object.keys(table)) if (key.toLowerCase() === low) return table[key];
    return null;
  };
  const hit = exact(model) || folded(model);
  if (hit) return hit;
  for (const c of aliases(model)) {
    const p = exact(c) || folded(c);
    if (p) return p;
  }
  if (vendor) {
    const vk = `${vendor}|${model}`;
    const p = exact(vk) || folded(vk);
    if (p) return p;
    for (const c of aliases(model)) {
      const q = exact(`${vendor}|${c}`) || folded(`${vendor}|${c}`);
      if (q) return q;
    }
  }
  return null;
}

// ------------------------------------------------------------- pricing

// A tally: { input, cacheWrite, cacheRead, output }. Cost in dollars.
// A long-context request is priced at its tier, whole; contextBands carries
// one band's worth of requests when the caller knows the context size.
const CONTEXT_BOUNDARIES = [128000, 200000, 256000, 272000];

function flatCost(t, p) {
  return (t.input * p.input
    + t.cacheWrite * (p.cacheWrite != null ? p.cacheWrite : p.input)
    + t.cacheRead * (p.cacheRead != null ? p.cacheRead : p.input)
    + t.output * p.output) / 1e6;
}

function cost(tally, price, context) {
  if (!price) return 0;
  const band = context != null
    ? [...CONTEXT_BOUNDARIES].reverse().find((b) => context > b) : null;
  let p = price;
  if (band != null && price.tiers) {
    const tier = [...price.tiers].reverse().find((t) => t.threshold <= band);
    if (tier) p = tier;
  }
  return flatCost(tally, p);
}

module.exports = { table, priceFor, cost };
