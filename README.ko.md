# GemInWeb

[English](README.md) | 한국어

**Google AI Studio**(`aistudio.google.com`)와 **Gemini 웹**(`gemini.google.com`)이 내 PC의
파일과 셸을 직접 다루게 해 주는 Chrome 확장 프로그램 + 로컬 호스트입니다.
[DevSpace](https://github.com/Waishnav/devspace)가 ChatGPT에 MCP로 해 주는 일을,
MCP 커넥터를 지원하지 않는 Google 사이트에서 하도록 만든 것입니다.

동작 방식: 모델이 답변에 ` ```devspace ` 코드 블록으로 도구 호출을 쓰면, 확장 프로그램이
그 블록을 읽어 로컬 호스트에서 실행하고, 결과를 입력창에 넣어 자동으로 보냅니다.
모델이 도구 호출 없이 답하면 작업이 끝난 것입니다.

### 기존 브리지(`devspace` 의 gemini-web-bridge)와 다른 점

| | 기존 브리지 | GemInWeb |
| --- | --- | --- |
| 연결 | `localhost:7677` HTTP 서버 (CORS `*`) — 아무 웹페이지나 `/execute` 를 호출할 수 있었음 | Chrome **네이티브 메시징**. 기본 모드에서는 **열린 포트가 없음** |
| 페어링 | 없음 | 확장 프로그램 ID를 고정(`ekplpihmkdcielcfideebgocdkajifcc`)하고, 호스트 매니페스트의 `allowed_origins` 에 그 ID만 허용 |
| 호출 인식 | 페이지의 모든 `pre/code` (내가 붙여넣은 지침 포함) | **모델 턴만**, 사고(thinking) 영역 제외, 최신 턴만 |
| 중복/재실행 | 같은 호출은 두 번 다시 실행 불가, 새로고침하면 과거 호출 전부 재실행 | 켤 때 기존 턴을 모두 "본 것"으로 표시. 과거 호출은 절대 실행하지 않음 |
| UI | 없음 | 사이트 오른쪽 아래 패널 (상태, 작업 폴더, 승인 카드, 활동 로그, 중지) |
| 서버 실행 | 바로가기로 서버를 띄워 두어야 함 | Chrome 이 필요할 때 호스트를 직접 실행 (서버 상주 불필요) |

## 요구 사항

- Windows 10/11, Chrome (Edge/Brave/Chromium 도 레지스트리는 등록됨)
- Node.js 18 이상 (권장 20+). npm 패키지 설치는 필요 없습니다 (런타임 의존성 0개).
- 선택: [Git for Windows](https://git-scm.com/) — 있으면 셸 명령이 Git Bash로 실행됩니다. 없으면 PowerShell.

## 빠른 시작

1. **설치** — PowerShell에서:
   ```powershell
   cd C:\Users\<you>\devspace-gem
   powershell -NoProfile -ExecutionPolicy Bypass -File install\install.ps1
   ```
   (또는 `install\install.cmd` 더블클릭.) 먼저 확인만 하려면 `-DryRun` 을 붙이세요.
   여러 번 실행해도 안전합니다. Node를 다시 설치했거나 폴더를 옮겼으면 다시 실행하세요.
2. **확장 프로그램 로드** (처음 한 번):
   `chrome://extensions` → 오른쪽 위 **개발자 모드** 켜기 → **압축해제된 확장 프로그램 로드**
   → `devspace-gem\extension` 폴더 선택. 표시된 ID가 `ekplpihmkdcielcfideebgocdkajifcc` 인지 확인.
3. **사이트 열기** — 바탕화면 **GemInWeb - AI Studio** 또는 **GemInWeb - Gemini**.
4. **패널** — 페이지 오른쪽 아래 GemInWeb 패널의 상태 점이 연결됨(초록)인지 확인.
5. **작업 폴더** — 패널의 **변경** 으로 작업할 폴더 지정 (예: `C:\Users\<you>\projects\my-app`).
6. **작업 시작** — 할 일을 적고 **작업 시작**. 프로토콜 안내(primer) + 작업이 함께 전송되고,
   이 탭의 에이전트가 켜집니다. 이후 모델의 도구 호출 → 실행 → 결과 전송이 자동으로 반복됩니다.

에이전트가 켜진 대화는 기억되므로, 같은 대화를 다시 열면 이어서 동작합니다.

## Gem / 시스템 지침 만들기 (권장)

매 대화마다 긴 프로토콜 안내를 보내지 않으려면, 안내를 Gem 이나 AI Studio 시스템 지침에
한 번 넣어 두고 확장 옵션의 **primerMode 를 `context`** 로 바꾸세요. 그러면 작업 시작 시
작업 폴더 같은 짧은 컨텍스트 블록만 보냅니다.

- **Gemini Gem**: gemini.google.com → 사이드바 **Gem 관리자** → **새 Gem** → 이름(예: DevSpace)
  → **지침** 칸에 [`gem/GEM_INSTRUCTIONS.md`](gem/GEM_INSTRUCTIONS.md) 내용을 그대로 붙여넣기 → 저장.
  이후 그 Gem 으로 대화를 시작합니다. (파일이 없으면 `node scripts/gen-gem.mjs` 로 생성.)
- **AI Studio**: 채팅의 **System instructions** 에 같은 내용을 붙여넣거나, 패널의
  **시스템 지침에 넣기** 버튼을 누르세요. 패널의 **지침 복사** 는 전체 안내를 클립보드에 복사합니다.
- 확장 아이콘 우클릭 → **옵션** → primerMode `context` 저장.

Gem/시스템 지침 없이 쓸 때는 primerMode 를 기본값 `full` 로 두세요.

## 도구

경로는 작업 폴더 기준 상대 경로, 또는 `allowedRoots` 안의 절대 경로.

| 도구 | 인자 | 변경 | 별칭 |
| --- | --- | --- | --- |
| `open_workspace` | `path` | | `open`, `cd` |
| `list_dir` | `path?="."`, `depth?=1` (최대 4), `all?` | | `ls`, `list` |
| `find_files` | `pattern` (`**/*.ts` 또는 부분 문자열), `path?` | | `glob`, `find` |
| `read_file` | `path`, `offset?`, `limit?` | | `read`, `cat`, `view` |
| `write_file` | `path`, `content` | ✔ | `write`, `create_file` |
| `edit_file` | `path`, `edits: [{old_text, new_text, replace_all?}]` | ✔ | `edit`, `str_replace` |
| `apply_patch` | `patch` (Codex `*** Begin Patch` 형식) | ✔ | `patch` |
| `run_shell` | `command`, `timeout?`(초), `cwd?`, `shell?` (`bash`/`powershell`), `background?` | ✔ | `bash`, `shell`, `exec`, `run`, `powershell` |
| `search` | `query`, `path?`, `regex?`, `case_sensitive?`, `glob?`, `max_results?` | | `grep`, `rg` |
| `show_changes` | `path?` | | `git_diff`, `diff`, `git_status` |
| `fetch_url` | `url`, `max_chars?` | | `fetch`, `open_url` |

`list_dir`/`find_files`/`search` 는 `.git`, `node_modules`, `dist`, `build` 등을 기본으로 건너뜁니다.

## 호출 형식

모델은 ` ```devspace ` 블록을 쓰고 **멈춰서 결과를 기다립니다**. 두 가지 형식이 있습니다.

**JSON 형식** (모든 도구):
````text
```devspace
{"tool": "read_file", "args": {"path": "src/app.ts", "offset": 1, "limit": 200}}
```
````

**헤더 형식** (JSON 이스케이프가 필요 없음 — 파일 내용, 패치, 스크립트에 적합).
`---` 위는 `키: 값` 인자, 아래는 본문(write_file→content, apply_patch→patch, run_shell→command):
````text
```devspace
tool: write_file
path: src/hello.py
---
print("hi")
```
````

`edit_file` 의 본문은 SEARCH/REPLACE 블록:
````text
```devspace
tool: edit_file
path: src/hello.py
---
<<<<<<< SEARCH
print("hi")
=======
print("hello")
>>>>>>> REPLACE
```
````

본문에 ```` ``` ```` 가 들어 있으면 더 긴 펜스(` ````devspace `)를 씁니다. 결과는
`[DevSpace result 1/2] read_file path=src/app.ts — ok (15 ms)` 같은 머리글과 함께 돌아갑니다.

## 승인 모드

패널에서 바꿀 수 있습니다. 승인 카드: **승인 / 거부 / 이 탭에서 모두 자동 승인**.

| 모드 | 동작 |
| --- | --- |
| `auto` | 모두 자동 실행 |
| `ask_shell` (기본) | `run_shell`, `fetch_url`, `.git` 폴더 안 쓰기만 클릭 필요 |
| `ask_mutating` | 위 항목 + `write_file`, `edit_file`, `apply_patch` 클릭 필요 |
| `read_only` | 변경 도구와 `fetch_url` 은 자동 거부 |

6000자가 넘는 명령은 전체 내용을 펼쳐 봐야 승인 버튼이 켜집니다. 승인 상태는 확장 내부
저장소에 있고 패널은 스크립트 클릭을 무시하므로, 페이지나 다른 확장이 대신 승인할 수 없습니다.

## 설정

**확장 옵션** (`chrome.storage.local["dsg.settings"]`):

| 키 | 기본값 | 설명 |
| --- | --- | --- |
| `transport` | `native` | `native` 또는 `http` (아래 HTTP 대체 모드) |
| `httpUrl` / `httpToken` | `http://127.0.0.1:7679` / 빈 값 | HTTP 모드 주소와 토큰 |
| `approval` | `ask_shell` | 승인 모드 |
| `maxSteps` | 25 | 사용자 입력 없이 자동으로 주고받는 최대 횟수. 넘으면 **계속** 버튼으로 일시정지 |
| `maxCallsPerTurn` | 6 | 한 모델 턴에서 실행할 최대 호출 수 |
| `maxMessageChars` | gemini 24000 / aistudio 80000 | 결과 메시지 최대 길이 (넘으면 출력 비율대로 잘림) |
| `primerMode` | `full` | `full` = 전체 안내 전송, `context` = Gem/시스템 지침 사용 시 짧은 컨텍스트만 |
| `autoSend` | `true` | 결과를 자동 전송할지 (끄면 입력창에만 넣음) |

**호스트 설정** `%USERPROFILE%\.devspace-gem\config.json` (첫 실행 시 기본값으로 생성):

| 키 | 기본값 | 설명 |
| --- | --- | --- |
| `allowedRoots` | `["~"]` | 파일 도구가 접근할 수 있는 폴더 (심볼릭 링크/정션 탈출 차단) |
| `defaultWorkspace` | `"~"` | 작업 폴더 미지정 시 |
| `shell` / `bashPath` | `"auto"` / `null` | auto = Git Bash 있으면 bash, 없으면 PowerShell |
| `commandTimeoutSec` / `maxCommandTimeoutSec` | 120 / 1800 | 명령 시간 제한 |
| `maxOutputChars` / `readMaxLines` | 30000 / 2000 | 출력 상한 |
| `http.port` | 7679 | HTTP 대체 모드 포트 |
| `blockedCommands` | `[]` | 정규식 목록. 일치하는 `run_shell` 명령은 거부 |

예: 프로젝트 폴더만 허용하려면 `"allowedRoots": ["C:\\Users\\<you>\\projects"]`.
환경 변수 `DEVSPACE_GEM_HOME` 으로 데이터 폴더를 바꿀 수 있습니다.

## HTTP 대체 모드

네이티브 메시징을 쓸 수 없는 환경(정책으로 차단 등)용입니다. 기본은 끄는 것을 권장합니다.

1. 터미널에서 `npm run start:http` (127.0.0.1:7679 에만 바인딩). 시작할 때 토큰이 출력되며
   `%USERPROFILE%\.devspace-gem\http-token` 에도 저장됩니다.
2. 확장 옵션 → transport `http`, httpToken 에 토큰 붙여넣기 → 저장.
3. 끝나면 터미널에서 Ctrl+C 또는 **GemInWeb 끄기**.

## 바로가기와 스크립트

| 파일 | 하는 일 |
| --- | --- |
| `install\install.ps1` (`-DryRun`, `-NoShortcuts`, `-NoPrompt`, `-SkipSelftest`, `-NodePath`) | 설치 / 재설치 |
| `install\uninstall.ps1` (`-DryRun`, `-Purge`) | 제거. `-Purge` 는 설정·토큰·로그 폴더까지 삭제 |
| 바탕화면 **GemInWeb - AI Studio** / **- Gemini** | 호스트 등록 확인 후 Chrome 으로 새 채팅 열기 (`launch\open-*.vbs`) |
| 바탕화면 **GemInWeb 끄기** | 호스트·HTTP 서버 node 프로세스와 그 하위 프로세스(실행 중인 명령) 모두 종료 (`launch\stop.vbs`) |

`.vbs` 는 콘솔 창 없이 PowerShell 스크립트를 실행하기 위한 래퍼입니다.

## 문제 해결

**로그 보기**
```powershell
Get-Content "$env:USERPROFILE\.devspace-gem\logs\host.log" -Tail 50 -Wait
```
확장 쪽 로그: `chrome://extensions` → GemInWeb → **서비스 워커** 링크 → 콘솔.
호스트 단독 점검: `node host\native-host.mjs --selftest` (상태 JSON 이 출력되면 정상).

**"Specified native messaging host not found" / 패널이 연결 안 됨**
- `install\install.ps1` 을 실행했는지 확인. 확인:
  `reg query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.devspace.gem"`
- 값이 가리키는 `com.devspace.gem.json` 이 있고, 그 안의 `path` (`host\native-host.cmd`) 가 있는지 확인.
- 프로젝트 폴더를 옮겼거나 Node 를 다시 설치했으면 install 을 다시 실행.
- 그 다음 `chrome://extensions` 에서 확장 새로고침(↻), 사이트 탭도 새로고침.

**"Access to the specified native messaging host is forbidden" (확장 ID 불일치)**
- `chrome://extensions` 의 ID 가 `ekplpihmkdcielcfideebgocdkajifcc` 가 아니면
  `extension\manifest.json` 의 `key` 가 빠졌거나 바뀐 것입니다. 이 저장소의 `extension` 폴더를
  그대로 로드하세요 (install 이 key 불일치를 경고합니다).

**"Native host has exited"**
- `node host\native-host.mjs --selftest` 와 host.log 확인. `host\native-host.cmd` 의 node 경로가
  실제로 있는지 확인 (nvm 으로 버전을 바꾸면 경로가 달라질 수 있음 → install 재실행).

**Gemini 가 도구를 호출하지 않음 / 결과를 지어냄**
- 패널의 에이전트가 **ON** 인지, **작업 시작** 으로 안내를 보냈는지 확인 (primerMode `context` 인데
  Gem/시스템 지침이 없는 대화면 모델은 프로토콜을 모릅니다).
- 일반 대화에서 "devspace 블록으로 도구를 호출해서 진행해" 라고 한 번 더 말하면 대개 이어갑니다.
- 에이전트를 켜기 전의 기존 턴은 의도적으로 실행하지 않습니다. 새 답변부터 처리됩니다.
- 모델이 결과를 스스로 지어내면 새 대화에서 Gem 을 사용하세요 (지침이 시스템 수준이라 더 잘 지킵니다).

**자동 전송 실패 ("전송되지 않았습니다")**
- 결과 텍스트는 입력창에 남아 있으니 직접 Enter/전송을 누르세요.
- 계속 실패하면 사이트 UI 가 바뀐 것입니다 (`extension/content/selectors.js`). 옵션에서
  `autoSend` 를 끄고 수동으로 보내며 쓸 수 있습니다.

**명령이 멈춤 / 프로세스가 남음** — 패널 **중지** (진행 중인 호출 취소) 또는 바탕화면 **GemInWeb 끄기**.

**스크립트 실행이 차단됨 (실행 정책)** — `install\install.cmd` 를 쓰거나
`powershell -ExecutionPolicy Bypass -File ...` 로 실행하세요.

## 보안 모델

- **기본 모드에는 네트워크 포트가 없습니다.** 호스트는 Chrome 이 네이티브 메시징(stdin/stdout)으로만
  실행하며, 매니페스트의 `allowed_origins` 에 고정 ID 확장 하나만 등록됩니다. 웹페이지는 호스트에
  직접 접근할 수 없습니다.
- 확장은 `aistudio.google.com`, `gemini.google.com` 에서만 동작하고, **모델 턴**의 최신 답변만
  해석합니다. 사용자 메시지, 사고 영역, 켜기 전의 과거 턴은 실행하지 않습니다.
- 파일 도구는 `allowedRoots` 안으로 제한됩니다 (realpath 검사로 심볼릭 링크/정션 탈출 차단).
- **보호 경로** (`config.json` 에서 바꿀 수 있음):
  - `protectedPaths` — 읽기·쓰기 모두 금지, 목록/검색에서도 숨김: `~/.devspace-gem`(토큰 포함),
    `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`, `~/.docker`,
    `~/.netrc`, `~/.git-credentials`, `~/.npmrc`, Chrome/Edge/Brave/Firefox 프로필, Windows 자격 증명 폴더.
  - `writeProtectedPaths` — 쓰기만 금지: GemInWeb 설치 폴더 자체, 시작프로그램 폴더,
    `~/.gitconfig`, `~/.config/git`. (그래서 **작업 폴더는 `devspace-gem` 밖**으로 잡으세요.)
- 파일 도구로는 `.git` 폴더 안에 쓸 수 없고, 내부 git 호출은 훅·fsmonitor·필터·외부 diff 를 끈 채
  실행됩니다 (저장소 설정에 심은 명령이 실행되지 않음).
- **`run_shell` 은 샌드박스가 아닙니다.** 명령은 내 Windows 계정 권한으로 무엇이든 할 수 있습니다.
  `blockedCommands` 는 실수 방지용일 뿐 보안 경계가 아닙니다. 모델이 읽은 파일이나
  `fetch_url` 로 가져온 웹페이지에 들어 있는 지시(프롬프트 인젝션)를 따를 수도 있으니,
  신뢰하지 않는 내용을 다룰 때는 `ask_mutating` 이나 `read_only` 를 쓰세요.
- 읽은 파일 내용과 명령 출력은 채팅 메시지로 **Google 에 전송됩니다.** 비밀 키, 개인 정보가 든
  파일을 읽히지 않도록 주의하세요.
- HTTP 대체 모드: `127.0.0.1` 에만 바인딩, `Authorization: Bearer <token>` 필수, `Host` 가
  `127.0.0.1`/`localhost` 가 아니면 거부(DNS 리바인딩 방지), `chrome-extension://` 이 아닌 `Origin`
  거부, CORS 헤더를 보내지 않음 (웹페이지가 응답을 읽을 수 없음).

## 구조

```
Gemini / AI Studio 페이지
  └─ content scripts  extension/content/*      모델 턴 읽기, ```devspace 블록 찾기,
       │                                        결과 입력 + 전송, 패널 UI
       │  chrome.runtime.sendMessage
       ▼
  background service worker  extension/background.js
       │  chrome.runtime.connectNative("com.devspace.gem")      ← 기본
       │  또는 fetch http://127.0.0.1:7679/rpc (Bearer 토큰)     ← 대체
       ▼
  host/native-host.cmd → node host/native-host.mjs   |   node server/http-server.mjs
       ▼
  core/engine.mjs → 도구 (fs, shell, search, patch, fetch)
```

| 경로 | 내용 |
| --- | --- |
| `core/` | 도구 엔진, 경로 검사, 셸 실행, primer 생성, apply-patch |
| `host/` | 네이티브 메시징 호스트 (`native-host.cmd` 는 install 이 생성) |
| `server/` | HTTP 대체 서버 |
| `extension/` | MV3 확장 (content scripts, background, options) |
| `gem/GEM_INSTRUCTIONS.md` | Gem / 시스템 지침용 안내문 (`scripts/gen-gem.mjs` 로 생성) |
| `install/`, `launch/` | 설치/제거, 바로가기, 실행/종료 스크립트 |
| `docs/SPEC.md` | 프로토콜과 구성 요소 간 계약 |

테스트: `node --test "test/**/*.test.mjs"`

## 제거

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\uninstall.ps1          # 설정/로그는 유지
powershell -NoProfile -ExecutionPolicy Bypass -File install\uninstall.ps1 -Purge   # 모두 삭제
```
그 다음 `chrome://extensions` 에서 GemInWeb 을 삭제하세요.

## 크레딧 / 라이선스

- [Waishnav/devspace](https://github.com/Waishnav/devspace) (MIT) — 도구 설계와 아이디어의 출처.
  `core/apply-patch` 는 devspace 의 `src/apply-patch.ts` 를 포팅한 것입니다.
- 이 프로젝트: MIT, [LICENSE](LICENSE) 참고.
