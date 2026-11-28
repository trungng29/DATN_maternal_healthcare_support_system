[CmdletBinding()]
param(
  [ValidateSet('Docker','Local','PrepareOnly')]
  [string]$Mode = '',
  [switch]$NoBuild,
  [switch]$ConfigureSmtp,
  [switch]$SeedDemo,
  [switch]$NoSeed
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$SetupLocal = Join-Path $PSScriptRoot 'setup-local.ps1'
$EnvPath = Join-Path $Root '.env'

function Set-EnvValue([string]$Name, [string]$Value) {
  $lines = [Collections.Generic.List[string]](Get-Content $EnvPath)
  $prefix = "$Name="
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i].StartsWith($prefix)) {
      $lines[$i] = $prefix + $Value
      $found = $true
      break
    }
  }
  if (-not $found) { $lines.Add($prefix + $Value) }
  [IO.File]::WriteAllLines($EnvPath, $lines, (New-Object Text.UTF8Encoding($false)))
}

function Read-Secret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$modeWasProvided = $PSBoundParameters.ContainsKey('Mode')
$KeysPath = Join-Path $PSScriptRoot 'keys'

function Reset-LocalConfigIfNeeded {
  $hasEnv = Test-Path $EnvPath
  $hasKeys = (Test-Path $KeysPath) -and @((Get-ChildItem $KeysPath -Filter '*.pem' -ErrorAction SilentlyContinue)).Count -gt 0
  if (-not ($hasEnv -or $hasKeys)) { return }

  Write-Warning 'Existing local configuration was found.'
  Write-Host 'The following local configuration can be regenerated:' -ForegroundColor Yellow
  if ($hasEnv) { Write-Host "  - $EnvPath" }
  if ($hasKeys) { Write-Host "  - $KeysPath\*.pem" }
  Write-Host 'This does not delete Docker containers, images, volumes or databases.' -ForegroundColor Yellow
  $answer = Read-Host 'Delete old local config and regenerate it? [y/N]'
  if ($answer -notmatch '^(y|yes)$') {
    Write-Host 'Keeping existing local configuration.' -ForegroundColor Yellow
    return
  }

  if ($hasEnv) {
    $envInfo = Get-Item -LiteralPath $EnvPath
    if ($envInfo.Length -gt 1MB) {
      $backup = "$EnvPath.corrupt.$((Get-Date).ToString('yyyyMMddHHmmss'))"
      Move-Item -LiteralPath $EnvPath -Destination $backup -Force
      Write-Host "Corrupt .env moved to $backup" -ForegroundColor Yellow
    } else {
      Remove-Item -LiteralPath $EnvPath -Force
    }
  }
  if ($hasKeys) { Remove-Item (Join-Path $KeysPath '*.pem') -Force -ErrorAction SilentlyContinue }
  Write-Host 'Old local configuration deleted.' -ForegroundColor Green
}

Write-Host '=== Maternal Healthcare local setup ===' -ForegroundColor Cyan
Write-Host "Root: $Root"

if (-not $Mode) {
  Write-Host 'Select run mode:'
  Write-Host '  1. Docker - run the full stack with Docker Compose (recommended)'
  Write-Host '  2. Local  - run databases with Docker and apps with Node/Nest'
  Write-Host '  3. PrepareOnly - create .env, keys and secrets only'
  $choice = Read-Host 'Enter choice [1]'
  $Mode = switch ($choice) { '2' { 'Local' } '3' { 'PrepareOnly' } default { 'Docker' } }
}

if (-not $modeWasProvided) { Reset-LocalConfigIfNeeded }

if (-not (Test-Path $EnvPath)) {
  Copy-Item (Join-Path $Root '.env.example') $EnvPath
  Write-Host 'Created .env from .env.example' -ForegroundColor Green
}

# setup-local creates or updates keys, peppers, database URLs and local secrets.
& $SetupLocal -Mode 'PrepareOnly'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$configureSmtpNow = $ConfigureSmtp
if (-not $modeWasProvided) {
  $smtpChoice = Read-Host 'Configure SMTP for password reset? [y/N]'
  $configureSmtpNow = $smtpChoice -match '^(y|yes)$'
}
if ($configureSmtpNow) {
  Set-EnvValue 'AUTH_SMTP_HOST' (Read-Host 'SMTP host')
  $smtpPort = Read-Host 'SMTP port [587]'; if (-not $smtpPort) { $smtpPort = '587' }
  Set-EnvValue 'AUTH_SMTP_PORT' $smtpPort
  $smtpSecure = Read-Host 'SMTP secure true/false [false]'; if (-not $smtpSecure) { $smtpSecure = 'false' }
  Set-EnvValue 'AUTH_SMTP_SECURE' $smtpSecure
  Set-EnvValue 'AUTH_SMTP_USER' (Read-Host 'SMTP user, optional')
  Set-EnvValue 'AUTH_SMTP_PASSWORD' (Read-Secret 'SMTP password')
  Set-EnvValue 'AUTH_EMAIL_FROM' (Read-Host 'Sender email')
}

