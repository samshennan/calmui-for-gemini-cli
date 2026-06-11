# CalmUI for Antigravity CLI MVP Research

Date: 2026-06-11

## Goal

Define a realistic MVP for a new `CalmUI for Antigravity CLI` project that:

- works inside Antigravity IDE / VS Code-compatible editors
- stays intentionally light
- is reliable for quick interactions
- avoids overbuilding around unstable or missing transport features
- sends heavier, approval-heavy, or long-running work to the native terminal workflow

## Research Summary

### Official Antigravity surfaces confirmed

As of 2026-06-11, official/public sources indicate:

- Antigravity CLI is now the terminal-first surface replacing Gemini CLI.
- Antigravity IDE and Antigravity CLI share a broader platform direction.
- Antigravity supports plugins, skills, hooks, MCP, and an SDK.
- Official docs describe Antigravity CLI as a TUI-first experience with onboarding, permissions, conversations, and prompting.
- Official prompting docs indicate multimodal/file input exists in the CLI UI.
- Official migration docs indicate Gemini-era concepts are being migrated, but not necessarily with identical low-level integration contracts.

### Important constraint

There is no clear official public documentation showing that Antigravity CLI currently exposes a Gemini-style ACP stdio server suitable for a custom VS Code companion extension.

Supplementary evidence from the public Antigravity CLI repo indicates ACP support is still being requested rather than documented as available:

- GitHub issue requesting `agy --acp` remains open.
- That issue explicitly describes current public modes as:
  - default TUI
  - `-i / --prompt-interactive`
  - `-p / --print`
- The same issue states those modes do not provide the streamed, bidirectional protocol needed for rich IDE orchestration.

This matters because the existing CalmUI for Gemini CLI architecture is heavily ACP-driven.

## What This Means

### Do not build v1 around full Gemini parity

The current Gemini extension depends on:

- long-lived ACP sessions
- streamed assistant chunks
- interactive tool approval callbacks
- session resume/load semantics
- cancellation and recovery
- MCP injection into ACP session creation

That is too much coupling for a first Antigravity version.

### Build a light companion instead

The MVP should assume:

- the terminal is the source of truth for advanced agent work
- the extension is a fast-launch, fast-read, high-clarity side panel
- the extension should fail safe and hand off to terminal early

## Recommended Product Shape

### Product statement

`CalmUI for Antigravity CLI` should be a polished quick-chat companion for Antigravity CLI, not a full orchestration shell.

### Core user promise

From the editor sidebar, the user can:

- verify setup quickly
- ask a short prompt
- attach image/file context in a simple way
- get a readable result
- launch or resume the full terminal workflow when the task becomes complex

## Recommended MVP Scope

### In scope

1. Setup and onboarding
- detect whether Antigravity CLI is installed
- clear install guide if not found
- simple first-run checklist
- explain when to use sidebar vs terminal

2. Lightweight prompt panel
- single prompt composer
- send prompt through the Antigravity CLI headless/non-interactive path if available
- readable transcript for user and assistant messages
- basic stop/reset/new-chat UX only if supported cleanly

3. Context attachments
- drag/drop or picker for:
  - images
  - files
- if the CLI headless path accepts file paths reliably, pass them through
- if not, degrade gracefully by inserting referenced paths into the prompt and telling the user exactly what was sent

4. Terminal handoff
- one-click "Open in Antigravity Terminal"
- one-click "Run this in terminal instead"
- prefill the terminal command/prompt when possible

5. Reliable UX states
- disconnected / missing CLI
- onboarding / first use
- prompt running
- prompt failed
- unsupported action
- handoff recommended

6. Minimal diagnostics
- CLI found / not found
- version shown if available
- workspace detected
- attachment capability known / unknown
- terminal handoff ready

7. Visual quality
- strong contrast for warnings and action panels
- clear approval or caution surfaces
- predictable spacing and hierarchy
- no feature clutter hidden behind too many secondary controls

### Explicitly out of scope for v1

- full ACP-style session manager
- tool-call approval callbacks from the CLI
- live streaming chunk protocol unless AGY exposes it cleanly
- Memory Studio / checkpoint browser / extension manager parity
- MCP session injection from the extension
- advanced search-grounding controls
- complex recovery/reconnect logic
- native diff review unless the CLI exposes a documented headless diff/apply contract

## Recommended Interaction Model

### Default mode: quick ask

The user types a prompt, optionally attaches files/images, and gets a concise answer in the panel.

This should target:

- explanation
- summarization
- code reading
- small refactor suggestions
- image/mockup review
- "what file should I change?"

### Escalation mode: continue in terminal

