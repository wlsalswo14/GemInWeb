# GemInWeb — build spec (shared contract)

GemInWeb lets **Google AI Studio** (`aistudio.google.com`) and **Gemini web**
(`gemini.google.com`) drive the user's local machine (files + shell), the way
[DevSpace](https://github.com/Waishnav/devspace) (MIT) lets ChatGPT do it over MCP.
Neither Google site supports custom MCP connectors, so the bridge is:

```
Gemini / AI Studio page
  └─ content scripts (extension/content/*)      read model turns, find ```devspace blocks,
       │  chrome.runtime.sendMessage              type results back, press Send
       ▼
  background service worker (extension/background.js)
       │  chrome.runtime.connectNative("com.devspace.gem")     ← default transport
       │  or fetch http://127.0.0.1:7679/rpc (Bearer token)     ← fallback transport
       ▼
  native host  host/native-host.mjs   /   HTTP server  server/http-server.mjs
       ▼
  core engine  core/engine.mjs  →  tools (fs, shell, search, patch, fetch)
```

Reference checkout of upstream DevSpace (read-only, do not edit):
a local clone of https://github.com/Waishnav/devspace (`src/apply-patch.ts`,
`src/roots.ts`, `src/workspaces.ts`, `src/pi-tools.ts`, `src/process-platform.ts`).
Its `src/bridge-api.ts` + `extensions/gemini-web-bridge/` are a previous attempt
that **never executed a single tool** (only `/status` hits in its log). Known
defects to avoid: any web page could POST `/execute` (CORS `origin || "*"` +
credentials = drive-by RCE); tool calls were scraped from *every* `pre/code` incl.
the user's own pasted instructions; a global signature set meant the same call
could never run twice, while a reload re-ran every historic call; no UI.

Project root: the repo root (git repo, Node 24 on PATH,
Windows 11, Git Bash at `C:\Program Files\Git\bin\bash.exe`, `rg` NOT on PATH
for Chrome-launched processes). **Zero npm dependencies** for runtime code.

## Ownership (do not write files you don't own)

| Path | Owner |
| --- | --- |
| `package.json`, `core/**`, `host/native-host.mjs`, `server/**`, `scripts/gen-gem.mjs`, `gem/GEM_INSTRUCTIONS.md` (generated), `test/core/**` | **A (core)** |
| `extension/**` except `extension/content/selectors.js`; `test/extension/**` | **B (extension)** |
| `extension/content/selectors.js`, `docs/dom-research.md`, `test/fixtures/**` | **C (DOM research)** |
| `install/**` (except `install/extension-key.json`, read-only), `launch/**`, `README.md`, `LICENSE` | **D (install/docs)** |
| `docs/SPEC.md`, `.gitignore` | orchestrator |

Tests: `node --test "test/**/*.test.mjs"` (Node built-in runner, no deps).

## Fixed identifiers

- Extension ID: `ekplpihmkdcielcfideebgocdkajifcc` — pinned by the public `key`
  in `install/extension-key.json`; `extension/manifest.json` must carry that
  exact `key`.
- Native host name: `com.devspace.gem`
- HTTP fallback: `127.0.0.1:7679` (env `DEVSPACE_GEM_PORT`)
- Data dir: `%USERPROFILE%\.devspace-gem\` (env `DEVSPACE_GEM_HOME` overrides):
  `config.json`, `http-token`, `logs\host.log`, `logs\bg-<pid>.log`,
  `com.devspace.gem.json` (host manifest written by installer).
- Protocol marker (first line of the full primer): `[GemInWeb protocol v1]`

## config.json (core creates it with defaults when missing)

```jsonc
{
  "allowedRoots": ["~"],          // every file path must resolve inside one of these
  "defaultWorkspace": "~",        // used when a request carries no workspace
  "shell": "auto",                // "auto" | "bash" | "powershell"; auto = Git Bash on Windows if found, else powershell
  "bashPath": null,
  "commandTimeoutSec": 120,
  "maxCommandTimeoutSec": 1800,
  "maxOutputChars": 30000,        // cap on a single tool output returned by core
  "readMaxLines": 2000,
  "http": { "port": 7679 },
  "blockedCommands": [],          // regex strings; matching run_shell commands are refused
  "protectedPaths": [             // no read AND no write (see "Path policy")
    "$DATA_DIR", "~/.ssh", "~/.gnupg", "~/.aws", "~/.azure", "~/.config/gcloud", "~/.kube",
    "~/.docker", "~/.netrc", "~/.git-credentials", "~/.npmrc",
    "~/AppData/Local/Google/Chrome/User Data", "~/AppData/Local/Microsoft/Edge/User Data",
    "~/AppData/Local/BraveSoftware/Brave-Browser/User Data", "~/AppData/Roaming/Mozilla/Firefox",
    "~/AppData/Roaming/Microsoft/Credentials", "~/AppData/Local/Microsoft/Credentials",
    "~/AppData/Roaming/Microsoft/Protect"
  ],
  "writeProtectedPaths": [        // readable, but file tools may not write
    "$INSTALL_DIR", "~/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup",
    "~/.gitconfig", "~/.config/git"
  ]
}
```
`~` expands to the home dir. Paths compare case-insensitively on Windows.
Symlink/junction escapes are blocked by realpath-checking the nearest existing ancestor;
a path component that exists only as a dangling symlink/junction is followed through its
link target (so a write through it is checked where it would land).

### Path policy (protected paths)

- `protectedPaths` entries (and everything below them) can be neither read nor written by
  any file tool: `read_file`, `list_dir`, `find_files`, `search`, `write_file`,
  `edit_file`, `apply_patch`, `show_changes path`, `open_workspace` (and as a request
  workspace), and `run_shell` `cwd`. Listings and searches skip protected subtrees silently;
  the context files read by `open_workspace` / the primer (`AGENTS.md` …) and files met
  through file symlinks during `search` are realpath-checked and skipped when outside the
  allowed roots or protected. Exception: `$DATA_DIR/logs/bg-<pid>.log` stays readable
  (background `run_shell` output).
- `writeProtectedPaths` entries are readable but refused for `write_file`, `edit_file` and
  `apply_patch` (any added, updated, deleted or moved-to path).
- Placeholders: `$DATA_DIR` = the data dir (incl. `http-token`, `config.json`),
  `$INSTALL_DIR` = the GemInWeb checkout (resolved from `core/`'s location); `~` = home.
  Both lexical and realpath forms are matched (junctions, 8.3 names).
- The user may edit or empty both lists. When an existing strict-JSON `config.json` lacks
  either key, core adds it with the defaults (other values untouched); a `config.json` with
  comments is never rewritten — the defaults then apply in memory only.
- `write_file` / `edit_file` / `apply_patch` refuse any target with a `.git` path segment
  (case-insensitive; on Windows also `.git.`, `.git::$…` aliases), including a `.git` file
  itself, with a hint to edit git internals via `run_shell` git commands. Reading is allowed.
- `run_shell` itself is not sandboxed (approval modes are the control); the policy only
  applies to its `cwd`.

## RPC envelope (identical over native messaging and HTTP)

Request: `{ "id": "<string>", "type": "<type>", ...fields }`
Response: `{ "id": "<same>", "ok": true, "result": {...} }` or
`{ "id": "<same>", "ok": false, "error": "<message>" }`.
`ok:false` = protocol failure (bad request, unknown type). A tool that ran but
failed is `ok:true` with `result.ok:false`.

| type | request fields | result |
| --- | --- | --- |
| `ping` | — | `{ pong: true, version }` |
| `status` | — | `{ version, platform, homeDir, configPath, allowedRoots: [abs], defaultWorkspace: abs, shell: { kind: "bash"\|"powershell", path } }` |
| `tools` | — | `{ tools: [{ name, description, mutating, bodyParam?, params: [{ name, type, required, description }] }] }` |
| `primer` | `site: "aistudio"\|"gemini"\|"generic"`, `mode: "full"\|"context"`, `workspace?` | `{ text, marker }` — `full` = protocol + tool docs + context block; `context` = only the short dynamic context block (for chats whose Gem / system instructions already hold the protocol) |
| `call` | `tool`, `args` (object), `workspace?` (abs path or null) | `{ ok, output, durationMs, truncated?, workspace?, cancelled? }` — `workspace` is set by `open_workspace` (validated absolute root) |
| `cancel` | `target` (id of an in-flight call) | `{ cancelled: boolean }`; the cancelled call resolves with `result.ok:false, cancelled:true` |

Native messaging framing: 4-byte little-endian length + UTF-8 JSON. Requests are
handled concurrently. Host→browser messages must stay < 1 MB: the host shrinks
`result.output` (marking `truncated:true`) if a serialized response exceeds
900 000 bytes. The host must **never write anything but frames to stdout**
(redirect `console.*` to the log file). It exits when stdin closes.
`node host/native-host.mjs --selftest` prints the `status` result as JSON to
stdout and exits 0 (installer uses it; it also creates config.json).

HTTP: `GET /health` → `{ ok: true, name: "devspace-gem", version }` (no auth).
`POST /rpc` (envelope in, envelope out) requires `Authorization: Bearer <token>`
(`http-token` file, 32 random bytes hex, created on first start, printed at
startup). Reject requests whose `Host` hostname is not `127.0.0.1`/`localhost`
(DNS rebinding) and whose `Origin` is present but not `chrome-extension://…`.
Send **no CORS headers** (extension service workers with host permissions don't
need them; web pages must not be able to read responses). Bind `127.0.0.1` only.

## Tools (canonical names; core and protocol parser both accept the aliases)

Relative paths resolve against the request's workspace root; absolute paths are
allowed when inside `allowedRoots`. Every tool returns plain text `output`.

| tool | args | mutating | bodyParam | aliases |
| --- | --- | --- | --- | --- |
| `open_workspace` | `path` | no | — | `open`, `cd` |
| `list_dir` | `path?="."`, `depth?=1` (max 4), `all?=false` | no | — | `ls`, `list` |
| `find_files` | `pattern` (glob like `**/*.ts` or plain substring), `path?` | no | — | `glob`, `find` |
| `read_file` | `path`, `offset?` (1-based line), `limit?` | no | — | `read`, `cat`, `view` |
| `write_file` | `path`, `content` | yes | `content` | `write`, `create_file` |
| `edit_file` | `path`, `edits: [{ old_text, new_text, replace_all? }]` (also accept `oldText/newText`, `old_string/new_string`, and single-edit shorthand at top level) | yes | `edits` (SEARCH/REPLACE body) | `edit`, `str_replace` |
| `apply_patch` | `patch` (Codex `*** Begin Patch` format, port of devspace `src/apply-patch.ts`) | yes | `patch` | `patch` |
| `run_shell` | `command`, `timeout?` (sec), `cwd?`, `shell?` (`bash`\|`powershell`), `background?` | yes | `command` | `bash`, `shell`, `exec`, `run`, `powershell` (→ shell=powershell) |
| `search` | `query`, `path?="."`, `regex?=false`, `case_sensitive?=false`, `glob?`, `max_results?=100` | no | — | `grep`, `rg` |
| `show_changes` | `path?` | no | — | `git_diff`, `diff`, `git_status` |
| `fetch_url` | `url`, `max_chars?=20000` | no | — | `fetch`, `open_url` |

Semantics (core):
- `open_workspace`: directory must exist inside allowedRoots. Output: root, git
  branch + short status (or "not a git repository"), top-level entries (≤ 60), and
  the content of `AGENTS.md` / `GEMINI.md` / `CLAUDE.md` at the root (≤ 8000 chars each).
- `list_dir` / `find_files` / `search` skip `.git node_modules dist build out .next
  .nuxt .venv venv __pycache__ .cache coverage target` unless `all`/explicit path.
  Caps: list 500 entries, find 200 paths, search `max_results` matches; skip binary
  files and files > 2 MB. `search` is pure JS (use `rg` only if found on PATH).
- `read_file`: `cat -n` style (`%6d\t<line>`), default limit `readMaxLines`, lines
  > 2000 chars cut, footer `(lines a-b of N — use offset to read more)` when partial;
  refuse binary.
- `write_file`: creates parent dirs; output `Wrote N lines (M bytes) to <path> (created|overwritten)`.
- `edit_file`: edits applied in order, all-or-nothing; each `old_text` must match
  exactly once unless `replace_all`; retry with LF/CRLF-normalized matching and keep
  the file's EOL style; on failure explain (not found / N matches) and show the
  closest lines. Output: summary + compact unified diff (≤ 80 lines).
- `run_shell`: Windows bash = Git Bash `bash.exe -c <command>`; powershell =
  `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`
  with UTF-8 output encoding forced. stdin ignored. Env adds `PAGER=cat GIT_PAGER=cat
  TERM=dumb NO_COLOR=1 PYTHONUTF8=1 PYTHONIOENCODING=utf-8`. Combined stdout/stderr
  in arrival order; decode UTF-8, fall back to cp949 (`euc-kr` TextDecoder) when that
  yields fewer U+FFFD. Timeout/cancel kills the whole tree (`taskkill /T /F` on
  Windows). Over-long output keeps head 40% + tail 60% with an omission marker.
  `background:true` detaches, logs to `logs/bg-<pid>.log`, returns pid + log path.
  Output layout:
  ```
  $ <command>
  [cwd: <dir> · shell: bash]
  <output>
  [exit 0 · 1.2s]
  ```
- Internal git calls (`open_workspace`, `show_changes`) never run repository-controlled
  commands: `-c core.fsmonitor=false -c core.hooksPath=<null device> -c diff.external=
  -c core.pager=cat -c safe.bareRepository=explicit --no-pager --no-optional-locks`, diffs with
  `--no-ext-diff --no-textconv --ignore-submodules=dirty`, env `GIT_CONFIG_NOSYSTEM=1
  GIT_TERMINAL_PROMPT=0` (inherited `GIT_DIR`/`GIT_CONFIG_*`/… dropped), and every configured
  filter driver (`git config --get-regexp ^filter\.`) is blanked (`clean/smudge/process` empty,
  `required=false`) via `GIT_CONFIG_COUNT/KEY/VALUE`. (Side effect: LFS files whose stat info
  changed may show as modified.)
- `apply_patch`: files are staged by realpath (case-insensitive on Windows), so
  `Delete File: readme.md` + `Add File: README.md` or a case-only `Move to` end with the
  new name and content; an update written through a differently-cased path keeps the on-disk
  name. A hunk with only `+` lines and no `@@ <context>` appends at EOF (with an `@@ <context>`
  anchor it inserts after that line). The original's final-newline state and EOL are kept.
- `show_changes`: `git status --short` + `git diff --stat` + `git diff` (+ list of
  untracked files), truncated.
- `fetch_url`: http(s) only, 20 s timeout, follows redirects; HTML → readable text
  (drop script/style/nav, decode entities, collapse whitespace); header line
  `HTTP <status> <final url> (<content-type>)`.

## Model-facing tool-call protocol (primer text ↔ extension parser)

The model calls tools by writing fenced code blocks tagged `devspace`. Two forms:

**JSON form** (any tool):
````
```devspace
{"tool": "read_file", "args": {"path": "src/app.ts", "offset": 1, "limit": 200}}
```
````
Parser also accepts `name`/`tool_name`/`function.name` for the tool,
`arguments`/`parameters`/`input` for args (object or JSON string), args placed at
the top level next to `tool`, a JSON array of calls, `//` comments, trailing commas,
and single backslashes in Windows paths (`C:\Users\x` → `C:\\Users\\x`).

**Header form** (no JSON escaping; best for file bodies, patches and scripts):
````
```devspace
tool: write_file
path: src/hello.py
---
print("hi")
```
````
Lines before a line that is exactly `---` are `key: value` args (values: `true`/
`false` → boolean, `^-?\d+$` → integer, else trimmed string). Everything after
`---` is the tool's `bodyParam` (write_file→content, apply_patch→patch,
run_shell→command). For `edit_file` the body is one or more Aider-style blocks:
```
<<<<<<< SEARCH
exact old text
=======
new text
>>>>>>> REPLACE
```
(marker lines: `^<{5,9} SEARCH\s*$`, `^={5,9}\s*$`, `^>{5,9} REPLACE\s*$`) →
`edits: [{ old_text, new_text }]`; a `replace_all: true` header applies to all.
If a body contains ``` the model must use a longer fence (````devspace).

Detection rule (extension): a block is a tool call if it parses in either form AND
its tool (after alias mapping) is a known tool — the fence language label is a hint,
not a requirement, because rendered DOM often drops it. Only **model** turns are
scanned, never user turns, and never the model's thinking/thought sections. If a
model turn has no `<pre>` blocks, a fallback scans its plain text for a balanced
`{"tool": ...}` JSON object.

Primer rules the model is told (A writes the wording in `core/primer.mjs`):
you really are connected; emit one or more devspace blocks then **stop and wait** —
never write results yourself; batch independent read-only calls, but put writes and
commands one per message unless they're independent; paths relative to the
workspace; Windows shell is Git Bash (POSIX) unless `shell: powershell`; when the
task is done answer normally with **no** devspace block; reply to the user in the
user's language. Keep the full primer ≤ 6000 chars.

**Result message** (extension → model, typed into the site's input and sent):
````
[DevSpace result 1/2] read_file path=src/app.ts — ok (15 ms)
```text
<output>
```
[DevSpace result 2/2] run_shell `npm test` — error (exit 1, 3.2 s)
```text
<output>
```
Continue the task: call more tools with ```devspace blocks, or answer normally (no devspace block) when the task is done.
````
Fence length must exceed the longest backtick run inside the output. Whole message
is capped per site (settings) by proportionally truncating outputs with a
`[… N chars truncated — narrow the request or use offset/limit …]` marker.

