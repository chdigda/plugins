#requires -Version 7.0
<#
.SYNOPSIS
  Verify a one-link install of this repository bundle into a throwaway DSH profile.
.DESCRIPTION
  The live harness home is never touched: every DSH command runs with DSH_HOME set to
  <Repo>/.verify/home-<Profile>. Steps: bare-clone the committed repo, initialize a
  profile (web template by default), run "dsh plugin add git+file:///...", assert the
  profile manifest / node_modules / dump-config, and optionally boot the web surface on
  -Port to prove the browser client bundle is served. Prints PASS/FAIL per check and
  exits 0 only when every check passed.
.PARAMETER Bundle
  Installed package (default: the root package.json name). Override to verify a
  pre-restructure single plugin by adding -Spec pointing at its git subdirectory.
.PARAMETER Spec
  Install spec (default: git+file:///<WorkRoot>/repo.git). Subdirectory example:
  git+file:///C:/repo/.verify/repo.git#path:/packages/dsh-web-search
.PARAMETER DshCli
  Path to @deepseek-ai/dsh/lib/bin.js. Default: "dsh" on PATH, else the newest npx cache copy.
.PARAMETER AllowNpmFallback
  When "dsh plugin add" fails (e.g. an agent sandbox blocks pnpm git spawn), pack the
  bundle and install it with npm, then reconcile dsh.profile.bundles manually. The
  degraded mode is reported; it does not exercise pnpm itself.
#>
[CmdletBinding()]
param(
  [string]$Profile = 'verify',
  [string]$Bundle = '',
  [string]$Spec = '',
  [string]$ClientId = '',
  [string]$Repo = (Split-Path -Parent $PSScriptRoot),
  [string]$WorkRoot = '',
  [string]$DshCli = '',
  [ValidateSet('web', 'base')][string]$Template = 'web',
  [int]$Port = 3099,
  [switch]$Boot,
  [switch]$AllowNpmFallback,
  [switch]$WhatIf
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$nl = [string][char]10

$Repo = (Resolve-Path -LiteralPath $Repo).Path
$source = Get-Content -LiteralPath (Join-Path $Repo 'package.json') -Raw | ConvertFrom-Json
if (-not $Bundle) { $Bundle = $source.name }
if (-not $ClientId) { $ClientId = $Bundle }
$patchRel = if ($source.PSObject.Properties.Name -contains 'dsh') { $source.dsh.bundle.patch } else { $null }
$clientRel = if (($source.PSObject.Properties.Name -contains 'exports') -and ($source.exports.PSObject.Properties.Name -contains './client')) { $source.exports.'./client' } else { '' }
if (-not $patchRel) { throw "package.json of '$Bundle' has no dsh.bundle.patch; it is not an installable bundle" }
if (-not $WorkRoot) { $WorkRoot = Join-Path $Repo '.verify' }
$HomeDir = Join-Path $WorkRoot "home-$Profile"
$BareRepo = Join-Path $WorkRoot 'repo.git'
$LogDir = Join-Path $WorkRoot 'logs'
$ProfileDir = Join-Path $HomeDir "profiles/$Profile"
$profileManifestPath = Join-Path $ProfileDir 'package.json'
$installSpec = if ($Spec) { $Spec } else { 'git+file:///' + ($BareRepo -replace '\\', '/') }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
$pnpm = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source
if (-not $pnpm) { $pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue).Source }
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
$dshArgs = @()
if ($DshCli) { $dshArgs = @((Resolve-Path -LiteralPath $DshCli).Path) }
elseif (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
  $hit = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'npm-cache\_npx\*\node_modules\@deepseek-ai\dsh\lib\bin.js') -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($hit) { $dshArgs = @($hit.FullName) }
}

