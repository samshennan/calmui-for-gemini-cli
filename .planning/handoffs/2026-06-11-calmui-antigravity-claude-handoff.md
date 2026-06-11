# CalmUI / Antigravity Claude Handoff

Date: 2026-06-11
Repo: `C:\AI_LAB\calmui-for-gemini-cli`
Current extension version in repo: `1.6.4`

## Goal

Get `CalmUI for Gemini CLI` working reliably inside Antigravity IDE with Vertex auth enabled.

## Current Status

- Antigravity was previously stuck on a stale CalmUI install (`1.6.1`).
- That stale install problem is now resolved.
- Antigravity extension registry now points to:
  - `veles.gemini-cli-calmui@1.6.4`
- Remaining issue is specifically the `Vertex ADC` diagnostics path and/or ACP session startup behavior.

## Most Recent User-Facing Symptoms

- Diagnostics now show the correct extension version:
  - `PASS Extension: version=1.6.3` earlier
  - then upgraded again to `1.6.4`
- Repeated failing check:
  - `FAIL Vertex ADC: '"C:\Users\sshennan\AppData\Local\Google\CloudSDK\google-cloud-sdk\bin\gcloud.cmd"' is not recognized ...`
- Chat panel symptom:
  - `Session error: Timed out waiting for session/new response.`
- UI still shows:
  - `Google Cloud credentials need attention`
  - Google Cloud Data Agent Kit popup about logging into Google Cloud CLI and Application Default Credentials

## What Was Wrong Earlier

### 1. Antigravity was loading an old extension

Evidence:

- diagnostics showed `version=1.6.1`
- output channel paths referenced:
  - `C:\Users\sshennan\.antigravity-ide\extensions\veles.gemini-cli-calmui-1.6.1\...`
- `C:\Users\sshennan\.antigravity-ide\extensions\extensions.json` still pointed at `1.6.1`

This was fixed by manually cleaning and re-registering the extension, because Antigravity CLI install/uninstall output was unreliable.

### 2. Windows `gcloud` resolution / invocation bugs

Multiple problems were fixed in sequence:

- missing `CloudSDK` candidate path
- extensionless `where.exe` result needed normalization to `.cmd`
- double quoting / command-string execution on Windows was incorrect

## Code Changes Made

### Already in repo

- [package.json](C:/AI_LAB/calmui-for-gemini-cli/package.json)
  - version bumped multiple times to force real host updates
  - current version: `1.6.4`

- [src/gcloud.ts](C:/AI_LAB/calmui-for-gemini-cli/src/gcloud.ts)
  - added Windows candidate path:
    - `AppData\Local\Google\CloudSDK\google-cloud-sdk\bin\gcloud.cmd`
  - normalizes extensionless Windows `gcloud` path to `.cmd`
  - latest change in `1.6.4`:
    - switched Windows execution from a quoted shell command string to argv-based `cmd.exe` invocation

- [src/gcloud.test.ts](C:/AI_LAB/calmui-for-gemini-cli/src/gcloud.test.ts)
  - tests for:
    - PATH/where.exe resolution
    - `.cmd` normalization
    - `CloudSDK` path variant
    - Windows spawn argument handling

- [src/process/GeminiSessionManager.ts](C:/AI_LAB/calmui-for-gemini-cli/src/process/GeminiSessionManager.ts)
  - fixed false disconnected state before ACP had ever started

- [src/process/sessionManager.test.ts](C:/AI_LAB/calmui-for-gemini-cli/src/process/sessionManager.test.ts)
  - regression test for the pre-start disconnected bug

- [src/webview/viewModel.ts](C:/AI_LAB/calmui-for-gemini-cli/src/webview/viewModel.ts)
  - changed misleading setup text that previously told the user to click a missing `Not signed in` control

- [README.md](C:/AI_LAB/calmui-for-gemini-cli/README.md)
  - FAQ clarifications around Gemini CLI auth / per-user GCP projects

## Packaging / Install History

Built:

