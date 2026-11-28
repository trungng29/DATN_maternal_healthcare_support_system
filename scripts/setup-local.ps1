param(
  [ValidateSet('Docker', 'Local', 'PrepareOnly')]
  [string]$Mode = 'Docker',
  [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$EnvPath = Join-Path $Root '.env'
$ExamplePath = Join-Path $Root '.env.example'
$ServicesPath = Join-Path $Root 'services'

function Test-EnvFile([string]$Path) {
  if (-not (Test-Path $Path)) { return $false }
  $file = Get-Item $Path
  if ($file.Length -gt 1MB) { return $false }
  foreach ($line in (Get-Content -LiteralPath $Path)) {
    if ($line.Length -gt 8192) { return $false }
  }
  return $true
}

function New-RandomBase64Url([int]$Bytes = 32) {
  $data = New-Object byte[] $Bytes
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($data) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($data).TrimEnd('=').Replace('+','-').Replace('/','_')
}

function New-RandomBase64([int]$Bytes = 32) {
  $data = New-Object byte[] $Bytes
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($data) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($data)
}

function New-RandomHex([int]$Bytes = 32) {
  $data = New-Object byte[] $Bytes
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($data) } finally { $rng.Dispose() }
  return (($data | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Read-EnvMap([string]$Path) {
  $map = @{}
  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
      $parts = $line -split '=', 2
      $value = $parts[1].Trim()
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      $map[$parts[0].Trim()] = $value
    }
  }
  return $map
}

function Encode-EnvValue([string]$Name, [string]$Value) {
  if ($Name.EndsWith('_PRIVATE_KEY') -or $Name.EndsWith('_PUBLIC_KEY')) {
    $normalized = $Value.Replace([string][char]13, '').Replace([string][char]10, '\n')
    return '"' + $normalized + '"'
  }
  return $Value
}

function Set-EnvValue([string]$Path, [string]$Name, [string]$Value) {
  $lines = [Collections.Generic.List[string]]::new([string[]][IO.File]::ReadAllLines($Path, [Text.UTF8Encoding]::new($false)))
  $prefix = $Name + '='
  $encoded = Encode-EnvValue $Name $Value
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i].StartsWith($prefix)) {
      $lines[$i] = $prefix + $encoded
      $found = $true
      break
    }
  }
  if (-not $found) { $lines.Add($prefix + $encoded) }
  [IO.File]::WriteAllLines($Path, $lines, (New-Object Text.UTF8Encoding($false)))
}

function Is-Placeholder([string]$Value) {
  return [string]::IsNullOrWhiteSpace($Value) -or $Value -match 'REPLACE_WITH|replace-with|<secret>|<password>'
}

function Read-Pem([string]$Path) {
  if (Test-Path $Path) { return (Get-Content $Path -Raw).Trim() }
  return $null
}

function Normalize-Pem([string]$Value) {
  if (-not $Value) { return '' }
  return $Value.Trim().Trim('"', "'").Replace('\r\n', [string][char]13 + [char]10).Replace('\n', [string][char]10)
}

function Run-Command([string]$File, [string[]]$Arguments, [string]$WorkingDirectory = $Root) {
  Push-Location $WorkingDirectory
  try {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }
}

function Ensure-AuthKeys([string]$Path) {
  $values = Read-EnvMap $Path
  $keysPath = Join-Path $Root 'scripts\keys'
  New-Item -ItemType Directory -Force -Path $keysPath | Out-Null
  $privatePath = Join-Path $keysPath 'auth-private.pem'
  $publicPath = Join-Path $keysPath 'auth-public.pem'
  $private = Read-Pem $privatePath
  $public = Read-Pem $publicPath

  if (-not $private -or -not $public) {
    Run-Command 'node' @((Join-Path $Root 'scripts/generate-auth-keys.cjs'), $keysPath)
    $private = Read-Pem $privatePath
    $public = Read-Pem $publicPath
  }

  if (-not $private -or -not $public) { throw 'Auth RSA key pair could not be created' }
  Set-EnvValue $Path 'AUTH_JWT_PRIVATE_KEY' $private
  Set-EnvValue $Path 'AUTH_JWT_PUBLIC_KEY' $public
}

function Ensure-InternalKeys([string]$Path) {
  $keysPath = Join-Path $Root 'scripts\keys'
  New-Item -ItemType Directory -Force -Path $keysPath | Out-Null
  $privatePath = Join-Path $keysPath 'patient-internal-private.pem'
  $publicPath = Join-Path $keysPath 'patient-internal-public.pem'
  if (-not (Test-Path $privatePath) -or -not (Test-Path $publicPath)) {
    Run-Command 'node' @((Join-Path $Root 'scripts/generate-internal-keys.cjs'), $keysPath)
  }
  $public = Read-Pem $publicPath
  if (-not $public) { throw 'Patient internal public key could not be created' }
  Set-EnvValue $Path 'PATIENT_INTERNAL_JWT_PUBLIC_KEY' $public
}

