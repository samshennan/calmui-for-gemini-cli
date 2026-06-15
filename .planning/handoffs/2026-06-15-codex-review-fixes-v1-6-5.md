# Handoff: Codex adversarial review of v1.6.5: 9 findings fixed and pushed to public main
**Date:** 2026-06-15
**Session:** Verified and fixed all 9 Codex review findings (1 HIGH, 6 MED, 2 LOW), 3 new tests, fast-forwarded public main

---

## What Was Done

Ran a Codex (gpt-5-codex, 0.137.0) adversarial code review against the v1.6.5 source at HEAD `af0fcf8`. It returned 9 findings (0 critical / 1 high / 6 medium / 2 low). Verified each against the actual code before touching it, then fixed all 9 on branch `fix/codex-review-v1.6.5` with atomic per-finding commits, fast-forwarded `main`, pushed, and deleted the branch.

Commits (oldest→newest), each maps to a finding:

1. **`0258b03` fix(acp): close yolo auto-approve gap and render object tool args** — *HIGH chain, security.*
   - `src/shared/acp.ts` `selectAcpPermissionOption`: removed the arbitrary fallback that returned the first available `optionId` when no kind match was found. In yolo mode that could auto-pick a persistent `allow_always` (or opposite-intent) option the user never saw. Now returns `null` when no exact kind match.
   - `src/process/GeminiProcessAcp.ts` `_handlePermissionRequest`: yolo mode now only auto-approves on an explicit `allow_once`; if absent it **falls through to the UI permission card** instead of silently dropping the request.
   - Same file: permission card read tool input via `readNestedString`, which returned null for object payloads → blank description before approval. Added `readNestedValue` + `formatToolInput` (JSON-stringifies object input).
   - Tests: 2 new in `src/shared/acp.test.ts` (yolo with no allow_once → null; ask with no reject_once → null).

2. **`6e658de` fix(acp): tear down process when initialize handshake fails** — *MED, race-condition.* `GeminiProcessAcp._start` assigned `_proc` before the `initialize` handshake. On handshake timeout/error `_proc` stayed non-null, so the next `_ensureStarted()` treated a dead process as ready. Wrapped the handshake in try/catch → on failure calls `_terminateProcess()` (rejects pending, tree-kills child, resets `_proc`) and rethrows.

3. **`66c975a` fix(auth): clear inherited GOOGLE_GENAI_USE_VERTEXAI in API-key mode** — *MED, correctness.* Both spawn-env builders (`GeminiProcess.ts` and `getGeminiSpawnEnv` in `GeminiProcessAcp.ts`) spread `...process.env` and only set the Vertex flag when Vertex mode was on. An inherited `GOOGLE_GENAI_USE_VERTEXAI=true` survived into API-key mode and silently forced Vertex auth. Now cleared to empty string (not delete — matches existing API-key handling so gemini's dotenv loader doesn't re-fill it).

4. **`877f906` fix(gcloud): tree-kill timed-out Windows commands** — *MED, resource-leak.* `runWindowsCommand` timeout used `child.kill()`, which only reaped the `cmd.exe` wrapper and orphaned the `gcloud.cmd`→python subtree. Now `taskkill /pid <pid> /f /t` (matches ACP cleanup pattern). `spawnSync` was already imported.

5. **`ed71c88` fix(session): stop double-counting failed ACP restarts** — *LOW, correctness.* `GeminiSessionManager` restart `catch` pushed a crash timestamp **and** called `_scheduleRestart()` which pushed another → each failed restart counted twice, tripping the repeated-crash breaker (MAX 3) a full attempt early and inflating backoff. Removed the redundant push. Added 1 regression test in `sessionManager.test.ts` (failed restart → still `reconnecting attempt 2`, not `failed`).

6. **`a9934c7` fix(chat): start ACP session before gating PDF on embeddedContext** — *MED, correctness.* `_validateAttachmentsForDispatch` read `getPromptCapabilities()` before the ACP handshake; on a fresh panel that's null, so a supported PDF was wrongly rejected. Made the gate async; when a PDF is present in ACP mode with no session yet, it `await`s `_ensureAcpSession()` first, then reads caps. Both call sites updated to `await`.

7. **`acb9c50` fix(chat): show the project Gemini will actually use in the status bar** — *LOW, correctness.* `readGcloudStatusAsync` displayed the gcloud-config project, ignoring `calmui.googleCloudProject` and `GOOGLE_CLOUD_PROJECT` that the spawn env resolves first. Now resolves displayed project the same way (setting → env → gcloud) for both Vertex and non-Vertex paths.

**Verification at each step:** `tsc --noEmit` clean, `npm run build` (esbuild) green. Full suite **201 passed / 1 todo** (up from 198 — added the 3 tests above).

## Current State

Public repo `samshennan/calmui-for-gemini-cli` (PUBLIC, default `main`) is at **`acb9c50`**, in sync with `origin/main` (fast-forward `af0fcf8..acb9c50`, no history rewrite). Working tree clean except the untracked `Calm UI for Gemini CLI UI Screenshots/` folder (longstanding, predates this session — deliberately left out of the commit).

Code is still labelled **1.6.5** — `package.json` says `1.6.5`, latest git tag is `v1.6.1`. These fixes landed on top of the 1.6.5 code **without a version bump or new tag**. No VSIX was repackaged or reinstalled this session, so the installed Antigravity extension (`veles.gemini-cli-calmui@1.6.5`) does NOT contain these fixes yet.

One intentional behavior change to be aware of: in yolo mode, if a CLI ever omits an `allow_once` option, CalmUI now shows the permission card instead of auto-approving — the security fix, but a UX shift for that edge case.

## Pending from This Session

- **No release cut.** If these fixes should ship to users: bump to v1.6.6, `npm run package`, install the new VSIX, tag `v1.6.6`, push the tag. Until then the running extension is still pre-fix 1.6.5.
- **Untracked `Calm UI for Gemini CLI UI Screenshots/`** — decide whether to commit (repo assets), gitignore, or remove. Untouched this session.
- Carried from 2026-06-11 handoff (not addressed this session): scope the Antigravity CLI (`agy`) port — Google ends consumer Gemini CLI access **June 18, 2026** (3 days out); notes in `.planning/2026-06-11-calmui-for-antigravity-cli-mvp.md`. Also the duplicate `session/new`-on-panel-open observation.
