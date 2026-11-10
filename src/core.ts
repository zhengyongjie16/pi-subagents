import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  parseFrontmatter,
  type AgentSession,
  type AgentSessionEvent,
  type ContextUsage,
} from '@earendil-works/pi-coding-agent';
import { createChildSession, promptChildSession, shutdownChildSession } from './runtime.js';
import { resolveAgentColor } from './color.js';
import { parseStreamingJson, type AssistantMessage } from '@earendil-works/pi-ai';

export const PACKAGE_BASENAME = 'pi-subagents';
export const SUBAGENT_DIR = path.join(getAgentDir(), PACKAGE_BASENAME);
const CONFIG_PATH = path.join(SUBAGENT_DIR, 'config.json');
const SYSTEM_PROMPT_PATH = path.join(SUBAGENT_DIR, 'SYSTEM.md');
const AGENTS_DIR = path.join(SUBAGENT_DIR, 'agents');
const TEMP_ROOT = path.join(
  process.env.PI_SUBAGENT_TEMP_DIR || os.tmpdir(),
  PACKAGE_BASENAME,
  os.userInfo().username,
);
const LEGACY_RUNS_DIR = path.join(TEMP_ROOT, 'runs');
const SOCKET_DIR = path.join(TEMP_ROOT, 'sockets');

export const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const CLEANUP_WAIT_TIMEOUT_MS = 2_000;

async function boundedWait<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string | Error,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(typeof message === 'string' ? new Error(message) : message),
          timeoutMs,
        );
        if (signal) {
          onAbort = () => reject(abortError(signal));
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        }
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
export const DEFAULT_RETENTION_DAYS = 7;
export const DEFAULT_MODEL_RESPONSE_TIMEOUT_MS = 10 * 60_000;
const ACTIVITY_PERSIST_INTERVAL_MS = 5_000;
export const DEFAULT_THINKING = 'high';
export const DEFAULT_TOOLS = 'read,bash,grep,find,ls';
const DEFAULT_SUBAGENT_SYSTEM_PROMPT =
  'You are a subagent working for a main agent. Work only on the assigned task and follow its scope precisely.';

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const FINAL_STATUSES = new Set<AgentRuntimeStatus>(['completed', 'failed', 'interrupted']);

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type AgentRuntimeStatus = 'starting' | 'running' | 'completed' | 'failed' | 'interrupted';

export interface SubagentConfig {
  shortcut?: string;
  storageDir?: string;
  retentionDays?: number;
  models?: string[];
  modelsFromEnabledModels?: boolean;
  modelResponseTimeoutMs?: number;
  maxIdleSessions?: number;
  defaults?: {
    extensions?: string[];
  };
}

export interface AgentDefinition {
  name: string;
  color?: string;
  description?: string;
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string;
  extensions?: string[];
  prompt?: string;
}

export interface AgentInfo {
  id: string;
  taskName: string;
  canonicalName: string;
  parentSessionId: string;
  parentSessionFile?: string;
  agentType?: string;
  /** Effective template badge color captured at creation; absent in older records. */
  color?: string;
  provider: string;
  modelId: string;
  model: string;
  thinking?: ThinkingLevel;
  tools?: string;
  extensions?: string[];
  extensionPaths?: string[];
  cwd: string;
  sessionFile: string;
  infoFile: string;
  logFile: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  lastActivity?: number;
  messageCount: number;
  status: AgentRuntimeStatus;
  lastTaskMessage?: string;
  finalResponse?: string;
  error?: string;
  contextUsage?: ContextUsage;
}

/** Read-only parent-widget data; never persisted or exposed as a tool result. */
export interface AgentWidgetSnapshot {
  readonly canonicalName: string;
  readonly color?: string;
  readonly status: 'starting' | 'running';
  readonly provider?: string;
  readonly modelId?: string;
  readonly thinking?: ThinkingLevel;
  readonly tokens?: number;
  readonly compactionCount?: number;
  readonly contextUsage?: ContextUsage;
  readonly elapsedMs?: number;
  readonly activeTools: readonly string[];
  readonly responsePreview?: string;
}

export interface AgentListEntry {
  agent_name: string;
  agent_status: AgentRuntimeStatus;
  last_task_message: string | null;
  parent_session_id?: string;
}

export interface AgentResponseEntry {
  agent_name: string;
  status: AgentRuntimeStatus;
  finalResponse?: string;
  error?: string;
  last_task_message: string | null;
}

export interface SpawnAgentParams {
  task_name: string;
  message: string;
  agent_type?: string;
  cwd: string;
  parentSessionId: string;
  parentSessionFile?: string;
  inheritedProvider: string;
  inheritedModelId: string;
  inheritedThinking?: ThinkingLevel;
  inheritedTools?: string;
  model?: { provider: string; modelId: string };
  thinking?: ThinkingLevel;
}

interface RunState {
  /** UI-only clock: the persisted agent timestamp retains its existing semantics. */
  displayStartedAt: number;
  cancellation: AbortController;
  promptFinished?: Promise<void>;
  pendingSteers: Set<Promise<unknown>>;
  finalizedRun: boolean;
  awaitingPrompt: boolean;
  accepted: boolean;
  /** Hidden while input is tentative; keep its identity until acceptance or rollback. */
  suspendedCompletion?: AgentCompletionEvent;
  candidateResponse: string;
  candidateError?: string;
  settledAborted: boolean;
  observerSettled: boolean;
  modelResponseTimer?: ReturnType<typeof setTimeout>;
  settlement?: Promise<void>;
}

interface LiveAgent {
  info: AgentInfo;
  session?: AgentSession;
  initialization?: Promise<AgentSession>;
  /** Captured while native work is busy; a late idle query can miss settled hooks. */
  nativeWork?: Promise<void>;
  /** Public compact calls can outlive native idle while failure hooks finish. */
  pendingCompactions: Set<Promise<void>>;
  unsubscribe?: () => void;
  broadcaster: EventBroadcaster;
  logger: SessionLogger;
  run?: RunState;
  closing: boolean;
  termination?: Promise<void>;
  eventError?: Error;
  lastUsedAt: number;
  lastActivityPersistedAt: number;
  widgetStats?: {
    session: AgentSession;
    entryCount: number;
    tokens: number;
    compactionCount: number;
  };
}

export interface AgentCompletionEvent {
  id: string;
  parentSessionId: string;
  agentName: string;
  status: AgentRuntimeStatus;
  finalResponse?: string;
  error?: string;
  createdAt: number;
}

export interface AgentActivityEvent {
  parentSessionId: string;
  agentName: string;
  active: boolean;
  /** Exact latest status, including terminal states; active remains backward-compatible. */
  status?: AgentRuntimeStatus;
}

export interface AgentManagerOptions {
  onActivityChange?: (event: AgentActivityEvent) => void;
  onCompletion?: (event: AgentCompletionEvent, waiting: boolean) => void;
  modelResponseTimeoutMs?: number;
  projectTrusted?: (cwd: string) => boolean | undefined;
  onError?: (error: Error) => void;
}

interface Waiter {
  parentSessionId: string;
  targets?: Set<string>;
  resolve: (event: AgentCompletionEvent) => void;
}

export function formatAgentError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const errno =
    error && typeof error === 'object' ? (error as { errno?: unknown }).errno : undefined;
  const edquot = os.constants.errno.EDQUOT;
  const quotaExceeded =
    (typeof edquot === 'number' &&
      (errno === edquot || errno === -edquot || message.includes(`system error -${edquot}`))) ||
    (error && typeof error === 'object' && (error as { code?: unknown }).code === 'EDQUOT') ||
    /\bEDQUOT\b/.test(message);
  return quotaExceeded && !/disk quota exceeded/i.test(message)
    ? `${message}\nCause: Disk quota exceeded (EDQUOT).`
    : message;
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('Wait canceled.');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function expandHome(value: string): string {
  return value === '~'
    ? os.homedir()
    : value.startsWith('~/')
      ? path.join(os.homedir(), value.slice(2))
      : value;
}

function stringList(value: unknown): string[] | undefined {
  const entries = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const normalized = entries.map((entry) => entry.trim()).filter(Boolean);
  return normalized.length ? normalized : undefined;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

function normalizeConfig(value: unknown): SubagentConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const defaultsRaw =
    raw.defaults && typeof raw.defaults === 'object' && !Array.isArray(raw.defaults)
      ? (raw.defaults as Record<string, unknown>)
      : undefined;
  const extensions = stringList(defaultsRaw?.extensions);
  const models = stringList(raw.models);
  const retentionDays =
    typeof raw.retentionDays === 'number' &&
    Number.isFinite(raw.retentionDays) &&
    raw.retentionDays >= 0
      ? raw.retentionDays
      : undefined;
  const modelResponseTimeoutMs =
    typeof raw.modelResponseTimeoutMs === 'number' &&
    Number.isFinite(raw.modelResponseTimeoutMs) &&
    raw.modelResponseTimeoutMs >= 0
      ? raw.modelResponseTimeoutMs
      : undefined;
  return {
    ...(typeof raw.shortcut === 'string' && raw.shortcut.trim()
      ? { shortcut: raw.shortcut.trim() }
      : {}),
    ...(typeof raw.storageDir === 'string' && raw.storageDir.trim()
      ? { storageDir: raw.storageDir.trim() }
      : {}),
    ...(retentionDays !== undefined ? { retentionDays } : {}),
    ...(models ? { models } : {}),
    ...(raw.modelsFromEnabledModels === true ? { modelsFromEnabledModels: true } : {}),
    ...(modelResponseTimeoutMs !== undefined ? { modelResponseTimeoutMs } : {}),
    ...(Number.isSafeInteger(raw.maxIdleSessions) && (raw.maxIdleSessions as number) >= 0
      ? { maxIdleSessions: raw.maxIdleSessions as number }
      : {}),
    ...(extensions ? { defaults: { extensions } } : {}),
  };
}

