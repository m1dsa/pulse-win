// Grok — port of GrokUsageService.swift.
//
// Borrows the OIDC login Grok's CLI stores in ~/.grok/auth.json and asks the
// CLI's own proxy. The pool is the xAI *account's* weekly pool across all Grok
// products, not the CLI's. An absent percentage inside a running period means
// zero (proto3 drops zero values) — read off the reply, not assumed.
'use strict';

const path = require('path');
const fs = require('fs');
const U = require('../../shared/usage.js');
const { request } = require('../http.js');

const BILLING = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const SETTINGS = 'https://cli-chat-proxy.grok.com/v1/settings';

function authFile(home) { return path.join(home, '.grok', 'auth.json'); }

// The file is keyed by issuer/client and may hold several entries: take the
// freshest unexpired dated one; an undated entry is only a last resort.
function storedLogin(home) {
  let root;
  try { root = JSON.parse(fs.readFileSync(authFile(home), 'utf8')); } catch { return { kind: 'none' }; }
  if (!root || typeof root !== 'object') return { kind: 'none' };

  let sawEntry = false;
  let best = null; // {token, expiry}

  for (const entry of Object.values(root)) {
    const token = entry && entry.key;
    if (!token) continue;
    sawEntry = true;
    const expiry = U.parseDate(entry.expires_at);
    if (expiry == null) {
      if (!best) best = { token, expiry: -Infinity }; // undated loses to any dated
      continue;
    }
    if (expiry <= Date.now()) continue;
    if (!best || expiry > best.expiry) best = { token, expiry };
  }

  if (best) return { kind: 'usable', token: best.token };
  return { kind: sawEntry ? 'expired' : 'none' };
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    'x-xai-token-auth': 'xai-grok-cli', // what the CLI sends; without it the reply is the enterprise shape
    Accept: 'application/json',
  };
}

function kindFor(seconds) {
  if (seconds >= 6 * 86400 && seconds <= 8 * 86400) return 'weekly';
  if (seconds >= 27 * 86400 && seconds <= 32 * 86400) return 'monthly';
  return 'other';
}

function windowFrom(config) {
  const start = U.parseDate((config.currentPeriod && config.currentPeriod.start) || config.billingPeriodStart);
  const end = U.parseDate((config.currentPeriod && config.currentPeriod.end) || config.billingPeriodEnd);
  if (!start || !end || end <= start) return null;

  const seconds = Math.round((end - start) / 1000);
  const now = Date.now();
  let percent = U.num(config.creditUsagePercent);
  if (percent == null) {
    if (start <= now && now <= end) percent = 0; // omitted inside a live period = zero
    else return null; // a finished period says nothing about the next one
  }

  return U.makeWindow({
    id: 'grok-pool',
    kind: kindFor(seconds),
    usedFraction: percent / 100,
    windowSeconds: seconds,
    resetsAt: end,
    isExhausted: percent >= 100,
  });
}

async function planName(token) {
  const res = await request(SETTINGS, { timeoutMs: 4000, retries: 0, headers: headers(token) });
  if (res.status !== 200 || !res.json) return null;
  const tier = res.json.subscription_tier_display;
  return tier && String(tier).trim() ? String(tier).trim() : null;
}

async function fetchUsage(ctx) {
  const account = ctx.account || 'grok';
  let token = ctx.token;
  if (!token) {
    const login = storedLogin(ctx.home);
    if (login.kind === 'none') return U.unavailable(account, 'grokSignInRequired');
    if (login.kind === 'expired') return U.unavailable(account, 'grokLoginExpired');
    token = login.token;
  }

  const res = await request(BILLING, { timeoutMs: 15000, retries: 1, headers: headers(token) });
  if (res.status === 401 || res.status === 403) {
    return U.unavailable(account, ctx.token ? 'signedOut' : 'grokLoginExpired');
  }
  if (res.status === 429) return U.unavailable(account, 'rateLimited');
  if (res.status === 0) return U.unavailable(account, 'unreachable');
  if (res.status !== 200 || !res.json || !res.json.config) {
    return U.unavailable(account, res.status === 200 ? 'unreadableReply' : 'serverError');
  }

  const window = windowFrom(res.json.config);
  if (!window) return U.unavailable(account, 'noLimitsReported');
  return U.live(account, [window], { plan: await planName(token) });
}

module.exports = { fetchUsage, authFile };
