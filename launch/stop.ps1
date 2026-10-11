# Stops GemInWeb's node processes (native host + HTTP fallback server) and their
# whole child process trees (shell commands started by the agent).
# Normally started hidden through stop.vbs; shows a popup with the result
# (success closes itself after a few seconds, errors wait for a click).
#   -Quiet   print to the console instead of popups (used by uninstall.ps1)
#   -DryRun  list what would be stopped, stop nothing
[CmdletBinding()]
param(
    [switch]$Quiet,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

function Report([string]$Message, [int]$Icon = 64, [int]$TimeoutSeconds = 0) {
    if ($Quiet -or $DryRun) {
        if ($Icon -eq 16) { Write-Host $Message -ForegroundColor Red } else { Write-Host $Message }
    } else {
        [void](Show-DsgPopup $Message $Icon $TimeoutSeconds)
    }
}

try {
    $root = [Management.Automation.WildcardPattern]::Escape($script:DsgRoot)
    $patterns = @(
        '*devspace-gem\host\native-host.mjs*',
        '*devspace-gem\server\http-server.mjs*',
        '*devspace-gem\host\native-host.cmd*',
        "*$root\host\native-host.mjs*",
        "*$root\server\http-server.mjs*",
        "*$root\host\native-host.cmd*"
    ) | Select-Object -Unique

    $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $targets = @($all | Where-Object {
        $p = $_
        ($p.Name -eq 'node.exe' -or $p.Name -eq 'cmd.exe') -and $p.CommandLine -and
        $p.ProcessId -ne $PID -and
        (@($patterns | Where-Object { $p.CommandLine -like $_ }).Count -gt 0)
    })

    # Collect child trees. A child must be younger than its parent, which guards
    # against Windows reusing the parent's PID for an unrelated older process.
    $children = @{}
    foreach ($p in $all) {
        $key = [string]$p.ParentProcessId
        if (-not $children.ContainsKey($key)) { $children[$key] = New-Object System.Collections.ArrayList }
        [void]$children[$key].Add($p)
    }
    $seen = @{}
    $ordered = New-Object System.Collections.ArrayList   # descendants before ancestors
    function Add-Tree($proc) {
        if ($seen.ContainsKey([string]$proc.ProcessId)) { return }
        $seen[[string]$proc.ProcessId] = $true
        $kids = $children[[string]$proc.ProcessId]
        if ($kids) {
            foreach ($k in $kids) {
                if ($k.ProcessId -eq $PID) { continue }
                if ($proc.CreationDate -and $k.CreationDate -and $k.CreationDate -lt $proc.CreationDate) { continue }
                Add-Tree $k
            }
        }
        [void]$ordered.Add($proc)
    }
    foreach ($t in $targets) { Add-Tree $t }

    if ($ordered.Count -eq 0) {
        Report "GemInWeb이 이미 꺼져 있습니다 (실행 중인 호스트/서버 없음)." 64 5
        exit 0
    }

    if ($DryRun) {
        Write-Host "[dry-run] 다음 프로세스를 종료합니다:"
        foreach ($p in $ordered) {
            $cl = [string]$p.CommandLine; if ($cl.Length -gt 140) { $cl = $cl.Substring(0, 140) + '...' }
            Write-Host ("  pid {0,-6} {1,-12} {2}" -f $p.ProcessId, $p.Name, $cl)
        }
        exit 0
    }

    foreach ($p in $ordered) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500

    $left = @(Get-CimInstance Win32_Process | Where-Object {
        $q = $_
        $q.CommandLine -and ($q.Name -eq 'node.exe') -and $q.ProcessId -ne $PID -and
        (@($patterns | Where-Object { $q.CommandLine -like $_ }).Count -gt 0)
    })
    if ($left.Count -gt 0) {
        Report ("일부 프로세스가 아직 실행 중입니다 (pid: {0}).`n작업 관리자에서 node.exe를 확인하세요." -f (($left | ForEach-Object { $_.ProcessId }) -join ', ')) 48
        exit 1
    }

    $nodeCount = @($targets | Where-Object { $_.Name -eq 'node.exe' }).Count
    $childCount = $ordered.Count - $targets.Count
    $msg = "GemInWeb을 껐습니다.`n호스트/서버 node 프로세스 $nodeCount 개, 하위 프로세스 $childCount 개 종료."
    $msg += "`n`n(확장 프로그램이 다시 연결하면 네이티브 호스트는 자동으로 다시 실행됩니다.)"
    Report $msg 64 6
    exit 0
} catch {
    Report "GemInWeb을 끄지 못했습니다.`n`n$($_.Exception.Message)" 16
    exit 1
}