function Ensure-ServiceKeys([string]$Path) {
  $keysPath = Join-Path $Root 'scripts\keys'
  New-Item -ItemType Directory -Force -Path $keysPath | Out-Null
  $privatePath = Join-Path $keysPath 'internal-service-private.pem'
  $publicPath = Join-Path $keysPath 'internal-service-public.pem'
  if (-not (Test-Path $privatePath) -or -not (Test-Path $publicPath)) {
    Run-Command 'node' @((Join-Path $Root 'scripts/generate-service-keys.cjs'), $keysPath)
  }
  Set-EnvValue $Path 'INTERNAL_SERVICE_JWT_PRIVATE_KEY' (Read-Pem $privatePath)
  Set-EnvValue $Path 'INTERNAL_SERVICE_JWT_PUBLIC_KEY' (Read-Pem $publicPath)
}

if (-not (Test-Path $ExamplePath)) { throw "Missing environment template: $ExamplePath" }

$recreated = $false
if (-not (Test-EnvFile $EnvPath)) {
  if (Test-Path $EnvPath) {
    $backup = "$EnvPath.corrupt.$((Get-Date).ToString('yyyyMMddHHmmss'))"
    Move-Item -LiteralPath $EnvPath -Destination $backup
    Write-Warning "File .env khong hop le; da luu ban cu tai $backup"
  }
  Copy-Item -LiteralPath $ExamplePath -Destination $EnvPath
  $recreated = $true
  Write-Host 'Da tao lai .env tu .env.example' -ForegroundColor Yellow
}

$fresh = $recreated -or -not (Test-Path $EnvPath)
if ($fresh) { Copy-Item -LiteralPath $ExamplePath -Destination $EnvPath }

$values = Read-EnvMap $EnvPath
$dbs = @(
  @('KONG_PG_PASSWORD','KONG_PG_DATABASE','kong','KONG_PG_USER','kong'),
  @('AUTH_DB_PASSWORD','AUTH_DB_NAME','auth','AUTH_DB_USER','auth'),
  @('DOCTOR_DB_PASSWORD','DOCTOR_DB_NAME','doctor','DOCTOR_DB_USER','doctor'),
  @('RECEPTIONIST_DB_PASSWORD','RECEPTIONIST_DB_NAME','receptionist','RECEPTIONIST_DB_USER','receptionist'),
  @('PATIENT_DB_PASSWORD','PATIENT_DB_NAME','patient','PATIENT_DB_USER','patient')
)
foreach ($db in $dbs) {
  if (-not $values[$db[1]]) { Set-EnvValue $EnvPath $db[1] $db[2] }
  if (-not $values[$db[3]]) { Set-EnvValue $EnvPath $db[3] $db[4] }
  if ($fresh -or (Is-Placeholder $values[$db[0]])) { Set-EnvValue $EnvPath $db[0] (New-RandomBase64Url 32) }
  $values = Read-EnvMap $EnvPath
}

$urls = @(
  @('AUTH_DATABASE_URL','AUTH_DB_USER','AUTH_DB_PASSWORD','AUTH_DB_NAME','AUTH_DB_PORT','5433'),
  @('DOCTOR_DATABASE_URL','DOCTOR_DB_USER','DOCTOR_DB_PASSWORD','DOCTOR_DB_NAME','DOCTOR_DB_PORT','5435'),
  @('RECEPTIONIST_DATABASE_URL','RECEPTIONIST_DB_USER','RECEPTIONIST_DB_PASSWORD','RECEPTIONIST_DB_NAME','RECEPTIONIST_DB_PORT','5436'),
  @('PATIENT_DATABASE_URL','PATIENT_DB_USER','PATIENT_DB_PASSWORD','PATIENT_DB_NAME','PATIENT_DB_PORT','5434')
)
foreach ($url in $urls) {
  $values = Read-EnvMap $EnvPath
  if (-not $values[$url[4]]) { Set-EnvValue $EnvPath $url[4] $url[5] }
  $values = Read-EnvMap $EnvPath
  if ($fresh -or -not $values[$url[0]]) {
    $connection = 'postgresql://' + $values[$url[1]] + ':' + $values[$url[2]] + '@localhost:' + $values[$url[4]] + '/' + $values[$url[3]] + '?schema=public'
    Set-EnvValue $EnvPath $url[0] $connection
  }
}

$values = Read-EnvMap $EnvPath
Ensure-AuthKeys $EnvPath
Ensure-InternalKeys $EnvPath
Ensure-ServiceKeys $EnvPath
$values = Read-EnvMap $EnvPath

