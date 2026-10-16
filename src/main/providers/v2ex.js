// V2EX — port of V2EXUsageService.swift.
//
// One documented route: GET edge.v2ex.com/api/v2/chat/quota with a Personal
// Access Token. The five-hour window does not run until it is USED — a reading
// with active:false reports the size the allowance WOULD be granted, with
// period_start/end of zero. That is a complete answer, not a fault.
'use strict';

const U = require('../../shared/usage.js');
const { request, bearer } = require('../http.js');

const ENDPOINT = 'https://edge.v2ex.com/api/v2/chat/quota';
const WINDOW_SECONDS = 5 * 3600;

function fraction(used, total) {
  const t = U.num(total), u = U.num(used);
  if (t == null || t <= 0 || u == null) return null;
  return u / t;
}

// V2EX's own remainder; an absent field says nothing.
function isSpent(remaining) {
  const r = U.num(remaining);
  return r != null && r <= 0;
}

// Unix seconds; zero is what this route reports when no window is running.
function dateOrNull(seconds) {
  const s = U.num(seconds);
  return s != null && s > 0 ? s * 1000 : null;
}

function windowsFrom(quota) {
  const windows = [];
  const isActive = quota.active === true;

  const frac = fraction(quota.used_tokens, quota.total_tokens);
  if (frac != null) {
    windows.push(U.makeWindow({
      id: 'window', kind: 'fiveHour',
      usedFraction: frac, windowSeconds: WINDOW_SECONDS,
      resetsAt: isActive ? dateOrNull(quota.period_end) : null,
      reportsLength: isActive, // five hours are real but have not started
      isExhausted: isSpent(quota.remaining_tokens),
      amount: U.usedOver(quota.used_tokens, quota.total_tokens),
    }));
  }

  const extra = quota.extra_usage;
  if (extra && U.num(extra.pack_count) > 0) {
    const ef = fraction(extra.used_tokens, extra.total_tokens);
    if (ef != null) {
      windows.push(U.makeWindow({
        id: 'extra', kind: 'topUp',
        usedFraction: ef, windowSeconds: 30 * 86400, // sort key only; the pack never expires
        resetsAt: null, reportsLength: false,
        isExhausted: isSpent(extra.remaining_tokens),
        amount: U.usedOver(extra.used_tokens, extra.total_tokens),
      }));
    }
  }
  return windows;
}

async function fetchUsage(ctx) {
  const account = 'v2ex';
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
  if (reply.success === false || !reply.result) {
    return U.unavailable(account, reply.success === false ? 'apiKeyRefused' : 'unreadableReply');
  }

  const windows = windowsFrom(reply.result);
  if (!windows.length) return U.unavailable(account, 'noLimitsReported');
  return U.live(account, windows);
}

module.exports = { fetchUsage };
