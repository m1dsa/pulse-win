// Xiaomi console account quota, adapted from Pulse's XiaomiMiMoUsageService.
// The separate Electron session owns the login; no browser cookies are copied.
'use strict';
const U = require('../../shared/usage.js');
const ledger = require('../agentLedger.js');
const BASE = 'https://platform.xiaomimimo.com/api/v1/';

function classify(res) {
  if (!res || res.status === 0) return 'unreachable';
  if ([301, 302, 303, 307, 308, 401, 403].includes(res.status)) return 'mimoSignIn';
  if (res.status === 429) return 'rateLimited';
  if (res.status >= 500) return 'serverError';
  if (res.status !== 200 || !res.json || typeof res.json !== 'object') return 'unreadableReply';
  if ([401, 403].includes(Number(res.json.code))) return 'mimoSignIn';
  if (Number(res.json.code) !== 0 || res.json.code == null) return 'serverError';
  return null;
}

function parse(usage, detail, balance) {
  const error = classify(usage);
  if (error) return U.unavailable('mimo', error);
  const d = !classify(detail) && detail.json.data || null;
  const b = !classify(balance) && balance.json.data || null;
  const amount = b && U.num(b.balance);
  const currency = b && typeof b.currency === 'string' ? b.currency.trim() : '';
  const sym = { CNY: '¥', USD: '$', HKD: 'HK$', TWD: 'NT$', JPY: '¥', KRW: '₩', RUB: '₽' }[currency] || (currency && currency + ' ');
  const credit = amount != null && currency
    ? `${sym}${Number(amount).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : null;
  // Without a token plan the wallet balance is what the account has left.
  const noPlan = () => Object.assign(U.unavailable('mimo', 'mimoNoPlan'), { creditBalance: credit });
  const month = usage.json.data && usage.json.data.monthUsage;
  const items = month && month.items;
  // No plan at all comes back as monthUsage.items = null, not an empty list.
  if (!Array.isArray(items)) return items == null && month ? noPlan() : U.unavailable('mimo', 'unreadableReply');
  if (d && d.expired === true) return noPlan();
  if (!items.length) return noPlan();
  const used = U.num(items[0].used), limit = U.num(items[0].limit);
  if (used == null || used < 0 || limit == null || limit <= 0) return U.unavailable('mimo', 'unreadableReply');
  let reset = null;
  if (d && typeof d.currentPeriodEnd === 'string') {
    const v = d.currentPeriodEnd;
    reset = U.parseDate(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(v) ? v.replace(' ', 'T') + 'Z' : v);
  }
  const window = U.makeWindow({ id: 'mimo.plan', kind: 'monthly', usedFraction: used / limit,
    windowSeconds: 30 * 86400, reportsLength: false, resetsAt: reset,
    isExhausted: used >= limit,
    amount: `${U.count(used)} / ${U.count(limit)} · 剩余 ${U.count(Math.max(0, limit - used))}` });
  return U.live('mimo', [window], {
    plan: d && typeof d.planCode === 'string' ? d.planCode : null,
    creditBalance: credit,
  });
}

async function sessionGet(path) {
  try {
    const { session } = require('electron');
    if (!session) return { status: 0 };
    const response = await session.fromPartition('persist:pulse-mimo').fetch(BASE + path, {
      method: 'GET', redirect: 'manual', credentials: 'include',
      headers: { Accept: 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(15000),
    });
    let json = null;
    try { json = await response.json(); } catch { /* not JSON */ }
    return { status: response.status, json };
  } catch { return { status: 0 }; }
}

// The console session (api-platform_serviceToken and friends) is handed out as
// session-only cookies, so it dies when the app quits. Xiaomi's passToken is
// persistent, and the authorize page re-mints the console session from it
// without user input — replay that page in a hidden window on a 401.
const AUTHORIZE_URL = 'https://platform.xiaomimimo.com/authorize/';
const SESSION_COOKIE = 'api-platform_serviceToken';
// A penalty longer than one refresh cycle reads as an outage: the card sits on
// "sign in" for the whole wait even though the next attempt would succeed.
const RETRY_MS = 60 * 1000;
let reauthorizing = null;
let lastFailureAt = 0;

async function reauthorize() {
  if (reauthorizing) return reauthorizing;
  if (Date.now() - lastFailureAt < RETRY_MS) return false;
  reauthorizing = (async () => {
    const { BrowserWindow, session } = require('electron');
    if (!BrowserWindow || !session) return false;
    const ses = session.fromPartition('persist:pulse-mimo');
    const passToken = await ses.cookies.get({ name: 'passToken' }).catch(() => []);
    if (!passToken || !passToken.length) return false; // never signed in
    const win = new BrowserWindow({
      show: false, width: 480, height: 640,
      webPreferences: {
        partition: 'persist:pulse-mimo', contextIsolation: true,
        nodeIntegration: false, sandbox: true, backgroundThrottling: false,
      },
    });
    try {
      win.loadURL(AUTHORIZE_URL).catch(() => { });
      // The hidden window walks the same redirect chain the visible one does
      // and stalls the same way, so it needs the same reload-on-stall remedy
      // (see the watchdog in main.js) — with a longer budget for two retries.
      const deadline = Date.now() + 30000;
      let reloads = 0;
      let nextLook = Date.now() + 6000;
      while (Date.now() < deadline) {
        if (win.isDestroyed()) return false;
        const ck = await ses.cookies.get({ url: 'https://platform.xiaomimimo.com/', name: SESSION_COOKIE });
        if (ck.length) return true;
        if (Date.now() > nextLook) {
          nextLook = Date.now() + 6000;
          if (reloads < 2 && !win.webContents.isLoading()) { reloads++; win.webContents.reload(); }
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      return false;
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  })().then((ok) => {
    if (!ok) lastFailureAt = Date.now();
    return ok;
  }).finally(() => { reauthorizing = null; });
  return reauthorizing;
}

async function fetchUsage(ctx) {
  const read = () => Promise.all([
    sessionGet('tokenPlan/usage'), sessionGet('tokenPlan/detail'), sessionGet('balance'),
  ]);
  let [usage, detail, balance] = await read();
  if (classify(usage) === 'mimoSignIn' && await reauthorize()) {
    [usage, detail, balance] = await read();
  }
  const result = parse(usage, detail, balance);
  try { result.ledger = await ledger.readLedger('mimo', ctx.dataDir); } catch { /* no local history */ }
  return result;
}

module.exports = { fetchUsage, parse };