- `gemini-cli-calmui-1.6.1.vsix`
- `gemini-cli-calmui-1.6.2.vsix`
- `gemini-cli-calmui-1.6.3.vsix`
- `gemini-cli-calmui-1.6.4.vsix`

Important finding:

- Reinstalling the same version was not reliable in Antigravity.
- Antigravity CLI install/uninstall messages often claimed success while leaving stale metadata behind.

## Host-Side Extension State Work

### Antigravity install locations found

- `C:\Users\sshennan\.antigravity-ide\extensions`
- `C:\Users\sshennan\.antigravity\extensions`

### What had to be done manually

Because Antigravity’s extension management was inconsistent:

1. Stop all Antigravity IDE processes.
2. Remove stale CalmUI entry from:
   - `C:\Users\sshennan\.antigravity-ide\extensions\extensions.json`
3. Remove stale folder:
   - `C:\Users\sshennan\.antigravity-ide\extensions\veles.gemini-cli-calmui-1.6.1`
4. Install newer VSIX.
5. If Antigravity failed to register it, manually add a registry entry back into:
   - `C:\Users\sshennan\.antigravity-ide\extensions\extensions.json`

### Current host-side expected state

- folder exists:
  - `C:\Users\sshennan\.antigravity-ide\extensions\veles.gemini-cli-calmui-1.6.4`
- Antigravity CLI reports:
  - `veles.gemini-cli-calmui@1.6.4`

## `gcloud` / Auth Findings

### Working facts

- `gcloud` is installed.
- Working binary path:
  - `C:\Users\sshennan\AppData\Local\Google\CloudSDK\google-cloud-sdk\bin\gcloud.cmd`
- In a direct shell invocation, this works:
  - `& 'C:\Users\sshennan\AppData\Local\Google\CloudSDK\google-cloud-sdk\bin\gcloud.cmd' auth list`
- It also worked via tested `cmd.exe` argv forms.

### ADC facts

- File exists:
  - `C:\Users\sshennan\AppData\Roaming\gcloud\application_default_credentials.json`
- Direct command works:
  - `gcloud auth application-default print-access-token`
- So ADC appears to be present and usable.

### Login weirdness

The user completed browser auth successfully, but `gcloud auth login` hit a permission error writing legacy credentials:

- failing path:
  - `C:\Users\sshennan\AppData\Roaming\gcloud\legacy_credentials\sshennan@velesproductions.com\adc.json`

Observed behavior:

- directory read itself hit `Access is denied`
- likely stale / corrupted / ACL-broken account folder under `legacy_credentials`

Important distinction:

- this legacy folder issue is real
- but ADC file already exists and direct `application-default` token retrieval worked
- so this may be noisy but not the primary blocker anymore

## Exact Logs Worth Looking At

### CalmUI output channel

Channel:

- `CalmUI for Gemini CLI`

Useful repeated lines:

- `[ACP SPAWN] command=C:\Users\sshennan\AppData\Local\Programs\Antigravity IDE\Antigravity IDE.exe args=C:\Users\sshennan\AppData\Roaming\npm\node_modules\@google\gemini-cli\bundle\gemini.js --acp`
- `[ACP SEND] initialize id=1`
- `[ACP RECV] {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"authMethods":[...`
- `[ACP SEND] session/new id=2`
- then timeout:
  - `Session error: Timed out waiting for session/new response.`

### Diagnostics excerpts

Recent working-stale-resolution proof:

- `PASS Extension: version=1.6.3` and then `1.6.4`
- `PASS Optional MCP context server: enabled for ACP sessions: c:\Users\sshennan\.antigravity-ide\extensions\veles.gemini-cli-calmui-1.6.3\media\calmui-context-mcp-server.js`

Repeated auth failure:

- `FAIL Vertex ADC: '"C:\Users\sshennan\AppData\Local\Google\CloudSDK\google-cloud-sdk\bin\gcloud.cmd"' is not recognized as an internal or external command, operable program or batch file.`

### Antigravity app logs

Folder:

- `C:\Users\sshennan\AppData\Roaming\Antigravity\logs`

