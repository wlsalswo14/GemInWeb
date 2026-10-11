# GemInWeb

English | [한국어](README.ko.md)

A Chrome extension plus a local host that lets **Google AI Studio** (`aistudio.google.com`) and
**Gemini web** (`gemini.google.com`) work with the files and shell on your own PC.
It does for those Google sites what [DevSpace](https://github.com/Waishnav/devspace) does for
ChatGPT over MCP. The Google sites don't support custom MCP connectors, so this goes through the browser instead.

How it works: the model writes tool calls as ` ```devspace ` code blocks in its reply. The extension
reads those blocks, runs them on the local host, types the results into the chat box and sends them.
When the model answers without a tool call, the task is done.

> The in-page panel and the installer messages are in Korean. Button names are given below as
> **Korean (English)**.

### How it differs from the earlier `devspace` gemini-web-bridge

| | Earlier bridge | GemInWeb |
| --- | --- | --- |
| Transport | HTTP server on `localhost:7677` with CORS `*`: any web page could call `/execute` | Chrome **native messaging**. In the default mode **no port is opened** |
| Pairing | None | The extension ID is pinned (`ekplpihmkdcielcfideebgocdkajifcc`), and the host manifest's `allowed_origins` allows only that ID |
| What counts as a call | Every `pre/code` on the page, including instructions you pasted | **Model turns only**, latest turn only, thinking sections excluded |
| Repeats | The same call could never run twice; a reload re-ran every past call | Turning on marks existing turns as seen; past calls never run |
| UI | None | Panel at the bottom right (status, workspace, approval cards, activity log, stop) |
| Server | Had to be started from a shortcut | Chrome starts the host on demand; nothing stays running |

## Requirements

- Windows 10/11 and Chrome (registry entries are also written for Edge, Brave and Chromium)
- Node.js 18+ (20+ recommended). No npm install needed; there are zero runtime dependencies.
- Optional: [Git for Windows](https://git-scm.com/). With it, shell commands run in Git Bash; without it, in PowerShell.

## Quick start

1. **Install.** In PowerShell:
   ```powershell
   cd C:\path\to\GemInWeb
   powershell -NoProfile -ExecutionPolicy Bypass -File install\install.ps1
   ```
   You can also double-click `install\install.cmd`. Add `-DryRun` to see what it would do first.
   It is safe to run repeatedly; run it again after reinstalling Node or moving the folder.
2. **Load the extension** (once): `chrome://extensions` → turn on **Developer mode** →
   **Load unpacked** → pick the `extension` folder. Check that the ID is `ekplpihmkdcielcfideebgocdkajifcc`.
3. **Open a site** with the desktop shortcut **GemInWeb - AI Studio** or **GemInWeb - Gemini**.
4. **Panel.** In the GemInWeb panel at the bottom right of the page, the status dot should be green (connected).
5. **Workspace.** Click **변경 (Change)** and choose the folder to work in (e.g. `C:\Users\<you>\projects\my-app`).
6. **Start.** Type the task and click **작업 시작 (Start task)**. The protocol primer and your task are sent
   together and the agent turns on for this tab. From then on, model tool calls are executed and the
   results are sent back automatically.

After the first message you can keep typing in the site's own input box. Conversations where the agent
was on are remembered, so reopening one picks up where it left off.

**Incognito:** enable **Allow in Incognito** on the extension's details page. Gemini works logged out;
AI Studio still requires signing in.

## Gem / system instructions (recommended)

To avoid sending the long primer in every new chat, put it once into a Gem or into AI Studio's system
instructions, then set **primerMode to `context`** in the extension options. **작업 시작 (Start task)** will
then send only a short context block (time, OS, workspace).

- **Gemini Gem:** gemini.google.com → **Gem manager** → **New Gem** → paste the content of
  [`gem/GEM_INSTRUCTIONS.md`](gem/GEM_INSTRUCTIONS.md) into **Instructions** → save, and start chats from that Gem.
  (Regenerate the file with `node scripts/gen-gem.mjs` if needed.)
- **AI Studio:** paste the same text into the chat's **System instructions**, or click
  **시스템 지침에 넣기 (Put into system instructions)** in the panel. **지침 복사 (Copy instructions)** copies the full primer.
- Right-click the extension icon → **Options** → set primerMode to `context` → save.

Without a Gem or system instructions, keep primerMode at the default `full`.

## Tools

Paths are relative to the workspace, or absolute paths inside `allowedRoots`.

| Tool | Arguments | Mutating | Aliases |
| --- | --- | --- | --- |
| `open_workspace` | `path` | | `open`, `cd` |
| `list_dir` | `path?="."`, `depth?=1` (max 4), `all?` | | `ls`, `list` |
| `find_files` | `pattern` (`**/*.ts` or a substring), `path?` | | `glob`, `find` |
| `read_file` | `path`, `offset?`, `limit?` | | `read`, `cat`, `view` |
| `write_file` | `path`, `content` | ✔ | `write`, `create_file` |
| `edit_file` | `path`, `edits: [{old_text, new_text, replace_all?}]` | ✔ | `edit`, `str_replace` |
| `apply_patch` | `patch` (Codex `*** Begin Patch` format) | ✔ | `patch` |
| `run_shell` | `command`, `timeout?` (s), `cwd?`, `shell?` (`bash`/`powershell`), `background?` | ✔ | `bash`, `shell`, `exec`, `run`, `powershell` |
| `search` | `query`, `path?`, `regex?`, `case_sensitive?`, `glob?`, `max_results?` | | `grep`, `rg` |
| `show_changes` | `path?` | | `git_diff`, `diff`, `git_status` |
| `fetch_url` | `url`, `max_chars?` | | `fetch`, `open_url` |

`list_dir`, `find_files` and `search` skip `.git`, `node_modules`, `dist`, `build` and similar folders by default.

## Call format

The model writes a ` ```devspace ` block and **stops to wait for the result**. Two forms are accepted.

**JSON form** (any tool):
````text
```devspace
{"tool": "read_file", "args": {"path": "src/app.ts", "offset": 1, "limit": 200}}
```
````

**Header form** (no JSON escaping, good for file contents, patches and scripts).
Lines above `---` are `key: value` arguments; everything below is the body
(write_file → content, apply_patch → patch, run_shell → command):
````text
```devspace
tool: write_file
path: src/hello.py
---
print("hi")
```
````

For `edit_file` the body is one or more SEARCH/REPLACE blocks:
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

If the body contains ```` ``` ````, the model uses a longer fence (` ````devspace `). Results come back
with a header such as `[DevSpace result 1/2] read_file path=src/app.ts — ok (15 ms)`.

## Approval modes

Set in the panel. Approval cards offer **승인 (Approve) / 거부 (Deny) / 이 탭에서 모두 자동 승인 (Auto-approve all in this tab)**.

| Mode | Behavior |
| --- | --- |
| `auto` | Everything runs automatically |
| `ask_shell` (default) | Click needed for `run_shell`, `fetch_url` and writes inside a `.git` folder |
| `ask_mutating` | The above plus `write_file`, `edit_file`, `apply_patch` |
| `read_only` | Mutating tools and `fetch_url` are denied automatically |

Commands longer than 6000 characters can only be approved after expanding the full text. Approval state
lives in extension storage and the panel ignores scripted clicks, so neither the page nor another extension
can approve on your behalf.

## Settings

**Extension options** (`chrome.storage.local["dsg.settings"]`):

| Key | Default | Meaning |
| --- | --- | --- |
| `transport` | `native` | `native` or `http` (see HTTP fallback below) |
| `httpUrl` / `httpToken` | `http://127.0.0.1:7679` / empty | Address and token for HTTP mode |
| `approval` | `ask_shell` | Approval mode |
| `maxSteps` | 25 | Automatic round trips without user input; past this the loop pauses with a **계속 (Continue)** button |
| `maxCallsPerTurn` | 6 | Max calls executed from one model turn |
| `maxMessageChars` | gemini 24000 / aistudio 80000 | Max length of a result message (outputs are truncated proportionally) |
| `primerMode` | `full` | `full` = send the whole primer; `context` = short context only, for Gem / system instructions |
| `autoSend` | `true` | Send results automatically (off = only fill the input box) |

**Host settings** in `%USERPROFILE%\.devspace-gem\config.json` (created with defaults on first run):

| Key | Default | Meaning |
| --- | --- | --- |
| `allowedRoots` | `["~"]` | Folders the file tools may access (symlink/junction escapes are blocked) |
| `defaultWorkspace` | `"~"` | Used when no workspace is set |
| `shell` / `bashPath` | `"auto"` / `null` | auto = Git Bash if present, else PowerShell |
| `commandTimeoutSec` / `maxCommandTimeoutSec` | 120 / 1800 | Command time limits |
| `maxOutputChars` / `readMaxLines` | 30000 / 2000 | Output caps |
| `http.port` | 7679 | HTTP fallback port |
| `blockedCommands` | `[]` | Regex list; matching `run_shell` commands are refused |
| `protectedPaths` / `writeProtectedPaths` | see Security | Paths denied for read+write / for write only |

Example, to allow only a projects folder: `"allowedRoots": ["C:\\Users\\<you>\\projects"]`.
The `DEVSPACE_GEM_HOME` environment variable changes the data folder.

## HTTP fallback

For environments where native messaging can't be used (e.g. blocked by policy). Leave it off otherwise.

1. Run `npm run start:http` in a terminal (binds to 127.0.0.1:7679 only). The token is printed at startup
   and saved to `%USERPROFILE%\.devspace-gem\http-token`.
2. Extension options → transport `http`, paste the token into httpToken → save.
3. When done, Ctrl+C in the terminal or use **GemInWeb 끄기 (Stop)**.

## Shortcuts and scripts

| File | What it does |
| --- | --- |
| `install\install.ps1` (`-DryRun`, `-NoShortcuts`, `-NoPrompt`, `-SkipSelftest`, `-NodePath`) | Install / reinstall |
| `install\uninstall.ps1` (`-DryRun`, `-Purge`) | Uninstall. `-Purge` also deletes settings, token and logs |
| Desktop **GemInWeb - AI Studio** / **- Gemini** | Checks the host registration, then opens a new chat in Chrome (`launch\open-*.vbs`) |
| Desktop **GemInWeb 끄기** (Stop) | Kills the host / HTTP server node processes and their children, i.e. running commands (`launch\stop.vbs`) |

The `.vbs` files are wrappers that run the PowerShell scripts without a console window.

## Troubleshooting

**Logs**
```powershell
Get-Content "$env:USERPROFILE\.devspace-gem\logs\host.log" -Tail 50 -Wait
```
Extension side: `chrome://extensions` → GemInWeb → **service worker** link → console.
Host self-check: `node host\native-host.mjs --selftest` (prints status JSON when healthy).

**"Specified native messaging host not found" / panel not connected**
- Make sure `install\install.ps1` was run. Check with
  `reg query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.devspace.gem"`.
- The `com.devspace.gem.json` it points to must exist, and so must its `path` (`host\native-host.cmd`).
- If you moved the folder or reinstalled Node, run the installer again.
- Then reload the extension (↻ in `chrome://extensions`) and the site tab.

**"Access to the specified native messaging host is forbidden"** (extension ID mismatch)
- If the ID in `chrome://extensions` isn't `ekplpihmkdcielcfideebgocdkajifcc`, the `key` in
  `extension\manifest.json` is missing or changed. Load this repo's `extension` folder as is
  (the installer warns about a key mismatch).

**"Native host has exited"**
- Check `node host\native-host.mjs --selftest` and host.log. Make sure the node path in
  `host\native-host.cmd` exists (switching versions with nvm changes it, so rerun the installer).

**Gemini doesn't call tools / makes up results**
- Check that the agent is **ON** in the panel and that the primer was sent via **작업 시작 (Start task)**
  (with primerMode `context` in a chat without a Gem / system instructions, the model doesn't know the protocol).
- Saying "continue by calling tools with devspace blocks" once usually gets it going.
- Turns that existed before the agent was turned on are intentionally never executed; only new replies are.
- If the model invents results, start a new chat from a Gem (system-level instructions are followed more reliably).

**Auto-send failed**
- The result text stays in the input box; press Enter / Send yourself.
- If it keeps failing, the site's UI has probably changed (`extension/content/selectors.js`). You can
  turn off `autoSend` in the options and send manually meanwhile.

**A command hangs / processes are left over:** **중지 (Stop)** in the panel (cancels the running call)
or the desktop **GemInWeb 끄기** shortcut.

**Scripts blocked by execution policy:** use `install\install.cmd` or run
`powershell -ExecutionPolicy Bypass -File ...`.

## Security model

- **No network port in the default mode.** Chrome starts the host over native messaging (stdin/stdout),
  and the manifest's `allowed_origins` lists only the pinned extension ID. Web pages can't reach the host.
- The extension runs only on `aistudio.google.com` and `gemini.google.com`, and only reads the latest
  **model turn**. User messages, thinking sections and turns from before the agent was turned on are never executed.
- File tools are confined to `allowedRoots` (realpath checks block symlink / junction escapes).
- **Protected paths** (changeable in `config.json`):
  - `protectedPaths`: no read, no write, hidden from listings and search: `~/.devspace-gem` (including the token),
    `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`, `~/.docker`,
    `~/.netrc`, `~/.git-credentials`, `~/.npmrc`, Chrome/Edge/Brave/Firefox profiles, Windows credential folders.
  - `writeProtectedPaths`: no write: the GemInWeb install folder itself, the Startup folder,
    `~/.gitconfig`, `~/.config/git`. (So **keep your workspace outside the GemInWeb folder**.)
- File tools can't write inside `.git` folders, and internal git calls run with hooks, fsmonitor, filters and
  external diff disabled, so commands planted in a repo's config don't run.
- **`run_shell` is not a sandbox.** Commands can do anything your Windows account can. `blockedCommands`
  only prevents accidents; it is not a security boundary. The model may follow instructions hidden in files it
  reads or pages fetched with `fetch_url` (prompt injection), so use `ask_mutating` or `read_only` with untrusted content.
- File contents and command output are **sent to Google** as chat messages. Don't let it read files
  holding secrets or personal data.
- HTTP fallback: binds to `127.0.0.1` only, requires `Authorization: Bearer <token>`, rejects a `Host` other than
  `127.0.0.1`/`localhost` (DNS rebinding), rejects any `Origin` that isn't `chrome-extension://`, and sends
  no CORS headers (web pages can't read responses).

## Architecture

```
Gemini / AI Studio page
  └─ content scripts  extension/content/*      read model turns, find ```devspace blocks,
       │                                        type + send results, panel UI
       │  chrome.runtime.sendMessage
       ▼
  background service worker  extension/background.js
       │  chrome.runtime.connectNative("com.devspace.gem")      ← default
       │  or fetch http://127.0.0.1:7679/rpc (Bearer token)      ← fallback
       ▼
  host/native-host.cmd → node host/native-host.mjs   |   node server/http-server.mjs
       ▼
  core/engine.mjs → tools (fs, shell, search, patch, fetch)
```

| Path | Contents |
| --- | --- |
| `core/` | Tool engine, path policy, shell runner, primer, apply-patch |
| `host/` | Native messaging host (`native-host.cmd` is generated by the installer) |
| `server/` | HTTP fallback server |
| `extension/` | MV3 extension (content scripts, background, options) |
| `gem/GEM_INSTRUCTIONS.md` | Primer for a Gem / system instructions (generated by `scripts/gen-gem.mjs`) |
| `install/`, `launch/` | Install/uninstall, shortcuts, start/stop scripts |
| `docs/SPEC.md` | Protocol and contracts between the components |
| `docs/dom-research.md` | DOM notes for both sites |

Tests: `node --test "test/**/*.test.mjs"`. Browser E2E: `node test/e2e/run-mock.mjs` (AI Studio mock) and
`test/e2e/run-gemini-live.mjs` (live Gemini, logged out); see the header of each script.

## Status

- Gemini web: verified end to end in a real browser (logged out): write, read, edit, shell, batch calls, approvals.
- AI Studio: verified against a mock page built from current open-source selectors; not yet verified on the live
  site. If something breaks there, please open an issue with the `outerHTML` of `ms-run-button` during generation
  and of one finished `ms-chat-turn`.

## Uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\uninstall.ps1          # keeps settings/logs
powershell -NoProfile -ExecutionPolicy Bypass -File install\uninstall.ps1 -Purge   # removes everything
```
Then remove GemInWeb in `chrome://extensions`.

## Credits / license

- [Waishnav/devspace](https://github.com/Waishnav/devspace) (MIT): source of the tool design and ideas.
  `core/apply-patch` is a port of devspace's `src/apply-patch.ts`.
- This project: MIT, see [LICENSE](LICENSE).
