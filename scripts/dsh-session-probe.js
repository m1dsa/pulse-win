'use strict';
// Peek at real DSH session files + a ZCode model_usage sample.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');

const home = os.homedir();
const sess = path.join(home, '.dsh', 'sessions');
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(4);
      fs.readSync(fd, buf, 0, 4, 0);
      fs.closeSync(fd);
      const magic = buf.readUInt32LE(0) === 0xFD2FB528 ? 'zstd' : 'plain';
      console.log(p.slice(home.length), (fs.statSync(p).size / 1024).toFixed(0) + 'KB', magic);
      if (magic === 'zstd') {
        const raw = zlib.zstdDecompressSync(fs.readFileSync(p));
        const lines = raw.toString('utf8').split('\n').filter(Boolean);
        console.log('  decoded', (raw.length / 1024).toFixed(0) + 'KB', lines.length, 'lines');
        // print just event types + which carry usage
        const types = {};
        let usageShape = null;
        for (const l of lines) {
          try {
            const j = JSON.parse(l);
            types[j.type] = (types[j.type] || 0) + 1;
            if (!usageShape && j.data && j.data.usage) usageShape = JSON.stringify(j.data.usage);
          } catch { }
        }
        console.log('  types:', JSON.stringify(types));
        console.log('  usage:', usageShape);
      }
    }
  }
})(sess);

const db = new DatabaseSync(path.join(home, '.zcode', 'cli', 'db', 'db.sqlite'), { readOnly: true });
const r = db.prepare("SELECT model_id, input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens, cache_creation_input_tokens, computed_total_tokens, started_at, status FROM model_usage ORDER BY started_at DESC LIMIT 5").all();
for (const row of r) console.log('zcode:', JSON.stringify(row));
db.close();