if ($Mode -eq 'PrepareOnly') {
  Write-Host "Preparation completed. Config file: $EnvPath" -ForegroundColor Green
  exit 0
}

if ($Mode -eq 'Docker') {
  if ($NoBuild) { & $SetupLocal -Mode 'Docker' -NoBuild }
  else { & $SetupLocal -Mode 'Docker' }
} elseif ($Mode -eq 'Local') {
  & $SetupLocal -Mode 'Local'
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $NoSeed) {
  Write-Host '==> Kiểm tra và khởi tạo dữ liệu demo (seed_system_data.js)...' -ForegroundColor Cyan
  $servicesDir = Join-Path $Root 'services'
  $priorUrls = @{}
  # Resolve COMPOSE_FILE entries against the checkout, before entering services.
  Push-Location $Root
  try {
    $resolved = & docker compose --project-directory $Root config --format json
    if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the active Compose configuration.' }
    $config = ($resolved -join "`n") | ConvertFrom-Json
  } finally {
    Pop-Location
  }
  Push-Location $servicesDir
  try {
    if (-not (Test-Path (Join-Path $servicesDir 'node_modules'))) {
      npm.cmd ci
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    # Use the selected Compose project's published ports and server credentials.
    # Inherited URLs and old .env URLs can refer to a different local project.
    $databaseServices = @(
      'auth','doctor','receptionist','catalog','patient','queue','prescription',
      'appointment','billing','medical-record','document','treatment-plan',
      'notification','audit-log','reporting','consultation'
    )
    foreach ($name in $databaseServices) {
      $definition = $config.services."$name-database"
      $ports = @($definition.ports | Where-Object { $_.target -eq 5432 })
      if ($ports.Count -ne 1 -or $ports[0].published -notmatch '^[0-9]+$') {
        throw "Expected one published PostgreSQL port for $name."
      }
      $binding = $ports[0]
      if ($binding.host_ip -and $binding.host_ip -notin @('127.0.0.1','0.0.0.0','::','::1')) {
        throw "Expected a local PostgreSQL binding for $name."
      }
      $pg = $definition.environment
      if (-not ($pg.POSTGRES_USER -and $pg.POSTGRES_PASSWORD -and $pg.POSTGRES_DB)) {
        throw "Missing Compose PostgreSQL configuration for $name."
      }
      $key = ($name.ToUpperInvariant() -replace '-', '_') + '_DATABASE_URL'
      $priorUrls[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
      $user = [Uri]::EscapeDataString($pg.POSTGRES_USER)
      $password = [Uri]::EscapeDataString($pg.POSTGRES_PASSWORD)
      $database = [Uri]::EscapeDataString($pg.POSTGRES_DB)
      $localHost = if ($binding.host_ip -in @('::','::1')) { '[::1]' } else { '127.0.0.1' }
      $url = 'postgresql://{0}:{1}@{2}:{3}/{4}?schema=public' -f $user,$password,$localHost,$binding.published,$database
      [Environment]::SetEnvironmentVariable($key, $url, 'Process')
    }
    node seed_system_data.js
    $seedExit = $LASTEXITCODE
    if ($seedExit -ne 0 -and $seedExit -ne 3) { exit $seedExit }
  }
  finally {
    foreach ($key in $priorUrls.Keys) {
      [Environment]::SetEnvironmentVariable($key, $priorUrls[$key], 'Process')
    }
    Pop-Location
  }
}

if ($Mode -eq 'Docker') {
  if (-not $NoBuild) {
    $resolved = & docker compose --project-directory $Root config --format json
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $services = (($resolved -join "`n") | ConvertFrom-Json).services
    $apps = @($services.PSObject.Properties | Where-Object { $_.Value.build -and $_.Value.build.target -ne 'migrator' })
    # Run built apps in bounded batches by building one service at a time.
    foreach ($app in $apps) {
      & docker compose --project-directory $Root build $app.Name
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
  }
  & docker compose --project-directory $Root up --no-build -d --wait --wait-timeout 180
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host 'Setup completed.' -ForegroundColor Green
if ($Mode -eq 'Docker') {
  & docker compose --project-directory $Root port frontend 3000
  & docker compose --project-directory $Root port gateway 8000
}
if ($Mode -eq 'Local') {
  Write-Host 'Databases are ready. Start local apps according to docs/first-run.md.'
}
