// Provider registry — mirrors the hand-written subset of Provider.builtIn.
// Each entry: id, ring name, icon file, how it proves itself on first run,
// what credential it needs, and fetch(ctx).
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const claudeCode = require('./claudeCode.js');
const codex = require('./codex.js');
const grok = require('./grok.js');
const deepseek = require('./deepseek.js');
const zai = require('./zai.js');
const kimiCode = require('./kimiCode.js');
const minimax = require('./minimax.js');
const v2ex = require('./v2ex.js');
const devin = require('./devin.js');
const qwenCloud = require('./qwenCloud.js');
const qoder = require('./qoder.js');
const trae = require('./trae.js');
const openCodeGo = require('./openCodeGo.js');

const HOME = os.homedir();
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

const mimo = require('./mimo.js');
const codebuddy = require('./codebuddy.js');

const PROVIDERS = [
  {
    id: 'mimo', name: '小米 MiMo Code', icon: 'xiaomimimo.svg', usesAPIKey: false,
    discovered: () => exists(path.join(HOME, '.local', 'share', 'mimocode', 'mimocode.db')),
    fetch: (ctx) => mimo.fetchUsage(ctx),
  },
  {
    id: 'codebuddy', name: 'CodeBuddy', icon: 'tencent.svg', usesAPIKey: false,
    discovered: () => exists(path.join(HOME, '.codebuddy', 'projects')),
    fetch: (ctx) => codebuddy.fetchUsage(ctx),
  },
  {
    id: 'claudeCode',
    name: 'Claude Code',
    icon: 'claude.svg',
    usesAPIKey: false,
    discovered: () => exists(path.join(HOME, '.claude')),
    fetch: (ctx) => claudeCode.fetchUsage(ctx),
  },
  {
    id: 'codex',
    name: 'Codex',
    icon: 'openai.svg',
    usesAPIKey: false,
    discovered: () => exists(path.join(HOME, '.codex')),
    fetch: (ctx) => codex.fetchUsage(ctx),
  },
  {
    id: 'grok',
    name: 'Grok',
    icon: 'grok.svg',
    usesAPIKey: false,
    discovered: () => exists(path.join(HOME, '.grok')),
    fetch: (ctx) => grok.fetchUsage(ctx),
  },
  {
    id: 'deepSeek',
    name: 'DeepSeek',
    icon: 'deepseek.svg',
    usesAPIKey: true,
    balanceAccount: true,
    keyHint: 'apiKeyDeepSeekPlaceholder',
    discovered: () => false,
    fetch: (ctx) => deepseek.fetchUsage(ctx),
  },
  {
    id: 'zai',
    name: 'z.ai',
    icon: 'zai.svg',
    usesAPIKey: true,
    discovered: () => false,
    fetch: (ctx) => zai.fetchUsage({ ...ctx, providerId: 'zai' }),
  },
  {
    id: 'glmCoding',
    name: 'Zhipu GLM Coding',
    icon: 'zai.svg',
    // The API key still feeds paid-plan rate limits, but a Z Code install on
    // this machine already makes the Start Plan balance readable on its own.
    usesAPIKey: true,
    apiKeyOptional: true,
    keyHint: 'apiKeyGlmCodingPlaceholder',
    discovered: () => [
      path.join(HOME, '.coding-relay', 'glm-api-key'),
      path.join(HOME, '.config', 'bigmodel', 'api_key'),
      path.join(HOME, '.config', 'zhipu', 'api_key'),
      path.join(HOME, '.zcode', 'v2', 'logs'),
    ].some(exists),
    fetch: (ctx) => zai.fetchUsage({ ...ctx, providerId: 'glmCoding' }),
  },
  {
    id: 'kimiCode',
    name: 'Kimi Code',
    icon: 'kimi.svg',
    usesAPIKey: true,
    discovered: () => false,
    fetch: (ctx) => kimiCode.fetchUsage(ctx),
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    icon: 'minimax.svg',
    usesAPIKey: true,
    sites: [{ id: 'international', label: 'minimax.io' }, { id: 'china', label: 'minimaxi.com' }],
    discovered: () => false,
    fetch: (ctx) => minimax.fetchUsage(ctx),
  },
  {
    id: 'v2ex',
    name: 'V2EX',
    icon: 'v2ex.svg',
    usesAPIKey: true,
    discovered: () => false,
    fetch: (ctx) => v2ex.fetchUsage(ctx),
  },
  {
    id: 'devin',
    name: 'Devin',
    icon: 'devin.svg',
    // The desktop app's saved plan row answers without any key; a pasted
    // "token org" upgrades it to the live endpoint.
    usesAPIKey: true,
    apiKeyOptional: true,
    discovered: () => ['Devin', 'Windsurf'].some((n) =>
      exists(path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'),
        n, 'User', 'globalStorage', 'state.vscdb'))),
    fetch: (ctx) => devin.fetchUsage(ctx),
  },
  {
    id: 'qwenCloud',
    name: 'Qwen Cloud',
    icon: 'qwen.svg',
    // No API key and no CLI file: the console reads its plan off a browser
    // session, so the pasted "key" is the Cookie header from qwencloud.com.
    usesAPIKey: true,
    keyHint: 'apiKeyCookiePlaceholder',
    discovered: () => false,
    fetch: (ctx) => qwenCloud.fetchUsage(ctx),
  },
  {
    id: 'qoder',
    name: 'Qoder',
    icon: 'qoder.svg',
    // No key of its own: the account page reads credits off a web session, so
    // the pasted "key" is the Cookie header. qoder.com and qoder.com.cn are
    // separate sign-ins, hence the site picker.
    // Sign-in is a button (a MiMo-style window), not a pasted Cookie header.
    usesAPIKey: false,
    sites: [{ id: 'international', label: 'qoder.com' }, { id: 'china', label: 'qoder.com.cn' }],
    discovered: () => [
      path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Qoder'),
      path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Qoder CN'),
      path.join(HOME, '.qoder-cn'),
      path.join(HOME, '.qoder'),
    ].some(exists),
    fetch: (ctx) => qoder.fetchUsage(ctx),
  },
  {
    id: 'trae',
    name: 'Trae CN',
    icon: 'trae.svg',
    // The account token is read from Trae's own encrypted local storage;
    // Settings still accepts a manually pasted one as a fallback.
    usesAPIKey: true,
    apiKeyOptional: true,
    keyHint: 'apiKeyTraePlaceholder',
    discovered: () => exists(path.join(HOME, '.trae-cn'))
      || exists(path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Trae CN')),
    fetch: (ctx) => trae.fetchUsage(ctx),
  },
  {
    id: 'openCodeGo',
    name: 'OpenCode',
    icon: 'opencode.svg',
    // Quota comes from a Go subscription key (pasted, or the one OpenCode
    // saved in auth.json); the local database gives the card a usage ledger
    // either way, so a missing key is not a missing card.
    usesAPIKey: true,
    apiKeyOptional: true,
    keyHint: 'apiKeyOpenCodePlaceholder',
    discovered: () => exists(path.join(HOME, '.local', 'share', 'opencode')),
    fetch: (ctx) => openCodeGo.fetchUsage(ctx),
  },
];

const byId = new Map(PROVIDERS.map((p) => [p.id, p]));

module.exports = { PROVIDERS, byId };
