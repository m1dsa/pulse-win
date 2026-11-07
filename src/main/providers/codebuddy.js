// CodeBuddy IDE account quota. The account reports credits, not token limits.
'use strict';
const crypto = require('crypto');
const U = require('../../shared/usage.js');
const ledger = require('../agentLedger.js');
const { request } = require('../http.js');
const BASE = 'https://copilot.tencent.com';
const NO_AUTH = { 'X-Product-Code': 'codebuddy', 'X-No-Authorization': 'true',
  'X-No-User-Id': 'true', 'X-No-Enterprise-Id': 'true', 'X-No-Department-Info': 'true' };

function unwrap(root) {
  const d = root && root.data;
  return d && typeof d === 'object' && 'data' in d ? d.data : d;
}
function headers(auth, account, machineId) {
  const h = { 'X-Product-Code': 'codebuddy', 'X-IDE-Type': 'vscode',
    'X-IDE-Name': 'Visual Studio Code', 'X-IDE-Version': '1.70.2',
    'X-Product-Version': '4.10.33259736', 'X-Machine-Id': machineId,
    Authorization: `Bearer ${auth.accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' };
  if (account.uid) h['X-User-Id'] = String(account.uid);
  if (account.enterpriseId) h['X-Enterprise-Id'] = h['X-Tenant-Id'] = String(account.enterpriseId);
  if (auth.domain) h['X-Domain'] = String(auth.domain);
  return h;
}
function parse(res) {
  if (!res || !res.status) return U.unavailable('codebuddy', 'unreachable');
  if (res.status === 401 || res.status === 403 || (res.json && [401, 403].includes(Number(res.json.code)))) return U.unavailable('codebuddy', 'buddySignIn');
  if (res.status === 429) return U.unavailable('codebuddy', 'rateLimited');
  if (res.status >= 500) return U.unavailable('codebuddy', 'serverError');
  const root = res.json;
  if (res.status !== 200 || !root || (root.code != null && Number(root.code) !== 0)) return U.unavailable('codebuddy', 'unreadableReply');
  const data = root.data;
  if (!data || !Array.isArray(data.Packages)) return U.unavailable('codebuddy', 'unreadableReply');
  const windows = [];
  for (const [i, p] of data.Packages.entries()) {
    const used = U.num(p.CycleUsedCapacity), total = U.num(p.CycleTotalCapacity), remaining = U.num(p.CycleRemainCapacity);
    if (used == null || total == null || total <= 0 || used < 0 || (remaining != null && remaining < 0)) continue;
    const left = remaining == null ? Math.max(0, total - used) : remaining;
    windows.push(U.makeWindow({ id: `codebuddy.${i}`, kind: 'credits',
      scope: p.PackageCode && p.PackageCode === data.SubscriptionPackageCode ? '套餐' : '资源包',
      usedFraction: used / total, reportsLength: false, isExhausted: left <= 0,
      amount: `${U.count(used)} / ${U.count(total)} 积分 · 剩余 ${U.count(left)}` }));
  }
  return windows.length ? U.live('codebuddy', windows, {}) : U.unavailable('codebuddy', 'noLimitsReported');
}

// Each resource instance carries its own remaining credits and cycle end.
// Never attach a package's aggregate balance to one arbitrarily chosen date.
async function readExpirations(auth, account, machineId, send = request) {
  const byDate = new Map();
  let offset = 0;
  for (let page = 0; page < 10; page++) {
    const res = await send(BASE + '/billing/meter/get-user-resource', {
      method: 'POST', body: JSON.stringify({ Offset: offset, Limit: 100 }),
      headers: headers(auth, account, machineId), timeoutMs: 15000, retries: 0, noDirectFallback: true,
    });
    const root = res && res.json;
    const data = root && root.data && root.data.Response && root.data.Response.Data;
    if (!res || res.status !== 200 || !root || (root.code != null && Number(root.code) !== 0) ||
        !data || !Array.isArray(data.Accounts) || data.TotalCount == null || !Number.isFinite(Number(data.TotalCount))) return null;
    for (const entry of data.Accounts) {
      if (!entry || Number(entry.Status) !== 0) continue;
      const remaining = U.num(entry.CycleCapacityRemainPrecise);
      if (remaining === 0) continue;
      const match = typeof entry.CycleEndTime === 'string' && /^(\d{4}-\d{2}-\d{2})(?:[ T]|$)/.exec(entry.CycleEndTime);
      if (remaining == null || remaining < 0 || !match) return null;
      byDate.set(match[1], (byDate.get(match[1]) || 0) + remaining);
    }
    offset += data.Accounts.length;
    if (offset >= Number(data.TotalCount)) {
      return [...byDate].sort((a, b) => a[0].localeCompare(b[0])).map(([date, credits]) => ({ date, credits }));
    }
    if (!data.Accounts.length) return null;
  }
  return null;
}

async function fetchUsage(ctx) {
  let usage = U.unavailable('codebuddy', 'buddySignIn');
  try {
    const saved = ctx.key && JSON.parse(ctx.key);
    if (saved && saved.auth && saved.auth.accessToken && saved.account && saved.machineId) {
      const query = () => request(BASE + '/billing/meter/get-user-resource-summary', {
        method: 'POST', body: '{}', headers: headers(saved.auth, saved.account, saved.machineId),
        timeoutMs: 15000, retries: 0, noDirectFallback: true,
      });
      let res = await query();
      if ((res.status === 401 || res.status === 403 || (res.json && [401, 403].includes(Number(res.json.code))) ) && saved.auth.refreshToken) {
        const h = headers(saved.auth, saved.account, saved.machineId);
        delete h.Authorization;
        h['X-Refresh-Token'] = saved.auth.refreshToken;
        h['X-Auth-Refresh-Source'] = 'plugin';
        const refresh = await request(BASE + '/v2/plugin/auth/token/refresh', {
          method: 'POST', body: '{}', headers: h, timeoutMs: 15000, retries: 0, noDirectFallback: true,
        });
        const next = unwrap(refresh.json);
        if (refresh.status === 200 && next && next.accessToken) {
          saved.auth = { ...saved.auth, ...next };
          if (typeof ctx.saveKey === 'function') ctx.saveKey(JSON.stringify(saved));
          res = await query();
        }
      }
      usage = parse(res);
      if (usage.state === 'live') {
        try {
          usage.expirations = await readExpirations(saved.auth, saved.account, saved.machineId);
        } catch { usage.expirations = null; }
      }
    }
  } catch { /* a missing or expired login remains unavailable */ }
  try { usage.ledger = await ledger.readLedger('codebuddy', ctx.dataDir); } catch { /* no local history */ }
  return usage;
}

async function beginLogin(openURL) {
  const options = { headers: { ...NO_AUTH, 'Content-Type': 'application/json' }, timeoutMs: 15000, retries: 0, noDirectFallback: true };
  const stateRes = await request(BASE + '/v2/plugin/auth/state?platform=VSCode', { ...options, method: 'POST', body: '{}' });
  const state = unwrap(stateRes.json);
  if (stateRes.status !== 200 || !state || !state.state || !state.authUrl) throw new Error('login unavailable');
  const url = new URL(state.authUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'copilot.tencent.com') throw new Error('unexpected login host');
  await openURL(url.toString());
  const until = Date.now() + 120000;
  while (Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const tokenRes = await request(BASE + '/v2/plugin/auth/token?state=' + encodeURIComponent(state.state), options);
    const auth = unwrap(tokenRes.json);
    if (!auth || !auth.accessToken) continue;
    const h = { ...NO_AUTH, Authorization: `Bearer ${auth.accessToken}` };
    delete h['X-No-Authorization'];
    if (auth.domain) h['X-Domain'] = String(auth.domain);
    const accountUntil = Date.now() + 30000;
    while (Date.now() < accountUntil) {
      const accRes = await request(BASE + '/v2/plugin/login/account?state=' + encodeURIComponent(state.state), { ...options, headers: h });
      const account = unwrap(accRes.json);
      if (account && account.uid) return { auth, account, machineId: crypto.randomUUID() };
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('account not available');
  }
  throw new Error('login not completed');
}

module.exports = { fetchUsage, parse, beginLogin, readExpirations };
