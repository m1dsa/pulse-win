// Pulse for Windows — entry point.
// Mirrors the macOS app shell: accessory-style (no taskbar entry), a floating
// non-activating panel instead of a WindowGroup, a tray icon instead of
// NSStatusItem, and the same `Pulse --statusline` CLI mode for Claude Code.
'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, safeStorage, powerMonitor, shell } = require('electron');
const { Settings } = require('./settings.js');
const { UsageStore } = require('./store.js');
const statusline = require('./statusline.js');
const { PROVIDERS } = require('./providers/index.js');
const { PanelController } = require('./windows.js');

// `--statusline` switches the executable out of app mode before Electron owns
// the process — same contract as the macOS build.
if (process.argv.includes(statusline.MODE_ARG)) {
  statusline.runAsStatusLine();
  return;
}

const DATA_DIR = path.join(app.getPath('userData'));
const ICONS_DIR = path.join(__dirname, '..', '..', 'assets', 'icons');

let settings, store, panel, tray, settingsWin = null;
let forceQuit = false;

// One instance; a second launch just surfaces the first.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else app.on('second-instance', () => openSettings());

// The provider icons are inlined once and shipped to the renderers, so the
// panel never has to touch the filesystem.
function loadIcons() {
  const map = {};
  for (const p of PROVIDERS) {
    try {
      map[p.id] = fs.readFileSync(path.join(ICONS_DIR, p.icon), 'utf8')
        .replace(/<title>[\s\S]*?<\/title>/g, ''); // a <title> in the SVG becomes a stray tooltip
    } catch { }
  }
  try {
    map.__app = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'pulse-icon.svg'), 'utf8')
      .replace(/<title>[\s\S]*?<\/title>/g, '');
  } catch { }
  return map;
}

function trayIcon() {
  const png = path.join(__dirname, '..', '..', 'assets', 'pulse-icon-32.png');
  try {
    const img = nativeImage.createFromPath(png);
    if (!img.isEmpty()) return img;
  } catch { }
  // Fall back to the big icon resized.
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'pulse-icon-1024.png'));
    return img.resize({ width: 32, height: 32 });
  } catch { }
  return nativeImage.createEmpty();
}

function contextMenu() {
  const s = settings;
  const panelVisible = panel && panel.isVisible();
  return Menu.buildFromTemplate([
    { label: '立即刷新', click: () => store.refreshAll() },
    { type: 'separator' },
    { label: panelVisible ? '隐藏悬浮条' : '显示悬浮条', click: () => togglePanel() },
    { label: '设置…', click: () => openSettings() },
    { type: 'separator' },
    {
      label: '开机自动启动', type: 'checkbox', checked: s.get('launchAtLogin'),
      click: (item) => setLaunchAtLogin(item.checked),
    },
    { type: 'separator' },
    { label: '退出', click: () => { forceQuit = true; app.quit(); } },
  ]);
}

function togglePanel() {
  const visible = panel.isVisible();
  settings.patchPanel({ visible: !visible });
  visible ? panel.hide() : panel.show();
  buildTrayMenu();
}

function setLaunchAtLogin(on) {
  settings.set('launchAtLogin', on);
  app.setLoginItemSettings({ openAtLogin: !!on, args: [] });
  buildTrayMenu();
}

function buildTrayMenu() {
  if (tray) tray.setContextMenu(contextMenu());
}

function openSettings(section) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    if (section) settingsWin.webContents.send('settings:section', section);
    return;
  }
  settingsWin = new BrowserWindow({
    width: 720, height: 600, minWidth: 560, minHeight: 480,
    title: 'Pulse 设置', backgroundColor: '#161617',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'api.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  if (section) settingsWin.webContents.once('did-finish-load', () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:section', section);
  });
  settingsWin.on('closed', () => { settingsWin = null; });
}

function snapshot() {
  return {
    state: store.state(),
    settings: {
      panel: settings.get('panel'),
      refreshMinutes: settings.get('refreshMinutes'),
      warningThreshold: settings.get('warningThreshold'),
      autoCollapse: settings.get('autoCollapse'),
      showNumbers: settings.get('showNumbers'),
      launchAtLogin: settings.get('launchAtLogin'),
      hidesFromScreenCapture: settings.get('hidesFromScreenCapture'),
      minimaxSite: settings.get('minimaxSite'),
      deepseekBasis: settings.get('deepseekBasis'),
      deepseekBudget: settings.get('deepseekBudget'),
      deepseekCurrency: settings.get('deepseekCurrency'),
      enabledAccounts: settings.get('enabledAccounts'),
    },
    providers: PROVIDERS.map((p) => ({
      id: p.id, name: p.name, usesAPIKey: p.usesAPIKey, apiKeyOptional: !!p.apiKeyOptional,
      keyHint: p.keyHint || null,
      sites: p.sites || null, balanceAccount: !!p.balanceAccount,
      detected: safeDetect(p),
      hasKey: settings.hasKey(p.id),
      enabled: (settings.get('enabledAccounts') || []).includes(p.id),
    })),
    icons: loadIcons(),
    statusLineInstalled: statusline.isInstalled(),
    needsProviderSelection: settings.needsProviderSelection,
    version: app.getVersion(),
  };
}

