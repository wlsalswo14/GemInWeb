# Shared helpers for launch/*.ps1, install/*.ps1. Dot-source only; no side effects.
# Saved as UTF-8 with BOM so Windows PowerShell 5.1 reads the Korean text correctly.

$script:DsgHostName  = 'com.devspace.gem'
$script:DsgRoot      = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:DsgTitle     = 'GemInWeb'
$script:DsgHostKeys  = @(
    'Software\Google\Chrome\NativeMessagingHosts\com.devspace.gem',
    'Software\Chromium\NativeMessagingHosts\com.devspace.gem',
    'Software\Microsoft\Edge\NativeMessagingHosts\com.devspace.gem',
    'Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.devspace.gem'
)

function Get-DsgDataDir {
    if ($env:DEVSPACE_GEM_HOME) { return [IO.Path]::GetFullPath($env:DEVSPACE_GEM_HOME) }
    return (Join-Path $env:USERPROFILE '.devspace-gem')
}

# WScript.Shell popup. Works from a hidden PowerShell started by wscript.exe.
# buttons: 0 OK, 1 OK/Cancel, 3 Yes/No/Cancel, 4 Yes/No. icon: 16 error, 32 question, 48 warning, 64 info.
# Returns 1 OK, 2 Cancel, 6 Yes, 7 No, -1 timed out.
function Show-DsgPopup([string]$Message, [int]$Icon = 64, [int]$TimeoutSeconds = 0, [int]$Buttons = 0) {
    $shell = New-Object -ComObject WScript.Shell
    return [int]$shell.Popup($Message, $TimeoutSeconds, $script:DsgTitle, $Icon + $Buttons)
}

function Find-DsgChrome {
    foreach ($hive in 'HKCU:', 'HKLM:') {
        $key = "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
        try {
            $p = (Get-ItemProperty -LiteralPath $key -ErrorAction Stop).'(default)'
            if ($p) { $p = $p.Trim('"'); if (Test-Path -LiteralPath $p) { return $p } }
        } catch { }
    }
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
    foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
    return $null
}

# Returns $null when the Chrome native host registration looks healthy, else a Korean problem description.
function Test-DsgHostRegistration {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($script:DsgHostKeys[0])
    if (-not $key) {
        return "Chrome에 네이티브 호스트($script:DsgHostName)가 등록되어 있지 않습니다.`n(HKCU\$($script:DsgHostKeys[0]) 없음)"
    }
    try { $manifest = [string]$key.GetValue('') } finally { $key.Close() }
    if (-not $manifest -or -not (Test-Path -LiteralPath $manifest)) {
        return "레지스트리는 있지만 호스트 매니페스트 파일이 없습니다:`n$manifest"
    }
    try {
        $json = [IO.File]::ReadAllText($manifest) | ConvertFrom-Json
    } catch {
        return "호스트 매니페스트를 읽을 수 없습니다:`n$manifest`n$($_.Exception.Message)"
    }
    if (-not $json.path -or -not (Test-Path -LiteralPath $json.path)) {
        return "호스트 매니페스트가 가리키는 실행 파일이 없습니다:`n$($json.path)"
    }
    return $null
}

function Open-DsgSite([string]$Url) {
    try {
        $problem = Test-DsgHostRegistration
        if ($problem) {
            $msg = "$problem`n`n이 상태에서는 확장 프로그램이 로컬 PC에 연결할 수 없습니다.`n`n" +
                   "예: 설치 스크립트 실행`n아니요: 그래도 사이트 열기`n취소: 아무것도 하지 않기"
            $answer = Show-DsgPopup $msg 48 0 3
            if ($answer -eq 6) {
                $install = Join-Path $script:DsgRoot 'install\install.ps1'
                Start-Process -FilePath 'powershell.exe' -ArgumentList @(
                    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', "`"$install`"")
                return
            }
            if ($answer -ne 7) { return }
        }
        $chrome = Find-DsgChrome
        if ($chrome) {
            Start-Process -FilePath $chrome -ArgumentList @("`"$Url`"")
        } else {
            [void](Show-DsgPopup "Chrome을 찾지 못해 기본 브라우저로 엽니다.`nGemInWeb 확장 프로그램은 Chrome 계열 브라우저에서만 동작합니다." 48 8)
            Start-Process -FilePath $Url
        }
    } catch {
        [void](Show-DsgPopup "사이트를 열지 못했습니다.`n`n$($_.Exception.Message)" 16)
        exit 1
    }
}