$script:results = [System.Collections.Generic.List[object]]::new()
function Add-Result {
  param([string]$Name, [bool]$Ok, [string]$Detail = '')
  $script:results.Add([pscustomobject]@{ Check = $Name; Ok = $Ok; Detail = $Detail })
  $tag = if ($Ok) { 'PASS' } else { 'FAIL' }
  if ($Detail) { Write-Host ("[{0}] {1} - {2}" -f $tag, $Name, $Detail) } else { Write-Host ("[{0}] {1}" -f $tag, $Name) }
}
function Invoke-Capture {
  param([string]$Name, [string]$Exe, [string[]]$Arguments, [hashtable]$Environment = @{}, [string]$WorkingDirectory = $Repo)
  $out = Join-Path $LogDir "$Name.out.txt"
  $err = Join-Path $LogDir "$Name.err.txt"
  $quote = { param($s) if ($s -match '[\s"]') { '"' + $s + '"' } else { $s } }
  $line = (& $quote $Exe) + ' ' + (($Arguments | ForEach-Object { & $quote $_ }) -join ' ') + ' > "' + $out + '" 2> "' + $err + '"'
  $saved = @{}
  foreach ($key in $Environment.Keys) { $saved[$key] = [Environment]::GetEnvironmentVariable($key); [Environment]::SetEnvironmentVariable($key, $Environment[$key]) }
  Push-Location -LiteralPath $WorkingDirectory
  try { & cmd.exe /d /s /c $line; $code = $LASTEXITCODE }
  finally {
    Pop-Location
    foreach ($key in $Environment.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key]) }
  }
  [pscustomobject]@{
    ExitCode = $code
    Out = (Get-Content -LiteralPath $out -Raw -Encoding utf8 -ErrorAction SilentlyContinue)
    Err = (Get-Content -LiteralPath $err -Raw -Encoding utf8 -ErrorAction SilentlyContinue)
    Log = $out
  }
}

if ($WhatIf) {
  Write-Host "[whatif] work root      : $WorkRoot"
  Write-Host "[whatif] throwaway home : $HomeDir"
  Write-Host "[whatif] bare repo      : $BareRepo"
  Write-Host "[whatif] install spec   : $installSpec"
  Write-Host "[whatif] bundle/client  : $Bundle / $ClientId"
  Write-Host "[whatif] dsh CLI        : $(if ($dshArgs) { $dshArgs -join ' ' } else { 'dsh (PATH)' })"
  exit 0
}
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$hasDsh = ($dshArgs.Count -gt 0) -or [bool](Get-Command dsh -ErrorAction SilentlyContinue)
Add-Result 'preflight: node available' ($null -ne $node) $node
Add-Result 'preflight: git available' ($null -ne $git) $git
Add-Result 'preflight: dsh CLI resolved' $hasDsh $(if ($dshArgs) { $dshArgs -join ' ' } else { 'dsh (PATH)' })
Add-Result 'preflight: pnpm available (or -AllowNpmFallback)' (($null -ne $pnpm) -or $AllowNpmFallback) $pnpm
if (-not $node -or -not $git -or -not $hasDsh) { Write-Host 'Preflight failed; see messages above.'; exit 1 }
$dshExe = if ($dshArgs) { $node } else { 'dsh' }
$dshPrefix = if ($dshArgs) { $dshArgs } else { @() }
$homeEnv = @{ DSH_HOME = $HomeDir; DSH_TELEMETRY_DISABLED = '1' }
function Invoke-Dsh {
  param([string]$Name, [string[]]$Arguments, [string]$WorkingDirectory = $Repo)
  Invoke-Capture -Name $Name -Exe $dshExe -Arguments (@($dshPrefix) + $Arguments) -Environment $homeEnv -WorkingDirectory $WorkingDirectory
}

Push-Location -LiteralPath $Repo
try { & git.exe -c safe.directory=* rev-parse --verify HEAD > $null 2>&1; $gitHead = $LASTEXITCODE -eq 0 } finally { Pop-Location }
Add-Result 'repo: has a commit to clone' $gitHead
if (Test-Path -LiteralPath $BareRepo) { Remove-Item -LiteralPath $BareRepo -Recurse -Force }
$clone = Invoke-Capture -Name 'git-clone-bare' -Exe $git -Arguments @('-c', 'safe.directory=*', 'clone', '--bare', '--quiet', $Repo, $BareRepo)
Add-Result 'repo: bare clone for git+file spec' (($clone.ExitCode -eq 0) -and (Test-Path -LiteralPath $BareRepo)) $BareRepo
$initArgs = if ($Template -eq 'web') { @('--profile', $Profile, '--from-default-profile', 'web', '--dump-config') } else { @('--profile', $Profile, '--dump-config') }
$init = Invoke-Dsh -Name 'init-profile' -Arguments $initArgs
Add-Result "profile: initialized from $Template template" (($init.ExitCode -eq 0) -and (Test-Path -LiteralPath $profileManifestPath)) $profileManifestPath

