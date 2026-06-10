# CalmUI for Gemini CLI

by [Sam Shennan](https://www.velesproductions.com) ([LinkedIn](https://www.linkedin.com/in/samshennan/))

A calmer UI for using Gemini CLI inside VS Code and VS Code-based IDEs.

CalmUI was developed for an internal, non-technical team. For most people the terminal is a black scary box. CalmUI makes Gemini CLI feel like a chatbot again — a familiar sidebar chat — while keeping all the under-the-hood powers of Gemini CLI: tool calls, file context, memory, checkpoints, and MCP.

If you have working access to Gemini CLI, CalmUI gives you a sidebar chat interface that feels closer to Claude Code, Codex, or modern agent IDEs. You can prompt Gemini, stream replies, approve tool calls, attach context, inspect memory/tools, export conversations, and keep the work inside your editor instead of living in a terminal.

## Open source, and just a wrapper

CalmUI is open source (MIT) and is deliberately only a user interface around the official [Gemini CLI](https://github.com/google-gemini/gemini-cli):

- It spawns your locally installed Gemini CLI and talks to it over its documented interfaces (stream-json and ACP). There is no CalmUI server.
- Your authentication never passes through anything of ours. The CLI uses whatever Google Cloud, Vertex AI, or API-key auth you already have configured.
- No telemetry, no analytics, no network calls of its own. Every request that leaves your machine is made by Gemini CLI itself, exactly as it would be from the terminal.
- The entire extension is in this repository. It is small enough to read before you install it.

CalmUI is a community project. It is not affiliated with, endorsed by, or sponsored by Google. Gemini is a trademark of Google LLC, used here only to identify compatibility with Gemini CLI.

## Who this is for

Use CalmUI if:

- You already use Gemini CLI and want a nicer editor UI.
- You have Gemini CLI access through Google Cloud, Vertex AI, API keys, or an enterprise setup.
- You want to use Gemini CLI from VS Code, Antigravity IDE, or another VS Code-compatible editor.
- You prefer a simple chat panel over terminal-first workflows.

This was originally built for internal Veles workflows, where non-terminal users needed a calmer way to use Gemini CLI against existing Google Cloud auth.

## Compatibility

| Environment | Status |
|---|---|
| VS Code | Supported target |
| Antigravity IDE | Designed to install as a VSIX; needs latest manual QA |
| Cursor | Likely compatible because it supports many VS Code extensions, but not tested yet |
| Other VS Code-based IDEs | Possible if they support webview/sidebar VSIX extensions |
| Gemini CLI with Google Cloud / Vertex / API key / enterprise access | Intended runtime |
| Consumer Gemini CLI after June 18, 2026 | Upstream Google support is ending for free, Pro, and Ultra access |
| Antigravity CLI (`agy`) | Not a drop-in replacement yet because it does not currently expose Gemini CLI's `--acp` protocol |

Google announced that Gemini CLI and Gemini Code Assist IDE extensions will stop serving requests for free, Pro, and Ultra consumer users on June 18, 2026. Enterprise and Google Cloud/API-key access remain supported. CalmUI still makes sense for people who retain Gemini CLI access, and it is structured so an Antigravity CLI adapter can be added if Google ships `agy --acp` or an equivalent programmatic interface.

## What it does

- Sidebar chat UI inside the editor, with a deliberately quiet default layout: status, history, new chat, and one menu.
- Streaming Gemini responses.
- Always-visible context window meter beside Send, colour-coded as the window fills, one click from the full Context Dashboard.
- ACP mode for long-running sessions.
- Inline permission cards for tool calls.
- Model and slash-command discovery from Gemini CLI.
- Advanced controls (model picker, search grounding, sketch canvas) behind a single composer toggle, so power features stay one click away without crowding the default view.
- Thinking section for ACP reasoning events.
- Markdown rendering with code blocks, tables, lists, and blockquotes.
- Image paste/drop support.
- Dropped file references as context.
- Conversation export to Markdown or clipboard.
- Context dashboard with token pressure hints.
- Memory Studio for `GEMINI.md`.
- MCP Tool Inspector.
- Checkpoint Browser and turn rollback helpers.
- Gemini CLI Extension Manager.
- Diagnostics command for checking auth, CLI path, ACP readiness, and search/tool settings.

Memory Studio, checkpoints, the MCP inspector, extensions, export, and diagnostics all live in the toolbar overflow menu rather than as persistent buttons.

## Requirements

- VS Code 1.93+ or a compatible VS Code-based IDE.
- Node.js 22 for building from source.
- Gemini CLI installed and available as `gemini`, or configured with an explicit path.
- Working Gemini CLI authentication.

For Vertex AI use, CalmUI sets `GOOGLE_GENAI_USE_VERTEXAI=true` and clears inherited public API keys so Vertex auth is not accidentally overridden.

## Install the VSIX

Build the package:

```bash
npm ci
npm run package
```

Then install the generated file:

```bash
code --install-extension gemini-cli-calmui-1.6.0.vsix
```

Or install manually:

1. Open Extensions in VS Code or a compatible IDE.
2. Open the `...` menu.
3. Choose **Install from VSIX...**
4. Select `gemini-cli-calmui-1.6.0.vsix`.
5. Reload the window.
6. Open the CalmUI activity bar panel.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `calmui.geminiPath` | `gemini` | Path to Gemini CLI. Leave as `gemini` if it is on `PATH`. |
| `calmui.useVertexAI` | `true` | Use Vertex AI auth behavior and scrub public API keys from the spawned process. |
| `calmui.googleCloudProject` | empty | Optional Google Cloud project override. |
| `calmui.includeDirectories` | `[]` | Extra folders Gemini CLI may read. |
| `calmui.useAcp` | `true` | Use Gemini CLI ACP mode for sessions, permissions, images, and recovery. |
| `calmui.attachMcpServersToAcp` | `false` | Experimental. Attach configured MCP servers to ACP sessions. Leave off if Gemini session creation hangs. |

## QA checklist

Use this after installing the VSIX:

1. Run **CalmUI: Run Diagnostics** from the command palette.
2. Open the CalmUI sidebar panel.
3. Send a simple prompt like `Say hello and tell me which model you are using.`
4. Confirm streaming text appears and the UI does not hang.
5. Try a coding prompt in a throwaway repo and confirm permission cards appear before file edits.
6. Paste or drop an image and send a prompt about it.
7. Drop a text/code file into the composer and confirm it becomes an `@file` reference.
8. Open Memory Studio and confirm it finds project/global `GEMINI.md` files.
9. Open MCP Tool Inspector and confirm it lists configured tools or shows an empty state.
10. Export a conversation to Markdown.
11. Reload the editor and confirm the panel starts cleanly.

## Build and verify

```bash
npm ci
npx tsc --noEmit
npm run build
npm test
npm run package
```

## Project layout

```text
src/
  extension.ts                     Extension activation and command wiring
  process/                         Gemini CLI stream-json and ACP process management
  providers/ChatPanelProvider.ts   Webview provider and host-side app logic
  shared/                          Typed messages and parser helpers
  webview/                         React UI and view-model helpers
  memory/                          GEMINI.md Memory Studio helpers
media/                             Icons and local helper scripts
scripts/                           Gemini CLI wrapper script for Vertex AI machines
```

## Current status

CalmUI is pre-release software. It is ready for local VSIX QA, not marketplace publishing. The next release-prep step is hands-on testing in VS Code and Antigravity IDE with a real Gemini CLI account.

## License

MIT. See [LICENSE](LICENSE).
