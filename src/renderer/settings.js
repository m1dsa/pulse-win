// Settings renderer — one page, applied immediately, no save button.
'use strict';

const T = window.I18N.t;
let snap = null;
const keyTimers = new Map(); // debounce per-provider key saves

const $ = (id) => document.getElementById(id);

function localize() {
  $('t-services').textContent = T('services');
  $('t-panel').textContent = '悬浮条';
  $('t-general').textContent = T('general');
  $('t-about').textContent = T('about');
  $('t-dock').textContent = T('dockPosition');
  $('d-right').textContent = T('dockRight');
  $('d-left').textContent = T('dockLeft');
  $('d-top').textContent = T('dockTop');
  $('d-free').textContent = T('dockFree');
  $('t-collapse').textContent = T('autoCollapse');
  $('t-numbers').textContent = T('showNumbers');
  $('t-nocap').textContent = '截图时隐藏';
  $('t-login').textContent = T('launchAtLogin');
  $('t-interval').textContent = T('refreshInterval');
  $('t-minutes').textContent = T('minutes');
  $('t-warn').textContent = T('warningThreshold');
  $('t-statusline').textContent = 'Claude Code 状态栏';
  $('t-statusline-hint').textContent = T('statusLineHint');
  $('providerHint').textContent = T('firstRunHint');
  $('aboutText').innerHTML =
    `<b>Pulse for Windows</b> — macOS 版 <b>Pulse</b> 的非官方移植。<br>` +
    `一眼看清 AI 编程工具的剩余额度，贴在屏幕边缘。无账号、无服务器、不回传任何数据。<br>` +
    `原版：<a href="https://github.com/qunqin24/Pulse">github.com/qunqin24/Pulse</a>（Apache-2.0）`;
}