export function loadSubagentConfig(): SubagentConfig {
  try {
    if (fs.existsSync(CONFIG_PATH))
      return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch {}
  return {};
}

export function getRunsDir(config: SubagentConfig = loadSubagentConfig()): string {
  const configured = config.storageDir;
  if (configured) {
    const expanded = expandHome(configured);
    return path.isAbsolute(expanded) ? expanded : path.resolve(SUBAGENT_DIR, expanded);
  }
  return path.join(SUBAGENT_DIR, 'runs');
}

function ensurePrivateDir(directory: string, enforceMode = false): void {
  const existed = fs.existsSync(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32' && (enforceMode || !existed)) fs.chmodSync(directory, 0o700);
}

function ensureSystemPromptFile(): void {
  if (fs.existsSync(SYSTEM_PROMPT_PATH)) return;
  try {
    fs.writeFileSync(SYSTEM_PROMPT_PATH, DEFAULT_SUBAGENT_SYSTEM_PROMPT, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
  }
}

function validateSystemPrompt(): void {
  ensureSystemPromptFile();
  const prompt = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
  if (!prompt.trim()) throw new Error(`Subagent system prompt is empty: ${SYSTEM_PROMPT_PATH}`);
}

function ensureBaseDirs(): void {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  ensureSystemPromptFile();
  const config = loadSubagentConfig();
  ensurePrivateDir(getRunsDir(config), !config.storageDir);
  ensurePrivateDir(SOCKET_DIR, true);
}

const SCOPE_DIR_PATTERN = /^[0-9a-f]{24}$/;
const AGENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OUTPUT_FILE_PATTERN = /^\d+-[0-9a-f-]{36}\.txt$/i;
const TASK_LOCK_PATTERN = /^\.task-[0-9a-f]{24}\.lock$/;

function isAgentArtifact(name: string, agentId: string): boolean {
  return (
    name === `${agentId}.jsonl` ||
    name === `${agentId}.info.json` ||
    name === `${agentId}.log` ||
    new RegExp(`^${agentId}\\.info\\.json\\.\\d+\\.tmp$`).test(name)
  );
}

function pruneScope(directory: string, cutoff: number): void {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  // Group once instead of scanning the whole directory for every run.
  const entriesByAgent = new Map<string, fs.Dirent[]>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const agentId = entry.name.split('.', 1)[0];
    if (!AGENT_ID_PATTERN.test(agentId)) continue;
    const group = entriesByAgent.get(agentId);
    if (group) group.push(entry);
    else entriesByAgent.set(agentId, [entry]);
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.info.json')) continue;
    const agentId = entry.name.slice(0, -'.info.json'.length);
    if (!AGENT_ID_PATTERN.test(agentId)) continue;
    const info = readInfoFile(path.join(directory, entry.name));
    const agentEntries = (entriesByAgent.get(agentId) ?? []).filter((candidate) =>
      isAgentArtifact(candidate.name, agentId),
    );
    let latest = Math.max(info?.lastActivity ?? 0, info?.updatedAt ?? 0, info?.createdAt ?? 0);
    for (const candidate of agentEntries) {
      try {
        latest = Math.max(latest, fs.statSync(path.join(directory, candidate.name)).mtimeMs);
      } catch {}
    }
    if (isRunActive(agentId) || latest >= cutoff) continue;
    let failed = false;
    for (const candidate of agentEntries.filter((candidate) => candidate.name !== entry.name)) {
      try {
        fs.rmSync(path.join(directory, candidate.name), { force: true });
      } catch {
        failed = true;
      }
    }
    if (failed) continue;
    try {
      fs.rmSync(path.join(directory, entry.name), { force: true });
    } catch {}
  }

  for (const entry of entries) {
    if (!entry.isFile() || !TASK_LOCK_PATTERN.test(entry.name)) continue;
    const lockFile = path.join(directory, entry.name);
    try {
      if (fs.statSync(lockFile).mtimeMs >= cutoff) continue;
      const owner = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid?: number };
      if (typeof owner.pid === 'number' && processAlive(owner.pid)) continue;
    } catch {}
    try {
      fs.rmSync(lockFile, { force: true });
    } catch {}
  }

  try {
    fs.rmdirSync(directory);
  } catch {}
}

function pruneRunsRoot(root: string, cutoff: number): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.name === '_outputs' && entry.isDirectory()) {
      let outputs: fs.Dirent[];
      try {
        outputs = fs.readdirSync(target, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const output of outputs) {
        if (!output.isFile() || !OUTPUT_FILE_PATTERN.test(output.name)) continue;
        const outputPath = path.join(target, output.name);
        try {
          if (fs.statSync(outputPath).mtimeMs < cutoff) fs.rmSync(outputPath, { force: true });
        } catch {}
      }
      continue;
    }
    if (!entry.isDirectory() || !SCOPE_DIR_PATTERN.test(entry.name)) continue;
    try {
      pruneScope(target, cutoff);
    } catch {}
  }
}

function pruneExpiredRuns(): void {
  const retentionDays = loadSubagentConfig().retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (retentionDays === 0) return;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const root of runsRoots()) pruneRunsRoot(root, cutoff);
}

export function parentScopeKey(parentSessionId: string): string {
  return createHash('sha256').update(parentSessionId).digest('hex').slice(0, 24);
}

export function taskStorageKey(taskName: string): string {
  return createHash('sha256').update(taskName).digest('hex').slice(0, 24);
}

function runsRoots(): string[] {
  return [...new Set([getRunsDir(), LEGACY_RUNS_DIR])];
}

function scopeDir(parentSessionId: string): string {
  return path.join(getRunsDir(), parentScopeKey(parentSessionId));
}

function scopeDirs(parentSessionId: string): string[] {
  const key = parentScopeKey(parentSessionId);
  return runsRoots().map((root) => path.join(root, key));
}

function normalizeTaskName(name: string): string {
  const normalized = name.trim().replace(/^\/+|\/+$/g, '');
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(normalized)) {
    throw new Error(
      'task_name must use letters, digits, underscores, dashes, and optional slash path separators',
    );
  }
  return normalized;
}

export function normalizeContextUsage(value: unknown): ContextUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { contextWindow, tokens, percent } = value as Record<string, unknown>;
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0)
    return undefined;
  const validUsage =
    typeof tokens === 'number' &&
    Number.isFinite(tokens) &&
    tokens >= 0 &&
    typeof percent === 'number' &&
    Number.isFinite(percent) &&
    percent >= 0;
  return {
    contextWindow,
    tokens: validUsage ? tokens : null,
    percent: validUsage ? percent : null,
  };
}

export function formatContextUsage(value: unknown): string {
  const usage = normalizeContextUsage(value);
  if (!usage) return '?%/?';
  const { contextWindow, percent } = usage;
  const window =
    contextWindow >= 1_000_000
      ? `${Number((contextWindow / 1_000_000).toFixed(2))}M`
      : contextWindow >= 1_000
        ? `${Number((contextWindow / 1_000).toFixed(2))}k`
        : String(contextWindow);
  const occupied =
    percent === null
      ? '?'
      : percent > 0 && percent < 0.1
        ? '<0.1'
        : String(Number(percent.toFixed(1)));
  return `${occupied}%/${window}`;
}

function sameContextUsage(a: ContextUsage | undefined, b: ContextUsage | undefined): boolean {
  return (
    a?.contextWindow === b?.contextWindow && a?.tokens === b?.tokens && a?.percent === b?.percent
  );
}

function saveInfo(info: AgentInfo): void {
  fs.mkdirSync(path.dirname(info.infoFile), { recursive: true });
  info.updatedAt = Date.now();
  const temporary = `${info.infoFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(info, null, 2));
  fs.renameSync(temporary, info.infoFile);
}

export function readInfoFile(file: string): AgentInfo | undefined {
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8')) as Omit<AgentInfo, 'status'> & {
      status: AgentRuntimeStatus | 'closed';
      closedAt?: number;
    };
    if (!info || typeof info !== 'object' || Array.isArray(info)) return undefined;
    const color = resolveAgentColor(info.color);
    if (color) info.color = color;
    else delete info.color;
    const contextUsage = normalizeContextUsage(info.contextUsage);
    if (contextUsage) info.contextUsage = contextUsage;
    else delete info.contextUsage;
    if (info.status === 'closed') {
      info.status = info.error
        ? 'failed'
        : info.finalResponse !== undefined
          ? 'completed'
          : 'interrupted';
      delete info.closedAt;
    }
    delete (info as any).childProcess;
    return info as AgentInfo;
  } catch {
    return undefined;
  }
}

function readInfoFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.info.json'))
    .map((name) => path.join(directory, name));
}

function readInfos(directory: string): AgentInfo[] {
  return readInfoFiles(directory).flatMap((file) => {
    const info = readInfoFile(file);
    return info ? [info] : [];
  });
}

function sortInfos(infos: AgentInfo[]): AgentInfo[] {
  return infos.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

function readScopeInfos(parentSessionId: string): AgentInfo[] {
  return sortInfos(scopeDirs(parentSessionId).flatMap(readInfos));
}

function readAllInfos(): AgentInfo[] {
  const directories = runsRoots().flatMap((root) => {
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SCOPE_DIR_PATTERN.test(entry.name))
      .map((entry) => path.join(root, entry.name));
  });
  return sortInfos(directories.flatMap(readInfos));
}

export function getAgent(name: string, parentSessionId: string): AgentInfo | null {
  const taskName = normalizeTaskName(name);
  return readScopeInfos(parentSessionId).find((info) => info.taskName === taskName) ?? null;
}

export function parseAgentDefinitionText(text: string, fallbackName: string): AgentDefinition {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  const attrs: Record<string, string> = {};
  if (match) {
    const lines = match[1].replace(/\r$/, '').split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const entry = lines[index].match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
      if (!entry) continue;
      const [, key, value] = entry;
      if (key === 'description' && /^[|>][0-9+-]*(?:[ \t]+#.*)?$/.test(value)) {
        // Only collect the block; native YAML handles indentation, folding and chomping.
        const block = [`${key}: ${value}`];
        while (index + 1 < lines.length && /^(?:[ \t]|$)/.test(lines[index + 1]))
          block.push(lines[++index]);
        // The helper consumes the newline before ---, so retain the block's final newline.
        attrs[key] = parseFrontmatter<Record<string, string>>(
          '---\n' + block.join('\n') + '\n\n---\n',
        ).frontmatter[key];
      } else {
        // Preserve legacy inline values, including unquoted @, colons and # characters.
        attrs[key] = value.replace(/^['"]|['"]$/g, '');
      }
    }
  }
  return {
    name: attrs.name || fallbackName,
    color: resolveAgentColor(attrs.color),
    description: attrs.description,
    provider: attrs.provider?.trim() || undefined,
    model: attrs.model?.trim() || undefined,
    thinking: isThinkingLevel(attrs.thinking) ? attrs.thinking : undefined,
    tools: attrs.tools,
    extensions: stringList(attrs.extensions),
    prompt: (match ? text.slice(match[0].length) : text).trim() || undefined,
  };
}

export function listAgentDefinitions(): AgentDefinition[] {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const definitions: AgentDefinition[] = [];
  for (const name of fs.readdirSync(AGENTS_DIR)) {
    if (!name.endsWith('.md')) continue;
    try {
      definitions.push(
        parseAgentDefinitionText(
          fs.readFileSync(path.join(AGENTS_DIR, name), 'utf8'),
          name.replace(/\.md$/, ''),
        ),
      );
    } catch (error) {
      console.warn(
        '[subagents] Failed to load agent template ' +
          path.join(AGENTS_DIR, name) +
          ': ' +
          String(error),
      );
    }
  }
  return definitions.sort((a, b) => a.name.localeCompare(b.name));
}

export function getAgentDefinition(name?: string): AgentDefinition | undefined {
  return name ? listAgentDefinitions().find((definition) => definition.name === name) : undefined;
}

export function getAgentDefinitionsDescription(): string {
  const definitions = listAgentDefinitions();
  if (!definitions.length) return 'None configured, so omit `agent_type`.';
  return definitions
    .map((definition) => {
      const description = definition.description?.replace(/\n+$/, '');
      const multiline = description?.includes('\n');
      let line = `- \`${definition.name}\`${description && !multiline ? ` — ${description}` : ''}`;
      if (definition.model)
        line += ` — model: ${definition.provider ? `${definition.provider}/${definition.model}` : `${definition.model} (inherited provider)`}`;
      if (definition.thinking) line += ` — thinking: ${definition.thinking}`;
      if (definition.extensions?.length)
        line += ` — extensions: ${definition.extensions.join(', ')}`;
      if (description && multiline)
        line += '\n  Description:\n' + description.replace(/^/gm, '    ');
      return line;
    })
    .join('\n');
}

