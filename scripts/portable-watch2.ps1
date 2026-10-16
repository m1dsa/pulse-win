$exe = "D:\Claude Code Workplace\pulse-win\dist\Pulse-0.1.0-win.exe"
$before = (Get-Process).Id
$p = Start-Process -FilePath $exe -PassThru
"launcher=$($p.Id) name=$($p.ProcessName)"
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    $new = Get-Process | Where-Object { $before -notcontains $_.Id } | ForEach-Object { "$($_.Id):$($_.ProcessName)" }
    if ($new) { "t+$([int]($i*0.5))s NEW: $($new -join ', ')" }
}
"--- final Pulse procs ---"
Get-Process | Where-Object { $_.ProcessName -like "*ulse*" } | Select-Object Id, ProcessName, Path
