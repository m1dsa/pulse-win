// UsageStore: owns readings, the refresh timer, and the cache file.
// Adaptive refresh is a single timer, 2–30 minutes, shortened while a
// provider is mid-fetch or after a failure — not a fixed 60s loop.
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');
const { PROVIDERS, byId } = require('./providers/index.js');

const FLOOR_S = 120;    // 2 min
const CEILING_S = 1800; // 30 min
// A 429 means "same answer, ask later" — keep serving the last reading and
// hit nothing until the cooldown ends. Anthropic's oauth usage endpoint is
// especially quick to refuse.
const COOLDOWN_MS = 3 * 60 * 1000;

class UsageStore extends EventEmitter {
  constructor(settings, dataDir) {
    super();
    this.settings = settings;
    this.dataDir = dataDir;
    this.readings = new Map();   // accountId -> ProviderUsage
    this.busy = new Set();
    this.cooldownUntil = new Map(); // accountId -> ms; no fetch while cooling
    this.timer = null;
    this.cacheFile = path.join(dataDir, 'usage-cache.json');
    this.loadCache();
  }

  loadCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      for (const [id, usage] of Object.entries(raw)) {
        if (usage && usage.state === 'live') usage.state = 'stale'; // a cached reading is not current
        this.readings.set(id, usage);
      }
    } catch { }
  }

  saveCache() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const obj = {};
      for (const [id, u] of this.readings) if (u.state !== 'unavailable') obj[id] = u;
      fs.writeFileSync(this.cacheFile, JSON.stringify(obj));
    } catch { }
  }

  state() {
    return {
      readings: Object.fromEntries(this.readings),
      busy: [...this.busy],
      enabled: this.settings.get('enabledAccounts'),
      warningThreshold: this.settings.get('warningThreshold'),
      lastRefreshAt: this.lastRefreshAt || null,
    };
  }

  start() {
    this.stop();
    if (this.settings.needsProviderSelection) return; // nothing enabled → nothing fetched
    this.refreshAll();
    this.schedule();
  }

  stop() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }

  schedule(delayS) {
    this.stop();
    const base = (this.settings.get('refreshMinutes') || 5) * 60;
    const s = Math.min(Math.max(delayS || base, FLOOR_S), CEILING_S);
    this.timer = setTimeout(() => { this.refreshAll(); this.schedule(); }, s * 1000);
  }

  async refreshAll() {
    const enabled = this.settings.get('enabledAccounts') || [];
    await Promise.allSettled(enabled.map((id) => this.refresh(id)));
    this.lastRefreshAt = Date.now();
    this.saveCache();
    this.emit('changed', this.state());
  }

  async refresh(accountId) {
    const enabled = this.settings.get('enabledAccounts') || [];
    if (!enabled.includes(accountId)) return; // a switched-off provider is not fetched
    const provider = byId.get(accountId);
    if (!provider) return;
    if (this.busy.has(accountId)) return;
    const cool = this.cooldownUntil.get(accountId);
    if (cool && Date.now() < cool) return; // rate-limited earlier — hold the last reading

    this.busy.add(accountId);
    this.emit('changed', this.state());
    try {
      const usage = await provider.fetch(this.ctx(accountId));
      usage.observedAt = usage.observedAt || Date.now();
      if (usage.state === 'unavailable' && usage.reason === 'rateLimited') {
        this.cooldownUntil.set(accountId, Date.now() + COOLDOWN_MS);
        // Keep the last reading: a 429 means "same answer, ask later", so the
        // card keeps its numbers (aged by observedAt) instead of a red error.
        if (!this.readings.get(accountId)) this.readings.set(accountId, usage);
      } else {
        this.cooldownUntil.delete(accountId);
        this.readings.set(accountId, usage);
      }
    } catch {
      this.readings.set(accountId, {
        account: accountId, windows: [], observedAt: Date.now(),
        state: 'unavailable', reason: 'unreachable', stale: false,
        plan: null, creditBalance: null, creditRemaining: null, source: null,
      });
    } finally {
      this.busy.delete(accountId);
    }
    this.saveCache();
    this.emit('changed', this.state());
  }

  // The credential context a provider's fetch() is handed.
  ctx(accountId) {
    const s = this.settings;
    return {
      home: os.homedir(),
      dataDir: this.dataDir,
      account: accountId,
      key: s.key(accountId, this.safeStorage),
      saveKey: (key) => {
        if (this.safeStorage && this.safeStorage.isEncryptionAvailable()) s.setKey(accountId, key, this.safeStorage);
      },
      // A provider with two sites keeps its own setting named {id}Site.
      site: s.get(accountId + 'Site'),
      basis: s.get('deepseekBasis'),
      budget: s.get('deepseekBudget'),
      currency: s.get('deepseekCurrency'),
    };
  }

  attachCrypto(safeStorage) { this.safeStorage = safeStorage; }
}

module.exports = { UsageStore };