If the task is likely to:

- edit multiple files
- require approvals
- run long tool chains
- depend on long-lived session context
- depend on undocumented headless behavior

the extension should recommend terminal handoff instead of pretending it can safely manage the flow.

## Architecture Recommendation

### Preferred v1 transport

Use a thin process adapter around the public Antigravity CLI invocation surface rather than porting the Gemini ACP stack.

Candidate flow:

1. Detect CLI binary.
2. Probe `--help` / `--version`.
3. Use documented headless/non-interactive invocation if available.
4. Capture stdout/stderr and present a simple assistant transcript.
5. If unsupported behavior is encountered, stop and offer terminal handoff.

### Why this is the right tradeoff

- smaller code surface
- lower transport risk
- easier onboarding
- fewer false promises
- much simpler testing

### Transport abstraction guidance

Create a new transport interface for the Antigravity project with only:

- `checkAvailability()`
- `sendPrompt()`
- `cancel()` only if supported safely
- `openInteractiveTerminal()`

Do not reuse the Gemini ACP manager directly.

## Attachment Strategy

### Images and files

The extension UI can still support:

- image drop
- file drop
- file picker

But the transport layer should separate:

- UI attachment support
- CLI transport support

If the CLI headless mode cannot accept raw blobs reliably, the fallback should be:

- include absolute or workspace-relative file paths in the prompt
- tell the user whether the attachment was sent as a native input or as a path reference

This avoids silent failure.

## Approvals and Safety

### Important product truth

Without an ACP-like interactive protocol, the extension cannot truly reproduce Gemini's in-panel approval cards for live tool calls.

Therefore v1 should use two safety mechanisms:

1. Preflight caution UI
- before sending prompts that imply edits or commands, warn that interactive approvals may require terminal mode

2. Terminal-first escalation
- provide a strong CTA to continue in the Antigravity terminal when the request crosses the safe boundary

### Design requirement

Even if approval cards are limited in v1, warning panels and handoff cards must be visually excellent:

- dark-on-light or light-on-dark contrast must meet accessibility expectations
- no muted text on saturated warning backgrounds
- primary and secondary actions must be visually distinct

## Onboarding Design Requirements

First-use onboarding should explain:

1. what this sidebar is for
2. what it is not for
3. how to install or locate the CLI
4. how to switch to terminal mode for heavier tasks
5. how attachments behave

Recommended onboarding structure:

- hero title
- short "Best for quick asks" explanation
- 3-step setup checklist
- "Try these prompts" chips
- "For full agent sessions, open terminal mode" card

## Proposed Repo Split

### Public product repo

`calmui-for-antigravity-cli`

Contains:

- shipped extension
- screenshots
- README
- changelog

### Private/dev repo

`CalmUI4AGCLI`

Contains:

- research notes
- protocol experiments
- CLI fixture captures
- design explorations
- migration planning

## Suggested Implementation Phases

### Phase 0: discovery spike

Duration: 2-4 days

See the "Developer Machine Setup Prerequisites" section above for the exact Windows commands (gcloud for Vertex/GC users + agy primary).

- install and validate AGY locally (plus gcloud if you use Vertex or Google Cloud projects)
- capture real `--help`, `--version`, and headless invocation behavior (`-p` / `--print`)
- test file/image attachment behavior (and graceful path-reference fallback)
- test failure modes, sandbox behavior, and auth flows
- determine stdout characteristics for the panel (block output, any streaming, history bloat on conversation continuation)
- test whether continue/resume can be used safely from a thin wrapper (note current limitations around approvals and full history)

Exit criteria:

- written transport notes + real command examples that work today
- known unsupported / degraded behaviors (especially approvals, long sessions, rich TUI features)
- fixture captures of `--help` and sample runs (private repo)

### Phase 1: shell extension

Duration: 3-5 days

- scaffold new extension
- onboarding card
- diagnostics card
- launch terminal CTA
- CLI detection

Exit criteria:

- installs cleanly
- first-run experience is clear

### Phase 2: quick prompt MVP

Duration: 4-6 days

- basic composer
- transcript rendering
- headless prompt execution
- error handling
- reset/new conversation UX

Exit criteria:

- reliable quick prompt round-trip

### Phase 3: attachments and handoff polish

Duration: 4-6 days

- file/image attach UI
- capability fallback messaging
- terminal handoff with prefilled prompt
- visual polish for warnings and action cards

Exit criteria:

- polished "quick ask + attach + escalate" loop

### Phase 4: release hardening

Duration: 2-4 days

- readme
- screenshots
- install docs
- regression tests
- packaging

