// MiniMax — port of MiniMaxUsageService.swift.
//
// One provider, two sites: api.minimax.io (international) and api.minimaxi.com
// (mainland) — a key for one is refused by the other, and each site keeps its
// own key. GET {host}/v1/token_plan/remains, falling back to the older
// coding-plan path on ANY failure: an older plan answers 401 on the current
// path, not 404.
//
// The reply reports what is LEFT, not what is gone (inverted here so
// downstream stays in terms of spend). Figures arrive as strings or numbers
// interchangeably. Lanes not in the subscription come back status 3 with zero
// counts and 100% remaining and are left out.
'use strict';

const U = require('../../shared/usage.js');
const { request, bearer } = require('../http.js');

const SITES = {
  international: 'https://api.minimax.io',
  china: 'https://api.minimaxi.com',
};

function endpoints(host) {
  return [`${host}/v1/token_plan/remains`, `${host}/v1/api/openplatform/coding_plan/remains`];
}

// 1004 is the credential verdict; the rest are the service having a bad day.
function statusVerdict(base) {
  const status = U.num(base && base.status_code) || 0;
  if (status === 0) return null;
  const said = ((base && base.status_msg) || '').toLowerCase();
  const credential = status === 1004 || ['token', 'auth', 'login', 'cookie', 'credential'].some((w) => said.includes(w));
  return credential ? 'apiKeyRefused' : 'serverError';
}

function payloadFrom(root) { return (root.data && typeof root.data === 'object') ? root.data : root; }

// Status 3 with nothing issued and nothing spent = a lane the plan lacks.
function laneUnavailable(status, total, remainingPercent) {
  return status === 3 && (total || 0) === 0 && (remainingPercent || 0) >= 100;
}

// Percentage remaining preferred; counts are the same way round despite the
// name: `current_*_usage_count` is the REMAINING quota, not the used one.
function spent(percentRemaining, total, left) {
  if (percentRemaining != null) return Math.min(Math.max(100 - percentRemaining, 0), 100);
  if (total != null && total > 0 && left != null) {
    return Math.min(Math.max((total - left) / total * 100, 0), 100);
  }
  return null;
}

function kindFor(seconds) {
  if (seconds === 5 * 3600) return 'fiveHour';
  if (seconds === 7 * 86400) return 'weekly';
  if (seconds === 30 * 86400) return 'monthly';
  return 'other';
}

function windowsFrom(payload, providerId) {
  const models = Array.isArray(payload && payload.model_remains) ? payload.model_remains : [];
  const out = [];

  models.forEach((model, index) => {
    let name = (model.model_name || '').trim() || null;
    const scope = (name && name.toLowerCase() === 'general' ? null : name);
    const key = name || `lane${index}`;

    // The short window: length measured from its own timestamps.
    if (!laneUnavailable(U.num(model.current_interval_status), U.num(model.current_interval_total_count), U.num(model.current_interval_remaining_percent))) {
      const used = spent(U.num(model.current_interval_remaining_percent), U.num(model.current_interval_total_count), U.num(model.current_interval_usage_count));
      const start = U.num(model.start_time), end = U.num(model.end_time);
      if (used != null && start != null && end != null && end > start) {
        const seconds = Math.floor((end - start) / 1000);
        if (seconds > 0) {
          out.push(U.makeWindow({
            id: `${providerId}.${key}.interval`, kind: kindFor(seconds), scope,
            usedFraction: used / 100, windowSeconds: seconds,
            resetsAt: end, // ms
            amount: U.usedOver(
              (U.num(model.current_interval_total_count) || 0) - (U.num(model.current_interval_usage_count) || 0),
              model.current_interval_total_count),
          }));
        }
      }
    }

    // The weekly window names its own length.
    if (!laneUnavailable(U.num(model.current_weekly_status), U.num(model.current_weekly_total_count), U.num(model.current_weekly_remaining_percent))) {
      const used = spent(U.num(model.current_weekly_remaining_percent), U.num(model.current_weekly_total_count), U.num(model.current_weekly_usage_count));
      if (used != null) {
        out.push(U.makeWindow({
          id: `${providerId}.${key}.weekly`, kind: 'weekly', scope,
          usedFraction: used / 100, windowSeconds: 7 * 86400,
          resetsAt: U.num(model.weekly_end_time),
          amount: U.usedOver(
            (U.num(model.current_weekly_total_count) || 0) - (U.num(model.current_weekly_usage_count) || 0),
            model.current_weekly_total_count),
        }));
      }
    }
  });

  return out.sort((a, b) => a.windowSeconds - b.windowSeconds);
}

function firstString(payload, keys) {
  for (const k of keys) {
    const v = payload && payload[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function balanceOf(payload, keys) {
  for (const k of keys) {
    const n = U.num(payload && payload[k]);
    if (n != null && n > 0) return `${Math.floor(n).toLocaleString()} points`;
  }
  return null;
}

async function attempt(endpoint, key, providerId) {
  const res = await request(endpoint, { timeoutMs: 15000, retries: 1, headers: bearer(key) });
  if (res.status === 404) return { type: 'notFound' };
  if (res.status === 401 || res.status === 403) return { type: 'failed', reason: 'apiKeyRefused' };
  if (res.status === 429) return { type: 'failed', reason: 'rateLimited' };
  if (res.status === 0) return { type: 'failed', reason: 'unreachable' };
  if (res.status !== 200 || !res.json) {
    return { type: 'failed', reason: res.status === 200 ? 'unreadableReply' : 'serverError' };
  }

  const verdict = statusVerdict(res.json.base_resp);
  if (verdict) return { type: 'failed', reason: verdict };

  const payload = payloadFrom(res.json);
  const windows = windowsFrom(payload, providerId);
  if (!windows.length) return { type: 'failed', reason: 'noLimitsReported' };

  return {
    type: 'success',
    usage: U.live(providerId, windows, {
      plan: firstString(payload, ['current_subscribe_title', 'plan_name', 'combo_title', 'current_plan_title']),
      creditBalance: balanceOf(payload, ['points_balance', 'point_balance', 'credits_balance', 'credit_balance', 'balance']),
    }),
  };
}

async function fetchUsage(ctx) {
  const providerId = 'minimax';
  const site = ctx.site || 'international';
  const host = SITES[site] || SITES.international;
  const key = ctx.key;
  if (!key) return U.unavailable(providerId, 'apiKeyMissing');

  let firstProblem = null;
  for (const ep of endpoints(host)) {
    const out = await attempt(ep, key, providerId);
    if (out.type === 'success') {
      out.usage.site = site;
      return out.usage;
    }
    if (out.type === 'failed' && !firstProblem) firstProblem = out.reason;
  }
  return U.unavailable(providerId, firstProblem || 'unreachable');
}

module.exports = { fetchUsage, SITES };
