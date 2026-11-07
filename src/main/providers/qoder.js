// Qoder — port of QoderUsageService.swift.
//
// Qoder publishes no usage API: its account page (https://{site}/account/usage)
// asks GET /api/v2/me/usages/big_model_credits with the signed-in cookies and
// draws what comes back, so that session is the credential. A pasted Cookie
// header works (exactly as Qwen Cloud's does); with none pasted, the signed-in
// Firefox cookie jar on this machine is read instead.
//
// Two sites, two accounts: qoder.com (international) and qoder.com.cn
// (mainland) are separate sign-ins, and a session for one is never sent to the
// other. Which one is read is the `qoderSite` setting.
//
// The reply mixes camelCase and snake_case field by field — the mainland site
// was seen answering `nextResetAt` beside `total_quota` — so every field is
// read under either spelling.
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const U = require('../../shared/usage.js');
// Firefox keeps cookie values in the clear, and node:sqlite is what the CLIs'
// own ledgers already use to read another local jar. That lets the card pick
// up a Qoder sign-in from this machine instead of asking for a pasted Cookie.
let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* older Node */ }
// Cookie is a forbidden header for fetch(), so the session rides on Electron's
// net.request — the transport Qwen Cloud already needed.
const { request } = require('./qwenCloud.js');

const ACCOUNT = 'qoder';
const HOSTS = { international: 'qoder.com', china: 'qoder.com.cn' };
const API_PATH = '/api/v2/me/usages/big_model_credits';

// Cookies an analytics script set on the host rather than ones Qoder issues.
// Alibaba's own (cna, isg, tfstk) are deliberately NOT listed: the same family
// carries the bot screening in front of Alibaba's sites, and dropping one of
// those is how a session that works in the browser gets refused here.
const ANALYTICS = [
  '_ga', '_gid', '_gat', '_gcl', '_fbp', '_fbc', '_clck', '_clsk', '_hj',
  '_uet', '_tt_', '_ttp', 'ajs_', 'amp_', 'mp_', 'hm_', 'hmaccount',
  'intercom-', '__stripe', '_rdt', '_pin',
];

// ------------------------------------------------------------------ cookie

/** The pasted header, reduced to what is worth sending; null if nothing is. */
function normalizeCookie(input) {
  // Two shapes arrive from the browser: a request header, which is pairs
  // separated by "; ", and the request inspector's listing, which is one
  // `"name": "value"` per line. Both mean the same set of cookies, so the JSON
  // rows are read as pairs too. Line breaks and tabs are separators, rewritten
  // as semicolons — which is what keeps every control character out of the
  // header that is finally sent. Anything else unprintable still refuses the
  // whole string rather than passing a second header on.
  const text = String(input == null ? '' : input)
    .replace(/[\r\n\t\v\f]+/g, ';')
    // The row's trailing comma is eaten here and each pair is ended with a
    // semicolon of its own: the settings box is single-line, and a browser
    // pasting into one drops the line breaks that separated the rows — without
    // a terminator of its own, every pair fuses into one unreadable chunk.
    .replace(/"([^"]+)"\s*:\s*"([^"]*)"\s*,?/g, '$1=$2;');
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 32 || c > 126) return null;
  }
  let header = text.trim();
  if (header.toLowerCase().startsWith('cookie:')) header = header.slice(7).trim();
  if (!header || Buffer.byteLength(header, 'utf8') > 32768) return null;

  const kept = [];
  const seen = new Set();
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    // What sits before the name — a `{`, a `"Request Cookies":` label — is not
    // part of it, so the name is the run of name characters at the end.
    const name = (/([A-Za-z0-9_.-]+)\s*$/.exec(pair.slice(0, eq)) || [])[1] || '';
    const value = pair.slice(eq + 1).trim();
    if (!name || !value) continue;
    const lowered = name.toLowerCase();
    if (ANALYTICS.some((p) => lowered.startsWith(p))) continue;
    // A cookie that cannot be passed on unaltered is dropped rather than
    // costing the sign-in sitting beside it.
    if (value.includes(' ') || value.includes('\\')) continue;
    // A host-only row and a domain row for one name is normal; first wins.
    if (seen.has(name)) continue;
    seen.add(name);
    kept.push(name + '=' + value);
  }
  return kept.length ? kept.join('; ') : null;
}

