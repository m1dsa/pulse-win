// Devin — port of DevinUsageService.swift.
//
// Three routes:
//   1. App session (no credential): the desktop app signs its Codeium
//      session into server.codeium.com and stores the token
//      (`devin-session-token$<jwt>`) in the same state database as the plan
//      row. Calling GetPlanStatus with it is what the app itself does on
//      launch — live daily/weekly REMAINING percents, reset times, overage
//      balance, plan name. No window opened, no key pasted.
//   2. Endpoint (optional pasted "token org"): GET
//      app.devin.ai/api/<org>/billing/quota/usage, live figures reported as
//      USED percents — the opposite sign of the cached row.
//   3. App cache (fallback): Devin's desktop app is the renamed Windsurf
//      editor, so it keeps its plan row in a VS Code state database —
//      %APPDATA%\Devin\User\globalStorage\state.vscdb, key
//      `windsurf.reactSettings.cachedPlanInfoData:<userId>`. The row is
//      written once per app launch, so freshness comes from the newest
//      directory under logs/ — and it answers when the session is gone or
//      the call is refused.
//
// The browser-localStorage credential route from the Mac version is not
// ported: Chromium's leveldb store is a different parser again, and the
// app's own session token covers the live route.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('../../shared/usage.js');
const { request, bearer } = require('../http.js');

const HOST = 'https://app.devin.ai';
const CODEIUM_HOST = 'https://server.codeium.com';
const PLAN_STATUS = '/exa.seat_management_pb.SeatManagementService/GetPlanStatus';
const SESSION_TOKEN = /devin-session-token\$[A-Za-z0-9_.-]+/g;
const SUPPORT_NAMES = ['Devin', 'Windsurf'];
const PLAN_KEYS = ['windsurf.reactSettings.cachedPlanInfoData', 'windsurf.settings.cachedPlanInfo'];
const FRESH_MS = 10 * 60 * 1000;        // past this the card says "as of …"
const MAX_AGE_MS = 24 * 3600 * 1000;    // past this the snapshot is not shown
const ACCOUNT = 'devin';

// ---------------------------------------------------------------- app cache

function roamingDir() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

function supportDir() {
  const dirs = SUPPORT_NAMES
    .map((n) => path.join(roamingDir(), n))
    .filter((d) => fs.existsSync(path.join(d, 'User', 'globalStorage', 'state.vscdb')));
  if (!dirs.length) return null;
  dirs.sort((a, b) => mtime(b) - mtime(a)); // a machine that ran both uses the newest
  return dirs[0];
}

function mtime(p) {
  try { return fs.statSync(path.join(p, 'User', 'globalStorage', 'state.vscdb')).mtimeMs; }
  catch { return 0; }
}

// SQLite keeps small TEXT values inline in leaf pages, and a -wal frame is a
// whole page image — so the row's key and its JSON are plain bytes in both
// files. We scan rather than link a sqlite library for one row; read-only,
// the app may be running and its journal is its own.
function collectPlans(dbFile) {
  const found = [];
  for (const file of [dbFile, dbFile + '-wal']) {
    let buf;
    try { buf = fs.readFileSync(file); } catch { continue; }
    for (const key of PLAN_KEYS) {
      let i = 0;
      while ((i = buf.indexOf(key, i)) !== -1) {
        i += key.length;
        let off = i, accountID = null;
        if (buf[i] === 0x3a) { // ':user-…' names the account the row is for
          let e = i + 1;
          while (e < buf.length && isWordByte(buf[e])) e++;
          accountID = buf.toString('utf8', i + 1, e) || null;
          off = e;
        }
        const plan = jsonAfter(buf, off);
        if (plan) found.push({ plan, accountID });
      }
    }
  }
  found.sort((a, b) => (U.num(a.plan.endTimestamp) || 0) - (U.num(b.plan.endTimestamp) || 0));
  return found[found.length - 1] || null;
}

function isWordByte(c) {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2d || c === 0x5f;
}

