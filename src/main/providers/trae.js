// Trae CN (api.trae.cn) account credits.
//
// The IDE's own entitlement screen reads POST /trae/api/v2/pay/ide_user_ent_usage
// with `Authorization: Cloud-IDE-JWT <account token>`; the field names below
// come from that client, not from guesswork. The account token is read straight
// from the IDE's own encrypted local storage (see readLocalToken), so nothing
// has to be pasted; a token in Settings still wins if one is supplied.
//
// Each pack carries a credits limit (-1 = unlimited), the credits used and an
// expiry. Packs become credit windows and their remaining credits are summed
// per expiry date, the same way CodeBuddy shows its resource packs.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('../../shared/usage.js');
const { request } = require('../http.js');

const ACCOUNT = 'trae';
const API = 'https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage';

function normalizeToken(input) {
  let k = String(input == null ? '' : input).trim().replace(/^["']+|["']+$/g, '');
  k = k.replace(/^(cloud-ide-jwt|bearer)\s+/i, '').trim();
  return k || null;
}

// ------------------------------------------------------- local account token
// Trae keeps the signed-in account under iCubeAuthInfo://* keys in
// %APPDATA%\Trae CN\User\globalStorage\storage.json. The blob is encrypted
// with the pure-JS byteCrypto the IDE ships: a 6-byte "tc" header, a 32-byte
// seed, then AES-128-CBC of [SHA-512(plaintext) || plaintext], with the key
// and IV derived from that seed by SHA-512 chaining. All of it is standard
// WebCrypto, so the same bytes can be opened here without a native module.
// The token never leaves this machine; a pasted one still takes precedence.
const subtle = (() => { try { return require('crypto').webcrypto.subtle; } catch { return null; } })();
const EHE = Uint8Array.from([191,192,216,250,122,246,220,97,31,254,98,27,8,72,71,176,135,99,96,18,127,101,203,104,211,102,191,125,37,72,150,156,51,229,121,35,17,153,141,177,110,131,150,128,172,255,254,6,18,140,55,62,236,249,135,64,135,12,117,4,89,149,168,209]);
const THE = Uint8Array.from([246,204,26,232,232,70,129,109,223,146,169,242,23,241,105,145,50,196,165,42,254,120,3,54,244,207,209,85,53,6,138,106,175,148,31,204,186,186,165,182,87,142,49,10,39,110,26,154,86,56,173,125,18,64,198,225,99,99,83,82,191,134,76,170]);
const IHE = Uint8Array.from([82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37]);
const RHE = Uint8Array.from([31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125]);
const LP = 64, GS = 32, UL = 64, RV = 6;

async function sha512(t) { return new Uint8Array(await subtle.digest('SHA-512', t)); }
function mix(t, version) {
  const out = new Uint8Array(t);
  const a = version === 2 ? EHE : IHE, b = version === 2 ? THE : RHE;
  for (let i = 0; i < t; i++) out[i] = a[i] ^ b[i];
  return out;
}
async function keyIv(seed, version) {
  const n = new Uint8Array(LP + UL);
  n.set(await sha512(seed), 0);
  n.set(mix(UL, version), LP);
  n.set(await sha512(n), 0);
  return { key: n.slice(0, 16), iv: n.slice(16, 32) };
}
function cryptoVersion(t) {
  if (t[2] === 32 && t[3] === 32 && t[4] === 2 && t[5] === 3 && t[0] === 18 && t[1] === 57) return 2;
  if (t[0] !== 116 || t[1] !== 99) return 0;
  if (t[2] === 5 && t[3] === 16 && t[4] === 0 && t[5] === 0) return 1;
  return 0;
}
async function decryptAuthInfo(b64) {
  if (!subtle) return null;
  const bytes = Buffer.from(b64, 'base64');
  const version = cryptoVersion(bytes);
  if (!version) return null;
  const { key, iv } = await keyIv(bytes.slice(RV, RV + GS), version);
  let plain;
  try {
    const k = await subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['decrypt']);
    plain = new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, k, bytes.slice(GS + RV)));
  } catch { return null; }
  if (plain.length <= LP) return null;
  const check = await sha512(plain.slice(LP));
  for (let i = 0; i < LP; i++) if (check[i] !== plain[i]) return null;
  return new TextDecoder().decode(plain.slice(LP));
}

