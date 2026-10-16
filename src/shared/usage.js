// Shared usage model for Pulse Windows — mirrors Sources/Pulse/Usage/ProviderUsage.swift.
// Loadable both in Node (module.exports) and in a renderer (<script> → window.UsageModel).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UsageModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // A provider's own judgement marks a window spent; the fraction alone never does.
  // kind mirrors UsageWindow.Kind: fiveHour|weekly|monthly|daily|spend|balance|
  // messages|topUp|credits|sharedCredits|planCredits|dedicatedCredits|other:<seconds>
  function makeWindow(o) {
    return {
      id: o.id,
      kind: o.kind,
      scope: o.scope || null,
      usedFraction: clamp01(o.usedFraction),
      windowSeconds: o.windowSeconds || 0,
      resetsAt: o.resetsAt || null,          // epoch ms
      reportsLength: o.reportsLength !== false,
      estimate: o.estimate || null,           // 'sinceTopUp'|'yourBudget'|'planPrice'
      isExhausted: o.isExhausted === true,
      amount: o.amount || null,               // absolute figures the service reported, e.g. '1.2k / 5k'
    };
  }

  function live(account, windows, extra) {
    return Object.assign({
      account, windows, observedAt: Date.now(),
      state: 'live', plan: null, creditBalance: null, creditRemaining: null,
      stale: false, reason: null, source: null,
    }, extra || {});
  }

  function unavailable(account, reason, source) {
    return {
      account, windows: [], observedAt: Date.now(),
      state: 'unavailable', plan: null, creditBalance: null, creditRemaining: null,
      stale: false, reason, source: source || null,
    };
  }

  function stale(account, windows, extra) {
    return Object.assign(live(account, windows, extra), { state: 'stale', stale: true });
  }

  function clamp01(x) { return Math.min(Math.max(x, 0), 1); }
  // A count the way the card shows it: 1234 -> '1.2k'.
  function count(v) {
    const n = num(v);
    if (n == null) return null;
    const a = Math.abs(n);
    const trim = (x) => { const s = x.toFixed(1); return s.endsWith('.0') ? s.slice(0, -2) : s; };
    if (a >= 1e6) return trim(n / 1e6) + 'M';
    if (a >= 1e3) return trim(n / 1e3) + 'k';
    return String(Math.round(n));
  }
  function usedOver(used, total) {
    const u = count(used), t = count(total);
    return u != null && t != null ? `${u} / ${t}` : null;
  }
  function num(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; }
    return null;
  }
  function firstLine(text) {
    if (!text) return null;
    const line = String(text).split(/\r?\n/)[0].trim();
    return line || null;
  }
  function parseDate(v) {
    if (v == null) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000; // s → ms
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }

  // The ring's headline window: the fullest one. Same idea as the Swift display rule.
  function headline(usage) {
    if (!usage || !usage.windows || !usage.windows.length) return null;
    return usage.windows.reduce((a, b) => (b.usedFraction > a.usedFraction ? b : a));
  }

  // Colour means usage, not brand: green → amber → red, deep red when the provider says spent.
  // warningThreshold default 75 (percent), caution at 50.
  function tint(window, warningPct) {
    const warn = warningPct == null ? 75 : warningPct;
    if (!window) return 'none';
    if (window.isExhausted) return 'spent';
    const pct = window.usedFraction * 100;
    if (pct >= warn) return 'red';
    if (pct >= 50) return 'amber';
    return 'green';
  }
  const TINT_COLOR = {
    green: '#30d158', amber: '#ffd60a', red: '#ff453a', spent: '#b3241c', none: '#48484a',
  };

  function windowKind(window) {
    const k = window.kind;
    if (k === 'other') return { name: 'other', seconds: window.windowSeconds };
    if (k.startsWith('other:')) return { name: 'other', seconds: Number(k.slice(6)) || window.windowSeconds };
    return { name: k, seconds: window.windowSeconds };
  }

  function kindForSeconds(seconds) {
    if (seconds === 5 * 3600) return 'fiveHour';
    if (seconds === 7 * 86400) return 'weekly';
    if (seconds === 30 * 86400) return 'monthly';
    return 'other';
  }

  return { makeWindow, live, unavailable, stale, clamp01, num, count, usedOver, firstLine, parseDate, headline, tint, TINT_COLOR, windowKind, kindForSeconds };
});
