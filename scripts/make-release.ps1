$token = Get-Content "$env:TEMP\gh-tok.txt" -Raw
$headers = @{ Authorization = "Bearer $($token.Trim())"; Accept = 'application/vnd.github+json' }
$body = @{
  tag_name   = 'v0.1.2'
  name       = 'Pulse 0.1.2 for Windows'
  body       = "Unofficial Windows port of qunqin24/Pulse. New in 0.1.2: OpenCode provider — Go quota endpoint plus a local token-usage ledger read from opencode.db, no key needed for the ledger. Settings files now tolerate a BOM. / 非官方 Windows 移植。0.1.2 新增 OpenCode：Go 额度通道 + 读 opencode.db 的本机用量账本（无需 key）；设置文件兼容 BOM。注意：本次 exe 为未压缩打包（约 328MB），功能完全一致。`n`nClaude Code, Codex, Grok, Devin, DeepSeek, GLM Coding / z.ai, Kimi Code, MiniMax, Qwen Cloud, V2EX quotas plus local token-usage ledgers."
  draft      = $false
  prerelease = $false
} | ConvertTo-Json -Depth 4

$rel = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/m1dsa/pulse-win/releases" -Headers $headers -Body $body -ContentType 'application/json; charset=utf-8'
"release id: $($rel.id)  tag: $($rel.tag_name)  upload_url: $($rel.upload_url)"
$rel.id | Set-Content "$env:TEMP\pulse-rel-id.txt" -NoNewline
