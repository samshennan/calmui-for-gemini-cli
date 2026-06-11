# CalmUI Antigravity Debug Handoff

Date: 2026-06-11
Repo: `C:\AI_LAB\calmui-for-gemini-cli`

## What Changed Locally

- Bumped extension version in [package.json](C:/AI_LAB/calmui-for-gemini-cli/package.json) to `1.6.3`.
- Added Windows `gcloud` resolution fixes in [src/gcloud.ts](C:/AI_LAB/calmui-for-gemini-cli/src/gcloud.ts):
  - support for `AppData\\Local\\Google\\CloudSDK\\google-cloud-sdk\\bin\\gcloud.cmd`
  - avoid broken double-quoting when spawning `gcloud`
  - normalize extensionless `where.exe` results to `.cmd` on Windows
- Added tests in [src/gcloud.test.ts](C:/AI_LAB/calmui-for-gemini-cli/src/gcloud.test.ts) for the Windows resolver cases above.
- Fixed a false disconnected state in [src/process/GeminiSessionManager.ts](C:/AI_LAB/calmui-for-gemini-cli/src/process/GeminiSessionManager.ts) so ACP is not marked disconnected before a session has actually started.
- Added a regression test in [src/process/sessionManager.test.ts](C:/AI_LAB/calmui-for-gemini-cli/src/process/sessionManager.test.ts).
- Reworded a misleading setup hint in [src/webview/viewModel.ts](C:/AI_LAB/calmui-for-gemini-cli/src/webview/viewModel.ts) so it no longer tells the user to click a missing `Not signed in` control.
- Updated [README.md](C:/AI_LAB/calmui-for-gemini-cli/README.md) FAQ to clarify local Gemini CLI / Vertex auth behavior without hardcoding internal project naming.
- Added AGY MVP planning in [.planning/2026-06-11-calmui-for-antigravity-cli-mvp.md](C:/AI_LAB/calmui-for-gemini-cli/.planning/2026-06-11-calmui-for-antigravity-cli-mvp.md).

## Current Git State

- Branch: `main`
- Status: `ahead 1`
- Uncommitted files:
  - `README.md`
  - `package.json`
  - `src/gcloud.test.ts`
  - `src/gcloud.ts`
  - `src/process/GeminiSessionManager.ts`
  - `src/process/sessionManager.test.ts`
  - `src/webview/viewModel.ts`
  - `.planning/2026-06-11-calmui-for-antigravity-cli-mvp.md`
- Existing local commit already present before these latest edits:
  - `fee7e8f` `fix(auth): resolve gcloud reliably on Windows`

## Verified Machine State

- `gcloud --version` now works in a fresh PowerShell:
  - `Google Cloud SDK 572.0.0`
  - `core 2026.06.05`
- Working binary path:
  - `C:\Users\sshennan\AppData\Local\Google\CloudSDK\google-cloud-sdk\bin\gcloud.cmd`
- User PATH was updated to include:
  - `C:\Users\sshennan\AppData\Local\Google\CloudSDK\google-cloud-sdk\bin`
- There is also a stale shim backup:
  - `C:\Users\sshennan\.local\bin\gcloud.cmd.bak`

## Main Finding

The biggest remaining issue is not the machine `gcloud` install. It is that Antigravity is still running the old CalmUI extension bundle.

Evidence:

- [package.json](C:/AI_LAB/calmui-for-gemini-cli/package.json) is `1.6.3`.
- Antigravity diagnostics still report:
  - `PASS Extension: version=1.6.1`
- Antigravity extension metadata file still points to the old install:
  - `C:\Users\sshennan\.antigravity-ide\extensions\extensions.json`
  - entry for `veles.gemini-cli-calmui` is version `1.6.1`
  - location is `C:\Users\sshennan\.antigravity-ide\extensions\veles.gemini-cli-calmui-1.6.1`

That stale metadata exactly matches the stale diagnostics output and explains why the latest code fixes are not yet reflected in the running extension.

## Why Diagnostics Still Fail

Current diagnostics still show:

- `FAIL Vertex ADC: '\"C:\\Users\\sshennan\\AppData\\Local\\Google\\CloudSDK\\google-cloud-sdk\\bin\\gcloud\"' is not recognized ...`

That error string is consistent with the older Windows spawn path behavior, where CalmUI tried to run an extensionless `...\\bin\\gcloud` path instead of the fixed `.cmd` path.

Since the shell now resolves `gcloud` correctly, the remaining failure is most likely stale Antigravity extension state rather than an actual missing SDK.

## Packaging / Install Notes

- Reinstalling the same extension version was unreliable.
- The extension version was bumped specifically to avoid host-side caching.
- Antigravity CLI at one point reported the newer VSIX as installed, but the on-disk extension metadata remained at `1.6.1`.
- There was also a prior manual copy of built assets into the `1.6.1` extension folder during troubleshooting, so the host-side extension state should be treated as dirty and untrustworthy until reinstalled cleanly.

## Better Logs To Capture Next

### CalmUI

- Output panel channel:
  - `CalmUI for Gemini CLI`

### Antigravity App Logs

- Folder:
  - `C:\Users\sshennan\AppData\Roaming\Antigravity\logs`
- Useful files already observed there:
  - `auth.log`
  - `cloudcode.log`
  - `main.log`
  - `ls-main.log`
  - `cli.log`

Relevant sample from `auth.log`:

- auth state reached `validatingLogin`

Relevant sample from `cloudcode.log`:

- `Failed to set Cloud Code URL on Language Server: Language server client has not been initialized!`

Relevant sample from `ls-main.log`:

- Antigravity language server starts from:
  - `c:\Users\sshennan\AppData\Local\Programs\Antigravity\resources\app\extensions\antigravity\bin\language_server_windows_x64.exe`
- endpoint passed:
  - `https://cloudcode-pa.googleapis.com`

### UI / Dev Logs Worth Opening

Inside Antigravity IDE, try:

- `Help -> Toggle Developer Tools`
- `Developer: Open Logs Folder`
- `Developer: Show Running Extensions`
- `Extensions: Open Extensions Folder`

The two most important artifacts for the next chat are:

- the current `extensions.json`
- the newest folder under `%APPDATA%\Antigravity\logs`

## Likely Next Steps

1. Confirm Antigravity is fully closed.
2. Inspect and clean stale CalmUI extension state under:
   - `C:\Users\sshennan\.antigravity-ide\extensions`
3. Verify whether Antigravity keeps a second extension cache or install registry besides `extensions.json`.
4. Reinstall the `1.6.3` VSIX only after stale `1.6.1` metadata is removed.
5. Reopen Antigravity and confirm diagnostics now report `PASS Extension: version=1.6.3`.
6. Only after the host is definitely on `1.6.3`, re-run diagnostics and check whether the Vertex ADC failure disappears.

## Secondary Issues Seen In UI

- `Google Cloud Data Agent Kit` warnings are from a separate extension, not CalmUI.
- `unsafe repositories` warning is from Git, not CalmUI.
- Those can add noise, but they are not the primary blocker for the CalmUI `Vertex ADC` failure.

## Summary

The current blocker is a stale Antigravity-hosted CalmUI install. The machine `gcloud` install is now present and working in the terminal, but Antigravity is still loading `veles.gemini-cli-calmui` `1.6.1`, so the runtime behavior and diagnostics do not yet reflect the latest fixes.
