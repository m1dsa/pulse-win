$exe = "D:\Claude Code Workplace\pulse-win\dist\Pulse-0.1.0-win.exe"
$p = Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=9223" -PassThru
"launcher=$($p.Id) t0=$(Get-Date -Format HH:mm:ss)"
for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep 2
    $procs = Get-Process | Where-Object { $_.ProcessName -like "*ulse*" } | ForEach-Object { "$($_.Id):$($_.ProcessName)" }
    $cdp = try { (Invoke-WebRequest -Uri "http://localhost:9223/json/version" -TimeoutSec 1 -UseBasicParsing).StatusCode } catch { "-" }
    $tmp = Get-ChildItem "$env:TEMP" -Directory -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-3) -and (Test-Path "$($_.FullName)\Pulse.exe" -ErrorAction SilentlyContinue) } | ForEach-Object { $_.Name }
    "t+$($i*2)s procs=[$($procs -join ',')] cdp=$cdp tmp=[$($tmp -join ',')]"
}
