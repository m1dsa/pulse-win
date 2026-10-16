// Shared preload: a thin typed bridge, no ambient Node in renderers.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const SEND = new Set([
  'refresh', 'panel:toggle', 'settings:open', 'open:external', 'quit',
  'settings:set', 'settings:patchPanel', 'provider:toggle', 'key:set',
  'panel:ready', 'card:ready', 'drag:move', 'drag:end',
  'card:show', 'card:size', 'card:hideSoon',
  'rail:contextmenu', 'rail:collapse', 'sliver:alertTint', 'provider:refresh',
]);
const INVOKE = new Set(['snapshot', 'statusline:isInstalled', 'statusline:install', 'statusline:uninstall']);
const LISTEN = new Set(['state', 'layout', 'card:account', 'card:tail', 'card:closed', 'settings:section']);

contextBridge.exposeInMainWorld('pulse', {
  send(channel, ...args) {
    if (SEND.has(channel)) ipcRenderer.send(channel, ...args);
  },
  invoke(channel, ...args) {
    if (INVOKE.has(channel)) return ipcRenderer.invoke(channel, ...args);
    return Promise.reject(new Error('unknown channel ' + channel));
  },
  on(channel, cb) {
    if (!LISTEN.has(channel)) return () => {};
    const sub = (_e, ...args) => cb(...args);
    ipcRenderer.on(channel, sub);
    return () => ipcRenderer.removeListener(channel, sub);
  },
});
