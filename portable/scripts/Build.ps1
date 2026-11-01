param()
$ErrorActionPreference = 'Stop'
$portableProject = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$buildRoot = [IO.Path]::GetFullPath((Join-Path $portableProject '..'))
$nodeVersion = '24.21.0'
$nodeHash = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
$toolDirectory = Join-Path $buildRoot 'tools\build-node'
$archivePath = Join-Path $toolDirectory "node-v$nodeVersion-win-x64.zip"
$nodeExecutable = Join-Path $toolDirectory "node-v$nodeVersion-win-x64\node.exe"
New-Item -ItemType Directory -Force -Path $toolDirectory | Out-Null
if (-not (Test-Path -LiteralPath $archivePath)) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" -OutFile ($archivePath + '.partial')
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath ($archivePath + '.partial')).Hash.ToLowerInvariant() -ne $nodeHash) { throw '构建用 Node.js 校验失败。' }
    Move-Item -LiteralPath ($archivePath + '.partial') -Destination $archivePath
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant() -ne $nodeHash) { throw '构建用 Node.js 校验失败。' }
if (-not (Test-Path -LiteralPath $nodeExecutable)) { Expand-Archive -LiteralPath $archivePath -DestinationPath $toolDirectory -Force }
$env:NODE_USE_ENV_PROXY = '1'
& $nodeExecutable (Join-Path $PSScriptRoot 'build.mjs')
if ($LASTEXITCODE -ne 0) { throw "构建失败：$LASTEXITCODE" }
& $nodeExecutable (Join-Path $PSScriptRoot 'verify-package.mjs')
if ($LASTEXITCODE -ne 0) { throw "程序包校验失败：$LASTEXITCODE" }
$builtPortable = Get-Content -LiteralPath (Join-Path $buildRoot 'delivery\build-result.json') -Raw | ConvertFrom-Json
Write-Host "构建完成：$($builtPortable.root)"