function normalizeTools(tools: string | undefined): string {
  if (tools === undefined) return DEFAULT_TOOLS;
  return tools
    .split(',')
    .map((tool) => tool.trim())
    .filter(Boolean)
    .join(',');
}

function normalizeList(values?: string[]): string[] | undefined {
  const normalized = Array.from(
    new Set((values ?? []).map((value) => value.trim()).filter(Boolean)),
  );
  return normalized.length ? normalized : undefined;
}

function looksLikePath(value: string): boolean {
  return value === '~' || value.startsWith('~/') || value.startsWith('.') || path.isAbsolute(value);
}

function resolveExtensionPath(extension: string, cwd: string): string {
  if (extension === '+codemode') return 'builtin:codemode';
  if (looksLikePath(extension)) {
    const expanded = expandHome(extension);
    const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
    if (!fs.existsSync(resolved)) throw new Error(`Extension path not found: ${extension}`);
    return resolved;
  }
  const candidates = [
    path.join(cwd, CONFIG_DIR_NAME, 'npm', 'node_modules', extension),
    path.join(getAgentDir(), 'npm', 'node_modules', extension),
  ];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolved)
    throw new Error(
      `Installed extension package not found: ${extension}. Install it with pi install first.`,
    );
  return resolved;
}

function resolveExtensionPaths(
  extensions: string[] | undefined,
  cwd: string,
): string[] | undefined {
  return extensions?.map((extension) => resolveExtensionPath(extension, cwd));
}

export interface PeekMarker {
  pid: number;
  startedAt: number;
  token: string;
}

