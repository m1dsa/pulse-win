'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const text = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8');
const blocks = [...text.matchAll(/([\w./-]+):\s*\n\s+kind:\s*(\S+)\s*\n\s+payload:\s*\n((?:\s{6,}\S.*\n?)*)/g)];
const found = {};
for (const b of blocks) {
  const m = /token:\s*(\S+)/.exec(b[3]) || /secret:\s*(\S+)/.exec(b[3]);
  found[b[1]] = { kind: b[2], value: m ? m[1] : null };
}
console.log(Object.keys(found).map((k) => `${k} kind=${found[k].kind} has=${!!found[k].value}`).join('\n'));

const ORIGIN = 'https://platform.deepseek.com';
async function get(p, token) {
  const res = await fetch(ORIGIN + p, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, code: body && body.code };
}

(async () => {
  for (const [name, rec] of Object.entries(found)) {
    if (!rec.value) continue;
    const r = await get('/api/v0/users/get_user_summary', rec.value);
    console.log(`${name} → summary ${r.status} code=${r.code}`);
  }
})().catch((e) => console.log('ERR', e.message));
