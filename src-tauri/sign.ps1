# Optional Authenticode signing for Windows bundles.
# Without a certificate this is a no-op, so local builds and unsigned CI keep working.
#
# Environment variables:
#   WIN_CERT_PFX_BASE64  base64 of the .pfx/.p12 (GitHub Secret)
#   WIN_CERT_PASSWORD    password of the .pfx
#   WIN_CERT_CSP         only for cloud-signing certs, e.g. "SimpliSign"
#   WIN_CERT_KC          only for cloud-signing certs, e.g. "SimpliSign Key Container"
param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'

function Stop-With([string]$Message) {
  Write-Host "[sign] $Message"
  exit 1
}

if ([string]::IsNullOrWhiteSpace($env:WIN_CERT_PFX_BASE64)) {
  Write-Host "[sign] no certificate configured, skip: $Path"
  exit 0
}

if (-not (Test-Path -LiteralPath $Path)) { Stop-With "target not found: $Path" }

# Locate signtool.exe from the Windows SDK (newest x64 build wins).
$signtool = $null
foreach ($root in @("${env:ProgramFiles(x86)}\Windows Kits\10\bin", "$env:ProgramFiles\Windows Kits\10\bin")) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  $signtool = Get-ChildItem -LiteralPath $root -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like '*\x64\*' } |
    Sort-Object FullName -Descending |
    Select-Object -First 1 -ExpandProperty FullName
  if ($signtool) { break }
}
if (-not $signtool) {
  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) { $signtool = $cmd.Source }
}
if (-not $signtool) { Stop-With 'signtool.exe not found, install the Windows SDK signing tools' }

$tmpDir = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$pfx = Join-Path $tmpDir ('xiaofeiyu-sign-' + [Guid]::NewGuid().ToString('N') + '.pfx')
[IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:WIN_CERT_PFX_BASE64))

try {
  $signArgs = @(
    'sign', '/fd', 'sha256', '/td', 'sha256',
    '/tr', 'http://timestamp.digicert.com',
    '/f', $pfx
  )
  if ($env:WIN_CERT_PASSWORD) { $signArgs += @('/p', $env:WIN_CERT_PASSWORD) }
  if ($env:WIN_CERT_CSP) { $signArgs += @('/csp', $env:WIN_CERT_CSP) }
  if ($env:WIN_CERT_KC) { $signArgs += @('/kc', $env:WIN_CERT_KC) }
  $signArgs += $Path

  & $signtool @signArgs
  if ($LASTEXITCODE -ne 0) { Stop-With "signtool sign failed (exit $LASTEXITCODE): $Path" }

  & $signtool verify /pa $Path
  if ($LASTEXITCODE -ne 0) { Stop-With "signature verification failed: $Path" }

  Write-Host "[sign] signed and verified: $Path"
}
finally {
  Remove-Item -LiteralPath $pfx -Force -ErrorAction SilentlyContinue
}
