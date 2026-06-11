# Handoff: CalmUI 1.6.5: gcloud resolution + ADC timeout fixes, Antigravity QA passed
**Date:** 2026-06-11
**Session:** Fixed Windows gcloud fallback and ADC check timeouts, verified 1.6.5 working end-to-end in Antigravity IDE, README comparison shots + troubleshooting FAQ

---

## What Was Done

Picked up from Codex's handoff (`2026-06-11-calmui-antigravity-claude-handoff.md`). Root-caused the persistent "Vertex ADC" diagnostics failure by reproducing the extension's exact spawn calls in Node on this machine:

1. **ADC check was timing out, not failing auth.** `gcloud auth application-default print-access-token` takes ~8s on Windows (Python startup + network round trip to mint the token). Diagnostics gave it 7000ms; the status-bar probe gave it 5000ms. Reproduced: spawnSync killed the process at 7s with a valid token already in stdout.
   - `src/diagnostics.ts`: ADC check 7s → 20s, project check 5s → 10s.
   - `src/providers/ChatPanelProvider.ts` (`readGcloudStatusAsync`): helper takes a timeout param, ADC call 5s → 20s, others 10s.

2. **gcloud fallback resolution returned nonexistent paths.** Inside Antigravity's extension host `where.exe gcloud` finds nothing (stale PATH), so resolution fell to the hardcoded candidate list — which returned the first candidate *without checking existence* (`~\.local\bin\gcloud.cmd`, not installed). That produced the `'...gcloud.cmd' is not recognized` errors.
   - `src/gcloud.ts` `resolveGcloudCommand`: candidates now require `fs.existsSync`.
   - `src/gcloud.test.ts`: updated fallback test, added skips-nonexistent and returns-null tests. Full suite: 198 passed, 1 todo.

3. **Root environmental cause found:** gcloud's bin dir WAS in the registry User PATH, but Antigravity was launched before that entry existed, so its whole process tree (extension host, Data Agent Kit, this Claude Code session) had a stale PATH. Full quit + relaunch of Antigravity fixed `where.exe gcloud`, the Data Agent Kit popup, and CalmUI resolution in one shot. Reload Window is NOT enough.

4. **Disabled `calmui.attachMcpServersToAcp`** in `C:\Users\sshennan\AppData\Roaming\Antigravity IDE\User\settings.json` (was true; experimental setting whose own description warns of session-creation hangs — matched the observed `session/new` timeout).

5. **Released 1.6.5:** version bump, `npm run package`, installed via `antigravity-ide --install-extension`, verified `.antigravity-ide/extensions/extensions.json` points at 1.6.5 and the installed bundle contains both fixes (checked minified `dist/extension.js` for `2e4` timeout + existsSync).

6. **README updates:**
   - Three new screenshots in `docs/`: `calm-chat.png`, `calm-vs-terminal.png`, `terminal-response.png` (reviewed — no secrets; project ID only ever appeared in status bars which are cropped out). Added to "What it looks like".
   - Install section: generic `<version>.vsix` filename (was hardcoded stale 1.6.1), Antigravity CLI install command, post-install diagnostics pointer.
   - Five new troubleshooting FAQ entries: stale PATH / full-restart, ADC timeout (fixed in 1.6.5), Antigravity stale VSIX recovery steps, session/new hang → disable MCP attach.
   - Compatibility table + Current status: Antigravity marked as manually QA'd (v1.6.5, June 2026).

## Current State

**CalmUI 1.6.5 works end-to-end in Antigravity IDE with Vertex AI auth.** Verified live: 10/10 diagnostics (including `PASS Vertex ADC`), ACP session created, prompt streamed with a `google_web_search` tool call, `end_turn` received. `gcloud auth list` shows the account active; ADC healthy. The lingering "Google Cloud Data Agent Kit" popup is Google's own extension being stale — cosmetic, not CalmUI.

Working tree at session end: code fixes + version bump + README/docs committed and pushed (see commit log). Antigravity registry: `veles.gemini-cli-calmui@1.6.5` in `~/.antigravity-ide/extensions`. The secondary `~/.antigravity/extensions` registry (the other Antigravity install) still has 1.6.3 — untouched, that app wasn't the target.

## Pending from This Session

- **Scope the Antigravity-specific version (target: later in June 2026).** Sam's stated next step. Context: Google ends consumer Gemini CLI access June 18, 2026; the Antigravity CLI (`agy`) does not yet expose an `--acp` equivalent. Existing scoping notes: `.planning/2026-06-11-calmui-for-antigravity-cli-mvp.md`. Key open questions: what transport `agy` offers, whether CalmUI's ACP layer can be adapted, what auth model applies.
- Codex's earlier observation about duplicate `session/new` (two sessions created on one panel open, plus a `dropped stale turn` log line) — visible in today's logs too. Chat works, but worth a look during the AG-version work.
- `legacy_credentials` folder ACL noise during `gcloud auth login` resolved itself this session (`gcloud auth list` shows active account) — no action needed unless it recurs.