export function getSocketPath(agentId: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${PACKAGE_BASENAME}-${os.userInfo().username}-${agentId}`
    : path.join(SOCKET_DIR, `${agentId}.sock`);
}

function markerPath(agentId: string, kind: 'active' | 'peek'): string {
  return path.join(SOCKET_DIR, `${agentId}.${kind}.json`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

function markActive(agentId: string, kind: 'active' | 'peek', marker: PeekMarker): void {
  fs.writeFileSync(markerPath(agentId, kind), JSON.stringify(marker, null, 2));
}

function clearActive(
  agentId: string,
  kind: 'active' | 'peek',
  owner?: Pick<PeekMarker, 'pid' | 'token'>,
): void {
  const file = markerPath(agentId, kind);
  try {
    if (owner && fs.existsSync(file)) {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (current.pid !== owner.pid || current.token !== owner.token) return;
    }
    fs.unlinkSync(file);
  } catch {}
}

function isActive(agentId: string, kind: 'active' | 'peek'): boolean {
  const file = markerPath(agentId, kind);
  try {
    if (!fs.existsSync(file)) return false;
    const marker = JSON.parse(fs.readFileSync(file, 'utf8')) as PeekMarker;
    if (processAlive(marker.pid)) return true;
    clearActive(agentId, kind, marker);
  } catch {
    clearActive(agentId, kind);
  }
  return false;
}

function isRunActive(agentId: string): boolean {
  return isActive(agentId, 'active') || isActive(agentId, 'peek');
}

export function isPeekActive(agentId: string): boolean {
  return isActive(agentId, 'peek');
}

class SessionLogger {
  private stream: fs.WriteStream | null = null;
  private closed = false;
  constructor(
    private readonly file: string,
    private readonly onError: (error: Error) => void,
  ) {}
  info(category: string, message: string): void {
    if (this.closed) return;
    if (!this.stream) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const stream = fs.createWriteStream(this.file, { flags: 'a' });
      stream.on('error', (error) => {
        if (this.stream === stream) this.stream = null;
        this.onError(error);
      });
      this.stream = stream;
    }
    this.stream.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'INFO',
        category,
        message,
      }) + '\n',
    );
    if (process.env.PI_SUBAGENT_DEBUG) console.error(`[INFO] ${category}: ${message}`, '');
  }
  close(): void {
    this.closed = true;
    this.stream?.end();
    this.stream = null;
  }
}

function assistantTextPreview(message: AssistantMessage | null | undefined): string | undefined {
  for (const part of message?.content ?? []) {
    if (part.type !== 'text') continue;
    const line = part.text.match(/\S[^\r\n]*/)?.[0];
    if (line) return line.trim().slice(0, 180);
  }
  return undefined;
}

export type RpcAssistantStreamStatus = 'thinking' | 'streaming' | 'calling';

export class RpcAssistantStreamState {
  status: RpcAssistantStreamStatus = 'thinking';
  private currentMessage: AssistantMessage | null = null;
  private readonly pendingToolArguments = new Set<number>();
  private readonly toolArguments = new Map<number, string>();

  get message(): AssistantMessage | null {
    this.flushToolArguments();
    return this.currentMessage;
  }

  /** Unlike message, reading a public-text preview never parses tool arguments. */
  get textPreview(): string | undefined {
    return assistantTextPreview(this.currentMessage);
  }

  /** Parse only changed arguments when a snapshot or UI frame actually needs them. */
  flushToolArguments(): boolean {
    if (!this.currentMessage || !this.pendingToolArguments.size) return false;
    for (const index of this.pendingToolArguments) {
      const block = this.currentMessage.content[index];
      if (block?.type === 'toolCall')
        block.arguments = parseStreamingJson(this.toolArguments.get(index) ?? '');
    }
    this.pendingToolArguments.clear();
    return true;
  }

  start(message: AssistantMessage): void {
    this.currentMessage = message;
    this.status = 'thinking';
    this.toolArguments.clear();
    this.pendingToolArguments.clear();
  }

  /** Return the live message without forcing argument parsing between UI frames. */
  update(delta: any, cumulativeMessage?: AssistantMessage): AssistantMessage | null {
    if (cumulativeMessage?.role === 'assistant') {
      this.currentMessage = cumulativeMessage;
      this.toolArguments.clear();
      this.pendingToolArguments.clear();
    } else if (this.currentMessage) {
      this.applyDelta(delta);
    }
    if (
      delta?.type === 'thinking_start' ||
      delta?.type === 'thinking_delta' ||
      delta?.type === 'thinking_end'
    ) {
      this.status = 'thinking';
    } else if (
      delta?.type === 'text_start' ||
      delta?.type === 'text_delta' ||
      delta?.type === 'text_end'
    ) {
      this.status = 'streaming';
    } else if (
      delta?.type === 'toolcall_start' ||
      delta?.type === 'toolcall_delta' ||
      delta?.type === 'toolcall_end'
    ) {
      this.status = 'calling';
    }
    return this.currentMessage;
  }

  resume(
    message: AssistantMessage,
    status: RpcAssistantStreamStatus,
    toolArguments: Array<[number, string]> = [],
  ): void {
    this.currentMessage = message;
    this.status = status;
    this.toolArguments.clear();
    this.pendingToolArguments.clear();
    for (const [index, raw] of toolArguments) {
      if (Number.isInteger(index) && index >= 0 && typeof raw === 'string')
        this.toolArguments.set(index, raw);
    }
  }

  snapshotToolArguments(): Array<[number, string]> {
    return [...this.toolArguments.entries()];
  }

  finish(message?: AssistantMessage): void {
    if (message?.role === 'assistant') this.currentMessage = message;
    else this.flushToolArguments();
    this.toolArguments.clear();
    this.pendingToolArguments.clear();
  }

  clear(): void {
    this.currentMessage = null;
    this.toolArguments.clear();
    this.pendingToolArguments.clear();
  }

  private applyDelta(delta: any): void {
    if (!this.currentMessage || !Number.isInteger(delta?.contentIndex) || delta.contentIndex < 0)
      return;
    const index = delta.contentIndex;
    const content = this.currentMessage.content as any[];
    if (
      delta.type === 'thinking_start' ||
      delta.type === 'text_start' ||
      delta.type === 'toolcall_start'
    ) {
      this.toolArguments.delete(index);
      this.pendingToolArguments.delete(index);
    }
    if (delta.type === 'thinking_start') {
      content[index] = { type: 'thinking', thinking: '' };
    } else if (delta.type === 'thinking_delta') {
      const block =
        content[index]?.type === 'thinking' ? content[index] : { type: 'thinking', thinking: '' };
      block.thinking += typeof delta.delta === 'string' ? delta.delta : '';
      content[index] = block;
    } else if (delta.type === 'thinking_end') {
      content[index] = {
        type: 'thinking',
        thinking: typeof delta.content === 'string' ? delta.content : '',
      };
    } else if (delta.type === 'text_start') {
      content[index] = { type: 'text', text: '' };
    } else if (delta.type === 'text_delta') {
      const block = content[index]?.type === 'text' ? content[index] : { type: 'text', text: '' };
      block.text += typeof delta.delta === 'string' ? delta.delta : '';
      content[index] = block;
    } else if (delta.type === 'text_end') {
      content[index] = {
        type: 'text',
        text: typeof delta.content === 'string' ? delta.content : '',
      };
    } else if (delta.type === 'toolcall_start') {
      this.toolArguments.set(index, '');
      content[index] = {
        type: 'toolCall',
        id: delta.id ?? `streaming-${index}`,
        name: delta.toolName ?? 'tool',
        arguments: {},
      };
    } else if (delta.type === 'toolcall_delta') {
      const raw = `${this.toolArguments.get(index) ?? ''}${typeof delta.delta === 'string' ? delta.delta : ''}`;
      this.toolArguments.set(index, raw);
      const block =
        content[index]?.type === 'toolCall'
          ? content[index]
          : { type: 'toolCall', id: `streaming-${index}`, name: 'tool', arguments: {} };
      this.pendingToolArguments.add(index);
      content[index] = block;
    } else if (delta.type === 'toolcall_end' && delta.toolCall?.type === 'toolCall') {
      this.toolArguments.delete(index);
      this.pendingToolArguments.delete(index);
      content[index] = delta.toolCall;
    }
  }
}

/** Build observer deltas independently of the SDK's mutable partial-message cache. */
export function toObserverEvent(event: AgentSessionEvent): any {
  if (event.type === 'message_start' && event.message.role === 'assistant') {
    return { ...event, message: structuredClone(event.message) };
  }
  if (event.type !== 'message_update') return event;
  if (event.message.role !== 'assistant')
    throw new Error('SDK message_update is not an assistant message.');
  const update = event.assistantMessageEvent;
  if (!('partial' in update))
    return { type: 'message_update', usage: event.message.usage, assistantMessageEvent: update };
  const { partial, ...delta } = update;
  if (delta.type === 'toolcall_start') {
    const toolCall = partial.content[delta.contentIndex];
    if (toolCall?.type !== 'toolCall')
      throw new Error('SDK toolcall_start is missing its tool call.');
    return {
      type: 'message_update',
      usage: event.message.usage,
      assistantMessageEvent: { ...delta, id: toolCall.id, toolName: toolCall.name },
    };
  }
  return { type: 'message_update', usage: event.message.usage, assistantMessageEvent: delta };
}

export class EventBroadcaster {
  private server: net.Server | null = null;
  private connections: net.Socket[] = [];
  private readonly marker: PeekMarker = {
    pid: process.pid,
    startedAt: Date.now(),
    token: randomUUID(),
  };
  private status: RpcAssistantStreamStatus | 'tool' | 'done' = 'thinking';
  private toolName?: string;
  private readonly assistantStream = new RpcAssistantStreamState();
  private userMessage: any = null;
  private responsePreview?: string;
  private readonly activeTools = new Map<
    string,
    {
      toolCallId: string;
      toolName: string;
      args: any;
      partialResult?: any;
      result?: any;
      isError?: boolean;
    }
  >();

  constructor(
    private readonly agentId: string,
    private readonly onError: (error: Error) => void = () => {},
  ) {}

  start(): void {
    try {
      ensurePrivateDir(SOCKET_DIR, true);
      markActive(this.agentId, 'active', this.marker);
    } catch (error) {
      clearActive(this.agentId, 'active');
      throw error;
    }
    const socketPath = getSocketPath(this.agentId);
    if (process.platform !== 'win32') {
      try {
        if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
      } catch {}
    }
    const server = (this.server = net.createServer((connection) => {
      this.connections.push(connection);
      try {
        connection.write(
          JSON.stringify({
            type: 'sync',
            status: this.status,
            toolName: this.toolName,
            partialMessage: this.assistantStream.message,
            toolArguments: this.assistantStream.snapshotToolArguments(),
            userMessage: this.userMessage,
            activeTools: [...this.activeTools.values()],
          }) + '\n',
        );
      } catch {}
      const remove = () => {
        this.connections = this.connections.filter((candidate) => candidate !== connection);
      };
      connection.on('close', remove);
      connection.on('error', remove);
    }));
    server.on('listening', () => {
      if (this.server !== server) return;
      try {
        markActive(this.agentId, 'peek', this.marker);
      } catch (error) {
        this.stopSocket();
        this.onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    server.on('error', (error) => {
      if (this.server !== server) return;
      this.stopSocket();
      this.onError(error);
    });
    try {
      server.listen(socketPath);
    } catch (error) {
      this.stopSocket();
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Reuse observer activity without opening a socket or exposing mutable tool state. */
  getWidgetActivity(): Pick<AgentWidgetSnapshot, 'activeTools' | 'responsePreview'> {
    return {
      activeTools: [...this.activeTools.values()]
        .filter((tool) => tool.result === undefined)
        .map((tool) => tool.toolName),
      responsePreview: this.assistantStream.textPreview ?? this.responsePreview,
    };
  }

  broadcast(event: any): void {
    const isToolExecution =
      event.type === 'tool_execution_start' ||
      event.type === 'tool_execution_update' ||
      event.type === 'tool_execution_end';

    // Only top-level calls get observer rows; parents carry nested progress in their own results.
    if (isToolExecution && event.parentToolCallId) return;

    if (event.type === 'message_start' && event.message?.role === 'user') {
      this.userMessage = event.message;
      this.responsePreview = undefined;
    } else if (event.type === 'message_start' && event.message?.role === 'assistant') {
      this.assistantStream.start(event.message);
      this.status = 'thinking';
    } else if (event.type === 'message_update') {
      this.assistantStream.update(event.assistantMessageEvent, event.message);
      this.status = this.assistantStream.status;
    } else if (event.type === 'tool_execution_start') {
      this.status = 'tool';
      this.toolName = event.toolName;
      if (event.toolCallId) {
        this.activeTools.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
      }
    } else if (event.type === 'tool_execution_update' && event.toolCallId) {
      const active = this.activeTools.get(event.toolCallId);
      if (active) active.partialResult = event.partialResult;
    } else if (event.type === 'tool_execution_end' && event.toolCallId) {
      const active = this.activeTools.get(event.toolCallId);
      if (active) {
        active.result = {
          ...event.result,
          durationMs: event.durationMs ?? event.result?.durationMs,
        };
        active.isError = event.isError ?? false;
      }
    } else if (event.type === 'message_end') {
      if (event.message?.role === 'assistant') {
        // Presentation sampling must never enter the observer/session failure path.
        try {
          this.responsePreview = assistantTextPreview(event.message);
        } catch {}
      }
      if (event.message?.role === 'toolResult' && event.message.toolCallId) {
        this.activeTools.delete(event.message.toolCallId);
      }
      this.assistantStream.clear();
      this.userMessage = null;
    } else if (event.type === 'agent_settled') {
      this.assistantStream.clear();
      this.responsePreview = undefined;
      this.userMessage = null;
      this.activeTools.clear();
      this.status = 'done';
      this.toolName = undefined;
    }
    const line = JSON.stringify(event) + '\n';
    for (const connection of this.connections) {
      try {
        connection.write(line);
      } catch {}
    }
  }

  private stopSocket(): void {
    clearActive(this.agentId, 'peek', this.marker);
    for (const connection of this.connections) {
      try {
        connection.destroy();
      } catch {}
    }
    this.connections = [];
    try {
      this.server?.close();
    } catch {}
    this.server = null;
    if (process.platform !== 'win32') {
      try {
        if (fs.existsSync(getSocketPath(this.agentId))) fs.unlinkSync(getSocketPath(this.agentId));
      } catch {}
    }
  }

  stop(): void {
    clearActive(this.agentId, 'active', this.marker);
    this.stopSocket();
  }
}

function extractTextFromMessage(message: any): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n\n');
}

export function previewText(text: string | undefined, maxLength = 180): string | null {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function canonicalAgentName(target: string): string {
  return target.startsWith('/') ? target : `/${target}`;
}

function targetMatches(event: AgentCompletionEvent, targets?: Set<string>): boolean {
  return !targets || targets.has(event.agentName);
}

export function consumeFirstMatchingMailboxEvent(
  events: AgentCompletionEvent[],
  parentSessionId: string,
  targets?: Set<string>,
): AgentCompletionEvent | undefined {
  const index = events.findIndex(
    (event) => event.parentSessionId === parentSessionId && targetMatches(event, targets),
  );
  if (index === -1) return undefined;
  return events.splice(index, 1)[0];
}

export class AgentManager {
  private readonly live = new Map<string, LiveAgent>();
  private readonly mailbox: AgentCompletionEvent[] = [];
  private waiters: Waiter[] = [];
  private readonly shutdownController = new AbortController();
  private readonly reconciliation: Promise<void>;
  private readonly maxIdleSessions: number;

  constructor(private readonly options: AgentManagerOptions = {}) {
    ensureBaseDirs();
    this.maxIdleSessions = loadSubagentConfig().maxIdleSessions ?? 4;
    pruneExpiredRuns();
    this.reconciliation = this.reconcileInactiveRuns();
    // Callers may await ready() after reconciliation has already settled.
    void this.reconciliation.catch(() => {});
    const nativeSessions = path.join(getAgentDir(), 'sessions');
    const storage = getRunsDir();
    const overlaps = (a: string, b: string) => {
      const relative = path.relative(a, b);
      return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
    };
    if (overlaps(nativeSessions, storage) || overlaps(storage, nativeSessions)) {
      this.reportError(
        undefined,
        new Error(
          "Subagent storageDir overlaps Pi's native session directory; child sessions may appear in /resume.",
        ),
      );
    }
  }

  async ready(): Promise<void> {
    await this.reconciliation;
  }

  private notifyStatusChange(info: AgentInfo): void {
    try {
      this.options.onActivityChange?.({
        parentSessionId: info.parentSessionId,
        agentName: info.canonicalName,
        active: info.status === 'starting' || info.status === 'running',
        status: info.status,
      });
    } catch (error) {
      this.reportError(undefined, error);
    }
  }

  private notifyCompletion(event: AgentCompletionEvent, waiting: boolean): void {
    try {
      this.options.onCompletion?.(event, waiting);
    } catch (error) {
      this.reportError(undefined, error);
    }
  }

  private reportError(live: LiveAgent | undefined, error: unknown): Error {
    const detail = error as { extensionPath?: string; event?: string; error?: unknown } | undefined;
    const failure =
      error instanceof Error
        ? error
        : new Error(
            detail && typeof detail === 'object' && 'error' in detail
              ? `${detail.extensionPath ?? 'child extension'}${detail.event ? ` (${detail.event})` : ''}: ${formatAgentError(detail.error)}`
              : formatAgentError(error),
          );
    try {
      live?.logger.info('error', failure.message);
    } catch {}
    try {
      if (this.options.onError) this.options.onError(failure);
      else console.error(`[subagents] ${formatAgentError(failure)}`);
    } catch {}
    return failure;
  }

  private async reconcileInactiveRuns(): Promise<void> {
    for (const info of readAllInfos()) {
      if ((info.status === 'starting' || info.status === 'running') && !isRunActive(info.id)) {
        info.status = 'interrupted';
        info.completedAt = Date.now();
        info.lastActivity = Date.now();
        saveInfo(info);
        this.notifyStatusChange(info);
      }
    }
  }

  async spawnAgent(params: SpawnAgentParams): Promise<{ task_name: string; nickname: null }> {
    throwIfAborted(this.shutdownController.signal);
    await this.reconciliation;
    throwIfAborted(this.shutdownController.signal);
    const taskName = normalizeTaskName(params.task_name);
    const definition = getAgentDefinition(params.agent_type);
    if (params.agent_type && !definition)
      throw new Error(`Agent template not found: ${params.agent_type}`);
    const templateModel = definition?.model
      ? { provider: definition.provider ?? params.inheritedProvider, modelId: definition.model }
      : undefined;
    const { provider, modelId } = params.model ??
      templateModel ?? { provider: params.inheritedProvider, modelId: params.inheritedModelId };
    const config = loadSubagentConfig();
    validateSystemPrompt();
    const extensions = normalizeList(definition?.extensions ?? config.defaults?.extensions);
    const tools =
      definition?.tools !== undefined
        ? normalizeTools(definition.tools)
        : extensions?.length
          ? undefined
          : normalizeTools(params.inheritedTools);
    const thinking =
      params.thinking ?? definition?.thinking ?? params.inheritedThinking ?? DEFAULT_THINKING;
    const cwd = path.resolve(params.cwd);
    const directory = scopeDir(params.parentSessionId);
    ensurePrivateDir(directory, true);

    const lockFile = path.join(directory, `.task-${taskStorageKey(taskName)}.lock`);
    let lock: number | undefined;
    try {
      try {
        lock = fs.openSync(lockFile, 'wx');
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      } catch (error: any) {
        if (error?.code === 'EEXIST')
          throw new Error(`Agent ${taskName} is already being created.`);
        throw error;
      }
      if (readScopeInfos(params.parentSessionId).some((info) => info.taskName === taskName)) {
        throw new Error(
          `Agent ${taskName} already exists in this parent session. Use a new task_name.`,
        );
      }
      const id = randomUUID();
      const info: AgentInfo = {
        id,
        taskName,
        canonicalName: `/${taskName}`,
        parentSessionId: params.parentSessionId,
        parentSessionFile: params.parentSessionFile,
        agentType: params.agent_type,
        color: definition?.color,
        provider,
        modelId,
        model: `${provider}:${modelId}`,
        thinking,
        tools,
        extensions,
        extensionPaths: resolveExtensionPaths(extensions, cwd),
        cwd,
        sessionFile: path.join(directory, `${id}.jsonl`),
        infoFile: path.join(directory, `${id}.info.json`),
        logFile: path.join(directory, `${id}.log`),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        startedAt: Date.now(),
        lastActivity: Date.now(),
        messageCount: 0,
        status: 'starting',
        lastTaskMessage: params.message,
      };
      saveInfo(info);
      this.notifyStatusChange(info);
      const prompt = [definition?.prompt, params.message].filter(Boolean).join('\n\n');
      try {
        await this.startLiveAgent(info, prompt, params.message, false);
      } catch (error) {
        const message = formatAgentError(error);
        if (error instanceof Error && error.message === message) throw error;
        throw new Error(message, { cause: error });
      }
      return { task_name: info.canonicalName, nickname: null };
    } finally {
      if (lock !== undefined) {
        fs.closeSync(lock);
        try {
          fs.unlinkSync(lockFile);
        } catch {}
      }
    }
  }

  private async startLiveAgent(
    info: AgentInfo,
    message: string,
    displayMessage = message,
    resume = true,
  ): Promise<void> {
    throwIfAborted(this.shutdownController.signal);
    if (this.live.has(info.id))
      throw new Error(
        `Agent ${info.canonicalName} already has a live session. Retry after startup finishes.`,
      );
    if (isRunActive(info.id))
      throw new Error(
        `Agent ${info.canonicalName} is active in another host; refusing to reopen its session file.`,
      );
    if (resume && !fs.existsSync(info.sessionFile))
      throw new Error(
        `Cannot resume agent ${info.canonicalName}: session history is missing: ${info.sessionFile}`,
      );
    // Native open initializes an existing empty file with a valid header. Even handled
    // first inputs then have a resumable path; no metadata heuristic can prove history exists.
    if (!resume) {
      try {
        fs.closeSync(fs.openSync(info.sessionFile, 'wx', 0o600));
      } catch (error) {
        // The persisted record and active notification were already published by the
        // caller; record the terminal failure so nothing dangles in 'starting'.
        const message = formatAgentError(error);
        info.status = 'failed';
        info.error = message;
        info.completedAt = Date.now();
        info.lastActivity = Date.now();
        try {
          saveInfo(info);
        } catch {
          // Keep the creation failure visible; waiters are still released below.
        }
        this.notifyStatusChange(info);
        this.pushMailbox(
          {
            id: randomUUID(),
            parentSessionId: info.parentSessionId,
            agentName: info.canonicalName,
            status: 'failed',
            error: message,
            createdAt: Date.now(),
          },
          true,
        );
        throw error;
      }
    }
    const live: LiveAgent = {
      info,
      broadcaster: new EventBroadcaster(info.id, (error) => this.failSession(live, error)),
      logger: new SessionLogger(info.logFile, (error) => this.reportError(undefined, error)),
      pendingCompactions: new Set(),
      closing: false,
      lastUsedAt: performance.now(),
      lastActivityPersistedAt: info.updatedAt,
    };
    this.live.set(info.id, live);
    await this.startRun(live, message, displayMessage);
  }

  private async startRun(
    live: LiveAgent,
    message: string,
    displayMessage = message,
  ): Promise<void> {
    const previous = { ...live.info };
    const run: RunState = {
      displayStartedAt: Date.now(),
      cancellation: new AbortController(),
      finalizedRun: false,
      awaitingPrompt: true,
      accepted: false,
      candidateResponse: '',
      settledAborted: false,
      observerSettled: false,
      pendingSteers: new Set(),
    };
    // Claim the idle slot before initialization, awaiting preflight, or invoking observers.
    live.run = run;
    const checkCanceled = () => {
      throwIfAborted(this.shutdownController.signal);
      throwIfAborted(run.cancellation.signal);
      if (live.eventError) throw live.eventError;
      if (live.closing || this.live.get(live.info.id) !== live || live.run !== run)
        throw new Error('Child session is closing.');
    };
    const timeout = new Error(
      `Timed out waiting for agent ${live.info.canonicalName} initialization or prompt acceptance.`,
    );
    try {
      checkCanceled();
      const initializing = !live.session;
      if (initializing) {
        ensureSystemPromptFile();
        live.broadcaster.start();
        live.info.status = 'starting';
        live.info.lastActivity = Date.now();
        saveInfo(live.info);
        this.notifyStatusChange(live.info);
        live.initialization = createChildSession({
          info: live.info,
          systemPromptPath: SYSTEM_PROMPT_PATH,
          projectTrusted: this.options.projectTrusted?.(live.info.cwd),
          checkCanceled,
          onCreated: (session) => {
            live.session = session;
            this.trackCompactions(live);
            live.unsubscribe = session.subscribe((event) => {
              // Listener failures must not escape into SDK message persistence.
              try {
                this.handleSessionEvent(live, event);
              } catch (error) {
                this.failSession(live, error);
              }
            });
          },
          onError: (error) => this.failSession(live, error),
          onShutdown: () => {
            // Register real termination before native abort can reenter this handler.
            live.closing = true;
            this.scheduleTermination(live);
            if (live.run)
              this.requestCancellation(
                live,
                live.run,
                new Error('Child extension requested shutdown.'),
              );
            try {
              if (live.run) this.finalizeRun(live, live.run, 'interrupted');
            } catch (error) {
              this.reportError(live, error);
            }
          },
          log: (text) => live.logger.info('sdk', text),
        });
      }
      const startup = initializing
        ? live.initialization!.then(async () => {
            checkCanceled();
            await this.prompt(live, run, message, displayMessage);
          })
        : this.prompt(live, run, message, displayMessage);
      await boundedWait(startup, DEFAULT_STARTUP_TIMEOUT_MS, timeout, run.cancellation.signal);
    } catch (error) {
      if (error === timeout) {
        live.closing = true;
        this.requestCancellation(live, run, timeout);
      }
      try {
        if (
          run.promptFinished &&
          !run.accepted &&
          !run.finalizedRun &&
          !run.cancellation.signal.aborted &&
          !this.shutdownController.signal.aborted &&
          this.live.get(live.info.id) === live &&
          live.run === run &&
          FINAL_STATUSES.has(previous.status)
        ) {
          live.info = previous;
          run.finalizedRun = true;
          try {
            saveInfo(previous);
          } finally {
            const completion = run.suspendedCompletion;
            delete run.suspendedCompletion;
            if (completion) this.pushMailbox(completion, false);
            else {
              for (const waiter of this.waiters.filter(
                (waiter) =>
                  waiter.parentSessionId === previous.parentSessionId &&
                  waiter.targets?.has(previous.canonicalName),
              )) {
                waiter.resolve({
                  id: randomUUID(),
                  parentSessionId: previous.parentSessionId,
                  agentName: previous.canonicalName,
                  status: previous.status,
                  finalResponse: previous.finalResponse,
                  error: previous.error,
                  createdAt: Date.now(),
                });
              }
            }
            this.notifyStatusChange(previous);
          }
        } else if (!run.finalizedRun) {
          if (
            !live.eventError &&
            (this.shutdownController.signal.aborted ||
              (run.cancellation.signal.aborted && error !== timeout))
          )
            this.finalizeRun(live, run, 'interrupted');
          else this.finalizeRun(live, run, 'failed', formatAgentError(live.eventError ?? error));
        }
      } catch (saveError) {
        live.closing = true;
        this.reportError(live, saveError);
      } finally {
        // Only explicit interruption of an initialized session is reusable here.
        if (!run.cancellation.signal.aborted || !run.promptFinished) live.closing = true;
        try {
          if (live.closing) await this.waitForTermination(live);
          else await this.waitForRunSettlement(live, run);
        } catch (cleanupError) {
          this.reportError(live, cleanupError);
        }
      }
      throw error;
    }
  }

  private async prompt(
    live: LiveAgent,
    run: RunState,
    message: string,
    displayMessage: string,
  ): Promise<void> {
    const session = live.session!;
    run.suspendedCompletion = consumeFirstMatchingMailboxEvent(
      this.mailbox,
      live.info.parentSessionId,
      new Set([live.info.canonicalName]),
    );
    live.info.status = 'running';
    live.info.lastTaskMessage = displayMessage;
    live.info.lastActivity = Date.now();
    live.info.messageCount += 1;
    delete live.info.finalResponse;
    delete live.info.error;
    delete live.info.completedAt;
    saveInfo(live.info);
    live.lastActivityPersistedAt = live.info.updatedAt;
    this.notifyStatusChange(live.info);

    const {
      promise: accepted,
      resolve: resolveAccepted,
      reject: rejectAccepted,
    } = Promise.withResolvers<void>();
    throwIfAborted(this.shutdownController.signal);
    throwIfAborted(run.cancellation.signal);
    if (live.closing || live.run !== run) throw new Error('Child session is closing.');
    const promptFinished = promptChildSession(session, message, () => {
      if (live.run !== run || this.live.get(live.info.id) !== live) return;
      delete run.suspendedCompletion;
      run.accepted = true;
      resolveAccepted();
      if (run.cancellation.signal.aborted || live.closing) this.requestAbort(live);
    });
    run.promptFinished = promptFinished;
    const finished = promptFinished.then(() => this.waitForNativeIdle(live));
    void finished.then(
      () => {
        if (!run.accepted)
          rejectAccepted(new Error('Child prompt returned without an acceptance result.'));
        else this.finishRun(live, run);
      },
      (error) => {
        rejectAccepted(error);
        if (run.accepted) this.finishRun(live, run, error);
      },
    );
    await accepted;
    if (run.cancellation.signal.aborted || this.shutdownController.signal.aborted) {
      if (live.run === run) this.requestAbort(live);
      throw abortError(
        run.cancellation.signal.aborted ? run.cancellation.signal : this.shutdownController.signal,
      );
    }
    if (this.live.get(live.info.id) === live && live.run === run && !run.finalizedRun)
      run.awaitingPrompt = false;
  }

  private finishRun(live: LiveAgent, run: RunState, error?: unknown): void {
    if (this.live.get(live.info.id) !== live || live.run !== run) return;
    this.clearModelResponseTimer(run);
    // Rejected execution/observer failures are not ordinary model error messages.
    if (error !== undefined || live.eventError) live.closing = true;
    try {
      this.sampleContextUsage(live);
      if (!run.finalizedRun) {
        const failure =
          live.eventError ??
          error ??
          run.candidateError ??
          (run.settledAborted ? 'Agent ended with aborted.' : undefined);
        if (failure !== undefined) this.finalizeRun(live, run, 'failed', formatAgentError(failure));
        else this.finalizeRun(live, run, 'completed');
      }
    } catch (error) {
      live.closing = true;
      this.reportError(live, error);
    } finally {
      if (live.closing) this.scheduleTermination(live);
      else void this.settleRun(live, run).catch((error) => this.failSession(live, error));
    }
  }

  private trackCompactions(live: LiveAgent): void {
    const session = live.session!;
    const compact = session.compact.bind(session);
    // ctx.compact also calls this public instance method. Register before native
    // abort/events can reenter; neither busy events nor another call can replace it.
    session.compact = async (...args) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      live.pendingCompactions.add(promise);
      try {
        return await compact(...args);
      } finally {
        live.pendingCompactions.delete(promise);
        resolve();
        if (this.live.get(live.info.id) === live && !live.run && !live.closing) {
          try {
            this.trimIdleSessions();
          } catch (error) {
            this.failSession(live, error);
          }
        }
      }
    };
  }

  private trackNativeWork(live: LiveAgent): void {
    const work = live.session!.waitForIdle();
    live.nativeWork = work;
    void work.then(
      () => {
        if (this.live.get(live.info.id) !== live || live.nativeWork !== work) return;
        delete live.nativeWork;
        // Manual compaction (or extension-owned work) may have no RunState to settle.
        try {
          if (!live.run && !live.closing) this.trimIdleSessions();
        } catch (error) {
          this.failSession(live, error);
        }
      },
      (error) => {
        if (live.nativeWork !== work) {
          this.reportError(live, error);
          return;
        }
        delete live.nativeWork;
        this.failSession(live, error);
      },
    );
  }

  private async waitForNativeIdle(live: LiveAgent): Promise<void> {
    const session = live.session!;
    do {
      await Promise.all([live.nativeWork ?? session.waitForIdle(), ...live.pendingCompactions]);
      // Busy events or public compact reentry may register more work while awaiting.
    } while (live.nativeWork || live.pendingCompactions.size || !session.isIdle);
  }

  private settleRun(live: LiveAgent, run: RunState): Promise<void> {
    if (run.settlement) return run.settlement;
    run.settlement = Promise.resolve().then(async () => {
      await run.promptFinished?.catch(() => {});
      // A native idle session can still have async steer input handlers in flight.
      await Promise.allSettled(run.pendingSteers);
      if (this.live.get(live.info.id) !== live || live.run !== run || live.closing) return;
      const session = live.session!;
      await this.waitForNativeIdle(live);
      if (live.run !== run || live.closing) return;
      session.clearQueue();
      this.clearModelResponseTimer(run);
      if (!run.observerSettled) {
        live.broadcaster.broadcast({
          type: 'agent_settled',
          aborted: run.cancellation.signal.aborted,
        });
        run.observerSettled = true;
      }
      delete live.run;
      live.lastUsedAt = performance.now();
      this.trimIdleSessions();
    });
    return run.settlement;
  }

  private waitForRunSettlement(live: LiveAgent, run: RunState): Promise<void> {
    return boundedWait(
      this.settleRun(live, run),
      CLEANUP_WAIT_TIMEOUT_MS,
      `Agent ${live.info.canonicalName} is still finishing after ${CLEANUP_WAIT_TIMEOUT_MS} ms; its session file remains locked until submitted work exits.`,
    );
  }

  private trimIdleSessions(): void {
    const idle = [...this.live.values()]
      .filter(
        (live) =>
          !live.run &&
          !live.closing &&
          !live.nativeWork &&
          !live.pendingCompactions.size &&
          live.session?.isIdle,
      )
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const live of idle.slice(0, Math.max(0, idle.length - this.maxIdleSessions))) {
      live.closing = true;
      this.scheduleTermination(live);
    }
  }

  private failSession(live: LiveAgent, error: unknown): void {
    const failure = this.reportError(live, error);
    live.eventError ??= failure;
    if (this.live.get(live.info.id) !== live) return;
    live.closing = true;
    this.scheduleTermination(live);
    const run = live.run;
    if (!run) return;
    this.requestCancellation(live, run, live.eventError);
    try {
      this.finalizeRun(live, run, 'failed', live.eventError.message);
    } catch (saveError) {
      this.reportError(live, saveError);
    }
  }

  private sampleContextUsage(live: LiveAgent): void {
    if (this.live.get(live.info.id) !== live || !live.session) return;
    try {
      const contextUsage = normalizeContextUsage(live.session.getContextUsage());
      if (sameContextUsage(live.info.contextUsage, contextUsage)) return;
      const candidate = { ...live.info };
      if (contextUsage) candidate.contextUsage = contextUsage;
      else delete candidate.contextUsage;
      saveInfo(candidate);
      Object.assign(live.info, candidate);
      if (!contextUsage) delete live.info.contextUsage;
    } catch (error) {
      // Report sampling failures while continuing result delivery and cleanup.
      this.reportError(live, error);
    }
  }

  private clearModelResponseTimer(run: RunState | undefined): void {
    if (!run) return;
    if (run.modelResponseTimer !== undefined) clearTimeout(run.modelResponseTimer);
    delete run.modelResponseTimer;
  }

  private startModelResponseTimer(live: LiveAgent, run: RunState): void {
    this.clearModelResponseTimer(run);
    if (live.closing || run.finalizedRun) return;
    const timeoutMs = Math.max(
      0,
      this.options.modelResponseTimeoutMs ??
        loadSubagentConfig().modelResponseTimeoutMs ??
        DEFAULT_MODEL_RESPONSE_TIMEOUT_MS,
    );
    if (timeoutMs === 0) return;
    run.modelResponseTimer = setTimeout(() => {
      delete run.modelResponseTimer;
      if (
        this.live.get(live.info.id) !== live ||
        live.run !== run ||
        live.closing ||
        run.finalizedRun
      )
        return;
      const error = `Model response exceeded ${timeoutMs} ms without completing.`;
      live.closing = true;
      this.requestCancellation(live, run, new Error(error));
      try {
        this.finalizeRun(live, run, 'failed', error);
      } catch (error) {
        this.reportError(live, error);
      } finally {
        this.scheduleTermination(live);
      }
    }, timeoutMs);
    run.modelResponseTimer.unref?.();
  }

  private handleSessionEvent(live: LiveAgent, event: AgentSessionEvent): void {
    if (this.live.get(live.info.id) !== live) return;
    // Acquire the public idle waiter before observers can reenter or settled hooks expose isIdle.
    if (
      event.type === 'agent_start' ||
      event.type === 'compaction_start' ||
      event.type === 'auto_retry_start'
    )
      this.trackNativeWork(live);
    live.broadcaster.broadcast(toObserverEvent(event));
    const run = live.run;
    if (
      event.type === 'agent_start' &&
      (live.closing || run?.cancellation.signal.aborted || live.eventError)
    )
      this.requestAbort(live);
    if (!run) return;
    if (event.type === 'agent_settled') {
      run.observerSettled = true;
      run.settledAborted = event.aborted;
      this.clearModelResponseTimer(run);
    }
    if (run.finalizedRun || (run.awaitingPrompt && !run.promptFinished)) return;
    // Sample after persistence; message_end is dispatched before its message is appended.
    if (
      event.type === 'turn_end' ||
      (event.type === 'compaction_end' && event.result) ||
      (event.type === 'entry_appended' &&
        ['context_edit', 'compaction', 'message', 'custom_message'].includes(event.entry.type))
    ) {
      this.sampleContextUsage(live);
    }
    if (event.type === 'agent_settled') return;
    if (live.closing) return;
    if (event.type === 'agent_start') {
      live.info.status = 'running';
      live.info.lastActivity = Date.now();
      saveInfo(live.info);
      live.lastActivityPersistedAt = live.info.updatedAt;
      this.notifyStatusChange(live.info);
    } else if (event.type === 'message_start' && event.message.role === 'assistant') {
      this.startModelResponseTimer(live, run);
    } else if (event.type === 'message_update' || event.type === 'tool_execution_update') {
      live.info.lastActivity = Date.now();
      if (live.info.lastActivity - live.lastActivityPersistedAt >= ACTIVITY_PERSIST_INTERVAL_MS) {
        saveInfo(live.info);
        live.lastActivityPersistedAt = live.info.updatedAt;
      }
    } else if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      live.info.lastActivity = Date.now();
      saveInfo(live.info);
      live.lastActivityPersistedAt = live.info.updatedAt;
    } else if (event.type === 'message_end' && event.message.role === 'assistant') {
      this.clearModelResponseTimer(run);
      run.candidateResponse = extractTextFromMessage(event.message).trim();
      run.candidateError =
        event.message.stopReason === 'error' || event.message.stopReason === 'aborted'
          ? event.message.errorMessage || `Agent ended with ${event.message.stopReason}.`
          : undefined;
    } else if (event.type === 'auto_retry_end' && !event.success && event.finalError) {
      run.candidateError = event.finalError;
    }
  }

  private finalizeRun(
    live: LiveAgent,
    run: RunState,
    status: 'completed' | 'failed' | 'interrupted',
    error?: string,
  ): void {
    if (this.live.get(live.info.id) !== live || live.run !== run || run.finalizedRun) return;
    // Close only this run's admission before invoking reentrant callbacks.
    run.finalizedRun = true;
    delete run.suspendedCompletion;
    this.clearModelResponseTimer(run);
    live.info.status = status;
    if (status === 'completed') live.info.finalResponse = run.candidateResponse;
    else delete live.info.finalResponse;
    if (error !== undefined) live.info.error = formatAgentError(error);
    else delete live.info.error;
    live.info.completedAt = Date.now();
    live.info.lastActivity = Date.now();
    try {
      saveInfo(live.info);
    } finally {
      // Publish status and resolve waits even when persistence fails.
      this.notifyStatusChange(live.info);
      this.pushMailbox(
        {
          id: randomUUID(),
          parentSessionId: live.info.parentSessionId,
          agentName: live.info.canonicalName,
          status,
          ...(status === 'completed' ? { finalResponse: live.info.finalResponse } : {}),
          ...(error !== undefined ? { error: live.info.error } : {}),
          createdAt: Date.now(),
        },
        status !== 'interrupted',
      );
    }
  }

  private removeMailboxEvents(parentSessionId: string, agentName: string): void {
    for (let index = this.mailbox.length - 1; index >= 0; index--) {
      const event = this.mailbox[index];
      if (event.parentSessionId === parentSessionId && event.agentName === agentName)
        this.mailbox.splice(index, 1);
    }
  }

  private pushMailbox(event: AgentCompletionEvent, notify = true): void {
    this.removeMailboxEvents(event.parentSessionId, event.agentName);
    const waiterIndex = this.waiters.findIndex(
      (waiter) =>
        waiter.parentSessionId === event.parentSessionId && targetMatches(event, waiter.targets),
    );
    if (waiterIndex !== -1) {
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      // Queue the result before waking the wait tool; it returns only status to the model.
      if (notify) this.notifyCompletion(event, true);
      waiter.resolve(event);
      return;
    }
    this.mailbox.push(event);
    if (notify) this.notifyCompletion(event, false);
  }

  /** Memory-only summaries. Cache writes below are presentation-only, never saveInfo(). */
  getWidgetSnapshot(parentSessionId: string): readonly AgentWidgetSnapshot[] {
    const snapshots: AgentWidgetSnapshot[] = [];
    const now = Date.now();
    for (const live of this.live.values()) {
      const { info, session, run } = live;
      if (
        info.parentSessionId !== parentSessionId ||
        (info.status !== 'starting' && info.status !== 'running')
      )
        continue;

      let provider = info.provider;
      let modelId = info.modelId;
      let thinking = info.thinking;
      let stats: LiveAgent['widgetStats'];
      if (session) {
        try {
          const model = session.model;
          provider = model?.provider ?? provider;
          modelId = model?.id ?? modelId;
          thinking = session.thinkingLevel;
        } catch {} // Keep configured metadata when a native getter is unavailable.
        try {
          const entryCount = session.sessionManager.getEntryCount();
          stats = live.widgetStats;
          if (stats?.session !== session || stats.entryCount !== entryCount) {
            let tokens = 0;
            let compactionCount = 0;
            for (const entry of session.sessionManager.getEntries()) {
              if (entry.type === 'compaction') compactionCount++;
              if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
              const usage = entry.message.usage;
              if (!usage) continue;
              // Match the reference display, not SDK billing totals or tool usage.
              for (const value of [usage.input, usage.output, usage.cacheWrite])
                if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
                  tokens += value;
            }
            stats = live.widgetStats = { session, entryCount, tokens, compactionCount };
          }
        } catch {
          stats = undefined; // Unknown is not zero; retry on the next UI refresh.
        }
      }
      let activity: Pick<AgentWidgetSnapshot, 'activeTools' | 'responsePreview'> = {
        activeTools: [],
      };
      try {
        activity = live.broadcaster.getWidgetActivity();
      } catch {} // Display failure cannot fail, cancel, or finalize an agent.
      snapshots.push({
        canonicalName: info.canonicalName,
        color: info.color,
        status: info.status,
        provider,
        modelId,
        thinking,
        tokens: stats?.tokens,
        compactionCount: stats?.compactionCount,
        contextUsage: normalizeContextUsage(info.contextUsage),
        elapsedMs: run ? Math.max(0, now - run.displayStartedAt) : undefined,
        ...activity,
      });
    }
    return snapshots;
  }

  listAgentInfos(
    pathPrefix: string | undefined,
    parentSessionId: string,
    includeAll = false,
  ): AgentInfo[] {
    const prefix = pathPrefix?.trim().replace(/^\/+/, '');
    const infos = includeAll ? readAllInfos() : readScopeInfos(parentSessionId);
    return infos.filter((info) => !prefix || info.taskName.startsWith(prefix));
  }

  listAgents(
    pathPrefix: string | undefined,
    parentSessionId: string,
    includeAll = false,
  ): AgentListEntry[] {
    return this.listAgentInfos(pathPrefix, parentSessionId, includeAll).map((info) => ({
      agent_name: info.canonicalName,
      agent_status: info.status,
      last_task_message: previewText(info.lastTaskMessage),
      ...(includeAll ? { parent_session_id: info.parentSessionId } : {}),
    }));
  }

  getAgentInfo(target: string, parentSessionId: string): AgentInfo {
    const info = getAgent(target, parentSessionId);
    if (!info) throw new Error(`Agent not found in this parent session: ${target}`);
    return info;
  }

  readAgentResponse(target: string, parentSessionId: string): AgentResponseEntry {
    const info = this.getAgentInfo(target, parentSessionId);
    return {
      agent_name: info.canonicalName,
      status: info.status,
      ...(info.finalResponse !== undefined ? { finalResponse: info.finalResponse } : {}),
      ...(info.error ? { error: info.error } : {}),
      last_task_message: previewText(info.lastTaskMessage),
    };
  }

  private waitTargetInfo(info: AgentInfo): AgentInfo {
    const live = this.live.get(info.id);
    if (live) return live.info;
    const event = this.mailbox.find(
      (event) =>
        event.parentSessionId === info.parentSessionId && event.agentName === info.canonicalName,
    );
    return event
      ? {
          ...info,
          status: event.status,
          finalResponse: event.finalResponse,
          error: event.error,
          completedAt: event.createdAt,
        }
      : info;
  }

  private checkWaitTarget(info: AgentInfo): void {
    if (!FINAL_STATUSES.has(info.status) && !this.live.has(info.id) && !isRunActive(info.id)) {
      throw new Error(
        `Agent ${info.canonicalName} has no active session but its saved status is ${info.status}. A status save may have failed; inspect the subagent log before retrying.`,
      );
    }
  }

  async waitAgent(
    parentSessionId: string,
    targets?: string[],
    signal?: AbortSignal,
  ): Promise<{ message: string; event: AgentCompletionEvent }> {
    const waitSignal = signal
      ? AbortSignal.any([signal, this.shutdownController.signal])
      : this.shutdownController.signal;
    throwIfAborted(waitSignal);
    const normalizedTargets = targets?.length
      ? new Set(targets.map(canonicalAgentName))
      : undefined;
    const existing = consumeFirstMatchingMailboxEvent(
      this.mailbox,
      parentSessionId,
      normalizedTargets,
    );
    if (existing) {
      return {
        message: `Wait completed: ${existing.agentName} ${existing.status}.`,
        event: existing,
      };
    }
    if (normalizedTargets) {
      const targetInfos = readScopeInfos(parentSessionId)
        .filter((info) => normalizedTargets.has(info.canonicalName))
        .map((info) => this.waitTargetInfo(info));
      if (!targetInfos.length)
        throw new Error(
          `Agent not found in this parent session: ${Array.from(normalizedTargets).join(', ')}`,
        );
      const finalInfo = targetInfos.find((info) => FINAL_STATUSES.has(info.status));
      if (!finalInfo) for (const info of targetInfos) this.checkWaitTarget(info);
      if (finalInfo) {
        return {
          message: `Wait completed: ${finalInfo.canonicalName} ${finalInfo.status}.`,
          event: {
            id: randomUUID(),
            parentSessionId,
            agentName: finalInfo.canonicalName,
            status: finalInfo.status,
            finalResponse: finalInfo.finalResponse,
            error: finalInfo.error,
            createdAt: Date.now(),
          },
        };
      }
    }
    return await new Promise((resolve, reject) => {
      let waiter: Waiter;
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        waitSignal.removeEventListener('abort', onAbort);
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        callback();
      };
      const onAbort = () => settle(() => reject(abortError(waitSignal)));
      waiter = {
        parentSessionId,
        targets: normalizedTargets,
        resolve: (event) =>
          settle(() =>
            resolve({ message: `Wait completed: ${event.agentName} ${event.status}.`, event }),
          ),
      };
      this.waiters.push(waiter);
      waitSignal.addEventListener('abort', onAbort, { once: true });
      if (waitSignal.aborted) onAbort();
    });
  }

  async sendMessage(
    parentSessionId: string,
    target: string,
    message: string,
  ): Promise<{ delivery: 'steer' | 'prompt' }> {
    throwIfAborted(this.shutdownController.signal);
    await this.reconciliation;
    throwIfAborted(this.shutdownController.signal);
    let info = this.getAgentInfo(target, parentSessionId);
    let live = this.live.get(info.id);
    while (live) {
      if (live.closing) await this.waitForTermination(live);
      else if (live.run?.finalizedRun) await this.waitForRunSettlement(live, live.run);
      else if (
        !live.run &&
        !live.nativeWork &&
        !live.pendingCompactions.size &&
        live.session?.isIdle
      ) {
        const trusted = this.options.projectTrusted?.(info.cwd);
        const model = live.session.model;
        if (
          (trusted === undefined || trusted === live.session.settingsManager.isProjectTrusted()) &&
          model?.provider === info.provider &&
          model.id === info.modelId
        ) {
          await this.startRun(live, message);
          return { delivery: 'prompt' };
        }
        // Rebuild native resources for changed trust or selection, preserving the saved exact route.
        live.closing = true;
        await this.waitForTermination(live);
      } else break;
      throwIfAborted(this.shutdownController.signal);
      info = this.getAgentInfo(target, parentSessionId);
      live = this.live.get(info.id);
    }
    if (!live) {
      await this.startLiveAgent(info, message);
      return { delivery: 'prompt' };
    }
    const run = live.run;
    if (run?.awaitingPrompt)
      throw new Error(
        `Agent ${info.canonicalName} is still starting. Retry after startup finishes.`,
      );
    const current = live;
    const session = current.session!;
    if (!run || run.finalizedRun || !session.isStreaming)
      throw new Error(`Agent ${info.canonicalName} is finishing. Retry after cleanup.`);
    // Register before SDK steer: input handlers and observers may synchronously reenter.
    const { promise: pending, resolve: resolvePending } = Promise.withResolvers<void>();
    run.pendingSteers.add(pending);
    let steer: Promise<unknown> | undefined;
    const timeout = new Error(
      `Timed out waiting for agent ${info.canonicalName} steering acceptance.`,
    );
    try {
      steer = session.steer(message, undefined, { source: 'rpc' });
      await boundedWait(steer, DEFAULT_STARTUP_TIMEOUT_MS, timeout, this.shutdownController.signal);
      throwIfAborted(this.shutdownController.signal);
      if (
        this.live.get(info.id) !== current ||
        current.run !== run ||
        current.closing ||
        run.finalizedRun ||
        !session.isStreaming
      ) {
        throw new Error(
          `Agent ${info.canonicalName} ended while steering input was being processed; delivery cannot be confirmed. Retry after cleanup.`,
        );
      }
      current.info.lastTaskMessage = message;
      current.info.lastActivity = Date.now();
      try {
        saveInfo(current.info);
      } catch (error) {
        this.failSession(current, error);
        throw error;
      }
      return { delivery: 'steer' };
    } catch (error) {
      if (error === timeout && this.live.get(info.id) === current && current.run === run) {
        current.closing = true;
        this.requestCancellation(current, run, timeout);
        try {
          this.finalizeRun(current, run, 'failed', timeout.message);
        } catch (saveError) {
          this.reportError(current, saveError);
        } finally {
          this.scheduleTermination(current);
        }
      }
      throw error;
    } finally {
      const finish = () => {
        if (this.live.get(info.id) === current && current.run === run) {
          if (
            run.cancellation.signal.aborted ||
            run.finalizedRun ||
            current.closing ||
            !session.isStreaming
          ) {
            try {
              session.clearQueue();
            } catch (error) {
              this.failSession(current, error);
            }
          }
          if (run.cancellation.signal.aborted) this.requestAbort(current);
        }
        run.pendingSteers.delete(pending);
        resolvePending();
      };
      if (steer) void steer.then(finish, finish);
      else finish();
    }
  }

  async interruptAgent(
    parentSessionId: string,
    target: string,
  ): Promise<{ previous_status: AgentRuntimeStatus }> {
    await this.reconciliation;
    const persisted = this.getAgentInfo(target, parentSessionId);
    const previous = persisted.status;
    const live = this.live.get(persisted.id);
    if (previous !== 'starting' && previous !== 'running') {
      if (live?.closing) await this.waitForTermination(live);
      else if (live?.run?.finalizedRun) await this.waitForRunSettlement(live, live.run);
      return { previous_status: previous };
    }
    if (live?.run) {
      const run = live.run;
      if (!live.session || !run.promptFinished || this.maxIdleSessions === 0) live.closing = true;
      this.requestCancellation(live, run, new Error('Agent interrupted.'));
      let failure: unknown;
      try {
        this.finalizeRun(live, run, 'interrupted');
      } catch (error) {
        live.closing = true;
        failure = error;
      } finally {
        try {
          if (live.closing) await this.waitForTermination(live);
          else await this.waitForRunSettlement(live, run);
        } catch (error) {
          this.reportError(live, error);
          failure ??= error;
        }
      }
      if (failure) throw failure;
    } else {
      if (isRunActive(persisted.id))
        throw new Error(
          `Agent ${persisted.canonicalName} is active in another host and cannot be controlled by this manager.`,
        );
      persisted.status = 'interrupted';
      persisted.completedAt = Date.now();
      persisted.lastActivity = Date.now();
      delete persisted.finalResponse;
      delete persisted.error;
      saveInfo(persisted);
      this.notifyStatusChange(persisted);
      this.pushMailbox(
        {
          id: randomUUID(),
          parentSessionId,
          agentName: persisted.canonicalName,
          status: 'interrupted',
          createdAt: Date.now(),
        },
        false,
      );
    }
    return { previous_status: previous };
  }

  private requestCancellation(live: LiveAgent, run: RunState, reason: Error): void {
    if (live.run !== run) return;
    this.clearModelResponseTimer(run);
    run.cancellation.abort(reason);
    try {
      live.session?.clearQueue();
    } catch (error) {
      this.reportError(live, error);
      live.closing = true;
    }
    this.requestAbort(live);
  }

  private requestAbort(live: LiveAgent): void {
    if (!live.session || this.live.get(live.info.id) !== live) return;
    // Let SDK callbacks return while cancellation finishes.
    try {
      void live.session.abort().catch((error) => this.reportError(live, error));
    } catch (error) {
      this.reportError(live, error);
    }
  }

  private scheduleTermination(live: LiveAgent): void {
    void this.waitForTermination(live).catch((error) => this.reportError(live, error));
  }

  private waitForTermination(live: LiveAgent): Promise<void> {
    return boundedWait(
      this.terminateSession(live),
      CLEANUP_WAIT_TIMEOUT_MS,
      `Agent ${live.info.canonicalName} is still closing after ${CLEANUP_WAIT_TIMEOUT_MS} ms; its session file remains locked until actual cleanup completes.`,
    );
  }

  private terminateSession(live: LiveAgent): Promise<void> {
    if (live.termination) return live.termination;
    live.closing = true;
    const run = live.run;
    this.clearModelResponseTimer(run);
    // abort listeners can synchronously request shutdown. Publish the shared promise first.
    live.termination = Promise.resolve().then(async () => {
      this.requestAbort(live);
      // Wait for initialization and submitted input before releasing session ownership.
      await live.initialization?.catch(() => {});
      await run?.promptFinished?.catch(() => {});
      await Promise.allSettled(run?.pendingSteers ?? []);
      const errors: unknown[] = [];
      try {
        if (live.session) {
          try {
            await live.session.abort();
          } catch (error) {
            errors.push(error);
          }
          try {
            await this.waitForNativeIdle(live);
            live.session.clearQueue();
          } catch (error) {
            errors.push(error);
          }
          this.sampleContextUsage(live);
          try {
            await shutdownChildSession(live.session);
          } catch (error) {
            errors.push(error);
          }
        }
      } finally {
        // SDK shutdown disposes the session even when its hook fails.
        try {
          live.unsubscribe?.();
        } catch (error) {
          errors.push(error);
        }
        this.clearModelResponseTimer(run);
        try {
          live.broadcaster.stop();
        } catch (error) {
          errors.push(error);
        }
        try {
          live.logger.close();
        } catch (error) {
          errors.push(error);
        }
        if (this.live.get(live.info.id) === live) this.live.delete(live.info.id);
      }
      if (errors.length)
        throw new AggregateError(
          errors,
          `Failed to clean up ${live.info.canonicalName}: ${errors.map(formatAgentError).join('; ')}`,
        );
    });
    // Keep tracking late cleanup even after every caller's finite wait has expired.
    void live.termination.catch((error) => this.reportError(live, error));
    return live.termination;
  }

  async shutdown(): Promise<void> {
    this.shutdownController.abort(new Error('Agent manager shut down.'));
    const errors: unknown[] = [];
    const terminations = [...this.live.values()].map((live) => {
      live.closing = true;
      // Register the one termination promise before abort can reenter shutdown.
      const termination = this.waitForTermination(live);
      try {
        if (live.run) {
          this.requestCancellation(live, live.run, abortError(this.shutdownController.signal));
          this.finalizeRun(live, live.run, 'interrupted');
        }
      } catch (error) {
        errors.push(error);
      }
      // Continue cleanup for every child when saving status fails.
      return termination;
    });
    const results = await Promise.allSettled([this.reconciliation, ...terminations]);
    for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
    if (errors.length) {
      const error = new AggregateError(
        errors,
        `Subagent shutdown failed: ${errors.map(formatAgentError).join('; ')}`,
      );
      this.reportError(undefined, error);
      throw error;
    }
  }
}

export function writeFullToolOutput(content: string): string {
  const directory = path.join(getRunsDir(), '_outputs');
  ensurePrivateDir(directory, true);
  const file = path.join(directory, `${Date.now()}-${randomUUID()}.txt`);
  fs.writeFileSync(file, content);
  return file;
}
