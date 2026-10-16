// Shared per-day aggregation → the compact ledger object the card renders.
// Every ledger source (Devin's sqlite, the CLI JSONL transcripts) fills the
// same `days` map: dayStartMs -> { tokens, cost, unpriced, models, tallies,
// cacheable } — and this file turns it into the card's figures.
'use strict';

const prices = require('./prices.js');

const SPAN = 31;

function startOfLocalDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function emptyDay() {
  return { tokens: 0, cost: 0, unpriced: 0, models: {}, tallies: {}, cacheable: false };
}

// Add one message's tally to a day bucket, priced at API rates. A model with
// no published price is counted, never priced — `unpriced` says how much of
// the figure money could not cover.
function addTally(day, model, tally, table) {
  // `unclassified`: tokens a store reports without naming their kind — counted
  // as used, never priced, never sorted into a bucket it might not be.
  const unclassified = Math.max(0, tally.unclassified || 0);
  const total = tally.input + tally.cacheWrite + tally.cacheRead + tally.output + unclassified;
  if (total <= 0) return;
  const context = tally.input + tally.cacheRead + tally.cacheWrite;
  const price = table ? prices.priceFor(model, table) : null;
  day.tokens += total;
  if (price) day.cost += prices.cost(tally, price, context);
  day.unpriced += unclassified;
  if (!price) day.unpriced += total - unclassified;
  day.models[model] = (day.models[model] || 0) + total;
  const mt = day.tallies[model] || { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  mt.input += tally.input; mt.cacheWrite += tally.cacheWrite;
  mt.cacheRead += tally.cacheRead; mt.output += tally.output;
  day.tallies[model] = mt;
  if (tally.cacheRead || tally.cacheWrite || tally.recordedCache) day.cacheable = true;
}

// The last `count` calendar days ending today, oldest first; days before the
// first record are left off, days after the last are quiet bars.
function recent(days, count, now) {
  const today = startOfLocalDay(now);
  const start = today - (count - 1) * 86400000;
  const first = Math.min(...days.keys());
  const from = Math.max(start, first);
  const out = [];
  for (let d = from; d <= today; d += 86400000) {
    out.push(days.get(d) || emptyDay());
  }
  return out;
}

function figure(days, count, now) {
  const span = recent(days, count, now);
  let tokens = 0, cost = 0, unpriced = 0;
  for (const d of span) { tokens += d.tokens; cost += d.cost; unpriced += d.unpriced; }
  return { tokens, cost, unpriced };
}

function topModel(days, now, table) {
  let span = recent(days, SPAN, now);
  if (!span.some((d) => d.tokens > 0)) span = [...days.keys()].sort().map((k) => days.get(k));
  const totals = {};
  for (const d of span) for (const [m, t] of Object.entries(d.models)) totals[m] = (totals[m] || 0) + t;
  let best = null, overall = 0;
  for (const [m, t] of Object.entries(totals)) {
    overall += t;
    if (!best || t > best.t) best = { m, t };
  }
  if (!best || !overall) return null;
  const name = (table && prices.priceFor(best.m, table) && prices.priceFor(best.m, table).name) || best.m;
  return { name, share: best.t / overall };
}

// Cache reads over every input token — fresh, written, and read — across the
// models that record cache fields at all.
function cacheHit(days, now) {
  const span = recent(days, SPAN, now);
  let input = 0, read = 0;
  for (const d of span) {
    for (const [model, t] of Object.entries(d.tallies)) {
      const recordsCache = d.cacheable || t.cacheRead > 0 || t.cacheWrite > 0;
      if (!recordsCache) continue; // a model that says nothing about cache has no hits possible
      input += t.input + t.cacheWrite + t.cacheRead;
      read += t.cacheRead;
    }
  }
  return input > 0 ? read / input : null;
}

// The compact object the renderer draws; null when there is nothing to read.
function build(days, now, table) {
  if (!days || !days.size) return null;
  const week = figure(days, 7, now);
  const month = figure(days, SPAN, now);
  const today = days.get(startOfLocalDay(now)) || emptyDay();
  return {
    today: { tokens: today.tokens, cost: today.cost, unpriced: today.unpriced },
    week, month,
    bars: recent(days, SPAN, now).map((d) => d.tokens),
    topModel: topModel(days, now, table),
    cacheHit: cacheHit(days, now),
  };
}

module.exports = { SPAN, startOfLocalDay, emptyDay, addTally, recent, figure, topModel, cacheHit, build };
