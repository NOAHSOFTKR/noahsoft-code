#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\noahsoft-code'),
    [string]$BinDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\noahsoft-code-bin'),
    [string]$RepositoryUrl = 'https://github.com/NOAHSOFTKR/noahsoft-code.git',
    [string]$Branch = 'main',
    [switch]$SkipPrerequisites,
    [switch]$SkipPathUpdate
)

function Get-CvpUserPath { [Environment]::GetEnvironmentVariable('Path', 'User') }
function Set-CvpUserPath([string]$Value) { [Environment]::SetEnvironmentVariable('Path', $Value, 'User') }

function Join-CvpPath {
    param([string]$Existing, [string[]]$Entries)
    $result = New-Object 'System.Collections.Generic.List[string]'
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in @($Entries) + @($Existing -split ';')) {
        if ([string]::IsNullOrWhiteSpace($entry)) { continue }
        $key = [Environment]::ExpandEnvironmentVariables($entry.Trim().Trim('"')).TrimEnd('\', '/')
        if ($seen.Add($key)) { $result.Add($entry) }
    }
    $result -join ';'
}

function Invoke-CvpCommand {
    param([string]$File, [string[]]$Arguments)
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $File" }
}

function Find-CvpNode {
    $candidates = @((Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue | ForEach-Object Source))
    $candidates += @((Join-Path $env:ProgramFiles 'nodejs\node.exe'), (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))
    foreach ($candidate in $candidates | Select-Object -Unique) {
        if (!(Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $version = & $candidate --version
        if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 24) { return $candidate }
    }
}

function Find-CvpGit {
    $candidates = @((Get-Command git.exe -CommandType Application -All -ErrorAction SilentlyContinue | ForEach-Object Source))
    $candidates += @((Join-Path $env:ProgramFiles 'Git\cmd\git.exe'), (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd\git.exe'))
    foreach ($candidate in $candidates | Select-Object -Unique) {
        if (!(Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $root = Split-Path -Parent $candidate
        for ($i = 0; $i -lt 3; $i++) {
            $bash = Join-Path $root 'bin\bash.exe'
            if (Test-Path -LiteralPath $bash -PathType Leaf) { return @{ Git = $candidate; Bash = $bash } }
            $root = Split-Path -Parent $root
            if (!$root) { break }
        }
    }
}

function Install-CvpPrerequisite {
    param([string]$Id)
    $winget = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue
    if (!$winget) { throw 'WinGet is unavailable. Install Node.js 24+ and Git for Windows, then run this script again.' }
    Write-Host "Installing prerequisite with WinGet: $Id (Windows may request elevation)."
    Invoke-CvpCommand -File $winget.Source -Arguments @('install', '--id', $Id, '--exact', '--source', 'winget', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity')
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = Get-CvpUserPath
    $env:Path = Join-CvpPath -Existing "$machine;$user;$env:Path" -Entries @()
}

function Get-CvpFullPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -match '[;\r\n"]') { throw 'Installation paths cannot be empty or contain semicolons, quotes or newlines.' }
    $full = [IO.Path]::GetFullPath($Value).TrimEnd('\', '/')
    if ($full -eq [IO.Path]::GetPathRoot($full).TrimEnd('\', '/')) { throw 'A filesystem root cannot be an installation directory.' }
    $full
}

function Get-CvpRemoteKey([string]$Value) {
    $key = $Value.Trim().TrimEnd('\', '/')
    if ($key.EndsWith('.git', [StringComparison]::OrdinalIgnoreCase)) { $key = $key.Substring(0, $key.Length - 4) }
    $key.ToLowerInvariant()
}

function Install-Cvp {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$TargetDirectory,
        [Parameter(Mandatory = $true)][string]$CommandDirectory,
        [string]$Remote = 'https://github.com/NOAHSOFTKR/noahsoft-code.git',
        [string]$Ref = 'main',
        [switch]$NoPrerequisites,
        [switch]$NoPathUpdate
    )
    $ErrorActionPreference = 'Stop'
    if ($env:OS -ne 'Windows_NT') { throw 'This installer supports Windows only.' }
    if ([string]::IsNullOrWhiteSpace($Remote) -or $Remote.StartsWith('-') -or $Ref -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$') { throw 'Invalid repository or branch.' }
    $target = Get-CvpFullPath $TargetDirectory
    $bin = Get-CvpFullPath $CommandDirectory
    if ($target -eq $bin -or $bin.StartsWith("$target\", [StringComparison]::OrdinalIgnoreCase) -or $target.StartsWith("$bin\", [StringComparison]::OrdinalIgnoreCase)) { throw 'The command directory must be separate from the Git checkout.' }
    $node = Find-CvpNode
    if (!$node -and !$NoPrerequisites) { Install-CvpPrerequisite 'OpenJS.NodeJS.LTS'; $node = Find-CvpNode }
    if (!$node) { throw 'Node.js 24+ is required. Install it and run this script again.' }
    $npm = Join-Path (Split-Path -Parent $node) 'npm.cmd'
    if (!(Test-Path -LiteralPath $npm -PathType Leaf)) { throw 'npm.cmd is missing beside node.exe. Install the full Node.js LTS distribution.' }
    $git = Find-CvpGit
    if (!$git -and !$NoPrerequisites) { Install-CvpPrerequisite 'Git.Git'; $git = Find-CvpGit }
    if (!$git) { throw 'Git for Windows (including Git Bash) is required.' }
    $env:Path = Join-CvpPath -Existing $env:Path -Entries @((Split-Path -Parent $node), (Split-Path -Parent $git.Git))

    $existingCheckout = (Test-Path -LiteralPath $target) -and (Test-Path -LiteralPath (Join-Path $target '.git'))
    if ((Test-Path -LiteralPath $target) -and !$existingCheckout -and (!(Test-Path -LiteralPath $target -PathType Container) -or @(Get-ChildItem -LiteralPath $target -Force).Count -gt 0)) { throw 'The installation directory is not empty and is not a Git checkout.' }
    if ($existingCheckout) {
        if (!(Test-Path -LiteralPath (Join-Path $target '.git'))) { throw 'The installation directory already exists and is not a Git checkout. Choose an empty/new directory.' }
        $prefix = & $git.Git -C $target rev-parse --show-prefix
        if ($LASTEXITCODE -ne 0 -or ![string]::IsNullOrEmpty($prefix)) { throw 'The installation directory is not the repository root.' }
        $origin = & $git.Git -C $target remote get-url origin
        if ($LASTEXITCODE -ne 0 -or (Get-CvpRemoteKey $origin) -ne (Get-CvpRemoteKey $Remote)) { throw 'The existing checkout has a different origin. It will not be overwritten.' }
        $branch = & $git.Git -C $target branch --show-current
        if ($LASTEXITCODE -ne 0 -or $branch -ne $Ref) { throw "The existing checkout is not on branch $Ref. It will not be switched automatically." }
        Invoke-CvpCommand -File $git.Git -Arguments @('-C', $target, 'diff', '--quiet')
        Invoke-CvpCommand -File $git.Git -Arguments @('-C', $target, 'diff', '--cached', '--quiet')
        # Non-conflicting untracked files are retained; Git itself refuses collisions.
        Invoke-CvpCommand -File $git.Git -Arguments @('-C', $target, 'pull', '--ff-only', 'origin', $Ref)
    } else {
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Invoke-CvpCommand -File $git.Git -Arguments @('clone', '--branch', $Ref, '--single-branch', '--', $Remote, $target)
    }
    $package = Get-Content -LiteralPath (Join-Path $target 'package.json') -Raw | ConvertFrom-Json
    if ($package.name -ne 'cvp-cli') { throw 'The checkout is not the cvp-cli package.' }
    Push-Location -LiteralPath $target
    try {
        Invoke-CvpCommand -File $npm -Arguments @('ci', '--include=dev')
        Invoke-CvpCommand -File $npm -Arguments @('run', 'build')
    } finally { Pop-Location }
    $entry = Join-Path $target 'dist\index.js'
    if (!(Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'Build did not produce dist/index.js.' }
    New-Item -ItemType Directory -Path $bin -Force | Out-Null
    # Only write our own command, and do not silently replace unrelated user scripts.
    $shim = Join-Path $bin 'cvp.cmd'
    if ((Test-Path -LiteralPath $shim) -and (Get-Content -LiteralPath $shim -Raw) -notmatch 'rem CVP CLI managed launcher') { throw 'An unmanaged cvp.cmd already exists in the command directory.' }
    $escape = { param([string]$value) $value.Replace('%', '%%') }
    $nodePath = & $escape $node
    $entryPath = & $escape $entry
    $bashPath = & $escape $git.Bash
    $runtimePath = & $escape ((Split-Path -Parent $node) + ';' + (Split-Path -Parent $git.Git))
    # Decode Unicode path assignments as UTF-8, then restore the caller's code page
    # before starting Node. Keeping %* in batch avoids a second argument parser.
    $launcher = "@echo off`r`nrem CVP CLI managed launcher`r`nsetlocal DisableDelayedExpansion`r`nfor /f `"tokens=2 delims=:`" %%a in ('chcp') do set `"_CVP_CP=%%a`"`r`nif not defined _CVP_CP exit /b 1`r`nchcp 65001 >nul`r`nif errorlevel 1 exit /b 1`r`nset `"_CVP_NODE=$nodePath`"`r`nset `"_CVP_ENTRY=$entryPath`"`r`nset `"PATH=$runtimePath;%PATH%`"`r`nif not defined CLAUDE_CODE_GIT_BASH_PATH set `"CLAUDE_CODE_GIT_BASH_PATH=$bashPath`"`r`nchcp %_CVP_CP% >nul`r`nif errorlevel 1 exit /b 1`r`n`"%_CVP_NODE%`" `"%_CVP_ENTRY%`" %*`r`nexit /b %errorlevel%`r`n"
    [IO.File]::WriteAllText($shim, $launcher, (New-Object Text.UTF8Encoding($false)))
    $consoleEncoding = [Console]::OutputEncoding
    try { Invoke-CvpCommand -File $shim -Arguments @('--version') }
    finally { [Console]::OutputEncoding = $consoleEncoding }
    if (!$NoPathUpdate) {
        $oldPath = Get-CvpUserPath
        $newPath = Join-CvpPath -Existing $oldPath -Entries @($bin)
        if ($newPath -cne $oldPath) { Set-CvpUserPath $newPath }
    }
    $env:Path = Join-CvpPath -Existing $env:Path -Entries @($bin)
    $resolved = Get-Command cvp -ErrorAction Stop
    if ($resolved.CommandType -ne 'Application' -or $resolved.Source -ne $shim) { throw 'cvp is shadowed by another alias or command. Use the printed cvp.cmd path or open a new terminal.' }
    Write-Host "Installed: $target"
    Write-Host "Command:   $shim"
    Write-Host 'Open a new terminal and run: cvp --version'
    Write-Host 'Authentication and model are not configured by the installer.'
}

if ($MyInvocation.InvocationName -ne '.') {
    Install-Cvp -TargetDirectory $InstallDirectory -CommandDirectory $BinDirectory -Remote $RepositoryUrl -Ref $Branch -NoPrerequisites:$SkipPrerequisites -NoPathUpdate:$SkipPathUpdate
}
