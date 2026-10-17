$token = (Get-Content "$env:TEMP\gh-tok.txt" -Raw).Trim()
$relId = (Get-Content "$env:TEMP\pulse-rel-id.txt" -Raw).Trim()
$url = "https://uploads.github.com/repos/m1dsa/pulse-win/releases/$relId/assets?name=Pulse-0.1.2-win.exe"
curl.exe -sS -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/octet-stream" --data-binary "@D:\Claude Code Workplace\pulse-win\dist\Pulse-0.1.2-win.exe" "$url" -o "$env:TEMP\upload-resp.json" -w "http %{http_code} | %{size_upload} bytes up | %{time_total}s`n"
