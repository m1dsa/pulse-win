// Qwen Cloud — port of QwenCloudUsageService.swift.
//
// The individual Token Plan (5h / weekly / monthly shares used) is read the
// way the console's own page reads it: a qwencloud.com session cookie, the
// page's `sec_token`, then a form POST to the console gateway.
//
// On the Mac the cookie comes out of a browser's cookie jar. Here the user
// pastes the Cookie header into Settings instead — one string, same
// transport. Needs at least one sign-in ticket:
// login_qwencloud_ticket | login_aliyunid_ticket | qwen_sso_ticket, plus
// whatever of login_current_pk, login_aliyunid_pk, login_aliyunid_csrf,
// csrf, cna, sec_token the session carries.
'use strict';

const U = require('../../shared/usage.js');

const ACCOUNT = 'qwenCloud';
const ORIGIN = 'https://home.qwencloud.com';
const PAGE = `${ORIGIN}/billing/subscription/token-plan-individual`;
const USERINFO = `${ORIGIN}/tool/user/info.json`;
const GATEWAY = 'https://cs-data.qwencloud.com/data/api.json';
const USAGE_API = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage';
const SUBSCRIPTION_API = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription';
const COMMODITY = 'sfm_tokenplansolo_public_intl';
const TICKETS = ['login_qwencloud_ticket', 'login_aliyunid_ticket', 'qwen_sso_ticket'];

// ---------------------------------------------------------------- http
// Cookie is a forbidden header for fetch() but an ordinary one for Electron's
// net.request (ClientRequest), so the console session rides on that where it
// exists. Redirects are never followed: a 3xx is an expired session being
// sent to the sign-in page, not an answer.

function electronNet() {
  try {
    const e = require('electron');
    return e && e.net && e.net.request ? e.net : null;
  } catch { return null; }
}

function request(url, opts = {}) {
  const net = electronNet();
  return net ? netRequest(net, url, opts) : fetchRequest(url, opts);
}

function netRequest(net, url, opts) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (out) => { if (!done) { done = true; resolve(out); } };
    const timer = setTimeout(() => finish({ status: 0 }), opts.timeoutMs || 15000);
    let req;
    try {
      req = net.request({ url, method: opts.method || 'GET', redirect: 'manual', useSessionCookies: false });
    } catch (err) { clearTimeout(timer); return finish({ status: 0, error: err }); }
    for (const [k, v] of Object.entries(opts.headers || {})) {
      try { req.setHeader(k, v); } catch { /* forbidden name */ }
    }
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => { if (body.length < 512 * 1024) body += c.toString('utf8'); });
      res.on('end', () => { clearTimeout(timer); finish({ status: res.statusCode || 0, text: body }); });
      res.on('error', () => { clearTimeout(timer); finish({ status: 0 }); });
    });
    req.on('error', (err) => { clearTimeout(timer); finish({ status: 0, error: err }); });
    try { req.end(opts.body || undefined); } catch (err) { clearTimeout(timer); finish({ status: 0, error: err }); }
  });
}

async function fetchRequest(url, opts) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 15000);
    const res = await globalThis.fetch(url, {
      method: opts.method || 'GET', headers: opts.headers || {},
      body: opts.body, redirect: 'manual', signal: controller.signal,
    });
    clearTimeout(timer);
    return { status: res.status, text: await res.text() };
  } catch (err) { return { status: 0, error: err }; }
}

// ------------------------------------------------------------- cookie

function cookieValue(name, header) {
  for (const part of String(header).split(';')) {
    const p = part.trim();
    if (p.startsWith(name + '=')) {
      const v = p.slice(name.length + 1);
      return v || null;
    }
  }
  return null;
}

// --------------------------------------------------------- security token

