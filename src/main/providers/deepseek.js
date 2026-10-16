// DeepSeek — port of DeepSeekUsageService.swift + BalanceRing.
//
// One documented route: GET api.deepseek.com/user/balance with a pasted key.
// There is no allowance, no window, no reset — the reply reports money and
// stops, so the ring's denominator comes from BalanceRing: the highest balance
// observed ('sinceTopUp'), a figure the user typed ('yourBudget'), or nothing
// ('balanceOnly'). Only the provider's own is_available marks spent.
'use strict';

const path = require('path');
const fs = require('fs');
const U = require('../../shared/usage.js');
const { request, bearer } = require('../http.js');

const ENDPOINT = 'https://api.deepseek.com/user/balance';
const CONSOLE = 'https://platform.deepseek.com';

// The web console's own sign-in, pasted as the `userToken` localStorage value
// (or the whole {"value":"…"} wrapper). It answers the balance and the last
// thirty days of per-model usage and charges for anyone without an API key.
// Every route replies HTTP 200 with {code, data:{biz_code, biz_data}} — a
// refused token is a 40002–40099 code, not an HTTP error.
function consoleToken(raw) {
  if (!raw) return null;
  const t = String(raw).trim();
  if (!t) return null;
  if (t.startsWith('{')) {
    try {
      const v = JSON.parse(t).value;
      return typeof v === 'string' && v.trim() ? v.trim() : null;
    } catch { return null; }
  }
  return t;
}