// A pasted Cookie still wins. When there is none, read the local Firefox jar:
// Chromium encrypts its values, Firefox does not, so its session can be used
// as-is. Only the matching site's cookies are ever collected — a CN session
// is never offered to qoder.com, nor the reverse.
function browserCookie(site) {
  if (!DatabaseSync) return null;
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const dir = path.join(base, 'Mozilla', 'Firefox', 'Profiles');
  let files;
  try {
    files = fs.readdirSync(dir)
      .map((d) => path.join(dir, d, 'cookies.sqlite'))
      .filter((f) => fs.existsSync(f));
  } catch { return null; }
  const like = site === 'china' ? '%qoder.com.cn%' : '%qoder.com%';
  let best = null;
  for (const file of files) {
    let db = null;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const rows = db.prepare('select host, name, value from moz_cookies where host like ?').all(like);
      const pairs = [];
      const seen = new Set();
      for (const r of rows) {
        const host = String(r.host || '');
        if (site !== 'china' && (host.endsWith('.cn') || host.includes('qoder.com.cn'))) continue;
        const name = String(r.name || ''), value = String(r.value || '');
        if (!name || !value || seen.has(name) || /[\s\\;,"]/.test(value)) continue;
        seen.add(name);
        pairs.push(name + '=' + value);
      }
      if (pairs.length && (!best || pairs.length > best.length)) best = pairs;
    } catch { /* a locked or foreign jar is skipped */ }
    finally { try { if (db) db.close(); } catch { /* already closed */ } }
  }
  return best && best.length ? best.join('; ') : null;
}

// ------------------------------------------------------------------- reply

/** The value under the camelCase key, else under the snake_case one. */
function field(obj, camel, snake) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj[camel] !== undefined) return obj[camel];
  return obj[snake];
}

function container(obj, camel, snake) {
  const v = field(obj, camel, snake);
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

/** A quota summary Qoder stated in full, or null. Negative figures are not a
 *  reading anybody could have, so they are refused rather than clamped. */
function summary(container_) {
  const inner = container(container_, 'quotaSummary', 'quota_summary');
  if (!inner) return null;
  const used = U.num(field(inner, 'usedValue', 'used_value'));
  const limit = U.num(field(inner, 'limitValue', 'limit_value'));
  if (used == null || limit == null || used < 0 || limit < 0) return null;
  let remaining = U.num(field(inner, 'remainingValue', 'remaining_value'));
  if (remaining != null && remaining < 0) remaining = null;
  return { used, limit, remaining };
}

/** ISO text or a Unix stamp in seconds or milliseconds; zero is no date. */
function stamp(value) {
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isFinite(t) && t > 0 ? t : null;
  }
  const n = U.num(value);
  if (n == null || n <= 0) return null;
  return n > 1e12 ? Math.trunc(n) : Math.trunc(n * 1000);
}

function ring(pool, id, kind, resetsAt) {
  // A limit of zero is no allowance: 100% would say something was spent that
  // was never granted.
  if (!pool || pool.limit <= 0) return null;
  const left = pool.remaining != null ? pool.remaining : Math.max(0, pool.limit - pool.used);
  return U.makeWindow({
    id, kind,
    usedFraction: pool.used / pool.limit,
    // Thirty days is a sort key, not a reported length: Qoder states when the
    // credits reset and never how long the period runs.
    windowSeconds: 30 * 86400,
    reportsLength: false,
    // A reset already behind now is no reset — a trial account was seen
    // answering with a month-old nextResetAt beside credits it could still
    // spend. The credits are real; the date is not.
    resetsAt: resetsAt != null && resetsAt > Date.now() ? resetsAt : null,
    isExhausted: pool.remaining != null ? pool.remaining <= 0 : pool.used >= pool.limit,
    // Same credit line as CodeBuddy: the balance is named in words ("积分") and
    // the remainder is stated here, not in `remaining`, so the card does not
    // print it a second time.
    amount: `${U.count(pool.used)} / ${U.count(pool.limit)} 积分 · 剩余 ${U.count(left)}`,
  });
}

// The mainland API lists each resource pack with its own remaining credits and
// expiry, so those real dates are summed by day — the same list CodeBuddy
// shows. total_quota.quota_detail is the full set; the resource-package box is
// only a fallback, never added on top (that would count packs twice). Replies
// without any dated pack fall back to the single account reset day.
function expirations(reply, pool, resetsAt) {
  const totalBox = container(reply, 'totalQuota', 'total_quota');
  const packBox = container(reply, 'resourcePackageQuota', 'resource_package_quota');
  const details = (totalBox && field(totalBox, 'quotaDetail', 'quota_detail'))
    || (packBox && field(packBox, 'quotaDetail', 'quota_detail'));
  const byDate = new Map();
  if (Array.isArray(details)) {
    for (const d of details) {
      if (!d || typeof d !== 'object') continue;
      const left = U.num(field(d, 'remainingValue', 'remaining_value'));
      const ts = stamp(field(d, 'expiresAt', 'expires_at'));
      if (left == null || left <= 0 || ts == null || ts <= Date.now()) continue;
      const dt = new Date(ts);
      const date = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      byDate.set(date, (byDate.get(date) || 0) + left);
    }
  }
  if (byDate.size) {
    return [...byDate].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, credits]) => ({ date, credits }));
  }
  if (resetsAt == null || resetsAt <= Date.now()) return [];
  const left = pool.remaining != null ? pool.remaining : Math.max(0, pool.limit - pool.used);
  if (!(left > 0)) return [];
  const dt = new Date(resetsAt);
  const date = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  return [{ date, credits: left }];
}

