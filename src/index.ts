import { isAbsolute, relative, sep } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolRenderers,
} from '@earendil-works/pi-coding-agent';
import {
  createCodemodeExtension,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  formatSize,
  truncateHead,
} from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import {
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type KeyId,
} from '@earendil-works/pi-tui';
import {
  AgentManager,
  formatAgentError,
  getAgentDefinitionsDescription,
  getRunsDir,
  loadSubagentConfig,
  previewText,
  TASK_PATH_PATTERN,
  THINKING_LEVELS,
  type AgentCompletionEvent,
  type AgentInfo,
  type AgentWidgetSnapshot,
  type ThinkingLevel,
  writeFullToolOutput,
} from './core.js';
import { SubagentPeekOverlay } from './peek.js';
import {
  agentStatusColor,
  paintAgentLine,
  renderAgentBadge,
  resolveAgentColor,
  sanitizeAgentText,
} from './color.js';
import { AgentSummaryWidget, type AgentStatusCounts } from './widget.js';

type ToolRenderContext = Parameters<NonNullable<ToolRenderers['renderResult']>>[3];
type InputActivity = 'MailboxActivity' | 'Steered';
type InputWaitOutcome = InputActivity | 'TimedOut';

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MIN_WAIT_TIMEOUT_MS = 10_000;
const MAX_WAIT_TIMEOUT_MS = 3_600_000;

const agentStatusSchema = Type.Union([
  Type.Literal('pending_init'),
  Type.Literal('running'),
  Type.Literal('interrupted'),
  Type.Object(
    { completed: Type.Union([Type.String(), Type.Null()]) },
    { additionalProperties: false },
  ),
  Type.Object({ errored: Type.String() }, { additionalProperties: false }),
]);

function textResult(text: string, details?: any) {
  return { content: [{ type: 'text' as const, text }], details };
}

interface BoundedText {
  text: string;
  fullOutputPath?: string;
  truncated?: true;
}