const TOKEN_PATTERNS = [
  /"secToken"\s*:\s*"([^"]+)"/, /"sec_token"\s*:\s*"([^"]+)"/,
  /secToken['"]?\s*[:=]\s*['"]([^'"]+)['"]/, /sec_token['"]?\s*[:=]\s*['"]([^'"]+)['"]/,
  /csrfToken['"]?\s*[:=]\s*['"]([^'"]+)['"]/,
];

function tokenInPage(html) {
  for (const re of TOKEN_PATTERNS) {
    const m = re.exec(html);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

function isSignInPage(html) {
  const p = html.toLowerCase();
  return ['passport.alibabacloud.com', 'signin.aliyun.com',
    'account.alibabacloud.com/login', 'login.qwencloud.com'].some((s) => p.includes(s))
    || (p.includes('login') && p.includes('password') && p.includes('sign in'));
}

async function securityToken(cookie) {
  let pageFailure = null;
  const res = await request(PAGE, {
    headers: { Accept: 'text/html,application/xhtml+xml', Cookie: cookie },
  });
  if (res.status === 200 && res.text && !isSignInPage(res.text)) {
    const t = tokenInPage(res.text);
    if (t) return { token: t };
  } else if (res.status === 0) pageFailure = 'unreachable';
  else if (res.status >= 500) pageFailure = 'serverError';
  else if (res.status >= 300 && res.status < 400) pageFailure = 'sessionExpired';

  const inCookie = cookieValue('sec_token', cookie);
  if (inCookie) return { token: inCookie };

  const info = await request(USERINFO, {
    headers: { Accept: 'application/json, text/plain, */*', Cookie: cookie },
  });
  if (info.status === 200 && info.text) {
    try {
      const t = firstString(['secToken', 'sec_token', 'csrfToken', 'token'], expand(JSON.parse(info.text)));
      if (t) return { token: t };
    } catch { /* not json */ }
  }
  return { error: pageFailure || 'sessionExpired' };
}

// ------------------------------------------------------------- gateway

function esc(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

async function ask(api, data, token, cookie) {
  const cornerstone = {
    feTraceId: crypto.randomUUID().toLowerCase(), feURL: PAGE,
    protocol: 'V2', console: 'ONE_CONSOLE', productCode: 'p_efm',
    domain: 'home.qwencloud.com', consoleSite: 'QWENCLOUD',
    userNickName: '', userPrincipalName: '', xsp_lang: 'en-US',
  };
  const cna = cookieValue('cna', cookie);
  if (cna) cornerstone['X-Anonymous-Id'] = cna;
  const params = JSON.stringify({ Api: api, V: '1.0', Data: { ...data, cornerstoneParam: cornerstone } });

  const url = `${GATEWAY}?action=IntlBroadScopeAspnGateway&product=sfm_bailian&api=${esc(api)}&_v=undefined`;
  const body = [
    ['product', 'sfm_bailian'], ['action', 'IntlBroadScopeAspnGateway'],
    ['sec_token', token], ['region', 'ap-southeast-1'], ['language', 'en-US'],
    ['params', params],
  ].map(([k, v]) => `${esc(k)}=${esc(v)}`).join('&');

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json, text/plain, */*',
    Cookie: cookie, Origin: ORIGIN, Referer: PAGE,
    'X-Requested-With': 'XMLHttpRequest',
  };
  const csrf = cookieValue('login_aliyunid_csrf', cookie) || cookieValue('csrf', cookie);
  if (csrf) { headers['x-xsrf-token'] = csrf; headers['x-csrf-token'] = csrf; }

  const res = await request(url, { method: 'POST', headers, body });
  if (res.status === 0) return { error: 'unreachable' };
  if (res.status >= 300 && res.status < 400) return { error: 'sessionExpired' };
  if (res.status === 401 || res.status === 403) return { error: 'sessionExpired' };
  if (res.status !== 200) return { error: 'serverError' };
  return { text: res.text };
}

// -------------------------------------------------------- console JSON

// The envelope nests JSON strings inside JSON; expand until nothing is a
// serialized object.
function expand(v) {
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { return expand(JSON.parse(t)); } catch { /* leave it */ }
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(expand);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = expand(v[k]);
    return o;
  }
  return v;
}

function firstObject(value, matches) {
  if (Array.isArray(value)) {
    for (const n of value) { const f = firstObject(n, matches); if (f) return f; }
    return null;
  }
  if (value && typeof value === 'object') {
    if (matches(value)) return value;
    for (const k of Object.keys(value)) { const f = firstObject(value[k], matches); if (f) return f; }
  }
  return null;
}

function firstString(keys, value) {
  let out = null;
  firstObject(value, (o) => {
    out = keys.map((k) => o[k]).find((x) => typeof x === 'string' && x.trim()) || null;
    if (out) out = out.trim();
    return out != null;
  });
  return out;
}

function firstInt(keys, value) {
  let out = null;
  firstObject(value, (o) => {
    out = keys.map((k) => U.num(o[k])).find((n) => n != null) ?? null;
    return out != null;
  });
  return out == null ? null : Math.trunc(out);
}

const SIGN_IN_WORDS = ['needlogin', 'login', 'tokenerror', 'request has expired',
  'refresh page', '请求已经过期'];
const REFUSED_WORDS = ['notauthorised', 'notauthorized', 'not authorised', 'not authorized',
  'unauthorised', 'unauthorized', 'access denied', 'forbidden'];

// 'signedOut' | 'failed' | null — what a non-reading reply says went wrong.
function failure(tree) {
  const frame = firstObject(tree, (o) =>
    ['successResponse', 'success', 'Success'].some((k) => o[k] === false));
  const codeKeys = ['errorCode', 'code', 'Code', 'status', 'statusCode'];
  const messageKeys = ['errorMsg', 'message', 'Message', 'msg', 'statusMessage'];
  const said = [firstString(codeKeys, frame || tree), firstString(messageKeys, frame || tree)]
    .filter(Boolean).join(' ').toLowerCase();

  if (SIGN_IN_WORDS.some((w) => said.includes(w))) return 'signedOut';
  // A workspace the account may not use is a permission, not a session.
  if (!said.includes('workspace.notauthori') && REFUSED_WORDS.some((w) => said.includes(w))) return 'signedOut';
  if (frame) return 'failed';

  const status = firstInt(['statusCode', 'status_code', 'code', 'httpStatusCode'], tree);
  if (status != null && status !== 0 && status !== 200) {
    return status === 401 || status === 403 ? 'signedOut' : 'failed';
  }
  return null;
}

// ------------------------------------------------------------ readings

const ROLLING = [
  { key: 'per5HourPercentage', reset: 'per5HourResetTime', id: 'fiveHour', kind: 'fiveHour', seconds: 5 * 3600, reportsLength: true },
  { key: 'per1WeekPercentage', reset: 'per1WeekResetTime', id: 'weekly', kind: 'weekly', seconds: 7 * 86400, reportsLength: true },
  { key: 'per1MonthPercentage', reset: 'per1MonthResetTime', id: 'monthly', kind: 'monthly', seconds: 30 * 86400, reportsLength: false },
];

function rollingWindows(tree, now) {
  const keys = new Set(ROLLING.map((r) => r.key));
  const usage = firstObject(tree, (o) => Object.keys(o).some((k) => keys.has(k)));
  if (!usage) return [];
  return ROLLING.map((r) => {
    const ratio = U.num(usage[r.key]);
    if (ratio == null || ratio < 0) return null;
    const resetMs = U.num(usage[r.reset]);
    return U.makeWindow({
      id: `qwenCloud.${r.id}`, kind: r.kind,
      usedFraction: ratio, windowSeconds: r.seconds,
      resetsAt: resetMs != null && resetMs > now ? resetMs : null,
      reportsLength: r.reportsLength,
      isExhausted: ratio >= 1,
    });
  }).filter(Boolean);
}

function planName(subscriptionText) {
  try {
    const code = firstString(['specCode', 'spec_code', 'planName', 'plan_name'],
      expand(JSON.parse(subscriptionText)));
    if (!code) return null;
    return ['lite', 'standard', 'pro', 'max'].includes(code.toLowerCase())
      ? code[0].toUpperCase() + code.slice(1).toLowerCase() : code;
  } catch { return null; }
}

// ---------------------------------------------------------------- fetch

async function fetchUsage(ctx) {
  const cookie = String(ctx.key || '').trim();
  if (!cookie || !cookie.includes('=')) return U.unavailable(ACCOUNT, 'sessionMissing');
  if (!TICKETS.some((t) => cookie.includes(t + '='))) return U.unavailable(ACCOUNT, 'sessionMissing');

  const token = await securityToken(cookie);
  if (token.error) return U.unavailable(ACCOUNT, token.error);

  const used = await ask(USAGE_API, {}, token.token, cookie);
  if (used.error) return U.unavailable(ACCOUNT, used.error);

  let tree;
  try { tree = expand(JSON.parse(used.text)); }
  catch {
    const text = (used.text || '').slice(0, 4096).toLowerCase();
    return U.unavailable(ACCOUNT,
      text.includes('<html') && isSignInPage(text) ? 'sessionExpired' : 'unreadableReply');
  }

  const fail = failure(tree);
  if (fail === 'signedOut') return U.unavailable(ACCOUNT, 'sessionExpired');
  if (fail === 'failed') return U.unavailable(ACCOUNT, 'serverError');

  const windows = rollingWindows(tree, Date.now());
  if (!windows.length) {
    // An older summary-shaped reply can still say the account has no plan.
    const count = firstInt(['TotalCount', 'totalCount'], tree);
    return U.unavailable(ACCOUNT, count === 0 ? 'noPlan' : 'noLimitsReported');
  }

  // The tier's name only — its failure costs the label, not the figures.
  let plan = null;
  const sub = await ask(SUBSCRIPTION_API, { commodityCode: COMMODITY }, token.token, cookie);
  if (sub.text) plan = planName(sub.text);

  return U.live(ACCOUNT, windows, { plan });
}

module.exports = { fetchUsage };
