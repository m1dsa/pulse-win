'use strict';
// Does the DeepSeek Harness platform token answer the web console routes?
const fs = require('fs');
const os = require('os');
const path = require('path');

// credentials.yaml records are fixed-shape; pull the platform token without a
// yaml dependency.
function dshToken(file) {
  const text = fs.readFileSync(file, 'utf8');
  const block = /deepseek-account-platform\/default:[\s\S]*?payload:[\s\S]*?token:\s*(\S+)/.exec(text);
  return block ? block[1] : null;
}

const token = dshToken(path.join(os.homedir(), '.dsh', '.credentials.yaml'));
console.log('token found:', !!token, token ? `prefix=${token.slice(0, 8)}… len=${token.length}` : '');

const ORIGIN = 'https://platform.deepseek.com';
async function get(p, query = {}) {
  const url = new URL(ORIGIN + p);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, code: body && body.code, biz: body && body.data && body.data.biz_code, body };
}

(async () => {
  if (!token) return console.log('no token — stop');
  const s = await get('/api/v0/users/get_user_summary');
  console.log('summary:', s.status, 'code=' + s.code, 'biz=' + s.biz);
  if (s.body && s.body.data && s.body.data.biz_data) {
    const d = s.body.data.biz_data;
    console.log('  normal wallets:', JSON.stringify(d.normal_wallets));
    console.log('  bonus wallets :', JSON.stringify(d.bonus_wallets));
  }

  const now = Date.now() / 1000;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = Math.floor(today.getTime() / 1000) - 29 * 86400;
  const end = Math.floor(today.getTime() / 1000) + 86400;
  const a = await get('/api/v0/usage/by_api_key/amount', { start, end, tz: 28800 });
  console.log('amount :', a.status, 'code=' + a.code, 'biz=' + a.biz);
  if (a.body && a.body.data && a.body.data.biz_data) {
    const d = a.body.data.biz_data;
    console.log('  bucket:', d.bucket, '| series:', (d.series || []).length,
      '| models:', (d.series || []).map((x) => x.model).join(', ').slice(0, 120));
  }
})().catch((e) => console.log('ERR', e.message));
