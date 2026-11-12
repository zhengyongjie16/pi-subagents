# pi-subagents

Session-scoped subagents for [Pi](https://github.com/earendil-works/pi), with background tasks, automatic results, steering, and a live session viewer. Children share the parent's working directory and process, but start with independent conversation context. No additional Pi process or child TUI is started.

Requires **Pi 1.1.0 or newer** and **Node.js 22.19 or newer**. Pi supplies the SDK and UI packages. For development, use the latest Pi release.

## Install

```bash
pi install git:github.com/zhengyongjie16/pi-subagents@main
```

## Interface

### Status widget

A summary above the editor shows agent counts and active work:

```text
● Agents · 2 running · 3 completed · 1 failed · 1 interrupted · /subagents to view details
├─ ⠹ /review-auth · openai-codex/gpt-6.1-sol/max · 33.8k token (62% · ↓1) · 12s
│    ⎿ reading…
└─ ⠹ /tests · anthropic/claude-sonnet-4-6/high · 8.2k token (12%) · 4s
     ⎿ thinking…
```

Each active row shows the model, thinking level, elapsed time, and current activity. Counts reflect each agent's latest run. `token` is cumulative assistant usage (`input + output + cacheWrite`), not current context size or a billing total; the percentage shows context occupancy, and `↓1` means one compaction.

### Browser and live overlay

`/subagents` opens the current session's agent browser, with status, elapsed time, model, thinking level, and task previews. It also offers a read-only all-sessions view.

The live overlay shows conversation and tool activity, including output already streaming when opened. Tool results use Pi's native collapsed previews and the child's working directory. These views are available in interactive TUI mode.

| View | Keys | Action |
| --- | --- | --- |
| Browser | Tab | Switch between current and all sessions |
| Browser | Enter / r | Open an agent / refresh the list |
| Overlay | Left / Right | Switch agents within the browser scope |
| Overlay | g / G | Jump to the top / follow the latest output |
| Both | Up / Down or j / k | Move selection or scroll output |
| Both | q / Esc | Close the view |

An optional `shortcut` setting opens the browser directly; no shortcut is assigned by default.

## Tools

| Tool | Purpose |
| --- | --- |
| `spawn_agent` | Start fresh-context background work |
| `wait_agent` | Wait for one completion; return its name and status |
| `list_agents` | List session-scoped agents, with pagination and an optional all-sessions view |
| `read_agent_response` | Read the latest run status and available response/error without waiting |
| `send_message` | Steer active work or continue a saved session |
| `interrupt_agent` | Request cooperative cancellation while preserving history |

Names are unique within each parent session. Read and control tools stay within that scope; cross-session access through `list_agents(include_all: true)` and the browser is read-only.

## Agent templates

Optional Markdown templates define roles, tools, model preferences, and badge colors. No templates are installed automatically.

```text
~/.pi/agent/pi-subagents/agents/*.md
```

Example `reviewer.md`:

```md
---
name: reviewer
description: Focused read-only code review
color: blue
tools: read,grep,find,ls
---

Review the assigned files without modifying them. Return concise findings with file paths.
```

`model` and `thinking` inherit from the parent unless specified. A template model uses its `provider` when set, otherwise the parent's provider; without a model, both provider and model inherit. `color` accepts supported names such as `blue` or a six-digit hex color.

### Tools and extensions

`tools` accepts a comma-separated allowlist or Pi tool modifiers such as `-codemode`. When omitted, children use Pi's normal tool activation if extensions are configured; otherwise they inherit the parent's active tool names, not their extension implementations. `tools: ""` disables built-in tools, not extension tools.

`extensions` accepts comma-separated local paths or npm packages already installed by Pi. Relative paths beginning with `./` or `../` resolve from the child's working directory; packages resolve from project-local Pi packages before global ones. Missing entries fail startup rather than being installed automatically.

A non-empty template extension list replaces `defaults.extensions`; an empty or omitted value inherits it. `+codemode` enables Pi's native codemode, preserving Pi's default tools and codemode settings. An explicit tool allowlist must include `codemode` to make it available. Other extensions and MCP servers are not loaded implicitly.

### Prompts and resources

The base system prompt comes from `~/.pi/agent/pi-subagents/SYSTEM.md`, created with a minimal default on first use. Template text is prepended to the first task message, not used as a separate system prompt.

Skills follow Pi's native discovery, settings, and project trust; parent-session skill selections are not copied. Automatic extension, prompt-template, theme, and context-file discovery is disabled, including `AGENTS.md` and `CLAUDE.md`. Only explicitly configured extensions are loaded.

Children use the parent's effective trust decision for the same working directory. Other directories follow Pi's trust store and headless policy.

## Configuration

Optional settings live in `~/.pi/agent/pi-subagents/config.json`:

```json
{
  "retentionDays": 7,
  "maxIdleSessions": 4,
  "modelResponseTimeoutMs": 600000,
  "modelsFromEnabledModels": true,
  "defaults": {
    "extensions": ["+codemode"]
  }
}
```

| Setting | Default | Purpose |
| --- | --- | --- |
| `storageDir` | `~/.pi/agent/pi-subagents/runs` | Run history; accepts absolute, home-relative, or config-directory-relative paths |
| `retentionDays` | `7` | Remove expired inactive runs and saved outputs at manager startup; `0` disables cleanup |
| `maxIdleSessions` | `4` | LRU cap on idle SDK sessions, not active tasks; `0` closes sessions after each run |
| `modelResponseTimeoutMs` | `600000` | Per-assistant-response timeout, excluding tools and total task runtime; `0` disables it |
| `shortcut` | Unbound | Browser shortcut, for example `ctrl+shift+a` |
| `models` | None | Exact `provider/model-id` pairs allowed for per-task model overrides |
| `modelsFromEnabledModels` | `false` | Add Pi's scoped models from `enabledModels` and `--models` |
| `defaults.extensions` | None | Extensions used unless a template supplies a non-empty replacement list |

Template/default-extension changes apply to new agents; model-routing changes apply when a parent session starts. The response timeout is read for each new assistant response. Reload Pi after shortcut or resource changes; restart after changing storage, retention, or idle-session policy. Keep storage separate from Pi's native session directory to avoid child entries in `/resume`; changing its location does not move existing history.

### Model routing

The two model sources form a deduplicated allowlist. Per-task `model` and `thinking` overrides are available only when at least one allowed model is available, and each is independently optional. Explicit overrides take precedence over the template, then parent inheritance. The allowlist limits explicit model overrides, not template or inherited models.

Unavailable allowlist entries produce warnings. A selected model is validated against the child's registry and fails rather than silently falling back. Extension-provided models require their provider extension to be configured in the child. Thinking is clamped to model support; thinking suffixes in Pi's scoped-model patterns are not inherited.

## Behavior and limits

- **Automatic results:** completed and failed runs notify the parent, including during a wait; an uninterrupted idle parent starts a continuation turn. Waiting returns one name/status, not the response text, and does not replay notifications. Interrupted runs can satisfy a wait without emitting a completion notification. Canceling a wait does not stop the agent.
- **Session reuse:** completion, ordinary model errors, and interruption leave sessions reusable once pending work drains. Reclaimed sessions reopen saved history; missing history is an error. Template edits do not change existing agents' saved configuration. Reused sessions keep loaded resources; rebuilt sessions reread the system prompt and rediscover skills.
- **Shared process:** cancellation is cooperative and does not undo completed tool actions. Child extensions run headlessly and share the host's event loop and module state; unresponsive tools or extensions can affect the parent.
- **Output:** notifications and response text use a 50 KB / 2,000-line truncation budget. Full output is saved under `storageDir/_outputs`, with a readable path in the notice. Structured response data remains complete even when the text preview is truncated.

## License

Originally created by **[Can Celik (ogulcancelik)](https://github.com/ogulcancelik)** as [`pi-codex-subagents`](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-codex-subagents). This standalone fork is maintained by [zhengyongjie16](https://github.com/zhengyongjie16).

[MIT](LICENSE). Original work copyright (c) 2025 Can Celik; modifications copyright (c) 2026 zhengyongjie16.
