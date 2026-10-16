// Codex — port of CodexUsageService.swift (endpoint route).
//
// Takes the OAuth credentials Codex stores in ~/.codex/auth.json and asks
// chatgpt.com/backend-api/wham/usage, the same internal endpoint the CLI uses.
// The app-server fallback from the macOS version is not ported yet: a missing
// or refused token reports signInRequired instead.
'use strict';

const path = require('path');
const fs = require('fs');
const U = require('../../shared/usage.js');
const { request } = require('../http.js');

const ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';

function authFile(home) { return path.join(home, '.codex', 'auth.json'); }

function loadCredentials(home) {
  try {
    const root = JSON.parse(fs.readFileSync(authFile(home), 'utf8'));
    const tokens = root.tokens || {};
    const token = tokens.access_token;
    const account = tokens.account_id;
    if (!token) return null;
    return { accessToken: token, accountID: account || '' };
  } catch { return null; }
}

function kind(seconds) {
  if (seconds === 18000) return 'fiveHour';
  if (seconds === 604800) return 'weekly';
  return 'other';
}

function isGroupSpent(limit) {
  return limit.limit_reached === true || limit.allowed === false;
}

// Codex reports "limit reached" for a whole group; only the fullest window
// in it is the reason, so only that one is marked spent.
function markingSpent(windows, spent) {
  if (!spent || !windows.length) return windows;
  const fullest = windows.reduce((a, b) => (b.usedFraction > a.usedFraction ? b : a));
  return windows.map((w) => (w.id === fullest.id ? { ...w, isExhausted: true } : w));
}

function httpWindows(limit, idPrefix, scope) {
  return ['primary_window', 'secondary_window'].map((slot) => {
    const node = limit[slot];
    const percent = node && U.num(node.used_percent);
    if (percent == null) return null;
    const seconds = U.num(node.limit_window_seconds);
    return U.makeWindow({
      id: `${idPrefix}.${slot}`,
      kind: seconds ? kind(seconds) : 'other',
      scope,
      usedFraction: percent / 100,
      windowSeconds: seconds || 0,
      resetsAt: U.parseDate(node.reset_at),
    });
  }).filter(Boolean);
}

function planName(raw) {
  switch (String(raw).toLowerCase()) {
    case 'free': return 'Free';
    case 'go': return 'Go';
    case 'plus': return 'Plus';
    case 'pro': return 'Pro';
    case 'prolite': return 'Pro 5x'; // the 5× Pro tier
    case 'team': return 'Team';
    case 'business': return 'Business';
    case 'enterprise': return 'Enterprise';
    case 'edu': return 'Edu';
    default: return raw;
  }
}

function creditBalance(node) {
  if (!node || node.unlimited === true) return null;
  const raw = node.balance;
  const value = U.num(raw) ?? (typeof raw === 'string' ? U.num(raw.trim()) : null);
  if (value != null && Number.isFinite(value)) {
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return typeof raw === 'string' ? raw : null;
}

function parse(root, account) {
  const windows = [];
  const spendReached = !!(root.spend_control && root.spend_control.reached);

  if (root.rate_limit) {
    const groupSpent = isGroupSpent(root.rate_limit)
      || (root.rate_limit_reached_type != null)
      || spendReached;
    windows.push(...markingSpent(httpWindows(root.rate_limit, 'codex', null), groupSpent));
  }

  for (const extra of root.additional_rate_limits || []) {
    const limit = extra.rate_limit;
    if (!limit) continue;
    const label = extra.limit_name || null;
    const key = extra.metered_feature || label || 'extra';
    windows.push(...markingSpent(httpWindows(limit, key, label), isGroupSpent(limit)));
  }

  if (!windows.length) return U.unavailable(account, 'noLimitsReported', 'endpoint');
  return U.live(account, windows, {
    plan: root.plan_type ? planName(root.plan_type) : null,
    creditBalance: creditBalance(root.credits),
    source: 'endpoint',
  });
}

async function fetchQuota(ctx, credentials) {
  const account = ctx.account || 'codex';
  const creds = credentials || loadCredentials(ctx.home);
  if (!creds) return U.unavailable(account, 'signInRequired', 'endpoint');

  const headers = {
    Authorization: `Bearer ${creds.accessToken}`,
    Accept: 'application/json',
  };
  // An empty header names no account and could put the other login's figures
  // under this ring — it is only sent when there is one.
  if (creds.accountID) headers['ChatGPT-Account-Id'] = creds.accountID;

  const res = await request(ENDPOINT, { timeoutMs: 20000, retries: 2, headers });
  if (res.status === 200 && res.json) return parse(res.json, account);
  if (res.status === 401 || res.status === 403) return U.unavailable(account, 'signInRequired', 'endpoint');
  if (res.status === 429) return U.unavailable(account, 'rateLimited', 'endpoint');
  if (res.status === 0) return U.unavailable(account, 'unreachable', 'endpoint');
  if (res.status === 200) return U.unavailable(account, 'unreadableReply', 'endpoint');
  return U.unavailable(account, 'serverError', 'endpoint');
}

async function fetchUsage(ctx, credentials) {
  const usage = await fetchQuota(ctx, credentials);

  // The CLI's own rollouts are the "on this Mac" history — it answers
  // whether the quota route did or not.
  try {
    const ledger = await require('../agentLedger.js').readLedger('codex', ctx.dataDir);
    if (ledger) usage.ledger = ledger;
  } catch { /* missing or unreadable transcripts are simply no history */ }

  return usage;
}

module.exports = { fetchUsage, authFile, loadCredentials };
