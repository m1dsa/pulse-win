'use strict';
// Why does parseDshFile yield nothing? Check where the model lives.
const path = require('path');
const os = require('os');
const { parseForTest } = (() => {
  // reuse the real decode via the module internals — simplest: copy decode here
  const fs = require('fs'), zlib = require('zlib');
  function decode(file) {
    const raw = fs.readFileSync(file);
    if (raw.length < 4 || raw.readUInt32LE(0) !== 0xfd2fb528) return raw.toString('utf8').split('\n');
    const off = [];
    for (let i = 0; i + 4 <= raw.length; i++) if (raw.readUInt32LE(i) === 0xfd2fb528) off.push(i);
    const parts = [];
    for (let i = 0; i < off.length; i++) {
      const end = i + 1 < off.length ? off[i + 1] : raw.length;
      try { parts.push(zlib.zstdDecompressSync(raw.subarray(off[i], end))); } catch { }
    }
    return Buffer.concat(parts).toString('utf8').split('\n');
  }
  return { parseForTest: decode };
})();

const f = path.join(os.homedir(), '.dsh', 'sessions',
  '--D-Claude~0020Code~0020Workplace-~88AB~8BA8~538C~7684~52C7~6C14--',
  'session-1589be01-ee2f-41c5-beff-2e8e3680a3c1', 'session.v4.jsonl.zstd');

for (const l of parseForTest(f)) {
  if (!l) continue;
  let j; try { j = JSON.parse(l); } catch { continue; }
  if (j.type === 'session') {
    console.log('session keys:', Object.keys(j).join(','), '| seedLength:', j.seedLength, '| seq:', j.seq);
  }
  if (j.type === 'request/header') {
    console.log('header data keys:', Object.keys(j.data || {}).join(','),
      '| config:', JSON.stringify(((j.data || {}).header || {}).config));
  }
  if ((j.type === 'assistant/message' || j.type === 'compaction/summary') && j.data && j.data.usage) {
    const d = j.data, m = d.message || {}, s = m.source || {};
    console.log(`${j.type} seq=${j.seq} time=${j.time} | msg.id=${m.id} | source.model=${s.model} | provider=${s.provider} | keys(d)=${Object.keys(d).join(',')}`);
    if (--count <= 0) break;
  }
}
var count = 4;