if (-not $values.AUTH_JWT_ISSUER) { Set-EnvValue $EnvPath 'AUTH_JWT_ISSUER' 'maternal-healthcare-auth' }
if (-not $values.AUTH_JWT_AUDIENCE) { Set-EnvValue $EnvPath 'AUTH_JWT_AUDIENCE' 'maternal-healthcare-api' }
if (-not $values.AUTH_JWT_KEY_ID -or (Is-Placeholder $values.AUTH_JWT_KEY_ID)) { Set-EnvValue $EnvPath 'AUTH_JWT_KEY_ID' 'local-dev-key' }
if ($fresh -or (Is-Placeholder $values.AUTH_REFRESH_TOKEN_PEPPER)) { Set-EnvValue $EnvPath 'AUTH_REFRESH_TOKEN_PEPPER' (New-RandomBase64Url 48) }
if ((Is-Placeholder $values.PATIENT_NATIONAL_ID_ENCRYPTION_KEY)) { Set-EnvValue $EnvPath 'PATIENT_NATIONAL_ID_ENCRYPTION_KEY' (New-RandomBase64 32) }
if ((Is-Placeholder $values.PATIENT_NATIONAL_ID_LOOKUP_PEPPER)) { Set-EnvValue $EnvPath 'PATIENT_NATIONAL_ID_LOOKUP_PEPPER' (New-RandomHex 32) }
if (-not $values.PATIENT_INTERNAL_JWT_KEY_ID -or (Is-Placeholder $values.PATIENT_INTERNAL_JWT_KEY_ID)) { Set-EnvValue $EnvPath 'PATIENT_INTERNAL_JWT_KEY_ID' 'internal-dev-key' }
if (-not $values.PATIENT_INTERNAL_JWT_ISSUER) { Set-EnvValue $EnvPath 'PATIENT_INTERNAL_JWT_ISSUER' 'maternal-healthcare-internal' }
if (-not $values.PATIENT_INTERNAL_JWT_AUDIENCE) { Set-EnvValue $EnvPath 'PATIENT_INTERNAL_JWT_AUDIENCE' 'patient-service' }
if ($fresh -or (Is-Placeholder $values.INTERNAL_SERVICE_AUTH_SECRET)) { Set-EnvValue $EnvPath 'INTERNAL_SERVICE_AUTH_SECRET' (New-RandomBase64Url 32) }
if (-not $values.AUTH_ACCOUNT_LOOKUP_URL) { Set-EnvValue $EnvPath 'AUTH_ACCOUNT_LOOKUP_URL' 'http://localhost:5003/internal/accounts' }

$values = Read-EnvMap $EnvPath
[Environment]::SetEnvironmentVariable('AUTH_DATABASE_URL', $values.AUTH_DATABASE_URL, 'Process')
[Environment]::SetEnvironmentVariable('DOCTOR_DATABASE_URL', $values.DOCTOR_DATABASE_URL, 'Process')
[Environment]::SetEnvironmentVariable('PATIENT_DATABASE_URL', $values.PATIENT_DATABASE_URL, 'Process')
Write-Host "Environment ready: $EnvPath"

if ($Mode -eq 'PrepareOnly') { exit 0 }

function Wait-Migration([string]$Service) {
  $deadline = (Get-Date).AddMinutes(3)
  do {
    $container = & docker compose --project-directory $Root ps -aq $Service
    if ($LASTEXITCODE -eq 0 -and $container) {
      $rawState = & docker inspect --format '{{.State.Status}}|{{.State.ExitCode}}' $container
      if ($LASTEXITCODE -eq 0 -and $rawState) {
        $state = ([string]$rawState).Trim()
        if ($state -eq 'exited|0') { return }
        if ($state -like 'exited|*') { throw "$Service failed. Run: docker compose logs $Service" }
      }
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  throw "Unable to verify migration $Service before the deadline. Check Docker Desktop and docker compose logs."
}

$migrationServices = @(
    'auth-migrate','doctor-migrate','receptionist-migrate','patient-migrate',
    'catalog-migrate','appointment-migrate','billing-migrate','medical-record-migrate',
    'queue-migrate','document-migrate','prescription-migrate','treatment-plan-migrate',
    'notification-migrate','audit-log-migrate','reporting-migrate','consultation-migrate'
  )
if ($Mode -eq 'Docker') {
  Run-Command 'docker' @('info')
  Run-Command 'docker' @('compose','config','--quiet')
  if (-not $NoBuild) { Run-Command 'docker' @('compose','build','auth-migrate') }
  Run-Command 'docker' (@('compose','up','--no-build','-d') + $migrationServices)
  foreach ($migration in $migrationServices) { Wait-Migration $migration }
  exit 0
}

if ($Mode -eq 'Local') {
  # Compose runs the same migration set in Docker and local-app modes.
  Run-Command 'docker' @('compose','build','auth-migrate')
  Run-Command 'docker' (@('compose','up','--no-build','-d') + $migrationServices)
  foreach ($migration in $migrationServices) { Wait-Migration $migration }
  Push-Location $ServicesPath
  try {
    if (-not (Test-Path (Join-Path $ServicesPath 'node_modules'))) {
      Run-Command 'npm.cmd' @('ci') $ServicesPath
    }
    Run-Command 'npm.cmd' @('run','prisma:generate') $ServicesPath
    Run-Command 'npm.cmd' @('run','prisma:generate:doctor') $ServicesPath
    Run-Command 'npm.cmd' @('run','prisma:generate:patient') $ServicesPath
  } finally { Pop-Location }
  Write-Host 'Local databases migrated. Run . .\scripts\load-env.ps1 before starting each app.'
  exit 0
}