function boundedText(
  text: string,
  maxBytes = DEFAULT_MAX_BYTES,
  maxLines = DEFAULT_MAX_LINES,
): BoundedText {
  const truncation = truncateHead(text, { maxBytes, maxLines });
  if (!truncation.truncated) return { text };
  const preview = `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
  try {
    const fullOutputPath = writeFullToolOutput(text);
    return {
      text: `${preview} Full output saved to: ${fullOutputPath}]`,
      fullOutputPath,
      truncated: true,
    };
  } catch (error) {
    return {
      text: `${preview} Could not save full output: ${formatAgentError(error)}]`,
      truncated: true,
    };
  }
}

function parentSessionId(ctx: any): string {
  const id = ctx?.sessionManager?.getSessionId?.();
  if (!id) throw new Error('The parent Pi session has no session id.');
  return String(id);
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatColumn(text: string, width: number): string {
  const clipped = sanitizeAgentText(truncateToWidth(sanitizeAgentText(text), width));
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
}

function runtimeLabel(info: AgentInfo): string {
  const start = info.startedAt || info.createdAt;
  const final = ['completed', 'errored', 'interrupted'].includes(info.status);
  const end = final ? info.completedAt || info.updatedAt || Date.now() : Date.now();
  return formatDuration(end - start);
}

function browserTimestamp(...values: (number | undefined)[]): number {
  return values.find((value) => typeof value === 'number' && Number.isFinite(value)) ?? 0;
}

/** Presentation-only grouping; keep the public list tool's ordering unchanged. */
function listBrowserAgents(manager: AgentManager, scopeId: string) {
  const infos = manager.listAgentInfos(undefined, scopeId);
  const active = infos.filter(
    (info) => info.status === 'pending_init' || info.status === 'running',
  );
  active.sort(
    (a, b) =>
      browserTimestamp(b.createdAt) - browserTimestamp(a.createdAt) || a.id.localeCompare(b.id),
  );
  const done = infos.filter((info) =>
    ['completed', 'errored', 'interrupted'].includes(info.status),
  );
  done.sort(
    (a, b) =>
      browserTimestamp(b.completedAt, b.updatedAt, b.createdAt) -
        browserTimestamp(a.completedAt, a.updatedAt, a.createdAt) ||
      browserTimestamp(b.createdAt) - browserTimestamp(a.createdAt) ||
      a.id.localeCompare(b.id),
  );
  return { active, done };
}

export default async function index_(pi: ExtensionAPI) {
  let nativeCodemodeRenderers: ToolRenderers = {};
  // Collect native codemode presentation hooks.
  await createCodemodeExtension()({
    ...pi,
    registerTool(definition) {
      if (definition.name !== 'codemode') return;
      const renderers = defineTool(definition);
      nativeCodemodeRenderers = {
        renderShell: renderers.renderShell,
        renderCall: renderers.renderCall,
        renderResult: renderers.renderResult,
      };
    },
  });
  if (!nativeCodemodeRenderers.renderCall || !nativeCodemodeRenderers.renderResult) {
    throw new Error('Native codemode renderers are unavailable.');
  }

  const completionMessageType = 'pi-subagent-completion';
  let activeContext: any;
  let widgetContext: any;
  // Pi exposes cancellation events, but no persistent interrupted-state query.
  let parentInterrupted = false;
  let pendingActivity: InputActivity | undefined;
  const inputWaiters = new Set<{
    resolve: (outcome: InputWaitOutcome) => void;
    cancel: (reason: unknown) => void;
  }>();

  const recordInputActivity = (activity: InputActivity) => {
    if (!inputWaiters.size) {
      pendingActivity = activity;
      return;
    }
    // One activity wakes every current wait; it is not replayed to the next wait.
    for (const waiter of inputWaiters) waiter.resolve(activity);
  };

  const waitForInput = (timeoutMs: number, signal?: AbortSignal): Promise<InputWaitOutcome> => {
    signal?.throwIfAborted();
    if (pendingActivity !== undefined) {
      const activity = pendingActivity;
      pendingActivity = undefined;
      return Promise.resolve(activity);
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        inputWaiters.delete(waiter);
      };
      const waiter = {
        resolve(outcome: InputWaitOutcome) {
          cleanup();
          resolve(outcome);
        },
        cancel(reason: unknown) {
          cleanup();
          reject(reason);
        },
      };
      const onAbort = () => waiter.cancel(signal?.reason);
      const timer = setTimeout(() => waiter.resolve('TimedOut'), timeoutMs);
      inputWaiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  };

  const clearInputActivity = () => {
    pendingActivity = undefined;
    for (const waiter of inputWaiters)
      waiter.cancel(new DOMException('Session lifecycle changed.', 'AbortError'));
  };

  const agentStatuses = new Map<string, AgentInfo['status']>();
  const agentColors = new Map<string, string>();
  let widgetStatusCounts: AgentStatusCounts = {
    running: 0,
    completed: 0,
    errored: 0,
    interrupted: 0,
  };

  type SpawnModel = { provider: string; modelId: string };

  const exactPair = (
    pattern: string,
    available: Map<string, SpawnModel>,
  ): SpawnModel | undefined => {
    const colon = pattern.lastIndexOf(':');
    // Exact registered IDs take precedence over thinking-suffix parsing.
    const reference =
      !available.has(pattern) &&
      colon > 0 &&
      (THINKING_LEVELS as readonly string[]).includes(pattern.slice(colon + 1))
        ? pattern.slice(0, colon)
        : pattern;
    if (/[*?[\]]/.test(reference)) return undefined;
    return available.get(reference);
  };

  let spawnModels = new Map<string, SpawnModel>();

  const resolveSpawnModels = (ctx: ExtensionContext) => {
    const config = loadSubagentConfig();
    const models = new Map<string, SpawnModel>();
    const available = new Map<string, SpawnModel>();
    for (const { provider, id } of ctx.modelRegistry.getAvailable()) {
      const reference = `${provider}/${id}`;
      const previous = available.get(reference);
      // Providers can contain slashes; ambiguous references follow Pi's longest-provider rule.
      if (!previous || provider.length > previous.provider.length)
        available.set(reference, { provider, modelId: id });
    }
    const unavailable: string[] = [];
    for (const entry of config.models ?? []) {
      const pair = exactPair(entry, available);
      if (pair) models.set(`${pair.provider}/${pair.modelId}`, pair);
      else unavailable.push(entry);
    }
    if (config.modelsFromEnabledModels) {
      for (const { model } of ctx.scopedModels ?? [])
        models.set(`${model.provider}/${model.id}`, {
          provider: model.provider,
          modelId: model.id,
        });
    }
    if (unavailable.length)
      ctx.ui?.notify?.(`spawn_agent models not available: ${unavailable.join(', ')}`, 'warning');
    return models;
  };

  const isCurrentSession = (parentId: string) => {
    try {
      return activeContext && parentSessionId(activeContext) === parentId;
    } catch {
      return false;
    }
  };

  const refreshAgentWidget = () => {
    if (activeContext?.mode !== 'tui') return;
    // Recount only on lifecycle events, never on the 200ms rendering ticks.
    const counts = { running: 0, completed: 0, errored: 0, interrupted: 0 };
    for (const status of agentStatuses.values())
      counts[status === 'pending_init' ? 'running' : status]++;
    widgetStatusCounts = counts;
    widgetContext = activeContext;
    agentWidget.attach(activeContext);
  };

  const deliverCompletion = (event: AgentCompletionEvent) => {
    if (!isCurrentSession(event.parentSessionId)) return;
    const waiting = inputWaiters.size > 0;
    const payload = JSON.stringify(
      {
        agent_name: event.taskName,
        status: event.status,
        ...(event.status === 'completed'
          ? { final_response: event.finalResponse }
          : { error: event.error }),
      },
      null,
      2,
    );
    const bounded = boundedText(payload, DEFAULT_MAX_BYTES - 1024, DEFAULT_MAX_LINES - 4);
    pi.sendMessage(
      {
        customType: completionMessageType,
        content: `<subagent_notification>\n${bounded.text}\n</subagent_notification>`,
        display: true,
        details: {
          agent_name: event.taskName,
          status: event.status,
          ...(bounded.fullOutputPath ? { fullOutputPath: bounded.fullOutputPath } : {}),
        },
      },
      // Keep interrupted parents stopped; an active wait otherwise guarantees a next turn.
      {
        deliverAs: 'steer',
        triggerTurn:
          !parentInterrupted &&
          activeContext.signal?.aborted !== true &&
          (!waiting || activeContext.isIdle()),
      },
    );
    recordInputActivity('MailboxActivity');
  };

  const reportError = (error: unknown, ctx = activeContext) => {
    const errors = error instanceof AggregateError ? [error, ...error.errors] : [error];
    const message = `[subagents] ${errors.map(formatAgentError).join('\n')}`;
    try {
      if (ctx?.hasUI && typeof ctx.ui?.notify === 'function') {
        ctx.ui.notify(message, 'error');
        return;
      }
    } catch {} // Fall back to stderr if UI reporting fails.
    try {
      console.error(message);
    } catch {}
  };

  let manager: AgentManager | undefined;
  const agentWidget = new AgentSummaryWidget(
    () => {
      if (!activeContext) return [];
      const snapshots = manager?.getWidgetSnapshot(parentSessionId(activeContext)) ?? [];
      const names = new Set(snapshots.map((snapshot) => snapshot.taskName));
      // Preserve early-start and external-host indicators without polling storage.
      const fallback: AgentWidgetSnapshot[] = [];
      for (const [taskName, status] of agentStatuses) {
        if ((status === 'pending_init' || status === 'running') && !names.has(taskName))
          fallback.push({
            taskName,
            color: agentColors.get(taskName),
            status,
            activeTools: [],
          });
      }
      return [...snapshots, ...fallback];
    },
    (error) => reportError(error, widgetContext),
    () => widgetStatusCounts,
  );
  const ensureManager = (ctx: any): AgentManager => {
    activeContext = ctx;
    if (manager) return manager;
    manager = new AgentManager({
      // Read the parent's effective trust decision for each creation/resume.
      projectTrusted: (cwd) => {
        if (typeof activeContext?.cwd !== 'string' || relative(cwd, activeContext.cwd) !== '')
          return undefined;
        const trusted = activeContext.isProjectTrusted?.();
        return typeof trusted === 'boolean' ? trusted : undefined;
      },
      onError: reportError,
      onActivityChange: (event) => {
        if (!isCurrentSession(event.parentSessionId)) return;
        agentStatuses.set(event.taskName, event.status);
        refreshAgentWidget();
      },
      onCompletion: deliverCompletion,
    });
    // Check storage overlap with the parent's custom session directory.
    const sessionDir = ctx.sessionManager.getSessionDir?.();
    if (typeof sessionDir === 'string') {
      const storage = getRunsDir();
      const overlaps = [relative(sessionDir, storage), relative(storage, sessionDir)].some(
        (path) => !isAbsolute(path) && path.split(sep)[0] !== '..',
      );
      if (overlaps)
        reportError(
          new Error(
            `Subagent storageDir overlaps the parent session directory (${sessionDir}); child sessions may appear in /resume.`,
          ),
        );
    }
    return manager;
  };

  pi.registerMessageRenderer(
    completionMessageType,
    (message: any, { expanded }: any, theme: Theme) => {
      const { agent_name, status } = message.details;
      const color = agentStatusColor(status);
      let text = theme.fg(color, `${status === 'completed' ? '✓' : '✗'} ${agent_name} ${status}`);
      if (expanded && typeof message.content === 'string')
        text += `\n${theme.fg('dim', message.content)}`;
      return new Text(text, 0, 0);
    },
  );

  const spawnAgentTool = {
    name: 'spawn_agent',
    label: 'Spawn Agent',
    get description() {
      return `Spawn a subagent for a well-scoped task, sharing the parent's working directory but not its conversation. Returns on task acceptance; results and errors arrive automatically. Continue other assigned work; use wait_agent only when blocked.

