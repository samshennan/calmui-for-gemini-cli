# Changelog

## [1.6.0] - 2026-06-10

### Changed - Calm UI redesign
- Header collapsed from two rows to one: status, history, new chat, and an overflow menu holding Checkpoints, Memory, Context, Extensions, Export, Diagnostics, settings, and help
- Composer split into a calm default (file attach, permission mode, context meter, Send) and an advanced row (model picker, Local/Search, sketch canvas, ACP badge) behind a persistent toggle
- Always-visible context window meter beside Send: colour-coded ring (green, amber at 80%, red at 95%) with token breakdown on hover and click-through to the Context Dashboard
- Welcome state simplified to logo, tagline, prompt chips, and a single setup link
- Thinking indicator picks one message per turn instead of rotating every 3 seconds; Retry reveals on hover

### Changed - Branding
- Gemini logo replaces the Veles logo: activity bar icon, welcome page, and the rotating thinking indicator
- Note: 1.5.x retains Veles branding for internal team use; 1.6.0+ is the Gemini-branded public build

## [1.5.2] - 2026-04-23

### Fixed
- Yellow warning banner X button now actually dismisses the notice (was only clearing unrelated state)
- "Not signed in" badge no longer shows when ACP connection is active (false positive when gcloud ADC check fails but CLI authenticates fine)
- Dismissed notices re-appear when connection state changes (so real issues surface)

## [1.5.1] - 2026-04-23

### Fixed
- Silent failures: turns that produce no response now show a visible warning instead of the thinking indicator silently stopping
- Empty-content turns (thinking-only, filtered, overloaded) display an actionable "no response" message with retry guidance

### Added
- File attachment preview chips: `@ current file` and dropped file references now appear as removable chips above the textarea instead of invisible draft text
- Attachment bar renders both image previews and file reference chips together (similar to Claude's attachment UI)

## [1.5.0] - 2026-04-23

### Added - ACP-visible features
- ACP crash recovery and reconnection status
- Connection health indicator with connected/receiving/disconnected/error states
- Coding surface v2: changed-file timelines, editor decorations, diff-block staging, and turn rollback
- MCP context injection for active editor, cursor, selection, and visible files
- Gemini native session history via ACP `session/list` and resume via `session/load`
- Image input in ACP mode: paste/drop images, previews, up to 5 per prompt

### Added - General UX
- Context window awareness with warning/critical usage pill states
- Theme-aware composer notice strip for connection, image, auth, and error warnings
- Drag/drop file references that insert `@relative/path`
- Transcript virtualization for long conversations
- Broader webview behavior tests for virtualization, notices, image send payloads, and file-drop URI handling

### Changed
- ACP mode remains opt-in via `calmui.useAcp`; stream-json fallback is intentionally retained
- Webview tests increased to 114 total tests across 7 files

## [1.4.0] - 2026-04-23

### Added — ACP Transport (opt-in via `calmui.useAcp`)
- Long-lived ACP process replaces per-turn spawns when enabled
- Session manager multiplexes conversations without restarting the process
- Dynamic model catalog from ACP discovery (no more hardcoded model list drift)
- Slash-command popover driven by ACP `available_commands_update`
- Live usage updates during streaming (not just end-of-turn)
- Permission cards: inline tool-call approval with Allow/Reject buttons
- Shift+Tab accepts first pending permission (allow once)
- Thoughts UI: collapsible "Thinking" section showing Gemini's internal reasoning

### Added — General
- Markdown v2: tables, inline code, blockquotes, numbered lists, italics, strikethrough, horizontal rules
- Conversation export: save as Markdown file or copy full thread to clipboard
- Keyboard shortcuts: Escape (cancel), Up arrow (recall last prompt), Ctrl+L (new conversation)
- Focus command: Ctrl+Shift+G / Cmd+Shift+G focuses the CalmUI chat panel
- CI pipeline: TypeScript check + build + 97 unit tests on every push

### Changed
- Generation lifecycle hardened with per-turn token guards (stale callbacks are no-ops)
- React error boundary catches rendering crashes with reload button
- Structured Output Channel logging with `[SPAWN]`, `[STREAM]`, `[QUEUE]`, `[ERROR]` prefixes

### Infrastructure
- Vitest test harness with 97 tests across 6 files
- ACP protocol spike findings documented
- Session manager with SessionHandle map and per-session generationId isolation

## [1.3.1] - 2026-04-21

- Model list updated: gemini-3.1-pro-preview, gemini-3.1-flash-lite-preview, gemini-2.5-pro
- Bug fixes and stability improvements

## [1.3.0] - 2026-04-21

- Compact control bar with model selector and permission toggle below input
- Welcome state with starter prompt chips
- Inline error messages (no more overlay banners)

## [1.2.2] - 2026-04-21

- Code blocks with copy button
- Auto-scroll that respects manual scroll position
- Markdown rendering (bold, links, headings, bullet lists, code blocks)

## [1.1.0] - 2026-04-21

- Initial rebrand from Veles to Gemini CLI CalmUI
- Auto-growing textarea with Enter/Shift+Enter
- Core chat functionality
