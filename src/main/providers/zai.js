// z.ai + Zhipu GLM Coding — port of ZaiUsageService.swift.
//
// Two storefronts, one service: api.z.ai (international) and open.bigmodel.cn
// (mainland) answer the same JSON at the same path, but they are separate
// accounts — a key for one is refused by the other. The reply wraps its
// payload in its own envelope (success + code), and a refused key comes back
// as HTTP 200, so the envelope is where refusal is actually seen.
'use strict';

const path = require('path');
const fs = require('fs');
const U = require('../../shared/usage.js');
const { request, bearer } = require('../http.js');

const HOSTS = { zai: 'https://api.z.ai', glmCoding: 'https://open.bigmodel.cn' };

// Mainland-only: relay/console tools write the key to a one-line file.
// Never consulted for the international route — they are separate accounts.
function storedKey(home) {
  const candidates = [
    path.join(home, '.coding-relay', 'glm-api-key'),
    path.join(home, '.config', 'bigmodel', 'api_key'),
    path.join(home, '.config', 'zhipu', 'api_key'),
  ];
  for (const file of candidates) {
    const key = U.firstLine(safeRead(file));
    if (key) return key;
  }
  return null;
}
function safeRead(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } }

// What the envelope's refusal actually was. A working key on an account with
// no running subscription answers `500` with the "coding plan" sentence; the
// mainland host answers auth failures in Chinese.
function problem(reply) {
  const said = (reply.msg || '').toLowerCase();
  if (said.includes('coding plan')) return 'zaiNoCodingPlan';

  const authWords = ['token', 'auth', 'key', 'unauthor', 'forbidden', 'credential',
    '身份验证', '鉴权', '认证', '令牌', '未授权', '无权限', '密钥'];
  if (authWords.some((w) => said.includes(w))) return 'apiKeyRefused';

  const code = reply.code || 0;
  if (code === 401 || code === 403) return 'apiKeyRefused';
  if (code === 429) return 'rateLimited';
  if (code >= 1000 && code <= 1099) return 'apiKeyRefused'; // Zhipu's own auth family
  return 'serverError';
}

function minutes(unit, number, type) {
  // A monthly MCP allowance is reported as "1 minute" — a marker, not a duration.
  if (type === 'TIME_LIMIT' && unit === 5 && number === 1) return 30 * 24 * 60;
  const perUnit = { 1: 1440, 3: 60, 5: 1, 6: 10080 };
  const mult = perUnit[unit];
  if (!mult || !(number > 0)) return null;
  return number * mult;
}

function kindFor(minutes_) {
  if (minutes_ === 300) return 'fiveHour';
  if (minutes_ === 10080) return 'weekly';
  if (minutes_ === 43200) return 'monthly';
  return 'other';
}

// Counts first (finer than the whole-number `percentage`); `remaining` is what
// is LEFT, `currentValue` is the spend directly. Nil rather than zero when the
// reply says nothing — a missing figure is not a limit at 0%.
function usedFraction(limit) {
  const usage = U.num(limit.usage);
  if (usage != null && usage > 0) {
    let used = null;
    const remaining = U.num(limit.remaining);
    const current = U.num(limit.currentValue);
    if (remaining != null) used = Math.max(usage - remaining, current != null ? current : usage - remaining);
    else if (current != null) used = current;
    if (used != null) return Math.min(Math.max(Math.min(used, usage) / usage * 100, 0), 100);
  }
  const pct = U.num(limit.percentage);
  return pct == null ? null : Math.min(Math.max(pct, 0), 100);
}

function windowFrom(limit, index, providerId) {
  const type = limit.type;
  if (!['TOKENS_LIMIT', 'CREDIT_LIMIT', 'TIME_LIMIT'].includes(type)) return null;
  const unit = U.num(limit.unit);
  const number = U.num(limit.number);
  if (unit == null || number == null) return null;

  const mins = minutes(unit, number, type);
  const used = usedFraction(limit);
  if (mins == null || used == null) return null;

  return U.makeWindow({
    id: `${providerId}.${type}.${unit}-${number}.${index}`,
    kind: kindFor(mins),
    scope: type === 'TIME_LIMIT' ? 'MCP' : null, // the MCP lane is a different allowance
    usedFraction: used / 100,
    windowSeconds: mins * 60,
    resetsAt: limit.nextResetTime != null ? U.num(limit.nextResetTime) : null, // ms
  });
}

function planLabel(data) {
  if (!data) return null;
  for (const k of ['planName', 'plan', 'plan_type', 'packageName', 'level']) {
    const v = data[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

async function fetchUsage(ctx) {
  const providerId = ctx.providerId; // 'zai' | 'glmCoding'
  const host = HOSTS[providerId];
  const key = ctx.key || (providerId === 'glmCoding' ? storedKey(ctx.home) : null);
  const usage = await fetchQuota(ctx, providerId, host, key);

  // ZCode's spend is the GLM Coding plan's — its local database is the card's
  // "本机用量" whether or not the quota route answered.
  if (providerId === 'glmCoding') {
    try {
      const ledger = await require('../agentLedger.js').readLedger('zcode', ctx.dataDir);
      if (ledger) usage.ledger = ledger;
    } catch { /* no database is no history */ }
  }
  return usage;
}

async function fetchQuota(ctx, providerId, host, key) {
  if (!key) return U.unavailable(providerId, 'apiKeyMissing');

  const res = await request(`${host}/api/monitor/usage/quota/limit`, {
    timeoutMs: 15000, retries: 1, headers: bearer(key),
  });
  if (res.status === 401 || res.status === 403) return U.unavailable(providerId, 'apiKeyRefused');
  if (res.status === 429) return U.unavailable(providerId, 'rateLimited');
  if (res.status === 0) return U.unavailable(providerId, 'unreachable');
  if (res.status !== 200 || !res.json) {
    return U.unavailable(providerId, res.status === 200 ? 'unreadableReply' : 'serverError');
  }

  const reply = res.json;
  if (reply.success !== true || reply.code !== 200) {
    return U.unavailable(providerId, problem(reply));
  }

  const limits = (reply.data && Array.isArray(reply.data.limits)) ? reply.data.limits : [];
  const windows = limits.map((l, i) => windowFrom(l, i, providerId)).filter(Boolean)
    .sort((a, b) => a.windowSeconds - b.windowSeconds);
  if (!windows.length) return U.unavailable(providerId, 'noLimitsReported');

  return U.live(providerId, windows, { plan: planLabel(reply.data) });
}

module.exports = { fetchUsage, storedKey };
