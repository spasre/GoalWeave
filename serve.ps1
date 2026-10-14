# 起本地服务。默认走后端（server.py）：静态文件 + 配置存储 + 技能运行都在一个 origin，
# 不用再管 CORS；设置里的密码门用 WebCrypto 的 PBKDF2，也只有 https 或 localhost 下才给用。
#
#   .\serve.ps1              # 后端模式，默认 8777
#   .\serve.ps1 -Port 9000   # 换端口
#   .\serve.ps1 -Lan         # 顺便让手机（连热点/同一 WiFi）也能打开
#   .\serve.ps1 -Static      # 退回纯静态（原来那套，python -m http.server）
#   .\serve.ps1 -Data config\data.fresh.json -Port 8780   # 空库分身，体验新用户流程
param([int]$Port = 8777, [switch]$Static, [switch]$Lan, [string]$Allow = "", [string]$Data = "")

$root = $PSScriptRoot
$url = "http://localhost:$Port/"

if ($Static) {
  Write-Host "任务板（纯静态）: $url"
  Write-Host "（Ctrl-C 停止）"
  Start-Process $url
  python -m http.server $Port --bind 127.0.0.1 --directory $root
  return
}

Write-Host "任务板后端: $url"
$extra = @("--port", $Port, "--open")
if ($Lan) { $extra += "--lan" }
if ($Allow) { $extra += @("--allow", $Allow) }
if ($Data) { $extra += @("--data", $Data) }
python "$root\server.py" @extra
