# pi-subagents

Session-scoped subagents for [Pi](https://github.com/earendil-works/pi), with background tasks, automatic results, steering, and a live session viewer. Children share the parent's working directory and process, but start with independent conversation context. No additional Pi process or child TUI is started.

This extension originated as a fork of [pi-codex-subagents](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-codex-subagents). Following extensive refactoring, it is now maintained in a standalone repository, as there is no longer a need to track upstream updates. The original project is an excellent project.

Requires **Pi 1.1.0 or newer** and **Node.js 22.19 or newer**. Pi supplies the SDK and UI packages. For development, use the latest Pi release.

## Install

```bash
pi install git:github.com/zhengyongjie16/pi-subagents@main
```

## Interface

### Status widget

A summary above the editor shows agent counts and active work:

```text
● Agents · 2 running · 3 completed · 1 errored · 1 interrupted · /subagents to view details
├─ ⠹ review-auth · openai-codex/gpt-6.1-sol/max · 33.8k token (62% · ↓1) · 12s
│    └─ read...
└─ ⠹ tests · anthropic/claude-sonnet-4-6/high · 8.2k token (12%) · 4s
     └─ Thinking...
```

Each active row shows the model, thinking level, elapsed time, and current activity. Tool activity uses the names reported by Pi and shows the innermost active calls on each branch. Counts reflect each agent's latest run. Agents in `pending_init` count as `running` and show `initializing…` as their activity. `token` is cumulative assistant usage (`input + output + cacheWrite`), not current context size or a billing total; the percentage shows context occupancy, and `↓1` means one compaction.

### Browser and live overlay

`/subagents` groups current-session agents, including unloaded history, into **Active** (`pending_init`, `running`) first, then **Done** (`completed`, `errored`, `interrupted`). The Active group is hidden when empty; Done is always shown. Active agents are newest-created first; Done agents are latest-finished first, using the latest run's `completedAt`, falling back to `updatedAt` and then `createdAt`. Each row shows status, elapsed time, model, thinking level, and a task preview. Visible group headings stay aligned with the browser title while scrolling through a shared ten-agent window; an empty Done group shows an empty-state message. Press `r` to refresh saved statuses and ordering.

Enter opens details over the existing browser without closing it. Esc or q in details closes only the overlay and returns focus to the same list and selected agent; Esc or q in the browser exits it. The live overlay shows conversation and tool activity, including output already streaming when opened. Tool results use Pi's native collapsed previews and the child's working directory. These views are available in interactive TUI mode.

| View | Keys | Action |
| --- | --- | --- |
| Browser | Enter / r | Open an agent / refresh the list |
| Overlay | Left / Right | Cycle through current-session agents in browser order (Active, then Done) |
| Overlay | g / G | Jump to the top / follow the latest output |
| Both | Up / Down or j / k | Move selection or scroll output |
| Both | q / Esc | Close the view |

An optional `shortcut` setting opens the browser directly; no shortcut is assigned by default.

## Tools

| Tool | Purpose |
| --- | --- |
| `spawn_agent` | Start fresh-context background work |
| `wait_agent` | Wait for new input, an agent notification, or a timeout; return a message and `timed_out` |
| `list_agents` | List current-session resident subagents and their latest run results without waiting |
| `send_message` | Steer active work or continue a saved session |
| `interrupt_agent` | Request cooperative cancellation while preserving history |

## Agent templates

Three built-in templates are available without creating any template files:

| Template | Purpose |
| --- | --- |
| `explorer` | Focused codebase questions and independent exploration |
| `general` | General-purpose work |
| `worker` | Implementation, fixes, and refactoring; its task prefix reminds it to preserve others' edits |

Built-ins do not pin a provider, model, thinking level, tools, or extensions; they follow the normal inheritance rules below. None sets a fixed `color`. Omitting `agent_type` still creates a generic subagent, without applying `general` or another template.

Optional Markdown templates define additional roles or replace built-ins:

```text
~/.pi/agent/pi-subagents/agents/*.md
```

A successfully loaded user template replaces the **entire** built-in definition with the same `name` (or filename when `name` is omitted). Omitted fields follow normal parent/default inheritance, not the built-in definition. Names are case-sensitive. If user files declare the same name, the first discovered definition is used. Removing all valid overrides for a name restores its built-in. Unreadable or invalid files are warned about and skipped, so a built-in may be used instead; resolve loading warnings when relying on custom behavior. Once a template loads, model, extension, or runtime failures remain errors and do not fall back to a built-in.

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

`model` and `thinking` inherit from the parent unless specified. A template model uses its `provider` when set, otherwise the parent's provider; without a model, both provider and model inherit.

`color` sets the background of the agent's name badge in the widget and browser. A valid template `color` (a supported name such as `blue` or a six-digit hex color) takes precedence. If it is missing, empty, or invalid, one color is drawn at random from the existing named palette at creation and saved for that agent.

### Tools and extensions

`tools` accepts a comma-separated allowlist or Pi tool modifiers such as `-codemode`. When omitted, new children use Pi's effective `defaultTools` and normal extension-tool activation, whether or not extensions are configured. They do not inherit the parent's current active tools. `tools: ""` disables default built-in tools, not extension tools; native codemode and tool search also start inactive.

`extensions` accepts comma-separated local paths or npm packages already installed by Pi. Relative paths beginning with `./` or `../` resolve from the child's working directory; packages resolve from project-local Pi packages before global ones. Missing entries fail startup rather than being installed automatically.

A non-empty template extension list replaces the top-level `extensions` in `config.json`; an empty or omitted value inherits it. Native `codemode` and `tool_search` implementations are provided inactive, so Pi's `defaultTools` or an explicit `tools` selection can enable them without configuring extensions. `+codemode` remains an explicit opt-in when it is not already a default tool, preserving Pi's other default tools and codemode settings. An explicit tool allowlist must include `codemode` to make it available. Third-party extensions and MCP servers are not loaded implicitly.

### Prompts and resources

Under `~/.pi/agent/pi-subagents/`, optional `SYSTEM.md` replaces the default base, including the built-in rule above; missing or blank content uses native defaults. Optional `APPEND_SYSTEM.md` appends user instructions to either base without replacing it.

Generated prompts sent to the model retain only the base, tools, rules, and appended instructions; generated docs, skill summaries, and cwd sections are omitted. User-authored text and tool declarations are unchanged. Global/project `SYSTEM.md` and `APPEND_SYSTEM.md` are not loaded automatically.

Skills follow Pi's native discovery, settings, and project trust; parent-session skill selections are not copied. Automatic extension, prompt-template, theme, and context-file discovery is disabled, including `AGENTS.md` and `CLAUDE.md`. Apart from the native codemode and tool-search providers, only explicitly configured extensions are loaded.

Children use the parent's effective trust decision for the same working directory. Other directories follow Pi's trust store and headless policy.

## Configuration

Optional settings live in `~/.pi/agent/pi-subagents/config.json`:

```json
{
  "retentionDays": 14,
  "maxAgents": 5,
  "modelResponseTimeoutMs": 600000,
  "modelsFromEnabledModels": true,
  "extensions": ["+codemode"]
}
```

| Setting | Default | Purpose |
| --- | --- | --- |
| `storageDir` | `~/.pi/agent/pi-subagents/runs` | Run history; accepts absolute, home-relative, or config-directory-relative paths |
| `retentionDays` | `14` | Remove expired inactive runs and saved outputs at manager startup; `0` disables cleanup |
| `maxAgents` | `5` | Shared resident-session cap per `AgentManager`, excluding the main agent |
| `modelResponseTimeoutMs` | `600000` | Per-assistant-response timeout, excluding tools and total task runtime; `0` disables it |
| `shortcut` | Unbound | Browser shortcut, for example `ctrl+shift+a` |
| `models` | None | Exact `provider/model-id` pairs allowed for per-task model overrides |
| `modelsFromEnabledModels` | `false` | Add Pi's scoped models from `enabledModels` and `--models` |
| `extensions` | None | Extensions used unless a template supplies a non-empty replacement list |

`maxAgents` must be a positive safe integer; invalid values, including `0`, cause a configuration error. Legacy `maxIdleSessions` is ignored with a migration warning; replace it with `maxAgents`. The old `maxIdleSessions: 0` close-after-each-run mode is no longer supported.

Template/default-extension changes apply to new agents; model-routing changes apply when a parent session starts. New agents without `tools` use current Pi defaults; existing agents retain saved explicit or legacy tool selections, and cold resumes follow Pi's native tool-history restoration rather than forcing the latest defaults. Parent-only tool restrictions no longer carry over: configure a template allowlist when needed. The response timeout is read for each new assistant response. Reload Pi after shortcut or resource changes; restart after changing storage, retention, or `maxAgents`. Keep storage separate from Pi's native session directory to avoid child entries in `/resume`; changing its location does not move existing history.

### Model routing

The two model sources form a deduplicated allowlist. Per-task `model` and `thinking` overrides are available only when at least one allowed model is available, and each is independently optional. Explicit overrides take precedence over the template, then parent inheritance. The allowlist limits explicit model overrides, not template or inherited models.

Unavailable allowlist entries produce warnings. A selected model is validated against the child's registry and fails rather than silently falling back. Extension-provided models require their provider extension to be configured in the child. Thinking is clamped to model support; thinking suffixes in Pi's scoped-model patterns are not inherited.

## Behavior and limits

- **Automatic results:** the parent receives a notification with `agent_name` and `status`. A `completed` notification carries `final_response` (`null` if there is no final text); an `errored` notification carries `error`. Interrupted runs do not send a result notification. A notification starts a continuation turn when the parent is idle and has not been interrupted. During an active wait, the notification wakes the wait without starting an extra turn.
- **Activity waits:** use `wait_agent` only when blocked, with `{}` or an optional `timeout_ms` integer/null. Omitted/null defaults to 30,000 ms; values below 10,000 ms (including zero and negatives) are raised to 10,000 ms, and values above 3,600,000 ms are rejected. Clamped waits append an explanation to the message. There are no `targets`: a wait observes parent input from every source (including extension and follow-up input), agent notifications, or timeout—not a particular child's terminal status. It returns only `{ "message": "...", "timed_out": false }`: `Wait completed.` for a notification, `Wait interrupted by new input.` for input, or `Wait timed out.` with `timed_out: true`. The input and notification still reach Pi separately; use `list_agents` for a non-blocking reread while the child is resident. The latest activity before a wait can satisfy it immediately and is consumed once; old pending activity is cleared before preparing the next model context. Canceling a wait does not stop agents. Session changes cancel waits and clear pending activity.
- **Capacity:** Within one `AgentManager`, initializing, active, idle, and closing sessions (until cleanup completes) share `maxAgents`. A spawn or cold resume at capacity reclaims the least-recently-used safely idle session and waits for cleanup before starting; without a safe candidate, it fails with a capacity error rather than queuing. Hot continuations reuse their slot. Completion does not trigger idle-only trimming.
- **Session reuse:** completion, ordinary model errors, and interruption leave sessions reusable once pending work drains. Reclaimed sessions reopen saved history; missing history is an error. Template edits do not change existing agents' saved configuration. Reused sessions keep loaded resources; rebuilt sessions reread both prompt files and rediscover skills.
- **Shared process:** cancellation is cooperative and does not undo completed tool actions. Child extensions run headlessly and share the host's event loop and module state; unresponsive tools or extensions can affect the parent.
- **Output:** completion notifications and the `list_agents` text preview cap the preview body at 50 KB / 2,000 lines. The truncation notice gives the full output path under `storageDir/_outputs` or reports the write error. The complete `list_agents` result remains available in `structuredContent`.

## License

[MIT](LICENSE). Original work copyright (c) 2025 Can Celik; modifications copyright (c) 2026 zhengyongjie16.
