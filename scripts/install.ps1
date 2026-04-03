param(
  [string]$RepoDir,
  [switch]$RunOnboard,
  [switch]$NoPathUpdate
)

$ErrorActionPreference = "Stop"

function Resolve-Bin {
  param([string[]]$Candidates)

  foreach ($candidate in $Candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
    try {
      $command = Get-Command $candidate -ErrorAction Stop
      return $command.Source
    } catch {
      if (Test-Path $candidate) {
        return (Resolve-Path $candidate).Path
      }
    }
  }

  return $null
}

function Test-SupaVectorRepo {
  param([string]$PathValue)

  return (Test-Path (Join-Path $PathValue "bin/supavector.js")) -and
    (Test-Path (Join-Path $PathValue "docker-compose.yml")) -and
    (Test-Path (Join-Path $PathValue "gateway"))
}

$repoUrl = if ($env:SUPAVECTOR_REPO_URL) { $env:SUPAVECTOR_REPO_URL } else { "https://github.com/Emmanuel-Bamidele/supavector.git" }
$installHome = if ($env:SUPAVECTOR_HOME) { $env:SUPAVECTOR_HOME } else { Join-Path $HOME ".supavector" }
$binDir = Join-Path $installHome "bin"
$defaultRepoDir = Join-Path $installHome "src/supavector"

if (-not $RepoDir -and $env:SUPAVECTOR_REPO_DIR) {
  $RepoDir = $env:SUPAVECTOR_REPO_DIR
}

$nodeBin = Resolve-Bin @(
  "node",
  "$env:ProgramFiles\nodejs\node.exe",
  "${env:ProgramFiles(x86)}\nodejs\node.exe"
)
if (-not $nodeBin) {
  throw "Node.js 18+ is required to run the SupaVector CLI."
}

& $nodeBin -e "process.exit(Number.parseInt(process.versions.node.split('.')[0], 10) >= 18 ? 0 : 1)"
if ($LASTEXITCODE -ne 0) {
  throw "Node.js 18+ is required. Found: $(& $nodeBin -v)"
}

$nodeDir = Split-Path -Parent $nodeBin
$npmBin = Resolve-Bin @(
  "npm",
  (Join-Path $nodeDir "npm.cmd"),
  (Join-Path $nodeDir "npm"),
  "$env:ProgramFiles\nodejs\npm.cmd",
  "${env:ProgramFiles(x86)}\nodejs\npm.cmd"
)
if (-not $npmBin) {
  throw "npm is required to install SupaVector CLI dependencies."
}

$gitBin = Resolve-Bin @(
  "git",
  "$env:ProgramFiles\Git\cmd\git.exe",
  "${env:ProgramFiles(x86)}\Git\cmd\git.exe"
)
if (-not $gitBin) {
  throw "git is required to install SupaVector from source."
}

$dockerBin = Resolve-Bin @(
  "docker",
  "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe",
  "${env:ProgramFiles(x86)}\Docker\Docker\resources\bin\docker.exe"
)

if ($RepoDir) {
  $RepoDir = (Resolve-Path $RepoDir).Path
  if (-not (Test-SupaVectorRepo $RepoDir)) {
    throw "Not a SupaVector checkout: $RepoDir"
  }
} elseif (Test-SupaVectorRepo (Get-Location).Path) {
  $RepoDir = (Get-Location).Path
} else {
  $RepoDir = $defaultRepoDir
  $repoParent = Split-Path -Parent $RepoDir
  New-Item -ItemType Directory -Force -Path $repoParent | Out-Null
  if (Test-Path (Join-Path $RepoDir ".git")) {
    & $gitBin -C $RepoDir fetch --depth=1 origin main
    if ($LASTEXITCODE -ne 0) {
      & $gitBin -C $RepoDir fetch origin
      if ($LASTEXITCODE -ne 0) { throw "git fetch failed." }
    }
    & $gitBin -C $RepoDir checkout main
    if ($LASTEXITCODE -ne 0) { throw "git checkout main failed." }
    & $gitBin -C $RepoDir pull --ff-only origin main
    if ($LASTEXITCODE -ne 0) { throw "git pull failed." }
  } else {
    if (Test-Path $RepoDir) {
      Remove-Item -Recurse -Force $RepoDir
    }
    & $gitBin clone --depth=1 $repoUrl $RepoDir
    if ($LASTEXITCODE -ne 0) { throw "git clone failed." }
  }
}

$previousPath = $env:Path
try {
  $env:Path = if ($previousPath) { "$nodeDir;$previousPath" } else { $nodeDir }
  Push-Location $RepoDir
  & $npmBin install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
} finally {
  Pop-Location
  $env:Path = $previousPath
}

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$ps1Wrapper = Join-Path $binDir "supavector.ps1"
$cmdWrapper = Join-Path $binDir "supavector.cmd"
$repoCli = (Join-Path $RepoDir "bin/supavector.js")

$ps1WrapperContent = @"
param(
  [Parameter(ValueFromRemainingArguments = `$true)]
  [string[]]`$Args
)
& "$nodeBin" "$repoCli" @Args
exit `$LASTEXITCODE
"@
Set-Content -Path $ps1Wrapper -Value $ps1WrapperContent -Encoding UTF8

$cmdWrapperContent = "@echo off`r`n""$nodeBin"" ""$repoCli"" %*`r`n"
Set-Content -Path $cmdWrapper -Value $cmdWrapperContent -Encoding ASCII

if (-not $NoPathUpdate) {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $pathParts = @()
  if ($userPath) {
    $pathParts = $userPath -split ";" | Where-Object { $_ }
  }
  if ($pathParts -notcontains $binDir) {
    $nextPath = if ($userPath) { "$userPath;$binDir" } else { $binDir }
    [Environment]::SetEnvironmentVariable("Path", $nextPath, "User")
  }
}

Write-Host "SupaVector CLI installed."
Write-Host ""
Write-Host "CLI wrappers:"
Write-Host "  $ps1Wrapper"
Write-Host "  $cmdWrapper"
Write-Host "Repo checkout: $RepoDir"
Write-Host "Node: $nodeBin"
Write-Host "Docker: $(if ($dockerBin) { $dockerBin } else { 'not detected in this shell' })"
Write-Host ""
Write-Host "Open a new terminal if \`"supavector\`" is not available yet."
Write-Host "Recommended first-run commands:"
Write-Host "  supavector doctor"
Write-Host "  supavector onboard"
Write-Host ""
Write-Host "After onboarding:"
Write-Host '  supavector write --doc-id welcome --text "SupaVector stores memory for agents."'
Write-Host '  supavector ask --question "What does SupaVector store?"'
Write-Host '  supavector boolean_ask --question "Does SupaVector store memory for agents?"'
Write-Host ""
Write-Host "Useful later:"
Write-Host "  supavector changemodel"
Write-Host "  supavector update"

if ($RunOnboard) {
  Write-Host ""
  Write-Host "Launching onboarding..."
  & $nodeBin $repoCli onboard
  exit $LASTEXITCODE
}