$install = Invoke-Dsh -Name 'dsh-plugin-add' -Arguments @('plugin', '--profile', $Profile, 'add', $installSpec)
if ($install.ExitCode -ne 0 -and $AllowNpmFallback -and $pnpm) {
  Write-Host '[WARN] dsh plugin add failed; falling back to pnpm pack + npm install (degraded, see logs).'
  Write-Host ((($install.Err -split $nl) | Select-Object -First 4) -join $nl)
  $packs = Join-Path $WorkRoot 'packs'
  New-Item -ItemType Directory -Path $packs -Force | Out-Null
  $pack = Invoke-Capture -Name 'pnpm-pack' -Exe $pnpm -Arguments @('pack', '--pack-destination', $packs, '--store-dir', (Join-Path $WorkRoot 'pnpm-store'))
  $tgz = Get-ChildItem -LiteralPath $packs -Filter '*.tgz' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  Add-Result 'fallback: pnpm pack produced a tarball' (($pack.ExitCode -eq 0) -and ($null -ne $tgz)) $(if ($tgz) { $tgz.FullName } else { [string]$pack.Err })
  if ($tgz) {
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    $npmInstall = Invoke-Capture -Name 'npm-install' -Exe $npm -Arguments @('install', $tgz.FullName, '--cache', (Join-Path $WorkRoot 'npm-cache'), '--no-audit', '--no-fund', '--loglevel=error') -WorkingDirectory $ProfileDir
    Add-Result 'fallback: npm install into profile' ($npmInstall.ExitCode -eq 0) $(if ($npmInstall.Err) { $npmInstall.Err.Trim() } else { '' })
    $installedPkgPath = Join-Path $ProfileDir "node_modules/$Bundle/package.json"
    if (Test-Path -LiteralPath $installedPkgPath) {
      $installedPkg = Get-Content -LiteralPath $installedPkgPath -Raw | ConvertFrom-Json
      $pmTmp = Get-Content -LiteralPath $profileManifestPath -Raw | ConvertFrom-Json
      $bundlesTmp = @($pmTmp.dsh.profile.bundles)
      if ($installedPkg.dsh.bundle.patch -and -not ($bundlesTmp -contains $Bundle)) {
        $pmTmp.dsh.profile.bundles = $bundlesTmp + $Bundle
        $pmTmp | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $profileManifestPath -Encoding utf8
      }
    }
  }
} else {
  Add-Result 'install: dsh plugin add succeeded' ($install.ExitCode -eq 0) $(if ($install.ExitCode -ne 0) { (($install.Err -split $nl) | Select-Object -First 2) -join ' ' } else { $Spec })
}
$pm = Get-Content -LiteralPath $profileManifestPath -Raw | ConvertFrom-Json
Add-Result "manifest: dependency $Bundle" ($null -ne $pm.dependencies.PSObject.Properties[$Bundle])
Add-Result "manifest: $Bundle in dsh.profile.bundles" (@($pm.dsh.profile.bundles) -contains $Bundle) (@($pm.dsh.profile.bundles) -join ', ')
$installedDir = Join-Path $ProfileDir "node_modules/$Bundle"
$installedManifestPath = Join-Path $installedDir 'package.json'
$installedOk = Test-Path -LiteralPath $installedManifestPath
Add-Result 'node_modules: installed package present' $installedOk $installedDir
if ($installedOk) {
  $ipm = Get-Content -LiteralPath $installedManifestPath -Raw | ConvertFrom-Json
  Add-Result "installed version $($ipm.version) matches source $($source.version)" ($ipm.version -eq $source.version)
  Add-Result 'installed bundle patch file exists' (Test-Path -LiteralPath (Join-Path $installedDir $patchRel)) $patchRel
  if ($clientRel) {
    $clientPath = Join-Path $installedDir $clientRel
    $clientOk = Test-Path -LiteralPath $clientPath
    $clientText = if ($clientOk) { Get-Content -LiteralPath $clientPath -Raw } else { '' }
    Add-Result "client bundle declares module id $ClientId" ($clientOk -and $clientText.Contains(('id: "' + $ClientId + '"'))) $clientRel
  }
}
$dump = Invoke-Dsh -Name 'dump-config' -Arguments @('--profile', $Profile, '--dump-config')
$dumpOk = ($dump.ExitCode -eq 0) -and [bool]$dump.Out -and $dump.Out.Contains("# == $Bundle")
Add-Result 'dump-config: bundle layer applied' $dumpOk "(log: $($dump.Log))"
if ($null -ne $dump.Out -and $dump.Out.Contains('# == @deepseek-ai/dsh-web-app')) { Add-Result 'dump-config: web template layer present' $true }
elseif ($Template -eq 'web') { Add-Result 'dump-config: web template layer present' $false }

