# Shared helpers for install.ps1 / uninstall.ps1. Dot-source only; no side effects.
# Expects $DryRun to be defined by the caller.

. (Join-Path $PSScriptRoot '..\launch\common.ps1')

$script:Utf8NoBom = New-Object Text.UTF8Encoding $false

function Write-Section([string]$Text) {
    Write-Host ''
    Write-Host "== $Text" -ForegroundColor Cyan
}

function Write-Did([string]$Text) {
    if ($DryRun) { Write-Host "[dry-run] $Text" -ForegroundColor Yellow }
    else { Write-Host "  [ok] $Text" -ForegroundColor Green }
}

function Write-Info([string]$Text) { Write-Host "  $Text" }

# Extension ID = first 32 hex chars of SHA-256(DER public key), digits 0-f mapped to a-p.
function Get-DsgExtensionId([string]$Base64Key) {
    $der = [Convert]::FromBase64String($Base64Key)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash($der) } finally { $sha.Dispose() }
    $sb = New-Object Text.StringBuilder
    foreach ($b in $hash[0..15]) {
        [void]$sb.Append([char](97 + ($b -shr 4)))
        [void]$sb.Append([char](97 + ($b -band 0x0F)))
    }
    return $sb.ToString()
}

function ConvertTo-JsonString([string]$s) {
    $sb = New-Object Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($ch in $s.ToCharArray()) {
        switch ($ch) {
            '"'  { [void]$sb.Append('\"') }
            '\'  { [void]$sb.Append('\\') }
            "`n" { [void]$sb.Append('\n') }
            "`r" { [void]$sb.Append('\r') }
            "`t" { [void]$sb.Append('\t') }
            default {
                if ([int]$ch -lt 0x20) { [void]$sb.Append(('\u{0:x4}' -f [int]$ch)) }
                else { [void]$sb.Append($ch) }
            }
        }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

# Writes $Content with $Encoding only when the bytes differ. Honors $DryRun.
function Write-DsgFile([string]$Path, [string]$Content, [Text.Encoding]$Encoding, [string]$Label) {
    $bytes = $Encoding.GetBytes($Content)
    $preamble = $Encoding.GetPreamble()
    if ($preamble.Length -gt 0) { $bytes = [byte[]]($preamble + $bytes) }
    $state = 'create'
    if (Test-Path -LiteralPath $Path) {
        $old = [IO.File]::ReadAllBytes($Path)
        if ($old.Length -eq $bytes.Length -and
            [Convert]::ToBase64String($old) -eq [Convert]::ToBase64String($bytes)) {
            Write-Info "(변경 없음) $Label`: $Path"
            return
        }
        $state = 'update'
    }
    if (-not $DryRun) {
        $dir = Split-Path -Parent $Path
        if (-not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
        [IO.File]::WriteAllBytes($Path, $bytes)
    }
    Write-Did "$Label $state`: $Path"
    if ($DryRun) {
        foreach ($line in ($Content.TrimEnd() -split "`r?`n")) { Write-Host "            | $line" -ForegroundColor DarkGray }
    }
}

function Find-DsgNode([string]$Override) {
    if ($Override) {
        if (Test-Path -LiteralPath $Override) { return [IO.Path]::GetFullPath($Override) }
        throw "-NodePath 로 지정한 파일이 없습니다: $Override"
    }
    $cmd = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe' }),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
        $(if ($env:NVM_SYMLINK) { Join-Path $env:NVM_SYMLINK 'node.exe' }),
        (Join-Path $env:LOCALAPPDATA 'Volta\bin\node.exe'),
        (Join-Path $env:USERPROFILE 'scoop\apps\nodejs\current\node.exe')
    )
    foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
    return $null
}

# Runs a process with stdin closed and stdout/stderr captured as UTF-8.
function Invoke-DsgCapture([string]$File, [string[]]$Arguments, [int]$TimeoutSec = 60) {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $File
    $psi.Arguments = ($Arguments | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = $script:Utf8NoBom
    $psi.StandardErrorEncoding = $script:Utf8NoBom
    $p = [Diagnostics.Process]::Start($psi)
    $p.StandardInput.Close()
    $out = $p.StandardOutput.ReadToEndAsync()
    $err = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($TimeoutSec * 1000)) {
        try { $p.Kill() } catch { }
        throw "$File 이(가) $TimeoutSec 초 안에 끝나지 않았습니다."
    }
    $p.WaitForExit()
    return [pscustomobject]@{ ExitCode = $p.ExitCode; Stdout = $out.Result; Stderr = $err.Result }
}