async function consoleGet(path, query, token) {
  const url = new URL(CONSOLE + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const res = await request(url.toString(), {
    timeoutMs: 20000, retries: 1,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (res.status === 401) return { out: 'signedOut' };
  if (res.status !== 200 || !res.json) return { out: 'failed' };
  const code = res.json.code;
  if (typeof code === 'number' && code !== 0) {
    return { out: code >= 40002 && code < 40100 ? 'signedOut' : 'failed' };
  }
  const data = res.json.data;
  if (!data || (typeof data.biz_code === 'number' && data.biz_code !== 0)) return { out: 'failed' };
  return { out: 'read', body: data.biz_data };
}

// A console figure arrives as a number, a string, or {value: either}.
function fig(v) {
  if (v && typeof v === 'object') v = v.value;
  const n = Number(typeof v === 'string' ? v.trim() : v);
  return Number.isFinite(n) && Math.abs(n) < 1e15 ? n : 0;
}

// The console's wallets as the key route's purse shape, so the ring is drawn
// by exactly the same rule whichever credential answered.
function consolePurses(body) {
  const out = [];
  for (const [wallets, isBonus] of [[body && body.normal_wallets, true], [body && body.bonus_wallets, false]]) {
    for (const w of Array.isArray(wallets) ? wallets : []) {
      const currency = w && w.currency;
      const amount = fig(w && w.balance);
      if (!currency) continue;
      let p = out.find((x) => x.currency === currency);
      if (!p) { p = { currency, total: 0, granted: 0, toppedUp: 0 }; out.push(p); }
      p.total += amount;
      if (isBonus) p.granted += amount; else p.toppedUp += amount;
    }
  }
  return out;
}

// The console's own last-30-days history: tokens per day per model, plus the
// money actually charged — its figure, not an API-price estimate.
async function consoleLedger(token, preferredCurrency) {
  const aggMod = require('../ledgerAggregate.js');
  const days = 30;
  const todayStart = aggMod.startOfLocalDay(Date.now());
  const start = Math.floor(todayStart / 1000) - (days - 1) * 86400;
  const end = Math.floor(todayStart / 1000) + 86400;
  const tz = -new Date().getTimezoneOffset() * 60;
  const wholeHours = Math.floor(tz / 3600) * 3600;
  const query = { start: start + (tz - wholeHours), end: end + (tz - wholeHours), tz: wholeHours };

  const [amount, cost] = await Promise.all([
    consoleGet('/api/v0/usage/by_api_key/amount', query, token),
    consoleGet('/api/v0/usage/by_api_key/cost', query, token),
  ]);
  if (amount.out === 'signedOut' || cost.out === 'signedOut') return 'signedOut';
  if (amount.out !== 'read' || cost.out !== 'read') return null;

  const bucket = (amount.body && amount.body.bucket) || 86400;
  const dayOf = (time) => aggMod.startOfLocalDay((time + bucket / 2) * 1000);
  const daysMap = new Map();
  const dayFor = (k) => {
    if (!daysMap.has(k)) {
      daysMap.set(k, { tokens: 0, cost: 0, unpriced: 0, models: {}, tallies: {}, cacheable: true });
    }
    return daysMap.get(k);
  };

  for (const series of (amount.body && amount.body.series) || []) {
    const model = series.model || '';
    for (const b of series.buckets || []) {
      const u = b.usage || {};
      const tally = {
        input: Math.round(fig(u.PROMPT_CACHE_MISS_TOKEN)),
        cacheWrite: 0,
        cacheRead: Math.round(fig(u.PROMPT_CACHE_HIT_TOKEN)),
        output: Math.round(fig(u.RESPONSE_TOKEN)),
      };
      const total = tally.input + tally.cacheRead + tally.output;
      if (total <= 0) continue;
      const day = dayFor(dayOf(b.time));
      day.tokens += total;
      if (model) day.models[model] = (day.models[model] || 0) + total;
      const mt = day.tallies[model] || { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
      mt.input += tally.input; mt.cacheRead += tally.cacheRead; mt.output += tally.output;
      day.tallies[model] = mt;
    }
  }

  // Which purse's money the ledger carries: the preferred currency's, else
  // the first with any charge, else the first — a zero purse would claim the
  // work was free.
  const purses = ((cost.body && cost.body.data) || []).filter((p) => p && p.currency);
  const hasMoney = (p) => (p.series || []).some((s) => (s.buckets || []).some((b) => fig(b.cost) > 0));
  const purse_ = purses.find((p) => p.currency === preferredCurrency && hasMoney(p))
    || purses.find(hasMoney) || purses.find((p) => p.currency === preferredCurrency) || purses[0];
  if (purse_) {
    for (const series of purse_.series || []) {
      for (const b of series.buckets || []) {
        const charged = fig(b.cost);
        if (!charged) continue;
        dayFor(dayOf(b.time)).cost += charged;
      }
    }
  }
  if (!daysMap.size) return null;
  const ledger = aggMod.build(daysMap, Date.now(), null);
  if (ledger) {
    ledger.title = 'usageHistory';
    if (purse_) { ledger.note = 'server'; ledger.currency = purse_.currency; }
  }
  return ledger;
}

async function consoleFetch(ctx, token) {
  const account = 'deepSeek';
  const summary = await consoleGet('/api/v0/users/get_user_summary', {}, token);
  if (summary.out === 'signedOut') return U.unavailable(account, 'consoleSignedOut');
  if (summary.out !== 'read') return U.unavailable(account, 'serverError');

  const purses = consolePurses(summary.body);
  const purse_ = (ctx.currency && purses.find((p) => p.currency === ctx.currency))
    || purses.find((p) => p.total > 0) || purses[0];
  if (!purse_) return U.unavailable(account, 'noLimitsReported');

  const marks = loadMarks(ctx.dataDir);
  const mark = advance(marks[purse_.currency], purse_.total);
  if (marks[purse_.currency] !== mark) { marks[purse_.currency] = mark; saveMarks(ctx.dataDir, marks); }

  const window = balanceWindow(purse_.total, ctx.basis || 'sinceTopUp', ctx.budget, mark.peak, false);
  const usage = U.live(account, window ? [window] : [], {
    creditBalance: moneyText(purse_.total, purse_.currency),
    creditRemaining: { amount: purse_.total, currency: purse_.currency },
  });

  // The thirty-day history is the console's own bill, worth showing beside
  // the ring whenever it reads.
  const ledger = await consoleLedger(token, purse_.currency);
  if (ledger && typeof ledger === 'object') usage.ledger = ledger;
  return usage;
}

function baselineFile(dataDir) { return path.join(dataDir, 'balance-baseline.json'); }

function loadMarks(dataDir) {
  try { return JSON.parse(fs.readFileSync(baselineFile(dataDir), 'utf8')) || {}; } catch { return {}; }
}
function saveMarks(dataDir, marks) {
  try { fs.mkdirSync(path.dirname(baselineFile(dataDir)), { recursive: true });
    fs.writeFileSync(baselineFile(dataDir), JSON.stringify(marks)); } catch { /* best effort */ }
}

// The mark only ever advances: it is the highest balance Pulse has watched.
function advance(mark, seeing) {
  const now = Date.now();
  if (!mark || !(mark.peak > 0)) return { peak: seeing, setAt: now };
  return seeing > mark.peak ? { peak: seeing, setAt: now } : mark;
}

function money(text) {
  if (text == null) return null;
  const t = String(text).trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function purse(reply, preferredCurrency) {
  const infos = Array.isArray(reply.balance_infos) ? reply.balance_infos : [];
  const purses = infos.map((i) => {
    const currency = i.currency;
    const total = money(i.total_balance);
    if (!currency || total == null) return null;
    return { currency, total, granted: money(i.granted_balance), toppedUp: money(i.topped_up_balance) };
  }).filter(Boolean);
  if (!purses.length) return null;
  if (preferredCurrency) {
    const chosen = purses.find((p) => p.currency === preferredCurrency);
    if (chosen) return chosen;
  }
  return purses.find((p) => p.total > 0) || purses[0];
}

// The API account's ring: money and at most one denominator.
function balanceWindow(balance, basis, budget, peak, isExhausted) {
  let used = null;
  let estimate = null;
  if (basis === 'sinceTopUp' && peak > 0) {
    used = (peak - balance) / peak;
    estimate = 'sinceTopUp';
  } else if (basis === 'yourBudget' && budget > 0) {
    used = (budget - balance) / budget;
    estimate = 'yourBudget';
  }
  if (used == null) return null; // balanceOnly, or a basis with no denominator: draw money, not a ring
  return U.makeWindow({
    id: 'deepseek.balance',
    kind: 'balance',
    usedFraction: U.clamp01(used),
    windowSeconds: 30 * 86400, // sort key only
    reportsLength: false,
    estimate,
    // A zero balance is arithmetic, not the provider's word — fills to 99% max.
    isExhausted: isExhausted === true,
  });
}

function moneyText(amount, currency) {
  const sym = { CNY: '¥', USD: '$', HKD: 'HK$', TWD: 'NT$', JPY: '¥', KRW: '₩', RUB: '₽' }[currency] || (currency + ' ');
  return `${sym}${Number(amount).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

async function fetchUsage(ctx) {
  const account = 'deepSeek';
  const key = ctx.key;
  let usage;

  if (!key) {
    usage = U.unavailable(account, 'apiKeyMissing');
  } else if (key.startsWith('sk-')) {
    const res = await request(ENDPOINT, { timeoutMs: 15000, retries: 1, headers: bearer(key) });
    if (res.status === 401 || res.status === 403) {
      usage = U.unavailable(account, 'apiKeyRefused');
    } else if (res.status === 429) {
      usage = U.unavailable(account, 'rateLimited');
    } else if (res.status === 0) {
      usage = U.unavailable(account, 'unreachable');
    } else if (res.status !== 200 || !res.json) {
      usage = U.unavailable(account, res.status === 200 ? 'unreadableReply' : 'serverError');
    } else {
      const purse_ = purse(res.json, ctx.currency);
      if (!purse_) {
        usage = U.unavailable(account, 'noLimitsReported');
      } else {
        const marks = loadMarks(ctx.dataDir);
        const mark = advance(marks[purse_.currency], purse_.total);
        if (marks[purse_.currency] !== mark) {
          marks[purse_.currency] = mark;
          saveMarks(ctx.dataDir, marks);
        }
        const window = balanceWindow(purse_.total, ctx.basis || 'sinceTopUp', ctx.budget, mark.peak, res.json.is_available === false);
        usage = U.live(account, window ? [window] : [], {
          creditBalance: moneyText(purse_.total, purse_.currency),
          creditRemaining: { amount: purse_.total, currency: purse_.currency },
        });
        if (!window && res.json.is_available === false) {
          // The provider says the account cannot pay — that IS worth a spent mark even with no ring.
          usage.creditRemaining.isExhausted = true;
        }
      }
    }
  } else {
    // Not sk-shaped: treated as the web console's userToken.
    const token = consoleToken(key);
    usage = token ? await consoleFetch(ctx, token) : U.unavailable(account, 'apiKeyRefused');
  }

  // DeepSeek Harness keeps its own transcripts on this machine — the "本机用量"
  // the card shows works with or without any credential. The console's own
  // billed history (when a userToken answered) is the better one.
  if (!usage.ledger) {
    try {
      const ledger = await require('../agentLedger.js').readLedger('dsh', ctx.dataDir);
      if (ledger) usage.ledger = ledger;
    } catch { /* no transcripts is no history */ }
  }

  return usage;
}

module.exports = { fetchUsage };