// First balanced {...} within reach of `from`, string-aware; null if none parses.
function jsonAfter(buf, from) {
  const end = Math.min(buf.length, from + 128 * 1024);
  for (let i = from; i < end; i++) {
    if (buf[i] !== 0x7b) continue; // '{'
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < end && j < i + 65536; j++) {
      const c = buf[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === 0x5c) esc = true;
        else if (c === 0x22) inStr = false;
        continue;
      }
      if (c === 0x22) inStr = true;
      else if (c === 0x7b) depth++;
      else if (c === 0x7d) {
        if (--depth === 0) {
          try {
            const o = JSON.parse(buf.toString('utf8', i, j + 1));
            if (o && (o.planName != null || o.dailyRemainingPercent != null
              || o.weeklyRemainingPercent != null || o.remainingMessages != null
              || o.overageBalanceMicros != null)) return o;
          } catch { /* not it */ }
          break;
        }
      }
    }
  }
  return null;
}

// logs/ has one directory per launch named after its local start time —
// '20261016T020906'. That stamp is when the plan row was last written.
function lastLaunch(support) {
  let entries;
  try { entries = fs.readdirSync(path.join(support, 'logs'), { withFileTypes: true }); }
  catch { return null; }
  let latest = null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const t = launchStamp(e.name);
    if (t != null && (latest == null || t > latest)) latest = t;
  }
  return latest;
}

function launchStamp(name) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(name);
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isFinite(t) ? t : null;
}

function money(micros) {
  const m = U.num(micros);
  if (m == null) return null;
  const v = m / 1e6;
  return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
}

function remainingWindow(id, kind, seconds, remainingPct, resetUnix, hidden) {
  if (hidden) return null;
  const r = U.num(remainingPct);
  if (r == null) return null;
  return U.makeWindow({
    id, kind, usedFraction: (100 - r) / 100, windowSeconds: seconds,
    resetsAt: resetUnix > 0 ? resetUnix * 1000 : null,
    isExhausted: r <= 0, // the row's own "0% remaining" is a reported spent
  });
}

function windowsFromPlan(plan) {
  const w = [
    remainingWindow('devin-daily', 'daily', 86400,
      plan.dailyRemainingPercent, plan.dailyResetAtUnix, plan.hideDailyQuota),
    remainingWindow('devin-weekly', 'weekly', 604800,
      plan.weeklyRemainingPercent, plan.weeklyResetAtUnix, plan.hideWeeklyQuota),
  ].filter(Boolean);

  // Free plan reports a message allowance instead of the two percents.
  const total = U.num(plan.totalMessages), left = U.num(plan.remainingMessages);
  if (total > 0 && left != null) {
    w.push(U.makeWindow({
      id: 'devin-messages', kind: 'messages',
      usedFraction: (total - left) / total, windowSeconds: 0,
      resetsAt: null, reportsLength: false, isExhausted: left <= 0,
      amount: U.usedOver(total - left, total),
    }));
  }
  return w;
}

// ------------------------------------------------- session (the app's own)

// The token sits in the same database as the plan row, inside the
// `windsurfAuthStatus` blob. A copy can wait in a -wal frame for a
// checkpoint, and a torn tail can truncate it — scan both files and let the
// longest match win.
function sessionToken(support) {
  const found = new Set();
  const dbFile = path.join(support, 'User', 'globalStorage', 'state.vscdb');
  for (const file of [dbFile, dbFile + '-wal']) {
    let buf;
    try { buf = fs.readFileSync(file); } catch { continue; }
    for (const m of buf.toString('latin1').matchAll(SESSION_TOKEN)) found.add(m[0]);
  }
  return [...found].sort((a, b) => b.length - a.length)[0] || null;
}