## Extension (B)

MV3, `manifest.json`: `key` from `install/extension-key.json`; permissions
`storage`, `nativeMessaging`, `clipboardWrite`; host_permissions
`https://aistudio.google.com/*`, `https://gemini.google.com/*`,
`http://127.0.0.1:7679/*`, `http://localhost:7679/*`; content_scripts on both sites,
`run_at: document_idle`, `all_frames: false`, js in this order:
`content/selectors.js`, `content/protocol.js`, `content/sites.js`, `content/rpc.js`,
`content/panel.js`, `content/agent.js`, `content/main.js` (classic scripts sharing
`globalThis.DSG`). Background service worker `background.js`. Options page.

`content/selectors.js` (owned by C) defines
`DSG.SELECTORS = { aistudio: {...}, gemini: {...} }`; each key holds an **ordered
array of CSS selectors** (first match wins; `:has()` allowed). Keys:
`input`, `sendButton`, `stopButton` (visible ⇒ generating), `generatingIndicator`
(extra signals, visible ⇒ generating), `turn` (all chat turns in document order),
`modelTurn` (matches a turn element that is a model turn — tested with
`el.matches()` or `el.querySelector()`), `userTurn`, `turnBody` (main rendered
content inside a model turn), `codeBlock` (the `pre`/`code` element whose
textContent is the raw code), `codeLanguage` (label element inside the code block
wrapper, optional), `exclude` (subtrees to ignore: thoughts, toolbars),
`turnComplete` (optional: element inside a model turn that only exists after the
turn finished), `systemInstructionsOpen` / `systemInstructionsInput` (AI Studio
only), plus `conversationIdFromUrl` (a RegExp string with one capture group). B's
code must only consume this shape and degrade gracefully when a key is missing.

