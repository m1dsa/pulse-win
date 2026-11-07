// Pulse for Windows — entry point.
// Mirrors the macOS app shell: accessory-style (no taskbar entry), a floating
// non-activating panel instead of a WindowGroup, a tray icon instead of
// NSStatusItem, and the same `Pulse --statusline` CLI mode for Claude Code.
'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, safeStorage, powerMonitor, shell, dialog } = require('electron');
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

let settings, store, panel, tray, settingsWin = null, totalWin = null;
let forceQuit = false;
let buddyLoginRunning = false;

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
    { label: '总用量', click: () => openTotal() },
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
    if (!settingsWin.webContents.isLoadingMainFrame()) {
      settingsWin.show();
      settingsWin.focus();
    }
    if (section) settingsWin.webContents.send('settings:section', section);
    return;
  }
  settingsWin = new BrowserWindow({
    width: 720, height: 600, minWidth: 560, minHeight: 480,
    title: 'Pulse 设置', backgroundColor: '#161617',
    autoHideMenuBar: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'api.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  settingsWin.once('ready-to-show', () => {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); }
  });
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  if (section) settingsWin.webContents.once('did-finish-load', () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:section', section);
  });
  settingsWin.on('closed', () => { settingsWin = null; });
}

function openTotal() {
  if (totalWin && !totalWin.isDestroyed()) {
    totalWin.show();
    totalWin.focus();
    return;
  }
  totalWin = new BrowserWindow({
    width: 860, height: 660, minWidth: 720, minHeight: 560,
    title: 'Pulse 总用量', backgroundColor: '#161617',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'api.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  totalWin.loadFile(path.join(__dirname, '..', 'renderer', 'total.html'));
  totalWin.on('closed', () => { totalWin = null; });
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
      qoderSite: settings.get('qoderSite'),
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
  for (const win of [panel && panel.win, panel && panel.cardWin, settingsWin, totalWin]) {
    if (win && !win.isDestroyed()) win.webContents.send('state', snap);
  }
  if (panel) panel.updateState(snap);
  buildTrayMenu();
}

function wireIpc() {
  ipcMain.on('codebuddy:login', async () => {
    if (buddyLoginRunning) return;
    if (!safeStorage.isEncryptionAvailable()) {
      dialog.showErrorBox('CodeBuddy', '无法安全保存登录状态，请检查 Windows 加密服务。');
      return;
    }
    buddyLoginRunning = true;
    try {
      const credential = await require('./providers/codebuddy.js').beginLogin((url) => shell.openExternal(url));
      settings.setKey('codebuddy', JSON.stringify(credential), safeStorage);
      await store.refresh('codebuddy');
    } catch {
      dialog.showErrorBox('CodeBuddy', '登录未完成或连接失败，请重试。');
    } finally { buddyLoginRunning = false; }
  });
  ipcMain.on('mimo:login', () => {
    const win = new BrowserWindow({
      width: 1000, height: 720, title: '小米 MiMo 登录', autoHideMenuBar: true,
      webPreferences: { partition: 'persist:pulse-mimo', contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    // Xiaomi's login shell sometimes commits a document whose boot scripts were
    // aborted mid redirect-chain and then sits on "加载中..." forever. Reload it
    // instead of leaving the user a white window.
    const wc = win.webContents;
    let reloads = 0;
    let watchdog = null;
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(async () => {
        if (win.isDestroyed()) return;
        let stuck = false;
        try {
          stuck = await wc.executeJavaScript(`location.host === 'account.xiaomi.com' &&
            !(document.getElementById('root') || {}).children?.length &&
            (document.body.innerText || '').trim().length < 12`);
        } catch { return; }
        if (stuck && reloads < 2) { reloads++; wc.reload(); }
      }, 6000);
    };
    wc.on('did-start-loading', armWatchdog);
    wc.on('did-stop-loading', armWatchdog);
    wc.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
      // -3 is the console SPA replacing its own first navigation; that is normal.
      if (isMainFrame && code !== -3 && reloads < 2 && !win.isDestroyed()) { reloads++; wc.reload(); }
    });
    wc.loadURL('https://platform.xiaomimimo.com/authorize/').catch(() => { });
    win.on('closed', () => { if (watchdog) clearTimeout(watchdog); store.refresh('mimo'); });
  });
  ipcMain.on('qoder:login', () => {
    const host = settings.get('qoderSite') === 'china' ? 'qoder.com.cn' : 'qoder.com';
    const origin = `https://${host}`;
    const win = new BrowserWindow({
      width: 1000, height: 720, title: 'Qoder 登录', autoHideMenuBar: true,
      webPreferences: {
        partition: 'persist:pulse-qoder', contextIsolation: true,
        nodeIntegration: false, sandbox: true,
      },
    });
    win.loadURL(`${origin}/account/usage`).catch(() => { });
    // MiMo-style sign-in: the window owns the session. On close, seal whatever
    // cookies the site issued into Pulse's encrypted key store, then refresh.
    win.on('closed', async () => {
      try {
        const { session } = require('electron');
        const cookies = await session.fromPartition('persist:pulse-qoder').cookies.get({ url: origin });
        const header = (cookies || []).filter((c) => c.name && c.value)
          .map((c) => `${c.name}=${c.value}`).join('; ');
        if (header) settings.setKey('qoder', header, safeStorage);
      } catch { /* a window closed before sign-in simply keeps the old key */ }
      store.refresh('qoder');
    });
  });
  ipcMain.handle('snapshot', () => snapshot());
  ipcMain.handle('total:data', () => require('./totalLedger.js').readAll(DATA_DIR));
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
    // A Qoder session is host-specific: one kept across a site switch would be
    // sent to the host that never issued it.
    if (key === 'qoderSite') settings.setKey('qoder', null, safeStorage);
    broadcast();
    // Only data-affecting settings refetch; layout-only changes just re-place.
    if (['minimaxSite', 'qoderSite', 'deepseekBasis', 'deepseekBudget', 'deepseekCurrency'].includes(key)) store.refreshAll();
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
  if (process.env.PULSE_OPEN_TOTAL) openTotal();

  app.on('before-quit', () => { forceQuit = true; });
});
