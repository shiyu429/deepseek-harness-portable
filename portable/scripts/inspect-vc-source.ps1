param([string]$Path, [string]$Destination)
$ErrorActionPreference = 'Stop'
$file = [IO.Path]::GetFullPath($Path)
$response = Invoke-WebRequest -UseBasicParsing -Method Head -Uri 'https://aka.ms/vs/17/release/vc_redist.x64.exe' -TimeoutSec 60
$signature = Get-AuthenticodeSignature -LiteralPath $file
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw 'Microsoft runtime signature verification failed.' }
$record = [ordered]@{ version=(Get-Item -LiteralPath $file).VersionInfo.FileVersion; url=$response.BaseResponse.ResponseUri.AbsoluteUri; sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant(); signature=$signature.Status.ToString(); signer=$signature.SignerCertificate.Subject }
[IO.File]::WriteAllText([IO.Path]::GetFullPath($Destination), ($record | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
