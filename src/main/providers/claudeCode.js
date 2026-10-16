// Claude Code — port of ClaudeCodeUsageService.swift.
//
// Main route: the account's own usage endpoint with the OAuth token the CLI
// stored in ~/.claude/.credentials.json (on Windows there is no login keychain;
// the file is the primary store). Fallback: ~/.claude/pulse-usage.json written
// by `Pulse --statusline` — a push that ages between sessions, so it reports
// .stale rather than pretending to be current.
'use strict';

const path = require('path');
const fs = require('fs');
const U = require('../../shared/usage.js');
const { request } = require('../http.js');

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE = 'https://api.anthropic.com/api/oauth/profile';
const FRESH_FOR = 10 * 60 * 1000;

// The plan cache survives between refreshes: one profile call per 6h at most.
const planCache = new Map(); // accountId -> {name, at}

function credentialsFile(home) { return path.join(home, '.claude', '.credentials.json'); }
function cacheFile(home) { return path.join(home, '.claude', 'pulse-usage.json'); }
function settingsFile(home) { return path.join(home, '.claude', 'settings.json'); }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function storedCredentials(home) {
  const root = readJson(credentialsFile(home));
  if (!root || !root.claudeAiOauth) return null;
  return root;
}

function unexpiredAccessToken(root) {
  const oauth = root && root.claudeAiOauth;
  const token = oauth && oauth.accessToken;
  if (!token) return null;
  const expiresAt = U.num(oauth.expiresAt);
  if (expiresAt && expiresAt <= Date.now()) return null; // expiry is in ms
  return token;
}

// The plan's name is also inside the credentials file on Windows
// (subscriptionType / rateLimitTier); the profile endpoint is the fallback.
function planFromCredentials(root) {
  const oauth = root && root.claudeAiOauth;
  if (!oauth) return null;
  const stated = oauth.subscriptionType;
  const tier = (oauth.rateLimitTier || '').toLowerCase();
  const multiplier = ['20x', '5x'].find((m) => tier.endsWith('_' + m));
  if (stated) {
    const name = tidy(stated);
    return multiplier ? `${name} ${multiplier}` : name;
  }
  return planFromTier(tier, multiplier, null);
}

function planFromTier(tier, multiplier, orgType) {
  if (!tier) return orgType ? tidy(orgType) : null;
  const base = tier.includes('max') ? 'Max'
    : tier.includes('team') ? 'Team'
    : tier.includes('enterprise') ? 'Enterprise'
    : tier.includes('pro') ? 'Pro'
    : tier.includes('free') ? 'Free' : tidy(tier);
  return multiplier ? `${base} ${multiplier}` : base;
}

function tidy(raw) {
  return String(raw).split(/[_-]/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

async function fetchPlanName(accountId, token) {
  const seen = planCache.get(accountId);
  if (seen && Date.now() - seen.at < 6 * 3600 * 1000) return seen.name;
  const res = await request(PROFILE, {
    timeoutMs: 15000, retries: 0,
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-cli (external, cli)',
      Accept: 'application/json',
    },
  });
  let name = null;
  if (res.status === 200 && res.json) {
    const org = res.json.organization || {};
    const tier = (org.rate_limit_tier || '').toLowerCase();
    const multiplier = ['20x', '5x'].find((m) => tier.endsWith('_' + m));
    const stated = org.subscription_type || res.json.subscription_type;
    name = stated
      ? (multiplier ? `${tidy(stated)} ${multiplier}` : tidy(stated))
      : planFromTier(tier, multiplier, org.organization_type);
  }
  planCache.set(accountId, { name, at: Date.now() }); // failures remembered too
  return name;
}

function isSpent(limit) {
  if (limit.locked_reason != null) return true;
  const sev = (limit.severity || '').toLowerCase();
  if (!sev) return false;
  return !['normal', 'ok', 'none', 'healthy', 'warning', 'warn'].includes(sev);
}

function windowFromLimit(limit) {
  const kindName = limit.kind;
  const percent = U.num(limit.percent);
  if (!kindName || percent == null) return null;
  let kind, seconds;
  if (kindName === 'session') { kind = 'fiveHour'; seconds = 5 * 3600; }
  else if (kindName === 'weekly_all' || kindName === 'weekly_scoped') { kind = 'weekly'; seconds = 7 * 86400; }
  else return null;

  const scope = limit.scope && limit.scope.model && limit.scope.model.display_name || null;
  return U.makeWindow({
    id: `claudeCode.${kindName}.${scope || 'all'}`,
    kind, scope,
    usedFraction: percent / 100,
    windowSeconds: seconds,
    resetsAt: U.parseDate(limit.resets_at),
    isExhausted: isSpent(limit),
  });
}

function parse(root, account, plan) {
  let windows = (Array.isArray(root.limits) ? root.limits : []).map(windowFromLimit).filter(Boolean);

  if (!windows.length) {
    windows = [['five_hour', 'fiveHour', 5 * 3600], ['seven_day', 'weekly', 7 * 86400]]
      .map(([key, kind, seconds]) => {
        const node = root[key];
        const percent = node && U.num(node.utilization);
        if (percent == null) return null;
        return U.makeWindow({
          id: `claudeCode.${key}`, kind,
          usedFraction: percent / 100, windowSeconds: seconds,
          resetsAt: U.parseDate(node.resets_at), isExhausted: isSpent(node),
        });
      }).filter(Boolean);
  }

  if (!windows.length) return U.unavailable(account, 'noLimitsReported', 'endpoint');
  return U.live(account, windows, { plan, source: 'endpoint' });
}

async function fetchOverHTTP(account, token) {
  const res = await request(ENDPOINT, {
    timeoutMs: 20000, retries: 2,
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-cli (external, cli)',
      Accept: 'application/json',
    },
  });
  if (res.status === 200 && res.json) {
    const plan = await fetchPlanName(account, token);
    return { ok: true, usage: parse(res.json, account, plan) };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, needsFresh: true };
  if (res.status === 429) return { ok: false, reason: 'rateLimited' };
  if (res.status === 0) return { ok: false, reason: 'unreachable' };
  if (res.status === 200 && !res.json) return { ok: false, reason: 'unreadableReply' };
  return { ok: false, reason: 'serverError' };
}

