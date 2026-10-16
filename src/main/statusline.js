// `Pulse --statusline` — Pulse's side of Claude Code's status line.
// Reads one JSON payload from stdin, banks rate_limits to
// ~/.claude/pulse-usage.json, and prints a status line back. Anything
// unexpected is swallowed on purpose: this runs inside someone's editor.
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const MODE_ARG = '--statusline';

function cacheFile() { return path.join(os.homedir(), '.claude', 'pulse-usage.json'); }
function settingsFile() { return path.join(os.homedir(), '.claude', 'settings.json'); }

function percent(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' ? Number(v) : null);
  if (n == null || !Number.isFinite(n) || n < 0 || n > 101) return null; // leaked epochs are dropped
  return n;
}

function defaultLine(root) {
  const limits = (root && root.rate_limits) || {};
  const parts = [['five_hour', '5h'], ['seven_day', '7d']]
    .map(([key, label]) => {
      const node = limits[key];
      const p = node && percent(node.used_percentage);
      return p == null ? null : `${label} ${Math.round(p)}%`;
    }).filter(Boolean);
  const model = root && root.model && root.model.display_name;
  return [model, ...parts].filter(Boolean).join('  ·  ');
}

function runAsStatusLine() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    let root = null;
    try { root = JSON.parse(input); } catch { }
    if (root && root.rate_limits) {
      try {
        const tmp = cacheFile() + `.tmp-${process.pid}`;
        fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify({ capturedAt: Date.now() / 1000, rate_limits: root.rate_limits }));
        fs.renameSync(tmp, cacheFile());
      } catch { }
    }
    try { process.stdout.write(defaultLine(root || {})); } catch { }
    process.exit(0);
  });
}

function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return null; }
}

function isInstalled() {
  const settings = readSettings();
  const line = settings && settings.statusLine;
  return !!(line && typeof line.command === 'string' && line.command.includes(MODE_ARG));
}

// Points Claude Code's status line at this executable, remembering any
// command already there so it can be restored on uninstall.
function install(exePath) {
  if (!fs.existsSync(path.dirname(settingsFile()))) return false;
  let settings = {};
  if (fs.existsSync(settingsFile())) {
    settings = readSettings();
    if (!settings) return false; // an unreadable file is left alone
  }
  const previous = settings.statusLine && settings.statusLine.command;
  if (previous && !previous.includes(MODE_ARG)) {
    const prevFile = settingsFile() + '.pulse-previous';
    try { fs.writeFileSync(prevFile, previous); } catch { }
  }
  settings.statusLine = { type: 'command', command: `"${exePath}" ${MODE_ARG}` };
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); return true; }
  catch { return false; }
}

function uninstall() {
  const settings = readSettings();
  if (!settings) return false;
  const prevFile = settingsFile() + '.pulse-previous';
  let previous = null;
  try { previous = fs.readFileSync(prevFile, 'utf8'); } catch { }
  if (previous) settings.statusLine = { type: 'command', command: previous };
  else delete settings.statusLine;
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); fs.rmSync(prevFile, { force: true }); return true; }
  catch { return false; }
}

module.exports = { MODE_ARG, runAsStatusLine, isInstalled, install, uninstall, cacheFile };
