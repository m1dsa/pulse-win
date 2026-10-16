// Kimi Code — port of KimiCodeUsageService.swift.
//
// Documented usage endpoint, pasted key. The reply has TWO kinds of limit:
// limits[] are windows the service times (duration + unit); `usage` is the
// weekly allowance with a reset and no length (the window rolls, so the reset
// lands anywhere inside the week — the length is named from the plan, not
// inferred). Every count arrives as a STRING, and detail reports what is LEFT
// rather than what is spent.
'use strict';

const U = require('../../shared/usage.js');
const { request, bearer } = require('../http.js');

const ENDPOINT = 'https://api.kimi.com/coding/v1/usages';

const TIME_UNIT = {
  TIME_UNIT_SECOND: 1,
  TIME_UNIT_MINUTE: 60,
  TIME_UNIT_HOUR: 3600,
  TIME_UNIT_DAY: 86400,
};

function durationOf(window) {
  if (!window) return null;
  const duration = U.num(window.duration);
  const unit = TIME_UNIT[window.timeUnit];
  if (!duration || duration <= 0 || !unit) return null;
  return duration * unit;
}

function kindFor(seconds) {
  if (seconds === 5 * 3600) return 'fiveHour';
  if (seconds === 7 * 86400) return 'weekly';
  if (seconds === 30 * 86400) return 'monthly';
  return 'other';
}

function windowFromDetail(detail, id, kind, seconds, reportsLength) {
  if (!detail) return null;
  const limit = U.num(detail.limit);
  if (limit == null || limit <= 0) return null;
  // `used` when given, else what the limit and the remainder imply.
  const used = U.num(detail.used) ?? (U.num(detail.remaining) != null ? limit - U.num(detail.remaining) : null);
  if (used == null) return null;
  return U.makeWindow({
    id, kind,
    usedFraction: used / limit,
    windowSeconds: seconds,
    resetsAt: U.parseDate(detail.resetTime),
    reportsLength,
    isExhausted: used >= limit,
  });
}

function planName(level) {
  if (!level) return null;
  const bare = String(level).startsWith('LEVEL_') ? String(level).slice(6) : String(level);
  return bare.split('_').filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ') || null;
}

async function fetchUsage(ctx) {
  const account = 'kimiCode';
  const key = ctx.key;
  if (!key) return U.unavailable(account, 'apiKeyMissing');

  const res = await request(ENDPOINT, { timeoutMs: 15000, retries: 1, headers: bearer(key) });
  if (res.status === 401 || res.status === 403) return U.unavailable(account, 'apiKeyRefused');
  if (res.status === 429) return U.unavailable(account, 'rateLimited');
  if (res.status === 0) return U.unavailable(account, 'unreachable');
  if (res.status !== 200 || !res.json) {
    return U.unavailable(account, res.status === 200 ? 'unreadableReply' : 'serverError');
  }

  const reply = res.json;
  const windows = [];

  for (const [index, limit] of (Array.isArray(reply.limits) ? reply.limits : []).entries()) {
    const seconds = durationOf(limit.window);
    if (!seconds) continue;
    const w = windowFromDetail(limit.detail, `limit.${index}.${seconds}`, kindFor(seconds), seconds, true);
    if (w) windows.push(w);
  }

  const weekly = windowFromDetail(reply.usage, 'weekly', 'weekly', 7 * 86400, false);
  if (weekly) windows.push(weekly);

  windows.sort((a, b) => a.windowSeconds - b.windowSeconds);
  if (!windows.length) return U.unavailable(account, 'noLimitsReported');

  const level = reply.user && reply.user.membership && reply.user.membership.level;
  return U.live(account, windows, { plan: planName(level) });
}

module.exports = { fetchUsage };