// The status-line push: figures only move while a session runs.
function readCapturedUsage(home, account) {
  const root = readJson(cacheFile(home));
  const limits = root && root.rate_limits;
  if (!limits) return null;

  const known = [['five_hour', 'fiveHour', 5 * 3600], ['seven_day', 'weekly', 7 * 86400], ['spend_limit', 'spend', 0]];
  const now = Date.now();
  const windows = known.map(([key, kind, seconds]) => {
    const node = limits[key];
    const percent = node && statusPercent(node.used_percentage);
    if (percent == null) return null;
    const resets = U.parseDate(node.resets_at);
    if (resets && resets <= now) return null; // a spent window's entry is dropped, not aged
    return U.makeWindow({
      id: `claudeCode.statusline.${key}`, kind,
      usedFraction: percent / 100, windowSeconds: seconds, resetsAt: resets,
      reportsLength: seconds > 0,
    });
  }).filter(Boolean);
  if (!windows.length) return null;

  const captured = U.num(root.capturedAt) ? U.num(root.capturedAt) * 1000 : null;
  const age = captured ? now - captured : Infinity;
  const usage = (age <= FRESH_FOR ? U.live : U.stale)(account, windows, { source: 'statusLine' });
  if (captured) usage.observedAt = captured;
  return usage;
}

function statusPercent(v) {
  const n = U.num(v);
  if (n == null || n < 0 || n > 101) return null; // leaked epochs are dropped
  return n;
}

function isStatusLineInstalled(home) {
  const settings = readJson(settingsFile(home));
  const line = settings && settings.statusLine;
  return !!(line && typeof line.command === 'string' && line.command.includes('--statusline'));
}

async function fetchQuota(ctx) {
  const home = ctx.home;
  const account = 'claudeCode';
  const credentials = storedCredentials(home);
  const hadCredentials = credentials != null;
  const token = credentials && unexpiredAccessToken(credentials);

  if (token) {
    const out = await fetchOverHTTP(account, token);
    if (out.ok) {
      // The file also states the plan on Windows — prefer it over a slow call.
      if (!out.usage.plan) out.usage.plan = planFromCredentials(credentials);
      return out.usage;
    }
    if (!out.needsFresh) {
      const capture = readCapturedUsage(home, account);
      if (capture) return capture;
      return U.unavailable(account, out.reason, 'endpoint');
    }
    // needsFresh → fall through to capture
  }

  const capture = readCapturedUsage(home, account);
  if (capture) return capture;

  let reason;
  if (isStatusLineInstalled(home)) reason = 'awaitingResponse';
  else reason = hadCredentials ? 'claudeLoginExpired' : 'claudeSignInRequired';
  return U.unavailable(account, reason, token ? 'endpoint' : null);
}

async function fetchUsage(ctx) {
  const usage = await fetchQuota(ctx);

  // The CLI's own transcripts are the "on this Mac" history — it answers
  // whether the quota route did or not.
  try {
    const ledger = await require('../agentLedger.js').readLedger('claudeCode', ctx.dataDir);
    if (ledger) usage.ledger = ledger;
  } catch { /* missing or unreadable transcripts are simply no history */ }

  return usage;
}

module.exports = { fetchUsage, isStatusLineInstalled, cacheFile, settingsFile, credentialsFile };