// Live figures, same remaining-percent sign as the cached row. Any failure
// returns null — the cache it stands in front of answers instead.
async function sessionFetch(token) {
  const res = await request(CODEIUM_HOST + PLAN_STATUS, {
    method: 'POST', timeoutMs: 15000, retries: 1,
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify({ metadata: {
      api_key: token, ide_name: 'devin', ide_version: '1.0.0',
      extension_name: 'windsurf', extension_version: '1.0.0', locale: 'en_US',
    }}),
  });
  if (res.status !== 200 || !res.json || typeof res.json !== 'object') return null;
  const ps = res.json.planStatus;
  if (!ps || typeof ps !== 'object') return null;

  const now = Date.now();
  const windows = [
    remainingWindow('devin-daily', 'daily', 86400,
      ps.dailyQuotaRemainingPercent, ps.dailyQuotaResetAtUnix, ps.hideDailyQuota),
    remainingWindow('devin-weekly', 'weekly', 604800,
      ps.weeklyQuotaRemainingPercent, ps.weeklyQuotaResetAtUnix, ps.hideWeeklyQuota),
  ].filter(Boolean).map((w) => rollForward(w, now));
  const info = ps.planInfo && typeof ps.planInfo === 'object' ? ps.planInfo : {};
  const plan = [info.planName, info.plan_name].find((x) => typeof x === 'string' && x) || null;
  const bal = money(ps.overageBalanceMicros);
  if (!windows.length && bal == null) return null;
  return U.live(ACCOUNT, windows, { plan, creditBalance: bal });
}

// ------------------------------------------------------------- endpoint

// "token [org]" — accepts an Authorization line, a Bearer prefix, a bare
// slug, an org_/org- id, or an app.devin.ai/org/… URL for the second word.
function parseCredential(text) {
  let s = String(text || '').trim();
  if (!s) return null;
  const colon = s.indexOf(':');
  if (colon > 0 && s.slice(0, colon).toLowerCase() === 'authorization') s = s.slice(colon + 1).trim();
  if (s.toLowerCase().startsWith('bearer ')) s = s.slice(7).trim();
  const [token, orgRaw] = s.split(/\s+/);
  if (!token) return null;
  return { token, organization: normalizeOrg(orgRaw || '') };
}

function isInternalID(v) { return v.startsWith('org_') || v.startsWith('org-'); }

function normalizeOrg(raw) {
  let v = String(raw || '').trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.hostname === 'devin.ai' || u.hostname.endsWith('.devin.ai')) {
      const seg = u.pathname.split('/').filter(Boolean);
      if (seg.length >= 2 && (seg[0] === 'org' || seg[0] === 'organizations')) {
        v = `${seg[0]}/${seg[1]}`;
      }
    }
  } catch { /* not a URL */ }
  v = v.replace(/^\/+|\/+$/g, '');
  if (!v) return null;
  if (v.startsWith('org/') || v.startsWith('organizations/')) return v;
  return isInternalID(v) ? `organizations/${v}` : `org/${v}`;
}

// The API is undocumented and this segment's spelling varies, so a 404-class
// miss on one spelling is retried as the others rather than reported.
function orgPaths(organization) {
  const paths = [organization];
  if (organization.startsWith('organizations/')) {
    paths.unshift(organization); // internal id first; header travels below too
  }
  if (organization.startsWith('org/')) {
    const slug = organization.slice(4);
    paths.push(slug);
    if (isInternalID(slug)) paths.push(`organizations/${slug}`);
  }
  return [...new Set(paths)].map((p) => `${p}/billing/quota/usage`);
}

function windowsFromReply(reply) {
  if (reply.has_quota_allocation === false) return [];
  const w = [];
  const mk = (id, kind, seconds, usedPct, resetAt, hidden) => {
    const p = U.num(usedPct);
    if (hidden || p == null) return;
    w.push(U.makeWindow({
      id, kind, usedFraction: p / 100, windowSeconds: seconds,
      resetsAt: U.parseDate(resetAt), isExhausted: p >= 100,
    }));
  };
  mk('devin-daily', 'daily', 86400, reply.daily_percentage, reply.daily_reset_at, reply.hide_daily_quota);
  mk('devin-weekly', 'weekly', 604800, reply.weekly_percentage, reply.weekly_reset_at, reply.hide_weekly_quota);
  return w;
}

function replyBalance(reply) {
  const micros = U.num(reply.overage_balance);
  if (micros != null) return '$' + micros.toFixed(2); // endpoint reports dollars
  const cents = U.num(reply.overage_balance_cents);
  return cents != null ? '$' + (cents / 100).toFixed(2) : null;
}

