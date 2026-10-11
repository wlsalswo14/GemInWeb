<#
.SYNOPSIS
  GemInWeb 설치: Chrome 네이티브 메시징 호스트 등록 + 바탕화면 바로가기.

.DESCRIPTION
  여러 번 실행해도 안전합니다(idempotent). 바뀐 파일/레지스트리 값만 다시 씁니다.
    1. extension-key.json 의 key 로 확장 프로그램 ID 계산, id 필드와 일치하는지 확인
    2. node.exe 찾기 (Chrome 이 띄우는 프로세스는 PATH 가 다를 수 있어 절대 경로로 고정)
    3. node host\native-host.mjs --selftest  (config.json 이 없으면 기본값으로 생성됨)
    4. host\native-host.cmd 생성
    5. %USERPROFILE%\.devspace-gem\com.devspace.gem.json (호스트 매니페스트, UTF-8 BOM 없음)
    6. HKCU 에 Chrome / Chromium / Edge / Brave NativeMessagingHosts 등록
    7. 바탕화면 바로가기 (launch\create-shortcuts.ps1)
    8. 확장 프로그램 로드 안내

.PARAMETER DryRun
  할 일을 모두 출력만 하고 아무것도 바꾸지 않습니다.
.PARAMETER NoShortcuts
  바탕화면 바로가기를 만들지 않습니다.
.PARAMETER NoPrompt
  마지막의 "폴더 열기" 질문을 하지 않습니다.
.PARAMETER SkipSelftest
  native-host.mjs --selftest 를 건너뜁니다.
.PARAMETER NodePath
  사용할 node.exe 경로를 직접 지정합니다.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install\install.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install\install.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$NoShortcuts,
    [switch]$NoPrompt,
    [switch]$SkipSelftest,
    [string]$NodePath
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$Root         = $script:DsgRoot
$DataDir      = Get-DsgDataDir
$HostScript   = Join-Path $Root 'host\native-host.mjs'
$HostCmd      = Join-Path $Root 'host\native-host.cmd'
$ManifestPath = Join-Path $DataDir "$($script:DsgHostName).json"
$ExtDir       = Join-Path $Root 'extension'

