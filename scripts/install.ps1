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

function Test-AtlasRagRepo {
  param([string]$PathValue)

  return (Test-Path (Join-Path $PathValue "bin/atlasrag.js")) -and
    (Test-Path (Join-Path $PathValue "docker-compose.yml")) -and
    (Test-Path (Join-Path $PathValue "gateway"))
}

$repoUrl = if ($env:ATLASRAG_REPO_URL) { $env:ATLASRAG_REPO_URL } else { "https://github.com/Emmanuel-Bamidele/atlasrag.git" }
$installHome = if ($env:ATLASRAG_HOME) { $env:ATLASRAG_HOME } else { Join-Path $HOME ".atlasrag" }
$binDir = Join-Path $installHome "bin"
$defaultRepoDir = Join-Path $installHome "src/atlasrag"

if (-not $RepoDir -and $env:ATLASRAG_REPO_DIR) {
  $RepoDir = $env:ATLASRAG_REPO_DIR
}

$nodeBin = Resolve-Bin @(
  "node",
  "$env:ProgramFiles\nodejs\node.exe",
  "${env:ProgramFiles(x86)}\nodejs\node.exe"
)
if (-not $nodeBin) {
  throw "Node.js 18+ is required to run the AtlasRAG CLI."
}

& $nodeBin -e "process.exit(Number.parseInt(process.versions.node.split('.')[0], 10) >= 18 ? 0 : 1)"
if ($LASTEXITCODE -ne 0) {
  throw "Node.js 18+ is required. Found: $(& $nodeBin -v)"
}

$gitBin = Resolve-Bin @(
  "git",
  "$env:ProgramFiles\Git\cmd\git.exe",
  "${env:ProgramFiles(x86)}\Git\cmd\git.exe"
)
if (-not $gitBin) {
  throw "git is required to install AtlasRAG from source."
}

$dockerBin = Resolve-Bin @(
  "docker",
  "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe",
  "${env:ProgramFiles(x86)}\Docker\Docker\resources\bin\docker.exe"
)

if ($RepoDir) {
  $RepoDir = (Resolve-Path $RepoDir).Path
  if (-not (Test-AtlasRagRepo $RepoDir)) {
    throw "Not an AtlasRAG checkout: $RepoDir"
  }
} elseif (Test-AtlasRagRepo (Get-Location).Path) {
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

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$ps1Wrapper = Join-Path $binDir "atlasrag.ps1"
$cmdWrapper = Join-Path $binDir "atlasrag.cmd"
$repoCli = (Join-Path $RepoDir "bin/atlasrag.js")

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

Write-Host "AtlasRAG CLI installed."
Write-Host ""
Write-Host "CLI wrappers:"
Write-Host "  $ps1Wrapper"
Write-Host "  $cmdWrapper"
Write-Host "Repo checkout: $RepoDir"
Write-Host "Node: $nodeBin"
Write-Host "Docker: $(if ($dockerBin) { $dockerBin } else { 'not detected in this shell' })"
Write-Host ""
Write-Host "Open a new terminal if \`"atlasrag\`" is not available yet."
Write-Host "Recommended next commands:"
Write-Host "  atlasrag doctor"
Write-Host "  atlasrag onboard"
Write-Host '  atlasrag write --doc-id welcome --text "AtlasRAG stores memory for agents."'
Write-Host '  atlasrag ask --question "What does AtlasRAG store?"'

if ($RunOnboard) {
  Write-Host ""
  Write-Host "Launching onboarding..."
  & $nodeBin $repoCli onboard
  exit $LASTEXITCODE
}