/** The rings, or the reason there are none. */
function parse(text) {
  let reply;
  try { reply = JSON.parse(text); } catch { return { error: 'unreadableReply' }; }
  if (!reply || typeof reply !== 'object') return { error: 'unreadableReply' };

  const personal = summary(container(reply, 'totalQuota', 'total_quota'));
  if (!personal) return { error: 'unreadableReply' };

  const now = Date.now();
  const resetsAt = stamp(field(reply, 'nextResetAt', 'next_reset_at'));
  const windows = [];
  const own = ring(personal, 'qoder.credits', 'credits', resetsAt);
  if (own) windows.push(own);

  // A team pool: absent is normal, unreadable is not proof anything is spent.
  const sharedBox = container(reply, 'sharedQuota', 'shared_quota');
  if (sharedBox) {
    const shared = summary(sharedBox);
    if (!shared) return { error: 'unreadableReply' };
    // The reset Qoder states is the account's, so it is not claimed for the pool.
    const poolRing = ring(shared, 'qoder.shared', 'sharedCredits', null);
    if (poolRing) windows.push(poolRing);
  }

  // A complete answer that the account has nothing to display.
  if (!windows.length) return { error: 'qoderNoCredits' };
  return { windows, expirations: expirations(reply, personal, resetsAt) };
}

// ------------------------------------------------------------------- fetch

// One attempt with one Cookie header. Kept separate so a stale pasted session
// can be tried first and, when the site refuses it, the local browser session
// tried next without the card ever going dark.
async function readOnce(cookie, origin) {
  const res = await request(origin + API_PATH, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      Cookie: cookie,
      Origin: origin,
      Referer: `${origin}/account/usage`,
      // What the page's own request carries. `Bx-V` belongs to Alibaba's bot
      // screening; a request that does not look like the page it stands in for
      // is the one that screening is there to turn away.
      'X-Requested-With': 'XMLHttpRequest',
      'Bx-V': '2.5.35',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
    },
  });

  if (res.status === 0) return U.unavailable(ACCOUNT, 'unreachable');
  // A signed-out page answers the API call by sending it to the sign-in flow.
  if ((res.status >= 300 && res.status < 400) || res.status === 401 || res.status === 403) {
    return U.unavailable(ACCOUNT, 'sessionExpired');
  }
  if (res.status === 429) return U.unavailable(ACCOUNT, 'rateLimited');
  if (res.status >= 500) return U.unavailable(ACCOUNT, 'serverError');
  if (res.status !== 200) return U.unavailable(ACCOUNT, 'unreadableReply');
  const out = parse(res.text);
  if (out.error === 'unreadableReply') {
    const body = String(res.text || '').slice(0, 4096).toLowerCase();
    return body.includes('<html') && (body.includes('signin') || body.includes('login'))
      ? U.unavailable(ACCOUNT, 'sessionExpired')
      : U.unavailable(ACCOUNT, 'unreadableReply');
  }
  return out.error ? U.unavailable(ACCOUNT, out.error)
    : U.live(ACCOUNT, out.windows, { expirations: out.expirations });
}

async function fetchUsage(ctx) {
  const host = HOSTS[ctx.site] || HOSTS.international;
  const origin = `https://${host}`;
  const pasted = normalizeCookie(ctx.key);
  const local = browserCookie(ctx.site);
  const candidates = [];
  if (pasted) candidates.push(pasted);
  if (local && local !== pasted) candidates.push(local);

  let usage = U.unavailable(ACCOUNT, 'sessionMissing');
  for (const cookie of candidates) {
    usage = await readOnce(cookie, origin);
    if (usage.state === 'live') break;
  }

  // The CLI's own transcripts are this machine's ledger — billed credits per
  // reply, whether the web session answered or not.
  try {
    const ledger = await require('../agentLedger.js').readLedger('qoder', ctx.dataDir);
    if (ledger) { ledger.note = 'credits'; usage.ledger = ledger; }
  } catch { /* a missing transcript is simply no history */ }

  return usage;
}

module.exports = { fetchUsage, normalizeCookie, browserCookie, parse, HOSTS };