try {
    Write-Host "GemInWeb 설치$(if ($DryRun) { ' (DRY RUN: 아무것도 바꾸지 않습니다)' })" -ForegroundColor Cyan
    Write-Info "프로젝트 폴더: $Root"
    Write-Info "데이터 폴더:   $DataDir"

    # 1. Extension ID ---------------------------------------------------------
    Write-Section '1/7 확장 프로그램 ID'
    $keyFile = Join-Path $PSScriptRoot 'extension-key.json'
    $keyJson = [IO.File]::ReadAllText($keyFile) | ConvertFrom-Json
    $ExtId = Get-DsgExtensionId $keyJson.key
    if ($ExtId -ne $keyJson.id) {
        throw "extension-key.json 의 key 로 계산한 ID($ExtId)가 id 필드($($keyJson.id))와 다릅니다."
    }
    Write-Info "ID: $ExtId (key 와 일치)"
    $extManifest = Join-Path $ExtDir 'manifest.json'
    if (Test-Path -LiteralPath $extManifest) {
        try {
            $m = [IO.File]::ReadAllText($extManifest) | ConvertFrom-Json
            $mKey = if ($m.PSObject.Properties['key']) { [string]$m.key } else { '' }
            if ($mKey -ne $keyJson.key) {
                Write-Warning "extension\manifest.json 의 key 가 extension-key.json 과 다릅니다. Chrome 에서 확장 ID 가 달라져 호스트 연결이 거부됩니다."
            } else {
                Write-Info "extension\manifest.json key 일치"
            }
        } catch {
            Write-Warning "extension\manifest.json 을 읽지 못했습니다: $($_.Exception.Message)"
        }
    } else {
        Write-Warning "extension\manifest.json 이 아직 없습니다. 확장 프로그램 로드 전에 확인하세요."
    }

    # 2. node.exe ---------------------------------------------------------------
    Write-Section '2/7 Node.js'
    $Node = Find-DsgNode $NodePath
    if (-not $Node) {
        throw "node.exe 를 찾지 못했습니다. Node.js 18 이상(권장 20+)을 설치하거나 -NodePath 로 지정하세요. https://nodejs.org/"
    }
    $ver = (Invoke-DsgCapture $Node @('-p', 'process.versions.node') 15).Stdout.Trim()
    $major = 0; [void][int]::TryParse(($ver -split '\.')[0], [ref]$major)
    if ($major -lt 18) { throw "Node.js $ver 는 너무 오래되었습니다. 18 이상이 필요합니다 ($Node)." }
    Write-Info "node.exe: $Node (v$ver)"

    # 3. Selftest -----------------------------------------------------------------
    Write-Section '3/7 호스트 자체 점검 (--selftest)'
    if ($SkipSelftest) {
        Write-Warning '-SkipSelftest: 건너뜀'
    } elseif (-not (Test-Path -LiteralPath $HostScript)) {
        Write-Warning "host\native-host.mjs 가 아직 없어 selftest 를 건너뜁니다: $HostScript"
    } elseif ($DryRun) {
        Write-Did "실행: `"$Node`" `"$HostScript`" --selftest  (config.json 을 만들 수 있어 dry-run 에서는 실행하지 않음)"
    } else {
        $r = Invoke-DsgCapture $Node @($HostScript, '--selftest') 60
        if ($r.ExitCode -ne 0) {
            if ($r.Stderr) { Write-Host $r.Stderr -ForegroundColor DarkGray }
            throw "selftest 실패 (exit $($r.ExitCode)). 로그: $(Join-Path $DataDir 'logs\host.log')"
        }
        $text = $r.Stdout.Trim()
        $status = $null
        try { $status = $text | ConvertFrom-Json } catch {
            $a = $text.IndexOf('{'); $b = $text.LastIndexOf('}')
            if ($a -ge 0 -and $b -gt $a) { try { $status = $text.Substring($a, $b - $a + 1) | ConvertFrom-Json } catch { } }
        }
        if ($status) {
            Write-Did 'selftest 통과'
            foreach ($prop in 'version', 'configPath', 'defaultWorkspace') {
                if ($status.PSObject.Properties[$prop]) { Write-Info ("{0,-17} {1}" -f $prop, $status.$prop) }
            }
            if ($status.PSObject.Properties['allowedRoots']) { Write-Info ("{0,-17} {1}" -f 'allowedRoots', (@($status.allowedRoots) -join '; ')) }
            if ($status.PSObject.Properties['shell'] -and $status.shell) { Write-Info ("{0,-17} {1} ({2})" -f 'shell', $status.shell.kind, $status.shell.path) }
        } else {
            Write-Warning "selftest 는 exit 0 이지만 출력이 JSON 이 아닙니다:`n$text"
        }
    }

    # 4. native-host.cmd ------------------------------------------------------------
    Write-Section '4/7 host\native-host.cmd'
    $cmdText = "@echo off`r`n`"$Node`" `"%~dp0native-host.mjs`" %*`r`n"
    $oem = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
    Write-DsgFile $HostCmd $cmdText $oem 'native-host.cmd'

    # 5. Host manifest ------------------------------------------------------------
    Write-Section '5/7 네이티브 호스트 매니페스트'
    $manifest = "{`n" +
        "  `"name`": $(ConvertTo-JsonString $script:DsgHostName),`n" +
        "  `"description`": $(ConvertTo-JsonString 'GemInWeb native host (local files + shell for AI Studio / Gemini)'),`n" +
        "  `"path`": $(ConvertTo-JsonString $HostCmd),`n" +
        "  `"type`": `"stdio`",`n" +
        "  `"allowed_origins`": [`n" +
        "    $(ConvertTo-JsonString "chrome-extension://$ExtId/")`n" +
        "  ]`n" +
        "}`n"
    Write-DsgFile $ManifestPath $manifest $script:Utf8NoBom 'host manifest'
    if (-not $DryRun) { [void]([IO.File]::ReadAllText($ManifestPath) | ConvertFrom-Json) }   # sanity: valid JSON

    # 6. Registry -------------------------------------------------------------------
    Write-Section '6/7 레지스트리 (HKCU NativeMessagingHosts)'
    foreach ($sub in $script:DsgHostKeys) {
        $current = $null
        $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sub)
        if ($k) { try { $current = $k.GetValue('') } finally { $k.Close() } }
        if ($current -eq $ManifestPath) { Write-Info "(변경 없음) HKCU\$sub"; continue }
        if (-not $DryRun) {
            $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($sub)
            try { $k.SetValue('', $ManifestPath, [Microsoft.Win32.RegistryValueKind]::String) } finally { $k.Close() }
        }
        Write-Did "HKCU\$sub = $ManifestPath"
    }

    # 7. Shortcuts --------------------------------------------------------------------
    Write-Section '7/7 바탕화면 바로가기'
    if ($NoShortcuts) {
        Write-Info '-NoShortcuts: 건너뜀'
    } else {
        & (Join-Path $Root 'launch\create-shortcuts.ps1') -DryRun:$DryRun
    }

    # Next steps ------------------------------------------------------------------
    Write-Host ''
    if ($DryRun) {
        Write-Host 'DRY RUN 완료: 실제로 바뀐 것은 없습니다. -DryRun 없이 다시 실행하면 위 작업을 수행합니다.' -ForegroundColor Yellow
    } else {
        Write-Host '설치 완료.' -ForegroundColor Green
    }
    Write-Host ''
    Write-Host '다음 단계 (확장 프로그램은 한 번만 로드하면 됩니다):' -ForegroundColor Cyan
    Write-Host '  1. Chrome 주소창에 chrome://extensions 입력'
    Write-Host '  2. 오른쪽 위 "개발자 모드" 켜기'
    Write-Host '  3. "압축해제된 확장 프로그램 로드" 클릭 → 아래 폴더 선택'
    Write-Host "       $ExtDir" -ForegroundColor White
    Write-Host "  4. 로드된 확장의 ID 가 $ExtId 인지 확인"
    Write-Host '  5. 바탕화면 "GemInWeb - AI Studio" 또는 "GemInWeb - Gemini" 실행'
    Write-Host '     → 오른쪽 아래 패널에서 작업 폴더 지정 → 작업 시작'
    Write-Host '  (이미 로드되어 있다면 chrome://extensions 에서 새로고침(↻)만 누르세요.)'
    Write-Host ''

    $interactive = -not $NoPrompt -and -not $DryRun -and [Environment]::UserInteractive -and
        -not [Console]::IsInputRedirected -and
        -not ([Environment]::GetCommandLineArgs() | Where-Object { $_ -like '-NonI*' })
    if ($interactive) {
        $ans = Read-Host '확장 프로그램 폴더를 탐색기로 열고 경로를 클립보드에 복사할까요? [Y/n]'
        if ($ans -eq '' -or $ans -match '^(y|yes|ㅛ|예|네)$') {
            try { Set-Clipboard -Value $ExtDir; Write-Info "클립보드에 복사됨: $ExtDir" } catch { }
            Start-Process -FilePath 'explorer.exe' -ArgumentList @("`"$ExtDir`"")
            $chrome = Find-DsgChrome
            if ($chrome) { Start-Process -FilePath $chrome -ArgumentList @('chrome://extensions') }
        }
    }
    exit 0
} catch {
    Write-Host ''
    Write-Host "설치 실패: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
