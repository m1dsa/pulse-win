'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const f = path.join(os.homedir(), '.dsh', 'sessions',
  '--D-Claude~0020Code~0020Workplace-~88AB~8BA8~538C~7684~52C7~6C14--',
  'session-1589be01-ee2f-41c5-beff-2e8e3680a3c1', 'session.v4.jsonl.zstd');
const raw = fs.readFileSync(f);

// How many concatenated zstd frames? Magic 0xFD2FB528LE.
let frames = 0;
for (let i = 0; i + 4 <= raw.length; i++) {
  if (raw.readUInt32LE(i) === 0xFD2FB528) frames++;
}
console.log('file', raw.length, 'bytes; magic hits:', frames);

// Streaming decode — how much comes out, and does the stream error?
const chunks = [];
const s = zlib.createZstdDecompress();
s.on('data', (c) => chunks.push(c));
s.on('error', (e) => console.log('stream error:', e.message));
s.on('end', () => {
  const out = Buffer.concat(chunks).toString('utf8');
  const lines = out.split('\n').filter(Boolean);
  const types = {};
  let usage = null;
  for (const l of lines) {
    try {
      const j = JSON.parse(l);
      types[j.type] = (types[j.type] || 0) + 1;
      if (!usage && j.data && j.data.usage) usage = JSON.stringify(j.data.usage);
    } catch { }
  }
  console.log('decoded', out.length, 'bytes;', lines.length, 'lines');
  console.log('types:', JSON.stringify(types));
  console.log('usage:', usage);
});
s.end(raw);