Agent templates:
${getAgentDefinitionsDescription()}`;
    },
    get parameters() {
      return Type.Object({
        task_name: Type.String({
          description:
            'Unique in this parent session; use ASCII letters, digits, _, -, and internal / separators.',
        }),
        message: Type.String({
          description: 'Self-contained task: context, paths, constraints, and expected output.',
        }),
        agent_type: Type.Optional(
          Type.String({ description: 'Listed template name; omit for a generic subagent.' }),
        ),
        ...(spawnModels.size
          ? {
              // Wrap enum schemas so TypeBox keeps Optional metadata non-enumerable.
              model: Type.Optional(
                Type.Unsafe<string>(
                  StringEnum([...spawnModels.keys()], {
                    description: 'Model override; defaults to template, then parent.',
                  }),
                ),
              ),
              thinking: Type.Optional(
                Type.Unsafe<ThinkingLevel>(
                  StringEnum(THINKING_LEVELS, {
                    description:
                      'Reasoning effort; defaults to template, then parent, clamped to model support.',
                  }),
                ),
              ),
            }
          : {}),
      });
    },
    async execute(
      _toolCallId: string,
      params: any,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      ctx: any,
    ) {
      const currentModel = ctx.model;
      if (!currentModel?.provider || !currentModel?.id)
        throw new Error('spawn_agent failed: the parent has no active provider/model pair.');
      const model = params.model ? spawnModels.get(params.model) : undefined;
      if (params.model && !model)
        throw new Error(
          `spawn_agent failed: model "${params.model}" is not in the configured spawn models: ${[...spawnModels.keys()].join(', ') || 'none'}`,
        );
      if (
        model &&
        !ctx.modelRegistry
          .getAvailable()
          .some((entry: any) => entry.provider === model.provider && entry.id === model.modelId)
      ) {
        throw new Error(`spawn_agent failed: model "${params.model}" is not currently available.`);
      }
      if (params.thinking !== undefined) {
        if (!spawnModels.size)
          throw new Error(
            'spawn_agent failed: thinking overrides require configured spawn models.',
          );
        if (!THINKING_LEVELS.includes(params.thinking))
          throw new Error(
            `spawn_agent failed: thinking must be one of: ${THINKING_LEVELS.join(', ')}`,
          );
      }
      try {
        const manager = ensureManager(ctx);
        const result = await manager.spawnAgent({
          task_name: params.task_name,
          message: params.message,
          agent_type: params.agent_type,
          cwd: ctx.cwd,
          parentSessionId: parentSessionId(ctx),
          parentSessionFile: ctx.sessionManager.getSessionFile?.(),
          inheritedProvider: currentModel.provider,
          inheritedModelId: currentModel.id,
          inheritedThinking: pi.getThinkingLevel() as ThinkingLevel,
          model,
          thinking: params.thinking,
        });
        const info = manager.getAgentInfo(result.task_name, parentSessionId(ctx));
        return textResult(`Spawned ${result.task_name}.`, {
          ...result,
          provider: info.provider,
          modelId: info.modelId,
          thinking: info.thinking,
        });
      } catch (error) {
        throw new Error(`spawn_agent failed: ${formatAgentError(error)}`);
      }
    },
    renderCall(args: any, theme: Theme) {
      return new Text(
        theme.fg('toolTitle', theme.bold('spawn_agent ')) +
          theme.fg('accent', args.task_name || '?') +
          theme.fg(
            'dim',
            (args.agent_type ? ` [${args.agent_type}]` : '') + (args.model ? ` ${args.model}` : ''),
          ),
        0,
        0,
      );
    },
    renderResult(result: any, _options: any, theme: Theme, context: ToolRenderContext) {
      if (context.isError)
        return new Text(theme.fg('error', `✗ ${result.content?.[0]?.text || 'failed'}`), 0, 0);
      const model =
        result.details?.provider && result.details?.modelId
          ? ` · ${result.details.provider}/${result.details.modelId}`
          : '';
      const thinking = result.details?.thinking ? ` · ${result.details.thinking}` : '';
      return new Text(
        theme.fg('success', `✓ ${result.details?.task_name || 'spawned'}${model}${thinking}`),
        0,
        0,
      );
    },
  };

  pi.on('input', () => {
    recordInputActivity('Steered');
  });

  pi.on('context', () => {
    // Earlier activity is now observed, even when providers omit payload callbacks.
    pendingActivity = undefined;
  });

  pi.on('agent_start', (_event, ctx) => {
    const signal = ctx.signal;
    parentInterrupted = signal?.aborted === true;
    const parentId = parentSessionId(ctx);
    // Observe cancellation before tools drain and the native signal disappears.
    // The SDK owns each signal; once its run is released, this listener is collectible.
    signal?.addEventListener(
      'abort',
      () => {
        if (isCurrentSession(parentId)) parentInterrupted = true;
      },
      { once: true },
    );
  });

  pi.on('agent_settled', (event) => {
    // A run may be aborted between low-level turns, when no turn signal exists.
    if (event.aborted) parentInterrupted = true;
  });

  pi.on('session_start', async (_event: any, ctx: any) => {
    clearInputActivity();
    activeContext = ctx;
    parentInterrupted = false;
    agentStatuses.clear();
    agentColors.clear();
    widgetStatusCounts = { running: 0, completed: 0, errored: 0, interrupted: 0 };
    try {
      spawnModels = resolveSpawnModels(ctx);
    } catch (error: any) {
      ctx.ui?.notify?.(
        `spawn_agent model resolution failed, keeping the previous list: ${error?.message || error}`,
        'warning',
      );
    }
    pi.registerTool(spawnAgentTool);
    const manager = ensureManager(ctx);
    await manager.ready();
    if (activeContext !== ctx) return;
    // One scoped metadata read seeds external-host summaries too; no presentation
    // fields are added to list_agents and the 200ms sampler never rereads storage.
    for (const info of manager.listAgentInfos(undefined, parentSessionId(ctx))) {
      agentStatuses.set(info.taskName, info.status);
      const color = resolveAgentColor(info.color);
      if (color) agentColors.set(info.taskName, color);
    }
    refreshAgentWidget();
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    clearInputActivity();
    const shutdownContext = activeContext ?? ctx;
    activeContext = undefined;
    agentStatuses.clear();
    agentColors.clear();
    widgetStatusCounts = { running: 0, completed: 0, errored: 0, interrupted: 0 };
    try {
      agentWidget.dispose();
    } catch (error) {
      reportError(error, shutdownContext);
    } finally {
      widgetContext = undefined;
    }
    try {
      await manager?.shutdown();
    } catch (error) {
      reportError(error, shutdownContext);
    }
  });

  pi.registerTool(spawnAgentTool);

  pi.registerTool({
    name: 'wait_agent',
    label: 'Wait Agent',
    description:
      'Wait for a subagent notification, input, or timeout. Returns message and timed_out, not content. Use only when blocked; canceling does not stop agents. When calling `wait_agent`, prefer longer waits (minutes) to avoid busy polling.',
    parameters: Type.Object(
      {
        timeout_ms: Type.Optional(
          Type.Union([Type.Integer(), Type.Null()], {
            description: `Timeout in ms. Default ${DEFAULT_WAIT_TIMEOUT_MS} (omitted/null); min ${MIN_WAIT_TIMEOUT_MS} (clamped); max ${MAX_WAIT_TIMEOUT_MS}.`,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    outputSchema: Type.Object(
      {
        message: Type.String(),
        timed_out: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    prepareArguments(args: any) {
      const timeoutMs = args?.timeout_ms;
      if (timeoutMs !== undefined && timeoutMs !== null && !Number.isInteger(timeoutMs))
        throw new Error('timeout_ms must be an integer or null');
      return args;
    },
    async execute(_id: string, params: any, signal: AbortSignal | undefined) {
      const requested = params.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS;
      if (!Number.isInteger(requested)) throw new Error('timeout_ms must be an integer or null');
      if (requested > MAX_WAIT_TIMEOUT_MS)
        throw new Error(`timeout_ms must be at most ${MAX_WAIT_TIMEOUT_MS}`);
      const effective = Math.max(MIN_WAIT_TIMEOUT_MS, requested);
      const outcome = await waitForInput(effective, signal);
      let message =
        outcome === 'MailboxActivity'
          ? 'Wait completed.'
          : outcome === 'Steered'
            ? 'Wait interrupted by new input.'
            : 'Wait timed out.';
      if (requested < effective)
        message += `\n\nRequested timeout of ${requested}ms was clamped to the minimum of ${effective}ms.`;
      const data = { message, timed_out: outcome === 'TimedOut' };
      return {
        ...textResult(JSON.stringify(data), data),
        structuredContent: data,
      };
    },
    renderCall(args: any, theme: Theme) {
      return new Text(
        theme.fg('toolTitle', theme.bold('wait_agent ')) +
          theme.fg('accent', `${args.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS}ms`),
        0,
        0,
      );
    },
    renderResult(result: any, _options: any, theme: Theme, context: ToolRenderContext) {
      if (context.isError) return new Text(theme.fg('error', '✗ wait failed'), 0, 0);
      return new Text(theme.fg('success', result.details?.message || 'done'), 0, 0);
    },
  });

  pi.registerTool({
    name: 'list_agents',
    label: 'List Agents',
    description:
      'List resident subagents in this session, including initializing and idle ones, with their latest status and any final text or error.',
    parameters: Type.Object(
      {
        path_prefix: Type.Optional(
          Type.String({
            pattern: TASK_PATH_PATTERN,
            description:
              'Relative task-name prefix (no trailing slash). Matches whole segments; omit for all.',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    outputSchema: Type.Object(
      {
        agents: Type.Array(
          Type.Object(
            {
              agent_name: Type.String(),
              agent_status: agentStatusSchema,
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    prepareArguments(args: any) {
      const prefix = args?.path_prefix;
      if (prefix !== undefined && typeof prefix !== 'string')
        throw new Error('path_prefix must be a string');
      return args;
    },
    async execute(
      _id: string,
      params: any,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      ctx: any,
    ) {
      const listed = ensureManager(ctx).listAgents(params.path_prefix, parentSessionId(ctx));
      const isActive = (agent: (typeof listed)[number]) =>
        agent.agent_status === 'pending_init' || agent.agent_status === 'running';
      const agents = [...listed.filter(isActive), ...listed.filter((agent) => !isActive(agent))];
      const result = { agents };
      const { text, ...preview } = boundedText(JSON.stringify(result, null, 2));
      return {
        ...textResult(text, { agentCount: agents.length, ...preview }),
        structuredContent: result,
      };
    },
    renderCall(_args: any, theme: Theme) {
      return new Text(theme.fg('toolTitle', theme.bold('list_agents')), 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      if (context.isError) return new Text(theme.fg('error', '✗ list failed'), 0, 0);
      const count = result.details?.agentCount;
      if (!expanded && typeof count === 'number')
        return new Text(theme.fg('success', `✓ ${count} agents`), 0, 0);
      const text = result.content.flatMap((part) => (part.type === 'text' ? [part.text] : []));
      return new Text(text.join('\n'), 0, 0);
    },
  });

  pi.registerTool({
    name: 'send_message',
    label: 'Send Message',
    description:
      'Steer a running subagent, or start another run with its history once idle. Returns on input acceptance, not completion.',
    parameters: Type.Object({
      target: Type.String({ description: 'Current-session agent name, e.g. review.' }),
      message: Type.String({ description: 'Message text to send.' }),
    }),
    async execute(
      _id: string,
      params: any,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      ctx: any,
    ) {
      try {
        const result = await ensureManager(ctx).sendMessage(
          parentSessionId(ctx),
          params.target,
          params.message,
        );
        return textResult(
          result.delivery === 'steer'
            ? 'Message steered into the running agent.'
            : 'Message started a new agent turn.',
          { target: params.target, ...result },
        );
      } catch (error) {
        throw new Error(`send_message failed: ${formatAgentError(error)}`);
      }
    },
    renderCall(args: any, theme: Theme) {
      return new Text(
        theme.fg('toolTitle', theme.bold('send_message ')) + theme.fg('accent', args.target || '?'),
        0,
        0,
      );
    },
    renderResult(result: any, _options: any, theme: Theme, context: ToolRenderContext) {
      if (context.isError) return new Text(theme.fg('error', '✗ send failed'), 0, 0);
      return new Text(
        theme.fg('success', result.details?.delivery === 'steer' ? '✓ steered' : '✓ started'),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: 'interrupt_agent',
    label: 'Interrupt Agent',
    description:
      'Request cooperative cancellation of the current run (no rollback). History can be resumed with send_message after cleanup.',
    parameters: Type.Object({
      target: Type.String({ description: 'Current-session agent name, e.g. review.' }),
    }),
    async execute(
      _id: string,
      params: any,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      ctx: any,
    ) {
      try {
        const result = await ensureManager(ctx).interruptAgent(parentSessionId(ctx), params.target);
        return textResult('Interrupt request handled.', result);
      } catch (error) {
        throw new Error(`interrupt_agent failed: ${formatAgentError(error)}`);
      }
    },
    renderCall(args: any, theme: Theme) {
      return new Text(
        theme.fg('toolTitle', theme.bold('interrupt_agent ')) +
          theme.fg('accent', args.target || '?'),
        0,
        0,
      );
    },
    renderResult(result: any, _options: any, theme: Theme, context: ToolRenderContext) {
      if (context.isError) return new Text(theme.fg('error', '✗ interrupt failed'), 0, 0);
      const previous = result.details?.previous_status;
      const text = typeof previous === 'string' ? `↯ previous: ${previous}` : '';
      return new Text(theme.fg('warning', text), 0, 0);
    },
  });

  async function openAgentOverlay(
    ctx: any,
    task: string,
    scopeId: string,
    isDisposed: () => boolean,
  ) {
    if (ctx.mode !== 'tui') {
      ctx.ui.notify('Subagent overlays require interactive TUI mode.', 'warning');
      return;
    }
    const manager = ensureManager(ctx);
    let info: AgentInfo;
    try {
      info = manager.getAgentInfo(task, scopeId);
    } catch (error) {
      ctx.ui.notify(formatAgentError(error), 'error');
      return;
    }

    while (!isDisposed()) {
      const { terminal, outputPad } = pi.getSettings();
      let closeOverlay: (() => void) | undefined;
      let overlay: SubagentPeekOverlay | undefined;
      const navigation = await ctx.ui
        .custom(
          (tui: any, theme: any, _keybindings: any, done: any) => {
            closeOverlay = () => done();
            overlay = new SubagentPeekOverlay(tui, theme, info, done, nativeCodemodeRenderers, {
              showImages: terminal?.showImages,
              imageWidthCells: terminal?.imageWidthCells,
              outputPad,
            });
            return overlay;
          },
          {
            overlay: true,
            // Pi installs overlays asynchronously; a UI reset may dispose the browser first.
            onHandle: () => {
              if (isDisposed()) closeOverlay?.();
            },
            overlayOptions: {
              anchor: 'right-center',
              width: '45%',
              minWidth: 50,
              maxHeight: 60,
              margin: { right: 2, top: 2, bottom: 2 },
            },
          },
        )
        .finally(() => overlay?.dispose()); // Also release timers if Pi rejects overlay mounting.
      if (isDisposed() || (navigation !== 'previous' && navigation !== 'next')) return;

      const { active, done } = listBrowserAgents(manager, scopeId);
      const entries = [...active, ...done];
      if (entries.length < 2) return;
      const currentIndex = entries.findIndex((entry) => entry.id === info.id);
      if (currentIndex === -1) return;
      const offset = navigation === 'next' ? 1 : -1;
      const next = entries[(currentIndex + offset + entries.length) % entries.length];
      try {
        info = manager.getAgentInfo(next.taskName, scopeId);
      } catch (error) {
        ctx.ui.notify(formatAgentError(error), 'error');
        return;
      }
    }
  }

  type AgentSelection = { task: string; parentSessionId: string };

  async function openAgentBrowser(ctx: ExtensionContext): Promise<void> {
    const manager = ensureManager(ctx);
    const currentSessionId = parentSessionId(ctx);
    return ctx.ui.custom<void>((tui, factoryTheme, _keybindings, done) => {
      let selected = 0;
      let detailOpen = false;
      let disposed = false;
      let displayedCount = 0;
      let displayedSelection: AgentSelection | undefined;
      let cached: string[] | undefined;
      let cachedWidth: number | undefined;
      let snapshot: ReturnType<typeof listBrowserAgents> | undefined;
      const pageSize = 10;
      const redraw = () => {
        cached = undefined;
        tui.requestRender();
      };
      const openDetails = (selection: AgentSelection) => {
        detailOpen = true;
        void openAgentOverlay(ctx, selection.task, selection.parentSessionId, () => disposed)
          .finally(() => {
            detailOpen = false;
            if (!disposed) {
              snapshot = listBrowserAgents(manager, currentSessionId);
              const entries = [...snapshot.active, ...snapshot.done];
              const index = entries.findIndex((entry) => entry.taskName === selection.task);
              selected = Math.max(0, Math.min(index === -1 ? selected : index, entries.length - 1));
              displayedCount = entries.length;
              redraw();
            }
          })
          .catch((error) => {
            if (!disposed) reportError(error, ctx);
          });
      };
      return {
        render(availableWidth: number): string[] {
          const width = Number.isFinite(availableWidth)
            ? Math.max(0, Math.floor(availableWidth))
            : 0;
          if (width === 0) return [];
          if (cached && cachedWidth === width) return cached;
          const theme = ctx.ui.theme ?? factoryTheme;
          const fg = theme.fg.bind(theme);
          // Navigation, resize and theme changes only repaint the current data snapshot.
          const { active, done: settled } = (snapshot ??= listBrowserAgents(
            manager,
            currentSessionId,
          ));
          const entries = [...active, ...settled];
          selected = Math.max(0, Math.min(selected, entries.length - 1));
          displayedCount = entries.length;
          displayedSelection = undefined;
          const lines = [
            fg('accent', '─'.repeat(width)),
            fg('dim', ` Subagents (${active.length} Active · ${settled.length} Done)`),
          ];
          const viewStart =
            entries.length > pageSize
              ? Math.max(
                  0,
                  Math.min(selected - Math.floor(pageSize / 2), entries.length - pageSize),
                )
              : 0;
          const viewEnd = Math.min(viewStart + pageSize, entries.length);
          const statusWidth = 12;
          const durationWidth = 6;
          const thinkingWidth = 7;
          const fixedWidth = 2 + statusWidth + durationWidth + thinkingWidth + 4;
          const nameWidth = Math.min(28, Math.max(8, width - fixedWidth - 8));
          const modelWidth = Math.max(0, Math.min(28, width - fixedWidth - nameWidth));
          let groupStart = 0;
          for (const [label, group] of [
            ['Active', active],
            ['Done', settled],
          ] as const) {
            if (label === 'Active' && !group.length) continue;
            const groupEnd = groupStart + group.length;
            lines.push(fg('dim', ` ${label} (${group.length})`));
            if (!group.length) lines.push(fg('dim', `  No ${label.toLowerCase()} subagents.`));
            const hiddenAbove = Math.max(0, Math.min(viewStart, groupEnd) - groupStart);
            const hiddenBelow = Math.max(0, groupEnd - Math.max(viewEnd, groupStart));
            if (hiddenAbove) lines.push(fg('dim', `  ↑ ${hiddenAbove} more`));
            for (
              let index = Math.max(viewStart, groupStart);
              index < Math.min(viewEnd, groupEnd);
              index++
            ) {
              const info = entries[index];
              if (typeof info.taskName !== 'string' || !info.taskName.trim()) continue;
              if (index === selected)
                displayedSelection = {
                  task: info.taskName,
                  parentSessionId: currentSessionId,
                };
              const isSelected = index === selected;
              const color = resolveAgentColor(info.color);
              const pointer = isSelected ? fg('accent', '› ') : '  ';
              const shownName = formatColumn(info.taskName, nameWidth).trimEnd();
              const padded = Boolean(color && visibleWidth(shownName) + 2 <= nameWidth);
              const badge = renderAgentBadge(
                shownName,
                theme,
                color,
                isSelected ? 'accent' : 'text',
                padded,
              );
              const name = badge + ' '.repeat(Math.max(0, nameWidth - visibleWidth(badge)));
              const details = [
                formatColumn(runtimeLabel(info), durationWidth),
                formatColumn(info.modelId || 'unknown', modelWidth),
                formatColumn(info.thinking || 'off', thinkingWidth),
              ].join(' ');
              lines.push(
                paintAgentLine(
                  pointer +
                    name +
                    ' ' +
                    fg(
                      agentStatusColor(info.status),
                      sanitizeAgentText(info.status).padEnd(statusWidth),
                    ) +
                    ' ' +
                    fg('dim', details),
                  width,
                  theme,
                  isSelected,
                ),
              );
              const preview = previewText(sanitizeAgentText(info.lastTaskMessage ?? ''));
              if (preview)
                lines.push(
                  paintAgentLine(
                    '  ' + fg('dim', truncateToWidth(preview, Math.max(0, width - 4))),
                    width,
                    theme,
                    isSelected,
                  ),
                );
            }
            if (hiddenBelow) lines.push(fg('dim', `  ↓ ${hiddenBelow} more`));
            groupStart = groupEnd;
          }
          lines.push('', fg('dim', 'enter: open  r: refresh  q/esc: close'));
          cached = lines.map((line) => truncateToWidth(line, width));
          cachedWidth = width;
          return cached;
        },
        handleInput(data: string) {
          if (disposed || detailOpen) return;
          if (matchesKey(data, 'escape') || data === 'q') {
            done();
            return;
          }
          if (data === 'r') {
            snapshot = undefined;
            redraw();
            return;
          }
          if (matchesKey(data, 'down') || data === 'j') {
            selected = Math.max(0, Math.min(displayedCount - 1, selected + 1));
            redraw();
            return;
          }
          if (matchesKey(data, 'up') || data === 'k') {
            selected = Math.max(0, selected - 1);
            redraw();
            return;
          }
          // Keep the browser mounted beneath details; only q/Esc finishes this interaction.
          if (matchesKey(data, 'return') && displayedSelection) openDetails(displayedSelection);
        },
        invalidate() {
          cached = undefined;
        },
        dispose() {
          disposed = true;
          snapshot = undefined;
        },
      };
    });
  }

  const browseAgents = async (ctx: ExtensionContext) => {
    if (ctx.mode !== 'tui') {
      ctx.ui.notify('Subagent overlays require interactive TUI mode.', 'warning');
      return;
    }
    await openAgentBrowser(ctx);
  };

  const shortcut = loadSubagentConfig().shortcut?.trim();
  if (shortcut) {
    pi.registerShortcut(shortcut as KeyId, {
      description: 'Browse subagents',
      handler: browseAgents,
    });
  }

  pi.registerCommand('subagents', {
    description: 'Browse subagents',
    handler: async (_args, ctx) => browseAgents(ctx),
  });
}
