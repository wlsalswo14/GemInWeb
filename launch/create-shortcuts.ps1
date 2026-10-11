# Creates (or with -Remove deletes) the GemInWeb desktop shortcuts.
# Idempotent: existing shortcuts with the same names are overwritten.
# -Remove only deletes shortcuts that point into this checkout's launch\ folder.
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$desktop = [Environment]::GetFolderPath('Desktop')
$launch  = Join-Path $script:DsgRoot 'launch'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$shell32 = Join-Path $env:SystemRoot 'System32\shell32.dll'
$chrome  = Find-DsgChrome
$chromeIcon = if ($chrome) { "$chrome,0" } else { "$shell32,13" }

$shortcuts = @(
    @{ Name = 'GemInWeb - AI Studio'; Script = 'open-aistudio.vbs'; Icon = $chromeIcon
       Description = 'GemInWeb: Google AI Studio 새 채팅을 Chrome에서 엽니다 (로컬 파일/셸 연결)' },
    @{ Name = 'GemInWeb - Gemini'; Script = 'open-gemini.vbs'; Icon = "$shell32,43"
       Description = 'GemInWeb: Gemini 웹을 Chrome에서 엽니다 (로컬 파일/셸 연결)' },
    @{ Name = 'GemInWeb 끄기'; Script = 'stop.vbs'; Icon = "$shell32,27"
       Description = 'GemInWeb 네이티브 호스트/HTTP 서버와 실행 중인 셸 명령을 모두 종료합니다' }
)

$wsh = New-Object -ComObject WScript.Shell
foreach ($s in $shortcuts) {
    $lnk = Join-Path $desktop ($s.Name + '.lnk')
    $vbs = Join-Path $launch $s.Script

    if ($Remove) {
        if (-not (Test-Path -LiteralPath $lnk)) { Write-Host "  (없음) $lnk"; continue }
        $existing = $wsh.CreateShortcut($lnk)
        if (-not ([string]$existing.Arguments).ToLowerInvariant().Contains($launch.ToLowerInvariant())) {
            Write-Warning "건너뜀: $lnk 는 이 폴더($launch)를 가리키지 않습니다."
            continue
        }
        if ($DryRun) { Write-Host "[dry-run] 바로가기 삭제: $lnk" -ForegroundColor Yellow; continue }
        Remove-Item -LiteralPath $lnk -Force
        Write-Host "  바로가기 삭제: $lnk" -ForegroundColor Green
        continue
    }

    $verb = if (Test-Path -LiteralPath $lnk) { '갱신' } else { '생성' }
    if ($DryRun) {
        Write-Host "[dry-run] 바로가기 $verb`: $lnk" -ForegroundColor Yellow
        Write-Host "            -> $wscript `"$vbs`"  (아이콘 $($s.Icon))"
        continue
    }
    $l = $wsh.CreateShortcut($lnk)
    $l.TargetPath       = $wscript
    $l.Arguments        = "`"$vbs`""
    $l.WorkingDirectory = $launch
    $l.IconLocation     = $s.Icon
    $l.Description      = $s.Description
    $l.WindowStyle      = 7
    $l.Save()
    Write-Host "  바로가기 $verb`: $lnk" -ForegroundColor Green
}
