# pi-subagents

Session-scoped subagents for [Pi](https://github.com/earendil-works/pi). Run fresh-context SDK sessions inside the parent Pi process, receive their final responses automatically, steer active work, and inspect sessions in the existing live overlay. No separate Pi agent engine or child TUI is started.

Originally created by **[Can Celik (ogulcancelik)](https://github.com/ogulcancelik)** as [`pi-codex-subagents`](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-codex-subagents). This standalone fork is maintained by [zhengyongjie16](https://github.com/zhengyongjie16). The original author's copyright notice and MIT license are preserved.

Requires **Pi 1.0.0 or newer** and Node.js 22.19 or newer. Pi supplies the SDK and UI packages. Development dependencies are pinned to Pi 1.5.0.

## Install

```bash
pi install git:github.com/zhengyongjie16/pi-subagents@main
```

For local development:

```bash
pi install /absolute/path/to/pi-subagents
```

## Tools

| Tool                  | Purpose                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `spawn_agent`         | Start a fresh-context SDK session and return after task acceptance     |
| `wait_agent`          | Block for one completion and return its final text                     |
| `list_agents`         | List current-session agents, or explicitly include historical sessions |
| `read_agent_response` | Read an agent's latest final raw text response                         |
| `send_message`        | Steer a running agent or start another turn when settled               |
| `interrupt_agent`     | Request cooperative cancellation while preserving session history      |

Agent names are unique within their parent session. The same task name can exist safely in different Pi sessions. Read and control tools are always scoped to the current parent session; only `list_agents(include_all: true)` crosses session boundaries, and that view is read-only.

## Agent templates

Templates are user-defined Markdown files in:

```text
~/.pi/agent/pi-subagents/agents/*.md
```

No templates are installed automatically. Example:

```md
---
name: reviewer
description: Focused read-only code review agent
provider: openai-codex
model: gpt-5.6-sol
thinking: high
tools: read,bash,grep,find,ls
extensions: @scope/pi-extra-tools, ~/.pi/agent/extensions/local-helper.ts
hint: Give this reviewer exact file paths and a narrow scope.
---

You are a focused review subagent. Return concise findings with file paths.
```

`provider` and `model` are optional. A template `model` uses its `provider` when set, otherwise the parent's current provider. When `model` is omitted, the child inherits both the parent's provider and model. `thinking` is also optional and otherwise inherits the parent. Template `tools` override inherited tool names.

`extensions` may contain local files/directories or npm package names already installed by Pi. Package names are resolved from project-local packages first and then Pi's global npm directory. Missing packages are never installed automatically.

When a template loads extensions but omits `tools`, the child uses Pi's normal tool activation so tools registered by those extensions are available. Set template `tools` when you want an explicit allowlist. Without configured extensions, omitted template tools inherit the parent's active tool names.

Children discover skills through Pi's native resource loader, using their working directory, Pi settings, and effective project trust. With a file-reading tool available, model-invocable skill names, descriptions, and locations are advertised to the model; full instructions are read when needed. Parent-session skill selections are not copied. This extension does not support `spawn_agent.skills`, template `skills`, or `defaults.skills`; remove those keys from existing callers and configurations. Existing history is not migrated, and legacy skill fields in saved run metadata no longer control resource loading.

Automatic extension, prompt-template, theme, and context-file discovery remains disabled. `AGENTS.md` and `CLAUDE.md` files are excluded from automatic loading. Each child replaces Pi's default coding prompt with the contents of `~/.pi/agent/pi-subagents/SYSTEM.md`, and loads only explicitly configured extensions. This file is created with a minimal subagent prompt when first used and can be edited directly. If the selected model comes from an extension-registered provider, add that provider extension to the selected template or configured defaults so the child can resolve it.

For the parent's working directory, each creation/resume uses the parent's current project-trust decision. Other directories follow Pi's trust store and headless policy.

## Configuration

Optional configuration lives at:

```text
~/.pi/agent/pi-subagents/config.json
```

```json
{
  "storageDir": "~/.local/state/pi-subagents/runs",
  "retentionDays": 7,
  "modelResponseTimeoutMs": 600000,
  "models": ["openai-codex/gpt-5.6-sol", "anthropic/claude-opus-4-6"],
  "modelsFromEnabledModels": true,
  "defaults": {
    "extensions": ["@scope/pi-extra-tools"]
  }
}
```

`storageDir` accepts an absolute path, `~/...`, or a path relative to the package configuration directory. By default runs are stored in `~/.pi/agent/pi-subagents/runs`. `retentionDays` defaults to `7`; expired runs and oversized tool outputs are removed when the agent manager initializes. Set it to `0` to disable automatic cleanup. Observer sockets remain in the operating system temporary directory and are removed on session cleanup. Keep `storageDir` separate from Pi's native session directory to keep child sessions out of `/resume`.

`modelResponseTimeoutMs` limits one model response, from assistant message start to completion, and defaults to 10 minutes. It does not limit tool execution or the agent's total runtime. A response that exceeds this limit is marked failed and cooperative SDK cancellation is requested. Set it to `0` to disable this guard.

`shortcut` optionally binds a key to the subagent browser, for example `"shortcut": "ctrl+shift+a"`. No shortcut is assigned by default; omit it or set it to `""` to leave it unbound. Run `/reload` after changing it.

Configuration is read when agents spawn, while cleanup runs when the agent manager initializes. Restart Pi after changing `storageDir` or `retentionDays` so storage lookup and cleanup use the same configuration throughout the process.

Template extensions override configured defaults. Tool selection belongs to the template or is inherited from the parent. A `model` and `thinking` level requested by the parent override the template and the inherited values, so one task can run on another model without a template.

## Model routing

An allowlist in `config.json` decides whether a parent may request a `model` and a `thinking` level per spawn, and which models it may pick. Both arguments appear together or not at all: an installation that configures nothing keeps routing in templates and inheritance. Two sources may be combined:

- `models` lists exact `provider/model-id` pairs approved for this extension alone, independent of any Pi setting.
- `modelsFromEnabledModels: true` adds the models Pi already scoped for the session, resolved from the `enabledModels` setting and `--models`. Models approved for the installation need no second approval here, and Pi has already expanded globs, preferred aliases over dated versions, and dropped unavailable entries. When Pi has no model scoping configured, this source adds nothing.

The arguments are offered only when at least one allowed model is available, and `model` enumerates exactly those pairs:

| Configuration | Allowed and available | `model` and `thinking` on the tool |
| --- | --- | --- |
| neither key set | — | absent, routing belongs to templates |
| `"modelsFromEnabledModels": true`, Pi scoping unset | — | absent |
| `"modelsFromEnabledModels": true`, Pi scoping set | 2 models | present, `model` lists those 2 pairs |
| `"models": ["typo/xyz"]` | nothing available | absent, entry reported as a notification |
| both keys set | the union, deduplicated | present, `model` lists the union |

The list is resolved when a session starts: `models` entries are filtered to what is currently available, unavailable entries are reported as a warning notification, and the scoped models are merged in. Editing the configuration or the Pi setting takes effect when the next session starts. If a provider drops out mid-session, `spawn_agent` refuses that model at spawn time instead of serving a stale route.

An allowed model may belong to an extension-registered provider. Load that provider extension through a template or configured defaults so the child can resolve it. Each child validates the exact provider/model pair against its own available registry before accepting a task. Resumptions reuse and revalidate the pair saved at spawn.

A thinking level written into an `enabledModels` pattern, such as `anthropic/claude-opus-4-6:high`, is ignored here. `thinking` stays a separate argument, and the child clamps it to what its model supports.

## Completion delivery

A child completion or failure is delivered automatically to its parent session after the child reaches final status. If the parent is active, the result joins the current run; if the parent is idle, it starts a continuation turn. Continue independent work instead of waiting. Use `wait_agent` only when the next action depends on that response and no useful work remains meanwhile; an active wait receives the result directly without a duplicate automatic message.

## Commands and TUI

While agents are starting or running, a compact one-line indicator appears above the editor. It shows the task name for one active agent or a count for multiple agents and points to `/subagents`. The indicator disappears when no agents are active.

`/subagents` opens the agent browser for the current session. Each row shows the task name, status, elapsed time, model, and thinking level, with the task preview underneath. Long names are shortened to fit the terminal. Press Tab to switch to the read-only all-sessions view, then Enter to open an agent.

The overlay uses the child working directory for tool rendering and synchronizes in-progress output when opened midway through a run. Tool output uses Pi's native collapsed previews. Use Left/Right to switch between agents in the current browser scope.

Child SDK sessions are disposed after completion, failure, or interruption, once initialization and submitted work have exited. `send_message` creates a fresh SDK session with the persisted history and continues from there. On startup, the extension marks inactive starting or running records as interrupted.

Cancellation is cooperative within the shared Pi process. Unresponsive tools or extensions can delay cleanup and affect the parent. Child extensions run in headless `print` mode (`hasUI: false`) and share the host's event loop and module state.

## Output limits

Automatic completions, wait tools, and response tools follow Pi's standard 50 KB / 2,000-line output limit. Oversized output is truncated and the complete text is written beside the runtime data; the returned notice includes a path that can be read with Pi's `read` tool.

## License

[MIT](LICENSE). Original work copyright (c) 2025 Can Celik; modifications copyright (c) 2026 zhengyongjie16.
