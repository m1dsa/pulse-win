# Pulse for Windows

**English**: Unofficial Windows port of [Pulse](https://github.com/qunqin24/Pulse) — a floating desktop widget and system-tray app that monitors usage quotas and token spend for AI coding tools: Claude Code, Codex, Grok, Devin, DeepSeek, Zhipu GLM Coding / z.ai, Kimi Code, MiniMax, Qwen Cloud and V2EX. Runs as a single portable `.exe`; reads local CLI credentials, API keys or browser sessions; tracks local token usage, estimated cost, top model and cache-hit rate per provider. No account, no server, no telemetry.

[原版 Pulse](https://github.com/qunqin24/Pulse)（macOS，Apache-2.0）的非官方 Windows 移植。
一眼看清 AI 编程工具还剩多少额度——贴在屏幕边缘的黑色胶囊 + 托盘图标。

## 下载

Windows 用户在 [Releases](../../releases) 页下载 `Pulse-x.y.z-win.exe`，双击即用（便携版，不写注册表、不用安装）。

## 功能

- **屏幕边悬浮胶囊**：每个已启用的服务商一个圆环，颜色随用量走（绿 → 黄 → 红，服务商说用完才是用完）。拖到屏幕边缘自动吸附；闲置时收成一条细线，悬停展开。
- **详情卡**：悬停某个圆环弹出气泡卡，显示每个限额的用量、重置时间、套餐名。
- **本机用量**：Claude Code / Codex / Devin / DeepSeek Harness / ZCode 的详情卡底部多一栏——今天、7 天、31 天的 token 数、按 API 价估算的花费、用量柱图、主力模型、缓存命中率。读的是各 CLI 自己写在本地磁盘的会话记录（`~/.claude/projects`、`~/.codex/sessions`、`%APPDATA%\devin\cli\sessions.db`、`~/.dsh/sessions`、`~/.zcode/cli/db/db.sqlite`），纯本地计算，不上传。没公开定价的模型只计 token 不编金额。
- **DeepSeek 控制台通道**：没有 API key 也能看余额+30 天用量——设置里粘贴 platform.deepseek.com 控制台登录态的 `userToken`（F12 → 本地存储 → `userToken` 的 value 值），走控制台自己的日结报表，金额是官方结算数不是估算。
- **托盘图标**：刷新、显示/隐藏、设置、开机启动、退出。
- **Claude Code 状态栏接入**：`Pulse.exe --statusline` 可写进 `~/.claude/settings.json`，登录过期后仍能读到用量快照。
- 无账号、无服务器、不回传任何数据。key 用 Windows DPAPI（Electron safeStorage）加密存在本地。

## 服务商

| 服务商 | 凭据来源 |
|---|---|
| Claude Code | 自动读 `~/.claude/.credentials.json`，或状态栏推送 |
| Codex | 自动读 `~/.codex/auth.json` |
| Grok | 自动读 `~/.grok/auth.json` |
| Devin | 自动读桌面端缓存 `%APPDATA%\Devin\User\globalStorage\state.vscdb`；可选粘贴 `token 组织名` 走实时接口 |
| Qwen Cloud | 设置里粘贴 qwencloud.com 已登录浏览器的 Cookie |
| DeepSeek | 设置里粘贴 API key，或控制台 userToken；本机装了 Harness 客户端还读 `~/.dsh` 会话账本 |
| z.ai / 智谱 GLM Coding | API key（智谱国内站可自动探测本机 key 文件）；装了 ZCode 还读 `~/.zcode` 用量库 |
| Kimi Code | API key |
| MiniMax | API key（国际站/国内站可选） |
| V2EX | API key |

服务商没报告的百分比，Pulse 不会编。API key 类服务商不在本地存会话记录，没有「本机用量」可看——它们卡片上显示的 token 数（如 MiniMax 的剩余条数、V2EX 的加油包）是服务端直接报告的数字。

## 运行

```bash
npm install
npm start
```

## 打包 exe

```bash
npm run dist   # 产出 dist/Pulse-0.1.0-win.exe（portable 单文件，双击即用）
```

## 测试

```bash
node scripts/test-providers.js   # 每个服务商 fetch 一次，验证解析与凭据读取
```

## 技术栈

Electron（透明无边框置顶窗 = 悬浮胶囊，Tray = 托盘）。
主进程负责凭据读取和网络请求；渲染层只通过 preload 白名单通道拿数据。

## License

[Apache-2.0](LICENSE)，与上游一致。本仓库是基于 [qunqin24/Pulse](https://github.com/qunqin24/Pulse) 的非官方移植（Electron/JavaScript 重写），与原作者无隶属关系；服务商商标与图标归各自所有者，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

**Keywords**: AI coding usage monitor for Windows, Claude Code quota tracker, Codex usage widget, OpenAI Codex CLI monitor, DeepSeek balance checker, Zhipu GLM Coding Plan quota, z.ai usage, Kimi Code monitor, MiniMax quota, Qwen Cloud usage, V2EX tokens, Devin usage, token spend tracker, API price cost estimate, local usage ledger, cache hit rate, system tray monitor, screen edge floating widget, transparent always-on-top panel, portable exe, Electron, Windows 10/11, 桌面悬浮球, 用量监控, 额度查询, 国产 AI 编程工具
