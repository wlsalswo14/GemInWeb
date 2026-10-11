<#
.SYNOPSIS
  GemInWeb 제거: install.ps1 이 한 일을 되돌립니다.

.DESCRIPTION
  1. 실행 중인 호스트/HTTP 서버와 하위 프로세스 종료 (launch\stop.ps1 -Quiet)
  2. HKCU NativeMessagingHosts 레지스트리 키 삭제 (Chrome / Chromium / Edge / Brave)
  3. 호스트 매니페스트(com.devspace.gem.json)와 host\native-host.cmd 삭제
  4. 바탕화면 바로가기 삭제 (이 폴더를 가리키는 것만)
  5. -Purge 일 때만 데이터 폴더 전체(config.json, http-token, logs) 삭제
  Chrome 에 로드한 확장 프로그램은 chrome://extensions 에서 직접 삭제하세요.

.PARAMETER DryRun
  할 일을 출력만 하고 아무것도 바꾸지 않습니다.
.PARAMETER Purge
  %USERPROFILE%\.devspace-gem (설정, 토큰, 로그)까지 삭제합니다.
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Purge
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$Root         = $script:DsgRoot
$DataDir      = Get-DsgDataDir
$HostCmd      = Join-Path $Root 'host\native-host.cmd'
$ManifestPath = Join-Path $DataDir "$($script:DsgHostName).json"

function Remove-DsgPath([string]$Path, [string]$Label, [switch]$Recurse) {
    if (-not (Test-Path -LiteralPath $Path)) { Write-Info "(없음) $Label`: $Path"; return }
    if (-not $DryRun) { Remove-Item -LiteralPath $Path -Force -Recurse:$Recurse }
    Write-Did "$Label 삭제: $Path"
}

try {
    Write-Host "GemInWeb 제거$(if ($DryRun) { ' (DRY RUN: 아무것도 바꾸지 않습니다)' })" -ForegroundColor Cyan
    Write-Info "프로젝트 폴더: $Root"
    Write-Info "데이터 폴더:   $DataDir"

    Write-Section '1/5 실행 중인 프로세스 종료'
    & (Join-Path $Root 'launch\stop.ps1') -Quiet -DryRun:$DryRun
    $stopCode = Get-Variable -Name LASTEXITCODE -ValueOnly -ErrorAction SilentlyContinue
    if ($stopCode) { Write-Warning '일부 프로세스를 종료하지 못했습니다. 계속 진행합니다.' }

    Write-Section '2/5 레지스트리'
    foreach ($sub in $script:DsgHostKeys) {
        $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sub)
        if (-not $k) { Write-Info "(없음) HKCU\$sub"; continue }
        $k.Close()
        if (-not $DryRun) { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($sub, $false) }
        Write-Did "HKCU\$sub 삭제"
    }

    Write-Section '3/5 호스트 파일'
    Remove-DsgPath $ManifestPath 'host manifest'
    Remove-DsgPath $HostCmd 'native-host.cmd'

    Write-Section '4/5 바탕화면 바로가기'
    & (Join-Path $Root 'launch\create-shortcuts.ps1') -Remove -DryRun:$DryRun

    Write-Section '5/5 데이터 폴더'
    if ($Purge) {
        Remove-DsgPath $DataDir '데이터 폴더(설정/토큰/로그)' -Recurse
    } else {
        Write-Info "유지함 (config.json, http-token, logs). 완전히 지우려면 -Purge: $DataDir"
    }

    Write-Host ''
    if ($DryRun) {
        Write-Host 'DRY RUN 완료: 실제로 바뀐 것은 없습니다.' -ForegroundColor Yellow
    } else {
        Write-Host '제거 완료.' -ForegroundColor Green
    }
    Write-Host 'Chrome 확장 프로그램은 chrome://extensions 에서 "GemInWeb" 의 [삭제] 를 눌러 지우세요.'
    exit 0
} catch {
    Write-Host ''
    Write-Host "제거 실패: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