## Engineering Principles for the New Project

- Prefer fewer capabilities with reliable behavior.
- Avoid hidden failure.
- Make handoff to terminal explicit and fast.
- Separate UI richness from transport assumptions.
- Keep transport replaceable so ACP can be added later if Antigravity exposes it.

## Future Expansion Path

If Antigravity CLI later adds a documented ACP-like server mode or another bidirectional IDE protocol, v2 can add:

- live streaming
- in-panel approvals
- richer session persistence
- native diff/apply review
- deeper MCP-aware context flow

That future should be treated as a transport upgrade, not a reason to delay MVP.

## Developer Machine Setup Prerequisites (Windows example)

The discovery spike and all subsequent development assume a working `agy` binary. For users coming from Gemini + Google Cloud / Vertex AI (very common), `gcloud` is also required for Application Default Credentials.

**1. Google Cloud CLI (gcloud) – required for Vertex AI / Google Cloud project usage**

Use the official installer (current as of the referenced docs):

- Download: https://dl.google.com/dl/cloudsdk/channels/rapid/GoogleCloudSDKInstaller.exe
- Or run directly in PowerShell:

```powershell
(New-Object Net.WebClient).DownloadFile("https://dl.google.com/dl/cloudsdk/channels/rapid/GoogleCloudSDKInstaller.exe", "$env:Temp\GoogleCloudSDKInstaller.exe")
& $env:Temp\GoogleCloudSDKInstaller.exe
```

Launch the signed Google LLC installer and follow the prompts:
- (Optional) Enable "Turn on screen reader mode" for better accessibility output.
- Google Cloud CLI bundles Python 3 (supported versions 3.10–3.14). You can uncheck "Install Bundled Python" if you prefer to use an existing installation.
- At the end of the installer, **uncheck** the option to start the Google Cloud CLI shell (you will run configuration manually below).

After the installer finishes:

```powershell
# Initialize (opens browser for login by default; use --console-only for terminal-only)
gcloud init

# For Vertex AI / application-default credentials (what CalmUI previously used for Vertex mode)
gcloud auth application-default login

# Verify
gcloud auth list
gcloud config list
gcloud --version
```

See the full official guide for details and troubleshooting (including PATH issues after install and the need to restart terminals): https://docs.cloud.google.com/sdk/docs/install-sdk

**2. Antigravity CLI (agy) – the primary target for this project**

Windows (PowerShell – recommended):

```powershell
irm https://antigravity.google/cli/install.ps1 | iex
```

Alternative (CMD):

```cmd
curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd
```

Default install location on Windows (from official sources):
`C:\Users\<YourName>\AppData\Local\agy\bin\agy.exe`

After install (new terminal recommended):

```powershell
agy --version
agy          # Run once interactively: completes first-run onboarding, auth (browser), and workspace permission grant
```

**Verification commands for the spike**

```powershell
agy --help
agy -p "Say hello and tell me your version"
agy -p "List the files in the current directory in one sentence"   # basic workspace context test
```

**Important notes for CalmUI onboarding / diagnostics**

- Many enterprise / Vertex users will still need the gcloud path even after switching to agy.
- Pure consumer Antigravity users primarily need to run `agy` once (browser OAuth).
- The extension must clearly distinguish the two paths in first-run UX and diagnostics.
- The existing `src/gcloud.ts` resolver (Windows `where.exe` + common SDK paths + quoting) is reusable with minimal changes.
- PATH problems after either install are common on Windows — diagnostics should surface the exact expected locations and a "refresh PATH / restart terminal" guidance.

## Immediate Next Step

Do a local AGY discovery spike first (after completing the prerequisites above).

Specifically:

- install AGY locally (and gcloud if targeting Vertex/GC usage)
- capture real `--help`, `--version`, and headless invocation behavior (`agy -p ...`)
- test file path / workspace context behavior in `-p` mode
- test image attachment behavior (likely limited or path-reference only outside TUI)
- test failure modes, sandbox/permission interactions, and first-run auth flows
- determine stdout characteristics (block output vs any streaming) and practical limits for multi-turn via `--conversation` or repeated `-p`
- test whether continue/resume can be used safely from a thin wrapper
- note any Windows-specific quoting, PATH, or .exe behaviors

Exit criteria:

- written transport notes with exact working command examples
- known unsupported / degraded behaviors (especially around approvals, long-running work, rich output)
- fixture captures of real `--help` + sample `-p` runs (committed to private dev repo)
- clear decision on the two auth paths (direct agy vs gcloud ADC) to encode in onboarding + settings

Only after the spike data is captured should implementation (Phase 1+) begin.
