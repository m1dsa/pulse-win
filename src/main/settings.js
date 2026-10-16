// Settings + key storage. Mirrors AppSettings' contract in small:
// one JSON file in userData for prefs, API keys sealed by Electron
// safeStorage (DPAPI on Windows) into keys.dat next to it.
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DEFAULTS = {
  enabledAccounts: [],            // ordered provider ids on the rail
  offeredProviders: [],           // stamped once a chooser ran, so offers don't recur
  panel: { dock: 'right', ratio: 0.5, freeX: null, freeY: null, freeAxis: 'vertical', visible: true },
  refreshMinutes: 5,
  warningThreshold: 75,
  autoCollapse: true,
  showNumbers: true,
  launchAtLogin: true,
  hidesFromScreenCapture: false,
  language: 'zh-CN',
  minimaxSite: 'international',
  deepseekBasis: 'sinceTopUp',    // 'sinceTopUp' | 'yourBudget' | 'balanceOnly'
  deepseekBudget: null,
  deepseekCurrency: null,
  keysMinimaxChina: null,         // unused slot marker; keys live in keys.dat
};

class Settings {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'settings.json');
    this.keyFile = path.join(dir, 'keys.dat');
    this.data = { ...DEFAULTS, panel: { ...DEFAULTS.panel } };
    this.keys = {};
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...DEFAULTS, ...raw, panel: { ...DEFAULTS.panel, ...(raw.panel || {}) } };
    } catch { /* absent or unreadable: defaults */ }
    try { this.keys = JSON.parse(fs.readFileSync(this.keyFile, 'utf8')) || {}; } catch { this.keys = {}; }
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch { /* best effort */ }
  }

  get(k) { return this.data[k]; }
  set(k, v) { this.data[k] = v; this.save(); }
  patch(obj) { Object.assign(this.data, obj); this.save(); }
  patchPanel(obj) { Object.assign(this.data.panel, obj); this.save(); }

  // API keys are sealed per entry; the file alone tells no one anything.
  setKey(providerId, key, safeStorage) {
    if (!key) { delete this.keys[providerId]; }
    else if (safeStorage && safeStorage.isEncryptionAvailable()) {
      this.keys[providerId] = 'enc:' + safeStorage.encryptString(key).toString('base64');
    } else {
      this.keys[providerId] = 'plain:' + Buffer.from(key, 'utf8').toString('base64');
    }
    try { fs.writeFileSync(this.keyFile, JSON.stringify(this.keys)); } catch { }
  }

  key(providerId, safeStorage) {
    const raw = this.keys[providerId];
    if (!raw) return null;
    if (raw.startsWith('enc:')) {
      try {
        if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null;
        return safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64'));
      } catch { return null; }
    }
    if (raw.startsWith('plain:')) return Buffer.from(raw.slice(6), 'base64').toString('utf8');
    return null;
  }

  hasKey(providerId) { return !!this.keys[providerId]; }

  // First-run contract: the resolved account set is the gate, not whether a
  // window was dismissed. Empty means the chooser shows.
  get needsProviderSelection() { return this.data.enabledAccounts.length === 0; }
}

module.exports = { Settings, DEFAULTS };