`chrome.storage.local["dsg.settings"]` defaults:
```json
{ "transport": "native", "httpUrl": "http://127.0.0.1:7679", "httpToken": "",
  "approval": "ask_shell", "maxSteps": 25, "maxCallsPerTurn": 6,
  "maxMessageChars": { "gemini": 24000, "aistudio": 80000 },
  "primerMode": "full", "autoSend": true }
```
`approval`: `auto` | `ask_shell` (run_shell, fetch_url and any write into a `.git`
folder need a click) | `ask_mutating` (those plus write/edit/patch) | `read_only`
(mutating calls and fetch_url auto-denied). Approval card offers 승인 / 거부 /
"이 탭에서 모두 자동 승인"; commands over 6000 chars can only be approved after the
full text is expanded. The panel's shadow root is closed and it ignores untrusted
(scripted) events.

Per-conversation memory `chrome.storage.local["dsg.conv"]` = map
`"<site>:<conversation id or path>" → { workspace, primed, armed, updatedAt }` (≤ 200).
Tab agent ON/OFF and the tab's auto-approve flag live in the background's
`chrome.storage.session`, keyed by tab and site (never in page-writable storage);
they survive SPA navigation and reloads of the same tab; visiting an `armed`
conversation turns it ON. When a new chat (no id yet) gets its id after the first
send, state carries over only if the page shows the message we just sent (checked for
up to 4 s); otherwise the agent re-baselines and cancels. The baseline ends only on
our own confirmed send or a new user turn becoming the latest turn — a "generating"
flicker never ends it.