function safeDetect(p) { try { return p.discovered(); } catch { return false; } }

function broadcast() {
  const snap = snapshot();
  for (const win of [panel && panel.win, panel && panel.cardWin, settingsWin]) {
    if (win && !win.isDestroyed()) win.webContents.send('state', snap);
  }
  if (panel) panel.updateState(snap);
  buildTrayMenu();
}

function wireIpc() {
  ipcMain.handle('snapshot', () => snapshot());
  ipcMain.on('refresh', (_e, id) => { id ? store.refresh(id) : store.refreshAll(); });
  ipcMain.on('panel:toggle', () => togglePanel());
  ipcMain.on('settings:open', (_e, section) => openSettings(section));
  ipcMain.on('open:external', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
  });
  ipcMain.on('quit', () => { forceQuit = true; app.quit(); });

  ipcMain.on('settings:set', (_e, key, value) => {
    if (key === 'launchAtLogin') return setLaunchAtLogin(value);
    if (key === 'hidesFromScreenCapture') {
      settings.set(key, !!value);
      applyContentProtection();
      return broadcast();
    }
    settings.set(key, value);
    broadcast();
    // Only data-affecting settings refetch; layout-only changes just re-place.
    if (['minimaxSite', 'deepseekBasis', 'deepseekBudget', 'deepseekCurrency'].includes(key)) store.refreshAll();
    if (key === 'refreshMinutes') store.schedule();
  });
  ipcMain.on('settings:patchPanel', (_e, patch) => {
    settings.patchPanel(patch);
    if (panel) {
      panel.dock = settings.get('panel').dock || panel.dock;
      panel.freeAxis = settings.get('panel').freeAxis || panel.freeAxis;
      if (typeof settings.get('panel').ratio === 'number') panel.ratio = settings.get('panel').ratio;
      panel.reposition();
    }
    broadcast();
  });

  ipcMain.on('provider:toggle', (_e, id, on) => {
    const cur = new Set(settings.get('enabledAccounts') || []);
    on ? cur.add(id) : cur.delete(id);
    settings.set('enabledAccounts', [...cur]);
    broadcast();
    // First enable is also first run's exit: the rail appears.
    if (cur.size && !panel.isVisible()) panel.show();
    if (!cur.size && panel.isVisible()) panel.hide(); // nothing enabled → nothing drawn
    panel.rebuild();
    store.start();
  });
  ipcMain.on('key:set', (_e, id, key) => {
    settings.setKey(id, key && String(key).trim() ? String(key).trim() : null, safeStorage);
    broadcast();
    store.refresh(id);
  });

  ipcMain.handle('statusline:isInstalled', () => statusline.isInstalled());
  ipcMain.handle('statusline:install', () => statusline.install(process.execPath));
  ipcMain.handle('statusline:uninstall', () => statusline.uninstall());
}

function applyContentProtection() {
  const on = !!settings.get('hidesFromScreenCapture');
  for (const w of [panel && panel.win, panel && panel.cardWin]) {
    if (w && !w.isDestroyed()) w.setContentProtection(on);
  }
}

app.whenReady().then(() => {
  settings = new Settings(DATA_DIR);
  store = new UsageStore(settings, DATA_DIR);
  store.attachCrypto(safeStorage);

  app.setLoginItemSettings({ openAtLogin: !!settings.get('launchAtLogin'), args: [] });

  tray = new Tray(trayIcon());
  tray.setToolTip('Pulse — AI 用量监控');
  tray.setContextMenu(contextMenu());
  tray.on('click', () => togglePanel());

  panel = new PanelController(settings, broadcast);
  panel.contextMenuAt = () => tray.popUpContextMenu();
  panel.refreshProvider = (id) => store.refresh(id);
  wireIpc();
  applyContentProtection();

  store.on('changed', () => broadcast());

  // First run: no enabled providers → the chooser opens; the rail stays away.
  if (settings.needsProviderSelection) {
    openSettings('providers');
  } else {
    if (settings.get('panel').visible !== false) panel.show();
    store.start();
  }

  powerMonitor.on('resume', () => store.refreshAll());
  screen.on('display-metrics-changed', () => panel.reposition());

  app.on('before-quit', () => { forceQuit = true; });
});