function render() {
  if (!snap) return;
  $('ver').textContent = 'v' + snap.version;
  $('firstRun').style.display = snap.needsProviderSelection ? 'inline' : 'none';
  $('firstRun').textContent = T('chooseProviders');

  // ---- providers ----
  const list = $('providerList');
  list.innerHTML = '';
  const detectedFirst = [...snap.providers].sort((a, b) => (b.detected - a.detected) || a.name.localeCompare(b.name));
  for (const p of detectedFirst) {
    const row = document.createElement('div');
    row.className = 'row provider';

    const badges = [];
    if (p.detected) badges.push(`<span class="badge">${T('detected')}</span>`);
    if (p.usesAPIKey && !p.apiKeyOptional && !p.hasKey && p.enabled) badges.push(`<span class="badge dim">${T('needsKey')}</span>`);
    if (p.usesAPIKey && p.hasKey) badges.push(`<span class="kept">key ✓</span>`);

    row.innerHTML = `
      <div class="line">
        <input type="checkbox" ${p.enabled ? 'checked' : ''} data-p="${p.id}">
        <div class="picon">${(snap.icons || {})[p.id] || ''}</div>
        <div class="grow"><span class="name">${p.name}</span></div>
        ${badges.join('')}
      </div>`;
    row.querySelector('input[type=checkbox]').addEventListener('change', (e) => {
      window.pulse.send('provider:toggle', p.id, e.target.checked);
    });

    // Extra controls per provider.
    const extras = document.createElement('div');
    extras.className = 'keyrow';
    let hasExtras = false;

    if (p.usesAPIKey && p.enabled) {
      const input = document.createElement('input');
      input.type = 'password';
      input.placeholder = p.hasKey ? '已保存（输入以更换）'
        : (p.keyHint ? T(p.keyHint)
          : (p.apiKeyOptional ? T('apiKeyOptionalPlaceholder') : T('apiKeyPlaceholder')));
      input.autocomplete = 'off';
      input.addEventListener('input', () => {
        clearTimeout(keyTimers.get(p.id));
        keyTimers.set(p.id, setTimeout(() => {
          window.pulse.send('key:set', p.id, input.value);
          input.value = '';
          input.placeholder = '已保存';
        }, 700));
      });
      extras.appendChild(input);
      hasExtras = true;
    }

    if (p.id === 'minimax' && p.enabled) {
      const sel = document.createElement('select');
      for (const s of p.sites || []) {
        const o = document.createElement('option');
        o.value = s.id; o.textContent = s.label;
        if (snap.settings.minimaxSite === s.id) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => window.pulse.send('settings:set', 'minimaxSite', sel.value));
      const lbl = document.createElement('span'); lbl.className = 'sub'; lbl.textContent = T('site');
      extras.prepend(sel); extras.prepend(lbl);
      hasExtras = true;
    }

    if (p.id === 'deepSeek' && p.enabled) {
      const sel = document.createElement('select');
      for (const [v, label] of [['sinceTopUp', T('sinceTopUp')], ['yourBudget', T('yourBudget')], ['balanceOnly', T('balance')]]) {
        const o = document.createElement('option');
        o.value = v; o.textContent = label;
        if (snap.settings.deepseekBasis === v) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => window.pulse.send('settings:set', 'deepseekBasis', sel.value));
      const lbl = document.createElement('span'); lbl.className = 'sub'; lbl.textContent = '圆环按';
      extras.prepend(sel); extras.prepend(lbl);
      hasExtras = true;
    }

    if (hasExtras) row.appendChild(extras);
    list.appendChild(row);
  }

  // ---- panel ----
  $('opt-dock').value = snap.settings.panel.dock || 'right';
  $('opt-collapse').checked = snap.settings.autoCollapse !== false;
  $('opt-numbers').checked = snap.settings.showNumbers !== false;
  $('opt-nocap').checked = !!snap.settings.hidesFromScreenCapture;

  // ---- general ----
  $('opt-login').checked = !!snap.settings.launchAtLogin;
  $('opt-interval').value = String(snap.settings.refreshMinutes || 5);
  $('opt-warn').value = snap.settings.warningThreshold || 75;
  $('warn-val').textContent = (snap.settings.warningThreshold || 75) + '%';
  $('btn-statusline').textContent = snap.statusLineInstalled ? T('disconnectStatusLine') : T('connectStatusLine');
}

// ---- option wiring ----
$('opt-dock').addEventListener('change', (e) => {
  window.pulse.send('settings:patchPanel', { dock: e.target.value });
});
$('opt-collapse').addEventListener('change', (e) => {
  window.pulse.send('settings:set', 'autoCollapse', e.target.checked);
});
$('opt-numbers').addEventListener('change', (e) => {
  window.pulse.send('settings:set', 'showNumbers', e.target.checked);
});
$('opt-nocap').addEventListener('change', (e) => {
  window.pulse.send('settings:set', 'hidesFromScreenCapture', e.target.checked);
});
$('opt-login').addEventListener('change', (e) => {
  window.pulse.send('settings:set', 'launchAtLogin', e.target.checked);
});
$('opt-interval').addEventListener('change', (e) => {
  window.pulse.send('settings:set', 'refreshMinutes', Number(e.target.value));
});
$('opt-warn').addEventListener('input', (e) => {
  $('warn-val').textContent = e.target.value + '%';
  window.pulse.send('settings:set', 'warningThreshold', Number(e.target.value));
});
$('btn-statusline').addEventListener('click', async () => {
  const installed = await window.pulse.invoke('statusline:isInstalled');
  if (installed) await window.pulse.invoke('statusline:uninstall');
  else await window.pulse.invoke('statusline:install');
  snap = await window.pulse.invoke('snapshot');
  render();
});

document.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (a) { e.preventDefault(); window.pulse.send('open:external', a.href); }
});

window.pulse.on('state', (s) => { snap = s; render(); });
window.pulse.on('settings:section', () => { /* one-page layout: nothing to switch */ });
window.pulse.invoke('snapshot').then((s) => { snap = s; localize(); render(); });
localize();