Safety rules for the loop: arming (turning ON, page load, conversation switch)
first **baselines** every existing model turn as seen — historic tool calls are
never executed. A model turn is processed once (key = turn element/id + hash of
its calls); a re-generated turn with different calls counts as new. Process only
the **latest** model turn, only when not generating (stopButton/generatingIndicator
absent, `turnComplete` present if defined) and its text has been stable ≥ 1.5 s.
Execute calls sequentially, stop at the first failure, cap `maxCallsPerTurn`.
After `maxSteps` automatic round trips without user input, pause with a 계속 button.
After sending, verify the send took (input cleared or a new user turn / generation
appeared within 8 s); retry once, else leave the text in the box and tell the user.

Panel (Shadow DOM, Korean UI, bottom-right, collapsible to a pill): status dot
(host connected?), agent ON/OFF toggle, workspace path + 변경, task textarea +
작업 시작 (sends primer/context + task, arms the tab), 지침 복사 (copies full
primer), AI Studio only: 시스템 지침에 넣기, step counter, approval mode select,
activity log (tool, short args, ok/error, duration; click to expand output),
pending-approval cards, 중지 (cancels in-flight call, disarms).

## Install / launch (D)

`install/install.ps1` (idempotent, `-DryRun` supported): find node.exe; run
`node host/native-host.mjs --selftest`; write `host/native-host.cmd`
(`@echo off` + absolute node path + `"%~dp0native-host.mjs" %*`); write
`%USERPROFILE%\.devspace-gem\com.devspace.gem.json`
(`{ name, description, path: <abs .cmd>, type: "stdio", allowed_origins:
["chrome-extension://<id>/"] }`, id computed from `install/extension-key.json`);
register it under HKCU `Software\Google\Chrome\NativeMessagingHosts\com.devspace.gem`
(+ `Chromium`, `Microsoft\Edge`, `BraveSoftware\Brave-Browser`); create desktop
shortcuts; print/open the "Load unpacked → `extension\`" steps.
`install/uninstall.ps1` reverses it (keeps config unless `-Purge`).
`launch/`: open AI Studio new chat / Gemini in Chrome (warn if host not
registered), and a stop script that kills native-host / http-server node processes
and their children (hidden window via .vbs, like the old shortcuts).