if ($Boot) {
  $bootOut = Join-Path $LogDir 'verify-boot.out.txt'
  $bootErr = Join-Path $LogDir 'verify-boot.err.txt'
  $savedHome = [Environment]::GetEnvironmentVariable('DSH_HOME')
  [Environment]::SetEnvironmentVariable('DSH_HOME', $HomeDir)
  [Environment]::SetEnvironmentVariable('DSH_TELEMETRY_DISABLED', '1')
  $proc = Start-Process -FilePath $node -ArgumentList (@($dshPrefix) + @('--profile', $Profile, '--port', $Port, '--no-open')) -RedirectStandardOutput $bootOut -RedirectStandardError $bootErr -PassThru -NoNewWindow
  try {
    $origin = "http://127.0.0.1:$Port"
    $url = $null
    for ($i = 0; $i -lt 120 -and -not $url; $i++) {
      Start-Sleep -Milliseconds 500
      if (Test-Path -LiteralPath $bootOut) {
        $m = [regex]::Match((Get-Content -LiteralPath $bootOut -Raw), [regex]::Escape($origin) + '/\?token=\S+')
        if ($m.Success) { $url = $m.Value }
        elseif ((Get-Content -LiteralPath $bootErr -Raw -ErrorAction SilentlyContinue) -match 'startup failed') { break }
      }
    }
    Add-Result 'boot: server announced its URL' ($null -ne $url) $url
    if ($url) {
      $handler = [System.Net.Http.HttpClientHandler]::new()
      $handler.AllowAutoRedirect = $true
      $handler.CookieContainer = [System.Net.CookieContainer]::new()
      $http = [System.Net.Http.HttpClient]::new($handler)
      $http.DefaultRequestHeaders.Add('Origin', $origin)
      $index = $http.GetStringAsync($url).GetAwaiter().GetResult()
      Add-Result 'boot: index carries DSH boot manifest' ($index.Contains('__DSH_BOOT__'))
      $entry = [regex]::Match($index, '"id":"' + [regex]::Escape($ClientId) + '","url":"([^"]+)"')
      Add-Result "boot: client entry $ClientId in boot manifest" $entry.Success $entry.Groups[1].Value
      if ($entry.Success) {
        $chunkUrl = [uri]::new([uri]"$origin/", $entry.Groups[1].Value.Replace('&amp;', '&')).AbsoluteUri
        $chunk = $http.GetStringAsync($chunkUrl).GetAwaiter().GetResult()
        Add-Result 'boot: served client bundle declares module id' ($chunk.Contains(('id: "' + $ClientId + '"')) -and $chunk.Contains('__ModuleLoader__.load')) "$($chunk.Length) bytes"
      }
    }
  } finally {
    if ($proc) { & cmd.exe /d /s /c ('taskkill /PID ' + $proc.Id + ' /T /F > "' + (Join-Path $LogDir 'boot-kill.log') + '" 2>&1') | Out-Null }
    [Environment]::SetEnvironmentVariable('DSH_HOME', $savedHome)
    [Environment]::SetEnvironmentVariable('DSH_TELEMETRY_DISABLED', $null)
  }
}
$failed = @($script:results | Where-Object { -not $_.Ok })
Write-Host ''
Write-Host ("{0} checks, {1} passed, {2} failed" -f $script:results.Count, ($script:results.Count - $failed.Count), $failed.Count)
Write-Host "Logs: $LogDir"
if ($failed.Count -gt 0) { Write-Host 'RESULT: FAIL'; exit 1 }
Write-Host 'RESULT: PASS'
exit 0
