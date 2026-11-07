'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const agg = require('../src/main/ledgerAggregate.js');
const prices = require('../src/main/prices.js');
const ledger = require('../src/main/agentLedger.js');

function calendarSpan(year, month, date) {
  const days = new Map();
  for (let i = 0; i < 7; i++) {
    days.set(new Date(year, month, date + i).getTime(), { ...agg.emptyDay(), tokens: i + 1 });
  }
  const now = new Date(year, month, date + 6, 12).getTime();
  assert.deepEqual(agg.recent(days, 7, now).map(d => d.tokens), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(agg.figure(days, 7, now).tokens, 28);
}

(async () => {
  const oldTZ = process.env.TZ;
  const oldHome = os.homedir;
  const oldTable = prices.table;
  const oldStream = fs.createReadStream;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ledger-calendar-'));
  try {
    process.env.TZ = 'America/Los_Angeles';
    calendarSpan(2026, 2, 5); // Spring forward: a day lasts 23 hours.
    calendarSpan(2026, 9, 29); // Fall back: a day lasts 25 hours.
    calendarSpan(2026, 9, 24);
    console.log('PASS seven calendar days across spring, fall and ordinary weeks');

    os.homedir = () => temp;
    prices.table = async () => ({});
    const sessions = path.join(temp, '.codex', 'sessions');
    const data = path.join(temp, 'data');
    fs.mkdirSync(sessions, { recursive: true });
    fs.mkdirSync(data);
    const file = path.join(sessions, 'rollout-fixture.jsonl');
    const at = '2026-10-25T02:30:00Z';
    const totals = { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 10, total_tokens: 1010 };
    const event = { timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: totals } } };
    fs.writeFileSync(file, [
      { type: 'session_meta', payload: { id: 'fixture' } },
      { type: 'turn_context', payload: { model: 'fixture-model' } },
      event, event, // Repeated cumulative readings must not double count.
    ].map(JSON.stringify).join('\n') + '\n');
    const stat = fs.statSync(file);
    const stamp = { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) };
    const tally = { input: 100, cacheRead: 900, cacheWrite: 0, output: 10, recordedCache: true };
    const missing = path.join(sessions, 'rollout-deleted.jsonl');
    const missingSlot = new Date(2026, 9, 26, 1).getTime();
    const cacheFile = path.join(data, 'agent-ledger-codex.json');
    fs.writeFileSync(cacheFile, JSON.stringify({ files: {
      [file]: { stamp, days: { [new Date(2026, 9, 25, 1).getTime()]: { 'fixture-model': { ...tally, output: 9999 } } } },
      [missing]: { stamp: {}, days: { [missingSlot]: { 'fixture-model': tally } } },
    } }));
    let scans = 0;
    fs.createReadStream = function (p, ...args) { if (p === file) scans++; return oldStream.call(this, p, ...args); };
    const first = await ledger.readLedgerDays('codex', data);
    assert.equal(first.get(agg.startOfLocalDay(Date.parse(at))).tokens, 1010);
    assert.equal(scans, 1);
    assert.equal([...first.values()].reduce((n, d) => n + d.tokens, 0), 2020);
    assert.equal(first.get(agg.startOfLocalDay(missingSlot)).tokens, 1010);
    console.log('PASS legacy cache rebuilt from raw events, cumulative counts deduplicated, deleted history retained');

    await ledger.readLedgerDays('codex', data);
    assert.equal(scans, 1);
    console.log('PASS unchanged files reuse cache within the same calendar context');

    process.env.TZ = 'Asia/Shanghai';
    const shifted = await ledger.readLedgerDays('codex', data);
    assert.equal(scans, 2);
    assert.equal(shifted.get(agg.startOfLocalDay(Date.parse(at))).tokens, 1010);
    assert.equal([...shifted.values()].reduce((n, d) => n + d.tokens, 0), 2020);
    console.log('PASS timezone change reparses unchanged transcripts without losing token history');
  } finally {
    os.homedir = oldHome;
    prices.table = oldTable;
    fs.createReadStream = oldStream;
    if (oldTZ == null) delete process.env.TZ; else process.env.TZ = oldTZ;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