async function endpointFetch(credential) {
  if (!credential.organization) return U.unavailable(ACCOUNT, 'devinOrganizationMissing');

  const headers = bearer(credential.token);
  if (credential.organization.startsWith('organizations/')) {
    headers['x-cog-org-id'] = credential.organization.slice('organizations/'.length);
  }

  let lastReason = 'unreachable';
  for (const p of orgPaths(credential.organization)) {
    const res = await request(`${HOST}/api/${p}`, { timeoutMs: 15000, retries: 1, headers });
    if (res.status === 200) {
      const reply = res.json;
      if (!reply || typeof reply !== 'object') return U.unavailable(ACCOUNT, 'unreadableReply');
      const windows = windowsFromReply(reply);
      const bal = replyBalance(reply);
      if (!windows.length && bal == null) return U.unavailable(ACCOUNT, 'noLimitsReported');
      // Only the reply's own plan name — the cached row's names no organization.
      const plan = [reply.plan_name, reply.planName, reply.plan, reply.tier]
        .find((x) => typeof x === 'string' && x) || null;
      return U.live(ACCOUNT, windows, { plan, creditBalance: bal });
    }
    if (res.status === 401 || res.status === 403) return U.unavailable(ACCOUNT, 'apiKeyRefused');
    if (res.status === 429) return U.unavailable(ACCOUNT, 'rateLimited');
    if (res.status === 0) return U.unavailable(ACCOUNT, 'unreachable');
    lastReason = 'serverError'; // try the next spelling of the path
  }
  return U.unavailable(ACCOUNT, lastReason);
}

// ------------------------------------------------------------------ fetch

// A daily row stamps the window's opening, not its closing edge, so by the
// time it is read the reset has always "passed" and the bar used to vanish
// for the rest of the day. Roll a past stamp forward by whole windows to keep
// the countdown; a future one (weekly normally) is left exactly as reported.
function rollForward(w, now) {
  if (w.resetsAt == null || w.resetsAt > now || !w.windowSeconds) return w;
  const step = w.windowSeconds * 1000;
  return { ...w, resetsAt: w.resetsAt + Math.ceil((now - w.resetsAt) / step) * step };
}

function appCacheFetch() {
  const support = supportDir();
  if (!support) return U.unavailable(ACCOUNT, 'devinAppMissing');
  const entry = collectPlans(path.join(support, 'User', 'globalStorage', 'state.vscdb'));
  if (!entry) return U.unavailable(ACCOUNT, 'devinPlanUnread');

  const now = Date.now();
  const launchedAt = lastLaunch(support);
  if (launchedAt == null || launchedAt > now || now - launchedAt > MAX_AGE_MS) {
    return U.unavailable(ACCOUNT, 'devinPlanUnread');
  }

  const windows = windowsFromPlan(entry.plan).map((w) => rollForward(w, now));
  const bal = money(entry.plan.overageBalanceMicros);
  if (!windows.length && bal == null) return U.unavailable(ACCOUNT, 'noLimitsReported');

  const make = now - launchedAt <= FRESH_MS ? U.live : U.stale;
  const out = make(ACCOUNT, windows, {
    plan: entry.plan.planName || null,
    creditBalance: bal,
  });
  out.observedAt = launchedAt; // the figures are the launch's, not the fetch's
  return out;
}

async function fetchUsage(ctx) {
  const credential = parseCredential(ctx.key);
  let usage;
  if (credential) {
    usage = await endpointFetch(credential);
  } else {
    // The app's own session answers live; the plan row it writes on launch
    // is the fallback it leaves behind.
    usage = null;
    const support = supportDir();
    if (support) {
      const token = sessionToken(support);
      if (token) usage = await sessionFetch(token);
    }
    if (!usage) usage = appCacheFetch();
  }

  // The CLI's own session database is the "on this Mac" history — tokens,
  // money at API prices, the busiest model, the cache's hit rate. It answers
  // whether the quota route did or not.
  try {
    const ledger = await require('../devinLedger.js').readLedger(ctx.dataDir);
    if (ledger) usage.ledger = ledger;
  } catch { /* a missing or unreadable database is simply no history */ }

  return usage;
}

module.exports = { fetchUsage, supportDir };
