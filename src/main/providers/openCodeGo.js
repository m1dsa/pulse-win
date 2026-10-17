// OpenCode — port of OpenCodeGoUsageService.swift's key route, plus a local
// usage ledger from its own database.
//
// Quota: GET https://opencode.ai/zen/go/v1/usage with a Bearer key. The
// pasted key wins; otherwise the one OpenCode saved for itself at
// ~/.local/share/opencode/auth.json under "opencode-go". A 403 carrying
// {"error":{"type":"EntitlementError"}} is a working key on an account with
// no Go subscription — noPlan, not a refused key.
//
// Ledger: ~/.local/share/opencode/opencode.db, the `message` table — every
// assistant message row carries its own token counts, so per-day history
// exists whether or not the account has a Go subscription.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('../../shared/usage.js');
const { request, bearer } = require('../http.js');

const ENDPOINT = 'https://opencode.ai/zen/go/v1/usage';
const ACCOUNT = 'openCodeGo';

// -------------------------------------------------------------- stored key

function storedKey() {
  const file = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
  try {
    const root = JSON.parse(fs.readFileSync(file, 'utf8'));
    const key = root && root['opencode-go'] && root['opencode-go'].key;
    return typeof key === 'string' && key ? key : null;
  } catch { return null; }
}

// -------------------------------------------------------------------- read

function isEntitlementError(res) {
  return res && res.json && res.json.error && res.json.error.type === 'EntitlementError';
}

function toWindow(reported, id, kind, seconds, reportsLength) {
  const percent = reported && U.num(reported.percent);
  if (percent == null) return null;
  return U.makeWindow({
    id, kind,
    usedFraction: percent / 100,
    windowSeconds: seconds,
    resetsAt: U.parseDate(reported.resetsAt),
    reportsLength,
    // The provider's own verdict: anything but "ok" is spent.
    isExhausted: String(reported.status || 'ok').toLowerCase() !== 'ok',
  });
}

function windowsFromReply(reply) {
  const u = reply && reply.usage;
  if (!u || typeof u !== 'object') return [];
  return [
    // The reply's "rolling" window is the five-hour one — measured, its
    // reported reset lands five hours out.
    toWindow(u.rolling, 'rolling', 'fiveHour', 5 * 3600, true),
    toWindow(u.weekly, 'weekly', 'weekly', 7 * 86400, true),
    // A month is not thirty days: the reply gives a reset and no start, so
    // the nominal length only orders the row.
    toWindow(u.monthly, 'monthly', 'monthly', 30 * 86400, false),
  ].filter(Boolean);
}

async function fetchByKey(key) {
  const res = await request(ENDPOINT, { timeoutMs: 15000, retries: 1, headers: bearer(key) });

  if (res.status === 200) {
    const windows = windowsFromReply(res.json);
    if (!windows.length) return U.unavailable(ACCOUNT, 'noLimitsReported');
    // The reply carries limits and nothing else — no plan name, no balance.
    return U.live(ACCOUNT, windows, {});
  }

  if (res.status === 403 && isEntitlementError(res)) return U.unavailable(ACCOUNT, 'noPlan');
  if (res.status === 401 || res.status === 403) return U.unavailable(ACCOUNT, 'apiKeyRefused');
  if (res.status === 429) return U.unavailable(ACCOUNT, 'rateLimited');
  if (res.status === 0) return U.unavailable(ACCOUNT, 'unreachable');
  if (res.status === 200) return U.unavailable(ACCOUNT, 'unreadableReply');
  return U.unavailable(ACCOUNT, 'serverError');
}

// ------------------------------------------------------------------- fetch

async function fetchUsage(ctx) {
  const key = (ctx.key && String(ctx.key).trim()) || storedKey();
  const usage = key ? await fetchByKey(key) : U.unavailable(ACCOUNT, 'apiKeyMissing');

  // OpenCode's own database records every message's tokens whether or not
  // the quota route can answer.
  try {
    const ledger = await require('../agentLedger.js').readLedger('opencode', ctx.dataDir);
    if (ledger) usage.ledger = ledger;
  } catch { /* a missing or unreadable database is simply no history */ }

  return usage;
}

module.exports = { fetchUsage, storedKey };
