param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
function Hash-Value([string]$Value) {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
}
function Environment-Snapshot([string]$Scope) {
    $result = [ordered]@{}
    $variables = [Environment]::GetEnvironmentVariables($Scope)
    foreach ($name in ($variables.Keys | Sort-Object)) { $result[$name] = Hash-Value ([string]$variables[$name]) }
    return $result
}
function Registry-Snapshot([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $result = [ordered]@{}
    foreach ($key in @((Get-Item -LiteralPath $Path)) + @(Get-ChildItem -LiteralPath $Path -Recurse)) {
        foreach ($name in $key.GetValueNames()) { $result[$key.Name + '\' + $name] = Hash-Value ([string]$key.GetValue($name)) }
    }
    return $result
}
$registry = [ordered]@{}
foreach ($path in @('Registry::HKEY_CURRENT_USER\Software\Classes\dsh', 'Registry::HKEY_LOCAL_MACHINE\Software\Classes\dsh', 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run')) { $registry[$path] = Registry-Snapshot $path }
$services = @(Get-CimInstance Win32_Service | Sort-Object Name | ForEach-Object { [ordered]@{ name=$_.Name; startMode=$_.StartMode; imageHash=(Hash-Value ([string]$_.PathName)) } })
$locations = [ordered]@{}
foreach ($path in @((Join-Path $env:USERPROFILE '.dsh'), (Join-Path $env:USERPROFILE '.agents'), (Join-Path $env:USERPROFILE '.npmrc'), (Join-Path $env:APPDATA 'DeepSeek Harness'), (Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop'), (Join-Path $env:APPDATA 'DSH Portable'))) {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    $locations[$path] = if ($null -eq $item) { $null } else { [ordered]@{ directory=$item.PSIsContainer; modified=$item.LastWriteTimeUtc.ToString('O'); entries=if ($item.PSIsContainer) { @(Get-ChildItem -LiteralPath $path -Force -Recurse -ErrorAction SilentlyContinue | Select-Object FullName,Length,@{n='modified';e={$_.LastWriteTimeUtc.ToString('O')}}) } else { @() } } }
}
$report = [ordered]@{ userEnvironment=(Environment-Snapshot 'User'); machineEnvironment=(Environment-Snapshot 'Machine'); registry=$registry; services=$services; hostLocations=$locations }
[IO.File]::WriteAllText([IO.Path]::GetFullPath($Destination), ($report | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