Files observed:

- `auth.log`
- `cloudcode.log`
- `main.log`
- `ls-main.log`
- `cli.log`

Notable excerpts:

- `auth.log`
  - auth state reached `validatingLogin`
- `cloudcode.log`
  - `Failed to set Cloud Code URL on Language Server: Language server client has not been initialized!`
- `ls-main.log`
  - Antigravity language server starts from:
    - `c:\Users\sshennan\AppData\Local\Programs\Antigravity\resources\app\extensions\antigravity\bin\language_server_windows_x64.exe`
  - cloud code endpoint:
    - `https://cloudcode-pa.googleapis.com`

## Strong Guesses / Probable Root Causes

### Most likely current issue 1

`1.6.3` still used a broken Windows invocation form for `gcloud.cmd`.

That is why `1.6.4` was created:

- direct local testing showed this fails:
  - passing a quoted command token to `cmd.exe`
- and this works:
  - passing the raw `.cmd` path as the command argv token

If `1.6.4` still fails with the same exact message, possible reasons are:

- Antigravity is still not truly loading the latest bundle
- or diagnostics are reaching a different code path than expected

### Most likely current issue 2

ACP session creation may be hanging for a separate reason after `initialize` succeeds.

Evidence:

- `initialize` receives a result
- `session/new` is sent
- UI later times out waiting for `session/new response`

That suggests:

- not a total spawn failure
- something about auth mode, MCP attachment, or ACP session creation is stalling after initialization

### Possible contributing issue 3

`Attach MCP Servers To ACP` was enabled in at least one settings screenshot earlier.

That setting is experimental and the UI text itself says to disable it if session creation hangs.

If Claude is trying shortest-path debugging, disable this first.

## Recommended Next Checks For Claude

1. Confirm Antigravity is truly running `1.6.4`.
   - output channel should say:
     - `PASS Extension: version=1.6.4`

2. Re-run diagnostics on `1.6.4`.
   - if `Vertex ADC` now passes, the remaining problem is ACP session creation
   - if the same quoted `gcloud.cmd` failure still appears, inspect whether another code path still builds a quoted shell string

3. Search all remaining Windows `gcloud` call sites.
   - especially anything not using `runGcloudCommandSync` / `runGcloudCommand`

4. Disable:
   - `CalmUI: Attach MCP Servers To ACP`
   - then retry chat

5. If `session/new` still hangs:
   - inspect `GeminiProcessAcp.ts`
   - inspect any payload differences between working Gemini CLI ACP in VS Code and Antigravity-hosted spawn

6. Check whether `Gemini path` should point at `gemini.js` instead of `gemini`.
   - current setup resolves:
     - Gemini CLI shim: `C:\Users\sshennan\AppData\Roaming\npm\gemini`
     - ACP bundle: `C:\Users\sshennan\AppData\Roaming\npm\node_modules\@google\gemini-cli\bundle\gemini.js`

7. Investigate whether `snapshot unavailable: git rev-parse ... not a git repository` is harmless or participates in the hang.
   - workspace path shown by diagnostics is `c:\AI_LAB`
   - actual repo in this session is `C:\AI_LAB\calmui-for-gemini-cli`
   - user’s open workspace may not be the repo root

## Current Settings Seen In Screenshots

- `Calmui: Gemini Path` = `gemini`
- `Calmui: Google Cloud Project` = empty
- `Calmui: Use Acp` = enabled
- `Calmui: Use Vertex AI` = enabled
- `Calmui: Attach Mcp Servers To Acp`
  - seen enabled in one screenshot earlier
  - seen disabled in a later screenshot

## Best Single Summary

The stale Antigravity extension problem is solved. The repo is now on `1.6.4`, and the live debugging target is a real Windows `gcloud.cmd` invocation / ACP session issue rather than an install-cache issue. The highest-value next step is to verify `1.6.4` in diagnostics, disable MCP attachment, and then debug whether the remaining `Vertex ADC` failure is coming from a still-unpatched Windows command path or whether the real blocker is the later `session/new` hang.
