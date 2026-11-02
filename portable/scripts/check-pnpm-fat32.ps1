# Manual CI check on an owned FAT32 VHD. Never selects or formats a physical disk.
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'This isolated VHD check requires the hosted Windows runner administrator token.' }
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('dsh-fat32-' + [Guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $testRoot) { throw 'Test root already exists' }
New-Item -ItemType Directory -Path $testRoot | Out-Null
$primary = Join-Path $testRoot 'primary'
New-Item -ItemType Directory -Path (Join-Path $primary 'node/bin') -Force | Out-Null
$lock = Get-Content -LiteralPath (Join-Path $projectRoot 'portable/upstream.lock.json') -Raw | ConvertFrom-Json
$runtimeLock = Get-Content -LiteralPath (Join-Path $projectRoot 'upstream/scripts/primary-runtime/lock.json') -Raw | ConvertFrom-Json
$yamlLock = Get-Content -LiteralPath (Join-Path $projectRoot 'portable/pnpm-yaml.lock.json') -Raw | ConvertFrom-Json
function Download-Checked([string]$url,[string]$file,[string]$algorithm,[string]$expected) {
    Invoke-WebRequest -Uri $url -OutFile $file
    if ($algorithm -eq 'SHA256') { $actual=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
    else { $hash=[Security.Cryptography.SHA512]::Create(); try {$actual='sha512-'+[Convert]::ToBase64String($hash.ComputeHash([IO.File]::ReadAllBytes($file)))} finally {$hash.Dispose()} }
    if ($actual -cne $expected) { throw ('Download checksum mismatch: '+[IO.Path]::GetFileName($file)) }
}
$nodeZip = Join-Path $testRoot 'node.zip'
Download-Checked ('https://nodejs.org/dist/v'+$runtimeLock.nodeVersion+'/node-v'+$runtimeLock.nodeVersion+'-win-x64.zip') $nodeZip 'SHA256' $runtimeLock.targets.'win-x64'.nodeSha256
Expand-Archive -LiteralPath $nodeZip -DestinationPath (Join-Path $testRoot 'node')
Copy-Item -LiteralPath (Join-Path $testRoot ('node/node-v'+$runtimeLock.nodeVersion+'-win-x64/node.exe')) -Destination (Join-Path $primary 'node/bin/node.exe')
foreach ($item in @(@{Name='pnpm';Version=$lock.pnpm;Url=('https://registry.npmjs.org/pnpm/-/pnpm-'+$lock.pnpm+'.tgz');Integrity=$lock.pnpmIntegrity},@{Name='yaml';Version=$yamlLock.version;Url=$yamlLock.url;Integrity=$yamlLock.integrity})) {
    $tarball=Join-Path $testRoot ($item.Name+'.tgz'); Download-Checked $item.Url $tarball 'SHA512' $item.Integrity
    $extract=Join-Path $testRoot ($item.Name+'-download');New-Item -ItemType Directory -Path $extract | Out-Null
    & tar.exe -xzf $tarball -C $extract
    if ($LASTEXITCODE -ne 0) { throw 'Package extraction failed' }
    if ($item.Name -eq 'pnpm') { Move-Item -LiteralPath (Join-Path $extract 'package') -Destination (Join-Path $primary 'pnpm') }
    else { New-Item -ItemType Directory -Force -Path (Join-Path $primary 'pnpm/dist/node_modules') | Out-Null; Move-Item -LiteralPath (Join-Path $extract 'package') -Destination (Join-Path $primary 'pnpm/dist/node_modules/yaml') }
}
Move-Item -LiteralPath (Join-Path $primary 'pnpm/bin/pnpm.mjs') -Destination (Join-Path $primary 'pnpm/bin/pnpm-real.mjs')
$node = Join-Path $primary 'node/bin/node.exe'
$letters=@('R','S','T','U','V','W','X','Y','Z','M','N','O') | Where-Object {-not (Get-PSDrive -Name $_ -ErrorAction SilentlyContinue)} | Select-Object -First 3
if ($letters.Count -ne 3) { throw 'Three unused drive letters are required' }
$vhd = Join-Path $testRoot 'owned-fat32.vhd'
if (Test-Path -LiteralPath $vhd) { throw 'Refusing an existing disk image' }
$diskpart=Join-Path $testRoot 'create-disk.txt'
@("create vdisk file=`"$vhd`" maximum=3072 type=expandable", "select vdisk file=`"$vhd`"", 'attach vdisk', 'convert mbr', 'create partition primary', 'format fs=fat32 quick label=DSH_PNPM_QA', ('assign letter='+$letters[0]), 'exit') | Set-Content -LiteralPath $diskpart -Encoding ascii
try {
    & diskpart.exe /s $diskpart
    $image=Get-DiskImage -ImagePath $vhd
    if (-not $image.Attached) { throw 'Owned disk image did not attach' }
    $disk=$image | Get-Disk
    $partition=Get-Partition -DriveLetter $letters[0]
    if ($partition.DiskNumber -ne $disk.Number) { throw 'Drive does not belong to the owned VHD' }
    $volume=Get-Volume -DriveLetter $letters[0]
    if ($volume.FileSystem -ne 'FAT32') { throw 'The test is not running on a real FAT32 filesystem' }
    $testScript=Join-Path $projectRoot 'portable/tests/pnpm-portability.mjs'
    foreach ($i in 0..2) {
        $letter=$letters[$i]
        if ($i -gt 0) {
            $partition=Get-Partition -DriveLetter $letters[$i-1]
            if ($partition.DiskNumber -ne $disk.Number) { throw 'Drive ownership changed' }
            $partition | Set-Partition -NewDriveLetter $letter
        }
        if ((Get-Volume -DriveLetter $letter).FileSystem -ne 'FAT32') { throw 'Filesystem changed unexpectedly' }
        $phase=if($i -eq 0){'initial'}else{'moved'}
        & $node $testScript ('--root='+$letter+':/便携 插件测试') ('--primary='+$primary) ('--phase='+$phase) --real-plugin
        if ($LASTEXITCODE -ne 0) { throw ('pnpm regression failed at drive '+$letter) }
    }
    Write-Output ('FAT32_VHD_REAL_FILESYSTEM_PASS drives='+($letters -join '->')+' physicalUsbTest=false')
} finally {
    if (Test-Path -LiteralPath $vhd) {
        $attached=Get-DiskImage -ImagePath $vhd -ErrorAction SilentlyContinue
        if ($attached -and $attached.Attached) { Dismount-DiskImage -ImagePath $vhd }
    }
}