async function readLocalToken() {
  try {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const file = path.join(base, 'Trae CN', 'User', 'globalStorage', 'storage.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const keys = Object.keys(data).filter((k) => k.startsWith('iCubeAuthInfo'))
      .sort((a, b) => (b.includes('icube.cloudide') ? 1 : 0) - (a.includes('icube.cloudide') ? 1 : 0));
    for (const k of keys) {
      const text = await decryptAuthInfo(String(data[k]));
      if (!text) continue;
      try {
        const obj = JSON.parse(text);
        if (typeof obj.token === 'string' && obj.token) return obj.token;
      } catch { /* a device-key or usertag blob, not an account */ }
    }
  } catch { /* Trae not installed, or its storage format changed */ }
  return null;
}

// Expiries arrive as a numeric Unix stamp (seconds or milliseconds) or ISO text.
function stamp(value) {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value);
  const n = U.num(value);
  if (n != null && n > 0) return n > 1e12 ? Math.trunc(n) : Math.trunc(n * 1000);
  const t = Date.parse(value);
  return Number.isFinite(t) && t > 0 ? t : null;
}

function dateOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parse(text) {
  let reply;
  try { reply = JSON.parse(text); } catch { return { error: 'unreadableReply' }; }
  if (!reply || typeof reply !== 'object') return { error: 'unreadableReply' };
  if (reply.code != null && Number(reply.code) !== 0) {
    return { error: Number(reply.code) === 1001 ? 'sessionExpired' : 'unreadableReply' };
  }
  const packs = Array.isArray(reply.user_entitlement_pack_list) ? reply.user_entitlement_pack_list : [];
  const windows = [];
  const byDate = new Map();
  for (const [i, p] of packs.entries()) {
    if (!p || typeof p !== 'object') continue;
    const limit = U.num(p.entitlement_base_info?.quota?.credits_limit);
    // The IDE's own summariser treats a missing per-pack usage as zero; packs
    // that have not been spent yet arrive with `usage: {}`.
    const used = U.num(p.usage?.credits_amount) ?? 0;
    if (used < 0 || limit == null || limit === 0) continue;
    const unlimited = limit === -1;
    const left = unlimited ? Infinity : Math.max(0, limit - used);
    const scope = typeof p.display_desc === 'string' && p.display_desc.trim()
      ? p.display_desc.trim().slice(0, 24) : '积分包';
    windows.push(U.makeWindow({
      id: `trae.${i}`, kind: 'credits', scope,
      usedFraction: unlimited ? 0 : used / limit,
      reportsLength: false,
      isExhausted: !unlimited && left <= 0,
      amount: unlimited
        ? `已用 ${U.count(used)} 积分 · 不限量`
        : `${U.count(used)} / ${U.count(limit)} 积分 · 剩余 ${U.count(left)}`,
    }));
    if (!unlimited && left > 0) {
      const ts = stamp(p.expire_time ?? p.entitlement_base_info?.end_time);
      if (ts != null && ts > Date.now()) {
        const date = dateOf(ts);
        byDate.set(date, (byDate.get(date) || 0) + left);
      }
    }
  }
  if (!windows.length) return { error: 'traeNoCredits' };
  const expirations = [...byDate].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, credits]) => ({ date, credits }));
  return { windows, expirations };
}

async function fetchUsage(ctx) {
  let token = normalizeToken(ctx.key);
  if (!token) token = await readLocalToken();
  let usage;
  if (!token) {
    usage = U.unavailable(ACCOUNT, 'traeSignIn');
  } else {
    const res = await request(API, {
      method: 'POST',
      body: JSON.stringify({ require_usage: true, req_source: 1 }),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Cloud-IDE-JWT ${token}`,
        'X-User-Region': 'CN',
      },
      timeoutMs: 15000, retries: 0, noDirectFallback: true,
    });
    if (res.status === 0) usage = U.unavailable(ACCOUNT, 'unreachable');
    else if (res.status === 401 || res.status === 403) usage = U.unavailable(ACCOUNT, 'sessionExpired');
    else if (res.status === 429) usage = U.unavailable(ACCOUNT, 'rateLimited');
    else if (res.status >= 500) usage = U.unavailable(ACCOUNT, 'serverError');
    else if (res.status !== 200) usage = U.unavailable(ACCOUNT, 'unreadableReply');
    else {
      const out = parse(res.text);
      usage = out.error ? U.unavailable(ACCOUNT, out.error)
        : U.live(ACCOUNT, out.windows, { expirations: out.expirations });
    }
  }
  return usage;
}

module.exports = { fetchUsage, parse, normalizeToken, readLocalToken };
