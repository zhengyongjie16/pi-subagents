import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import {
  createBashToolDefinition,
  createCodemodeExtension,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  initTheme,
  SessionManager,
  ToolExecutionComponent,
  type ExtensionAPI,
  type Theme,
  type ToolDefinition,
  type ToolExecutionOptions,
  type ToolRenderers,
} from '@earendil-works/pi-coding-agent';
import {
  getCapabilities,
  getCellDimensions,
  setCapabilities,
  setCellDimensions,
  TuiAltScreen,
  TuiMainScreen,
  visibleWidth,
  type Terminal,
  type TUI,
} from '@earendil-works/pi-tui';
import type { AssistantMessage, JsonObject } from '@earendil-works/pi-ai';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { AgentInfo } from '../src/core.js';
import { ObserverJsonlDecoder, useTestAgentDir, waitUntil } from './fixtures/core-sdk-fixture.js';

const TEST_AGENT_DIR = useTestAgentDir();
const { EventBroadcaster, getSocketPath } = await import('../src/core.js');
const { formatAgentSpecLines, SubagentPeekOverlay } = await import('../src/peek.js');
type SubagentPeekOverlay = InstanceType<typeof SubagentPeekOverlay>;

const widths = [38, 80, 100];
const cwd = process.cwd();
const nativeFactories = new Map<string, (cwd: string) => ToolDefinition<any, any, any>>([
  ['bash', (cwd) => defineTool(createBashToolDefinition(cwd))],
  ['edit', (cwd) => defineTool(createEditToolDefinition(cwd))],
  ['find', (cwd) => defineTool(createFindToolDefinition(cwd))],
  ['grep', (cwd) => defineTool(createGrepToolDefinition(cwd))],
  ['ls', (cwd) => defineTool(createLsToolDefinition(cwd))],
  ['powershell', (cwd) => defineTool(createPowerShellToolDefinition(cwd))],
  ['read', (cwd) => defineTool(createReadToolDefinition(cwd))],
  ['write', (cwd) => defineTool(createWriteToolDefinition(cwd))],
]);
const renderUi = { requestRender() {} } as TUI;
const components = new Set<ToolExecutionComponent>();
const overlays: SubagentPeekOverlay[] = [];
const temporaryDirectories: string[] = [];
let nativeCodemodeRenderers: ToolRenderers;
let codemodeDefinition: ToolDefinition<any, any, any>;
const initializationAccesses: PropertyKey[] = [];
let registrationCount = 0;
let clock: ReturnType<typeof controlledClock> | undefined;

beforeAll(async () => {
  initTheme('dark', false);
  // The factory facade exposes registerTool to collect native renderers.
  const registration: Pick<ExtensionAPI, 'registerTool'> = {
    registerTool(definition) {
      registrationCount++;
      const renderers = defineTool(definition);
      codemodeDefinition = renderers;
      nativeCodemodeRenderers = {
        renderShell: renderers.renderShell,
        renderCall: renderers.renderCall,
        renderResult: renderers.renderResult,
      };
    },
  };
  const localApi = new Proxy(registration, {
    get(target, key, receiver) {
      initializationAccesses.push(key);
      if (key !== 'registerTool')
        throw new Error('Unexpected codemode initialization API: ' + String(key));
      return Reflect.get(target, key, receiver);
    },
  }) as unknown as ExtensionAPI;
  await createCodemodeExtension()(localApi);
});

afterEach(() => {
  for (const overlay of overlays.splice(0)) overlay.dispose();
  for (const component of components)
    component.updateResult({ content: [], isError: false }, false);
  components.clear();
  clock?.restore();
  clock = undefined;
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function createTool(
  name: string,
  args: Record<string, unknown>,
  options: ToolExecutionOptions = {},
): ToolExecutionComponent {
  const component = SubagentPeekOverlay.prototype['createToolComponent'].call(
    { cwd, toolExecutionOptions: options, toolRenderUi: renderUi, nativeCodemodeRenderers } as any,
    name,
    'call-1',
    args,
  );
  components.add(component);
  return component;
}

function nativeDefinition(name: string): ToolRenderers {
  return name === 'codemode' ? nativeCodemodeRenderers : (nativeFactories.get(name)?.(cwd) ?? {});
}

function referenceTool(
  name: string,
  args: Record<string, unknown>,
  definition: ToolRenderers | undefined,
  options: ToolExecutionOptions = {},
): ToolExecutionComponent {
  const component = new ToolExecutionComponent(
    name,
    'call-1',
    args,
    options,
    definition,
    renderUi,
    cwd,
  );
  component.setExpanded(false);
  components.add(component);
  return component;
}

function renderTool(component: ToolExecutionComponent, width = 100): string {
  return stripVTControlCharacters(component.render(width).join('\n'));
}

function expectNativeLines(
  component: ToolExecutionComponent,
  reference: ToolExecutionComponent,
): void {
  for (const width of widths) expect(component.render(width)).toEqual(reference.render(width));
}

function textResult<T extends object = {}>(text: string, extra: T = {} as T) {
  return { content: [{ type: 'text' as const, text }], isError: false, ...extra };
}

function lines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, i) => prefix + String(i + 1).padStart(3, '0')).join(
    '\n',
  );
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const codeArgs = {
  code: 'const result = await tools.read({path: "中文目录/文件.ts"});\ntext(result);',
};
const statuses = ['ok', 'error', 'cancelled', 'running'] as const;
function calls(count = 4) {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i),
    name: 'nested_' + String(i + 1).padStart(3, '0'),
    args: 'path="中文目录/文件.ts" ' + 'very_long_argument_'.repeat(12),
    status: statuses[i % statuses.length],
    durationMs: i * 250,
    ...(i % 2 === 0 ? { cost: 0.00042 } : {}),
    ...(i % 4 === 1 ? { error: 'caught nested failure\nmust not be expanded' } : {}),
  }));
}

function assistant(content: AssistantMessage['content'] = []): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'test' as any,
    provider: 'test',
    model: 'fake',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: 1000,
  };
}

function toolCall(name = 'codemode', id = 'call-1', args: JsonObject = codeArgs) {
  return { type: 'toolCall' as const, name, id, arguments: args };
}

function history(messages: any[]): SessionManager {
  const session = SessionManager.inMemory(cwd);
  for (const message of messages) session.appendMessage(message);
  return session;
}

function toolRows(overlay: SubagentPeekOverlay): ToolExecutionComponent[] {
  return overlay['chatContainer'].children.filter(
    (child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
  );
}

function createOverlay(
  options: ToolExecutionOptions = {},
  sessionFile?: string,
  wrapTui: (tui: TUI) => TUI = (tui) => tui,
  info: Partial<AgentInfo> = {},
) {
  const requestRender = mock(() => {});
  const done = mock((_navigation?: 'previous' | 'next') => {});
  const tui = wrapTui({ terminal: { rows: 90 }, requestRender } as unknown as TUI);
  const connect = spyOn(SubagentPeekOverlay.prototype as any, 'connectSocket').mockImplementation(
    () => {},
  );
  let overlay: SubagentPeekOverlay;
  try {
    overlay = new SubagentPeekOverlay(
      tui,
      { fg: (_color: string, text: string) => text } as Theme,
      {
        id: 'peek-unit-' + randomUUID(),
        taskName: 'rendering',
        provider: 'test',
        modelId: 'fake',
        model: 'test:fake',
        thinking: 'off',
        cwd,
        sessionFile: sessionFile ?? join(tmpdir(), 'peek-absent-' + randomUUID() + '.jsonl'),
        infoFile: join(tmpdir(), 'peek-absent-' + randomUUID() + '.info.json'),
        ...info,
      } as any,
      done,
      nativeCodemodeRenderers,
      options,
    );
  } finally {
    connect.mockRestore();
  }
  overlays.push(overlay);
  return { overlay, requestRender, done, tui };
}

const savedContextUsage = { tokens: 50_000, contextWindow: 500_000, percent: 10 };

function createSavedOverlay(
  contextUsage: unknown = savedContextUsage,
  wrapTui?: (tui: TUI) => TUI,
) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pi-peek-context-'));
  temporaryDirectories.push(directory);
  const session = SessionManager.create(cwd, directory);
  session.appendMessage(assistant([{ type: 'text', text: lines('chat_line_', 100) }]));
  const infoFile = join(directory, 'agent.info.json');
  const state = createOverlay({}, session.getSessionFile()!, wrapTui, {
    infoFile,
    contextUsage: contextUsage as any,
  });
  const writeInfo = (fields: Record<string, unknown>) =>
    fs.writeFileSync(
      infoFile,
      JSON.stringify({
        ...state.overlay['info'],
        contextUsage: undefined,
        ...fields,
      }),
    );
  writeInfo({ contextUsage });
  return { ...state, session, infoFile, writeInfo };
}

function contextLine(overlay: SubagentPeekOverlay, width = 80): string {
  return stripVTControlCharacters(overlay.render(width).at(-2)!);
}

function controlledClock() {
  let now = 10_000;
  let nextId = 1;
  const timers = new Map<any, { callback: () => void; delay: number | undefined }>();
  const date = spyOn(Date, 'now').mockImplementation(() => now);
  const set = spyOn(globalThis, 'setInterval').mockImplementation(((
    callback: (...args: any[]) => void,
    delay?: number,
    ...args: any[]
  ) => {
    const id = nextId++;
    timers.set(id, { callback: () => callback(...args), delay });
    return id;
  }) as any);
  const clear = spyOn(globalThis, 'clearInterval').mockImplementation(((id: any) => {
    timers.delete(id);
  }) as any);
  return {
    timers,
    set,
    clear,
    advance(ms: number) {
      now += ms;
    },
    nativeTimers() {
      return [...timers].filter(([, timer]) => timer.delay === 1000);
    },
    restore() {
      clear.mockRestore();
      set.mockRestore();
      date.mockRestore();
    },
  };
}

function missingEditArgs() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pi-peek-edit-'));
  temporaryDirectories.push(directory);
  return freeze({
    path: join(directory, 'missing.txt'),
    edits: [{ oldText: 'before', newText: 'after' }],
  });
}

async function waitForEditPreview(component: ToolExecutionComponent): Promise<void> {
  // Poll rendered filesystem previews using real event-loop turns.
  for (let attempt = 0; attempt < 100; attempt++) {
    if (renderTool(component).includes('ENOENT')) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  expect(renderTool(component)).toContain('ENOENT');
}

function start(
  overlay: SubagentPeekOverlay,
  name = 'codemode',
  args: Record<string, unknown> = codeArgs,
) {
  overlay['handleEvent']({
    type: 'tool_execution_start',
    toolCallId: 'call-1',
    toolName: name,
    args,
  });
  return overlay['pendingTools'].get('call-1')!.component;
}

function progress(
  overlay: SubagentPeekOverlay,
  partialResult = textResult('', { details: { calls: calls() } }),
) {
  overlay['handleEvent']({ type: 'tool_execution_update', toolCallId: 'call-1', partialResult });
}

test('formats the resolved subagent model and thinking for the detail overlay', () => {
  expect(
    formatAgentSpecLines({ provider: 'openai-codex', modelId: 'gpt-5.5', thinking: 'high' }),
  ).toEqual(['Model: openai-codex/gpt-5.5', 'Thinking: high']);
});

describe('peek tool rendering', () => {
  test.each(['bash', 'edit', 'find', 'grep', 'ls', 'powershell', 'read', 'write'])(
    'passes an explicit built-in definition for %s',
    (name) => {
      const component = createTool(name, {});
      expect(component['toolDefinition']).toHaveProperty('name', name);
      expect(component['toolDefinition']?.renderCall).toBeFunction();
      expect(component['toolDefinition']?.renderResult).toBeFunction();
      expect(component['expanded']).toBe(false);
      expectNativeLines(component, referenceTool(name, {}, nativeDefinition(name)));
    },
  );

  test('read shows only its compact header instead of raw arguments and the full file', () => {
    const component = createTool('read', { path: 'src/catalog.rs', offset: 100, limit: 45 });
    component.updateResult({
      content: [
        {
          type: 'text',
          text: Array.from({ length: 45 }, (_, i) => 'file_line_' + (i + 1)).join('\n'),
        },
      ],
      isError: false,
    });

    const text = renderTool(component);
    expect(text).toContain('src/catalog.rs');
    expect(text).not.toContain('"path":');
    expect(text).toContain('100-144');
    expect(text).not.toContain('file_line_');
  });
});

describe('fixed native collapsed rendering', () => {
  test('collects codemode renderers through the public factory without execution or activation', () => {
    expect(initializationAccesses).toEqual(['registerTool']);
    expect(registrationCount).toBe(1);
    expect(codemodeDefinition.name).toBe('codemode');
    expect(codemodeDefinition.defaultActive).toBe(false);
    expect(nativeCodemodeRenderers.renderCall).toBeFunction();
    expect(nativeCodemodeRenderers.renderResult).toBeFunction();
    const component = createTool('codemode', codeArgs);
    expect(component['toolDefinition']).toBe(nativeCodemodeRenderers);
    expect(component['expanded']).toBe(false);
    expect(Object.keys(component['toolDefinition']!).sort()).toEqual([
      'renderCall',
      'renderResult',
      'renderShell',
    ]);
  });

  test.each(['bash', 'powershell'])(
    '%s retains long commands and native output tails at every width',
    (name) => {
      const args = freeze({ command: lines('echo 中文命令_', 40) });
      const result = freeze(textResult(lines('shell_output_', 100), { durationMs: 4250 }));
      const original = structuredClone({ args, result });
      const component = createTool(name, args);
      const reference = referenceTool(name, args, nativeDefinition(name));
      component.setArgsComplete();
      reference.setArgsComplete();
      for (const partial of [true, false]) {
        component.updateResult(result, partial);
        reference.updateResult(result, partial);
        expectNativeLines(component, reference);
        const text = renderTool(component);
        expect(text).toContain('中文命令_040');
        expect(text).not.toContain('"command":');
        expect(text).not.toContain('shell_output_001');
        expect(text).toContain('shell_output_100');
        expect(text).toContain('95 earlier lines');
      }
      expect({ args, result }).toEqual(original);
    },
  );

  test('codemode long Chinese code, calls and output exactly match native previews, not an expanded control', () => {
    const args = freeze({
      code: '// @options: {"max_output_tokens": 4000}\n' + lines('text("中文代码"); // code_', 30),
    });
    const result = freeze(
      textResult(lines('script_output_', 100), {
        details: {
          calls: calls(13),
          fullOutputPath: '/tmp/full-codemode-output.txt',
          retained: 'original details',
        },
        durationMs: 4250,
      }),
    );
    const original = structuredClone({ args, result });
    const component = createTool('codemode', args);
    const reference = referenceTool('codemode', args, nativeCodemodeRenderers);
    component.updateResult(result);
    reference.updateResult(result);
    expectNativeLines(component, reference);
    const text = renderTool(component);
    expect(text).toContain('中文代码');
    expect(text).not.toContain('code_030');
    expect(text).not.toContain('nested_001');
    expect(text).toContain('nested_013');
    expect(text).toContain('script_output_001');
    expect(text).not.toContain('script_output_100');
    expect(text).toContain('Full output: /tmp/full-codemode-output.txt');
    expect(text).toContain('Model calls:');
    expect(text).toContain('Took 4.3s');
    for (const symbol of ['✓', '✗', '⊘']) expect(text).toContain(symbol);
    expect(text).not.toContain('caught nested failure');
    expect(component['result']?.isError).toBe(false);
    expect(component['result']).toBe(result);
    reference.setExpanded(true);
    expect(component.render(80)).not.toEqual(reference.render(80));
    expect(renderTool(reference)).toContain('script_output_100');
    expect({ args, result }).toEqual(original);
  });

  test.each(statuses)('codemode preserves native %s status and styling', (status) => {
    const partial = status === 'running';
    const result = freeze(
      textResult('final text', {
        isError: status === 'error',
        details: {
          calls: [
            { name: '内层工具', args: '参数', status, durationMs: 125, error: 'nested error' },
          ],
        },
        durationMs: 125,
      }),
    );
    const component = createTool('codemode', codeArgs);
    const reference = referenceTool('codemode', codeArgs, nativeCodemodeRenderers);
    component.updateResult(result, partial);
    reference.updateResult(result, partial);
    expectNativeLines(component, reference);
    expect(renderTool(component)).toContain(
      { ok: '✓', error: '✗', cancelled: '⊘', running: '…' }[status] + ' 内层工具',
    );
    expect(renderTool(component).includes('final text')).toBe(!partial);
  });

  test.each([
    ['no output', { content: [], isError: false, details: { calls: [] } }],
    ['header only', textResult('Script completed\nWall time 0.1 seconds\nOutput:\n')],
    [
      'header with output',
      {
        content: [
          { type: 'text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
          { type: 'text', text: '中文 script output' },
        ],
        isError: false,
      },
    ],
    ['old result without details', textResult('old output')],
    [
      'old details without calls',
      textResult('old output', {
        details: { nestedCalls: [{ status: 'error', name: 'not-a-call' }] },
      }),
    ],
    ['error without calls', textResult('Script rejected: invalid options', { isError: true })],
  ])('codemode %s retains native behavior without invented nested states', (_name, result) => {
    const frozen = freeze(result);
    const original = structuredClone(frozen);
    const component = createTool('codemode', codeArgs);
    const reference = referenceTool('codemode', codeArgs, nativeCodemodeRenderers);
    component.updateResult(frozen);
    reference.updateResult(frozen);
    expectNativeLines(component, reference);
    expect(renderTool(component)).not.toMatch(/[✓✗⊘]/);
    expect(renderTool(component)).not.toContain('Script completed');
    expect(frozen).toEqual(original);
  });

  test('unregistered tools use native generic logical-line fallback, not undefined/full rendering', () => {
    const name = 'unregistered_extension_tool';
    const args = freeze({ query: '中文 search ' + 'long argument '.repeat(40), limit: 30 });
    const result = freeze(textResult(lines('generic_output_', 40)));
    const component = createTool(name, args);
    const reference = referenceTool(name, args, {});
    const undefinedControl = referenceTool(name, args, undefined);
    for (const tool of [component, reference, undefinedControl]) tool.updateResult(result);
    expect(component['toolDefinition']).toEqual({});
    expect(component['expanded']).toBe(false);
    expectNativeLines(component, reference);
    const text = renderTool(component);
    expect(text).toContain('generic_output_001');
    expect(text).not.toContain('generic_output_040');
    expect(text).toContain('more lines');
    expect(renderTool(undefinedControl)).toContain('generic_output_040');
    expect(component.render(80)).not.toEqual(undefinedControl.render(80));

    // Generic previews count logical lines, so one line can span many visual rows.
    const json = textResult(
      JSON.stringify({ data: '中文long_json_value_'.repeat(400), end: 'JSON_TAIL_SENTINEL' }),
    );
    for (const tool of [component, reference]) tool.updateResult(json);
    expectNativeLines(component, reference);
    expect(renderTool(component, 38).replace(/\s/g, '')).toContain('JSON_TAIL_SENTINEL');
    expect(component.render(38).length).toBeGreaterThan(component.render(100).length);
    const codemode = createTool('codemode', codeArgs);
    const nativeCodemode = referenceTool('codemode', codeArgs, nativeCodemodeRenderers);
    codemode.updateResult(json);
    nativeCodemode.updateResult(json);
    expectNativeLines(codemode, nativeCodemode);
    expect(renderTool(codemode, 38)).not.toContain('JSON_TAIL_SENTINEL');
  });

  test.each(['codemode', 'tool_search', 'read'])(
    '%s respects native images, imageWidthCells and outputPad settings',
    (name) => {
      const previousCaps = { ...getCapabilities() };
      const previousCells = { ...getCellDimensions() };
      try {
        // Deterministic iTerm2 image sequences support raw output equality.
        setCapabilities({ images: 'iterm2', hyperlinks: false, trueColor: true });
        setCellDimensions({ widthPx: 8, heightPx: 16 });
        const args = name === 'codemode' ? codeArgs : { path: '中文/图片.png' };
        const result = freeze({
          content: [
            { type: 'text', text: 'image result' },
            {
              type: 'image',
              mimeType: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
            },
          ],
          isError: false,
        });
        const original = structuredClone(result);
        const outputs: string[][] = [];
        for (const options of [
          {},
          { showImages: false, imageWidthCells: 7, outputPad: 0 },
          { showImages: true, imageWidthCells: 13, outputPad: 3 },
        ]) {
          const component = createTool(name, args, options);
          const reference = referenceTool(name, args, nativeDefinition(name), options);
          component.updateResult(result);
          reference.updateResult(result);
          expectNativeLines(component, reference);
          for (const key of ['showImages', 'imageWidthCells', 'outputPad'] as const)
            expect(component[key]).toBe(reference[key]);
          outputs.push(component.render(80));
        }
        expect(outputs[0].join('\n')).toContain('\x1b]1337;File=');
        expect(outputs[1].join('\n')).not.toContain('\x1b]1337;File=');
        expect(outputs[2].join('\n')).toContain('\x1b]1337;File=');
        expect(outputs[1]).not.toEqual(outputs[2]);
        expect(result).toEqual(original);
      } finally {
        setCapabilities(previousCaps);
        setCellDimensions(previousCells);
      }
    },
  );
});

describe('footer context information and metadata polling', () => {
  beforeEach(() => {
    clock = controlledClock();
  });

  test.each([
    [undefined, '?%/?'],
    [savedContextUsage, '10%/500k'],
    ['malformed snapshot', '?%/?'],
  ])('uses the saved snapshot in the footer: %j', (usage, expected) => {
    const input = freeze(usage);
    const original = structuredClone(input);
    const { overlay, requestRender } = createOverlay({}, undefined, undefined, {
      contextUsage: input as any,
    });
    const rendered = overlay.render(80).map(stripVTControlCharacters);
    expect(rendered.at(-2)).toStartWith(`│ 3L ● │ ${expected} │ ←/→ agent │`);
    expect(rendered[1]).toContain('Model: test/fake');
    expect(rendered.slice(0, -3).join('\n')).not.toContain(expected);
    expect(rendered.join('\n')).not.toMatch(/Context:|\bctx\b/);
    expect(overlay['cachedLines']!.join('\n')).not.toContain(expected);
    expect(requestRender).not.toHaveBeenCalled();
    expect(input).toEqual(original);
    expect([...clock!.timers.values()].map((timer) => timer.delay)).toEqual([200]);
  });

  test('context stays in the footer when following long output or scrolling manually', () => {
    const { overlay } = createSavedOverlay();
    expect(contextLine(overlay)).toContain(' │ 10%/500k │ ←/→ agent');
    overlay.handleInput('G');
    const bottom = overlay.render(80).map(stripVTControlCharacters);
    expect(bottom.at(-2)).toContain(' │ 10%/500k │ ←/→ agent');
    expect(bottom.join('\n')).toContain('chat_line_100');
    expect(bottom.slice(1, -3).join('\n')).not.toContain('Model:');
    expect(bottom.slice(0, -3).join('\n')).not.toContain('10%/500k');
    expect(overlay['scrollOffset']).toBeGreaterThan(0);
    for (const key of ['k', 'j', 'g', 'G', '\x1b[5~', '\x1b[6~']) {
      overlay.handleInput(key);
      expect(contextLine(overlay)).toContain(' │ 10%/500k │ ←/→ agent');
    }
  });

  test.each([false, true])(
    'reads only the known info file about once a second before an unchanged/missing session return (missing=%s)',
    (missing) => {
      const { overlay, requestRender, infoFile, writeInfo } = createSavedOverlay();
      if (missing) fs.unlinkSync(overlay['info'].sessionFile);
      writeInfo({ contextUsage: { ...savedContextUsage, tokens: 60_000, percent: 12 } });
      const read = spyOn(fs, 'readFileSync');
      const scan = spyOn(fs, 'readdirSync');
      const connect = spyOn(net, 'connect');
      const poll = [...clock!.timers.values()].find((timer) => timer.delay === 200)!;
      const reads = () => read.mock.calls.filter(([file]) => file === infoFile).length;
      try {
        for (let i = 0; i < 4; i++) {
          clock!.advance(200);
          poll.callback();
        }
        expect(reads()).toBe(0);
        expect(contextLine(overlay)).toContain('10%/500k');
        clock!.advance(200);
        poll.callback();
        expect(reads()).toBe(1);
        expect(contextLine(overlay)).toContain('12%/500k');
        expect(requestRender).toHaveBeenCalledTimes(1);
        for (let i = 0; i < 5; i++) {
          clock!.advance(200);
          poll.callback();
        }
        expect(reads()).toBe(2);
        expect(requestRender).toHaveBeenCalledTimes(1);
        expect(scan).not.toHaveBeenCalled();
        expect(connect).not.toHaveBeenCalled();
        expect([...clock!.timers.values()].map((timer) => timer.delay)).toEqual([200]);
      } finally {
        connect.mockRestore();
        scan.mockRestore();
        read.mockRestore();
      }
    },
  );

  test('temporary read failures keep the last value; successful missing or corrupt fields clear it', () => {
    const { overlay, requestRender, infoFile, writeInfo } = createSavedOverlay();
    const poll = () => {
      clock!.advance(1000);
      overlay['poll']();
    };
    writeInfo({ contextUsage: { ...savedContextUsage, tokens: 60_000, percent: 12 } });
    poll();
    expect(contextLine(overlay)).toContain('12%/500k');
    const requests = requestRender.mock.calls.length;
    for (const fail of [
      () => fs.unlinkSync(infoFile),
      () => fs.writeFileSync(infoFile, '{incomplete'),
    ]) {
      fail();
      poll();
      expect(contextLine(overlay)).toContain('12%/500k');
      expect(requestRender.mock.calls).toHaveLength(requests);
    }
    writeInfo({});
    poll();
    expect(contextLine(overlay)).toContain('?%/?');
    expect(overlay['contextUsage']).toBeUndefined();
    expect(requestRender.mock.calls).toHaveLength(requests + 1);
    writeInfo({ contextUsage: { tokens: null, percent: null, contextWindow: 500_000 } });
    poll();
    expect(contextLine(overlay)).toContain('?%/500k');
    expect(requestRender.mock.calls).toHaveLength(requests + 2);
    writeInfo({ contextUsage: { tokens: 'bad', percent: -1, contextWindow: 500_000 } });
    poll();
    expect(contextLine(overlay)).toContain('?%/500k');
    expect(requestRender.mock.calls).toHaveLength(requests + 2);
    writeInfo({ contextUsage: { tokens: 50_000, percent: 10, contextWindow: 'invalid' } });
    poll();
    expect(contextLine(overlay)).toContain('?%/?');
    expect(requestRender.mock.calls).toHaveLength(requests + 3);
    expect(contextLine(overlay)).not.toMatch(/NaN|Infinity/);
  });

  test.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'metadata-only updates preserve native tools, chat cache and scroll (follow=%s, historyDirty=%s)',
    (follow, dirty) => {
      const { overlay, requestRender, writeInfo } = createSavedOverlay();
      const component = start(overlay);
      progress(overlay);
      overlay['socket'] = { connecting: false, destroyed: false, destroy() {} } as any;
      overlay.handleInput(follow ? 'G' : 'g');
      overlay.render(82);
      overlay['historyDirty'] = dirty;
      const cached = overlay['cachedLines'];
      const children = [...overlay['chatContainer'].children];
      const pending = overlay['pendingTools'].get('call-1');
      const result = component['result'];
      const offset = overlay['scrollOffset'];
      const timers = [...clock!.timers];
      const requests = requestRender.mock.calls.length;
      const spies = [
        spyOn(overlay as any, 'rebuildChat'),
        spyOn(overlay as any, 'finishToolComponents'),
        spyOn(overlay['chatContainer'], 'render'),
        spyOn(component, 'updateResult'),
        spyOn(component, 'setArgsComplete'),
        spyOn(component, 'markExecutionStarted'),
      ];
      try {
        writeInfo({
          contextUsage: { tokens: 60_000, contextWindow: 500_000, percent: 12 },
          status: 'completed',
        });
        clock!.advance(1000);
        overlay['poll']();
        expect(requestRender.mock.calls).toHaveLength(requests + 1);
        expect(contextLine(overlay, 82)).toContain('12%/500k');
        expect(overlay['cachedLines']).toBe(cached);
        expect(overlay['cachedWidth']).toBe(80);
        expect(overlay['scrollOffset']).toBe(offset);
        expect(overlay['followMode']).toBe(follow);
        expect(overlay['historyDirty']).toBe(dirty);
        expect(overlay['status']).toBe('tool');
        expect(overlay['pendingTools'].get('call-1')).toBe(pending);
        expect(pending!.executing).toBe(true);
        expect(component['result']).toBe(result);
        expect(overlay['info'].contextUsage).toEqual(savedContextUsage);
        expect(overlay['chatContainer'].children).toHaveLength(children.length);
        children.forEach((child, i) => expect(overlay['chatContainer'].children[i]).toBe(child));
        expect([...clock!.timers]).toEqual(timers);
        clock!.advance(1000);
        overlay['poll']();
        expect(requestRender.mock.calls).toHaveLength(requests + 1);
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    },
  );

  test('streaming with deferred history still refreshes context without replacing the assistant or following again', () => {
    const { overlay, requestRender, writeInfo } = createSavedOverlay();
    overlay['socket'] = { connecting: false, destroyed: false, destroy() {} } as any;
    overlay['handleEvent']({
      type: 'sync',
      status: 'streaming',
      partialMessage: assistant([{ type: 'text', text: lines('streaming_', 100) }]),
    });
    overlay.handleInput('G');
    overlay.render(80);
    overlay['historyDirty'] = true;
    const streaming = overlay['streamingComponent'];
    const message = overlay['streamingMessage'];
    const cached = overlay['cachedLines'];
    const offset = overlay['scrollOffset'];
    const requests = requestRender.mock.calls.length;
    const rebuild = spyOn(overlay as any, 'rebuildChat');
    try {
      writeInfo({ contextUsage: { tokens: 0, contextWindow: 500_000, percent: 0 } });
      clock!.advance(1000);
      overlay['poll']();
      expect(contextLine(overlay)).toContain('0%/500k');
      expect(overlay['streamingComponent']).toBe(streaming);
      expect(overlay['streamingMessage']).toBe(message);
      expect(overlay['cachedLines']).toBe(cached);
      expect(overlay['scrollOffset']).toBe(offset);
      expect(overlay['followMode']).toBe(true);
      expect(overlay['status']).toBe('streaming');
      expect(overlay['historyDirty']).toBe(true);
      expect(requestRender.mock.calls).toHaveLength(requests + 1);
      expect(rebuild).not.toHaveBeenCalled();
    } finally {
      rebuild.mockRestore();
    }
  });

  test.each([false, true])(
    'RPC responses do not invalidate chat, alter context or move scrolling (follow=%s)',
    (follow) => {
      const { overlay, requestRender } = createSavedOverlay();
      const component = start(overlay);
      progress(overlay);
      overlay.handleInput(follow ? 'G' : 'g');
      overlay.render(80);
      const cached = overlay['cachedLines'];
      const offset = overlay['scrollOffset'];
      const pending = overlay['pendingTools'].get('call-1');
      const result = component['result'];
      const timers = [...clock!.timers];
      const requests = requestRender.mock.calls.length;
      const invalidate = spyOn(overlay as any, 'invalidateCache');
      try {
        for (const success of [true, false])
          for (const command of ['get_session_stats', 'get_state', 'abort']) {
            overlay['handleEvent']({
              type: 'response',
              id: 'management-rpc',
              command,
              success,
              data: { contextUsage: { tokens: 100_000, contextWindow: 500_000, percent: 20 } },
            });
          }
        expect(invalidate).not.toHaveBeenCalled();
        expect(requestRender.mock.calls).toHaveLength(requests);
        expect(overlay['cachedLines']).toBe(cached);
        expect(overlay['scrollOffset']).toBe(offset);
        expect(overlay['followMode']).toBe(follow);
        expect(overlay['status']).toBe('tool');
        expect(overlay['pendingTools'].get('call-1')).toBe(pending);
        expect(component['result']).toBe(result);
        expect(contextLine(overlay)).toContain('10%/500k');
        expect([...clock!.timers]).toEqual(timers);
      } finally {
        invalidate.mockRestore();
      }
    },
  );

  test('the footer is themed on every render, not stored with ANSI in the chat cache', () => {
    const { overlay } = createSavedOverlay();
    let color = 31;
    const fg = spyOn(overlay['theme'], 'fg').mockImplementation(
      (_name, text) => `\x1b[${color}m${text}\x1b[0m`,
    );
    try {
      const first = overlay.render(80).at(-2)!;
      const cached = overlay['cachedLines'];
      expect(first).toContain('\x1b[31m ');
      expect(first).toContain(' │ 10%/500k │ ←/→ agent');
      color = 32;
      const second = overlay.render(80).at(-2)!;
      expect(second).toContain('\x1b[32m ');
      expect(second).toContain(' │ 10%/500k │ ←/→ agent');
      expect(second).not.toContain('\x1b[31m');
      expect(overlay['cachedLines']).toBe(cached);
      expect(cached!.join('\n')).not.toContain('10%/500k');
      overlay.invalidate();
      expect(overlay['cachedLines']).toBeNull();
      const resized = overlay.render(38).at(-2)!;
      expect(resized).toContain('\x1b[32m ');
      expect(resized).toContain(' │ 10%/500k');
    } finally {
      fg.mockRestore();
    }
  });

  test('all widths fit ANSI/wide names and preserve maxHeight - 4 transcript rows', () => {
    const { overlay, tui } = createSavedOverlay();
    overlay['info'].taskName = '中文长名称😀/'.repeat(40);
    (overlay as any).modelName = '中文模型😀'.repeat(20);
    start(overlay);
    progress(overlay);
    overlay['status'] = 'streaming';
    const fg = spyOn(overlay['theme'], 'fg').mockImplementation(
      (_name, text) => `\x1b[36m${text}\x1b[0m`,
    );
    try {
      for (const rows of [0, 8, 11, 12, 13, 35, 64, 90]) {
        (tui.terminal as any).rows = rows;
        for (const width of [0, 1, 2, 3, 4, 8, 12, 21, 22, 32, 38, 50, 80, 120]) {
          overlay.handleInput('G');
          const rendered = overlay.render(width);
          for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
          if (width < 3) continue;
          const maxHeight = Math.min(60, Math.max(8, rows - 4));
          expect(rendered).toHaveLength(maxHeight);
          expect(overlay['scrollOffset']).toBe(
            Math.max(0, overlay['cachedLines']!.length - (maxHeight - 4)),
          );
          for (const line of rendered) expect(visibleWidth(line)).toBe(width);
          const plain = rendered.map(stripVTControlCharacters);
          expect(plain[0]).toStartWith('╭');
          expect(plain[0]).toEndWith('╮');
          expect(plain.at(-2)).toStartWith('│');
          expect(plain.at(-2)).toEndWith('│');
          expect(plain.at(-1)).toStartWith('╰');
          expect(plain.at(-1)).toEndWith('╯');
          expect(plain.join('\n')).not.toMatch(/Context:|\bctx\b/);
          expect(plain.slice(0, -3).join('\n')).not.toContain('10%/500k');
          if (width >= 32) {
            expect(plain.at(-2)).toContain(' │ 10%/500k');
            expect(plain[0]).toContain('● streaming');
          }
          if (width >= 50) expect(plain.at(-2)).toContain(' │ 10%/500k │ ←/→ agent');
        }
      }
      overlay['status'] = 'tool';
      const header = stripVTControlCharacters(overlay.render(22)[0]);
      expect(header).toContain('◑ tool');
      expect(visibleWidth(header)).toBe(22);
    } finally {
      fg.mockRestore();
    }
  });

  test('socket close reads immediately and the existing poll can pick up a later final snapshot', () => {
    const { overlay, requestRender, writeInfo, infoFile } = createSavedOverlay();
    const socket = Object.assign(new EventEmitter(), { destroy: mock(() => {}) });
    const connect = spyOn(net, 'connect').mockReturnValue(socket as any);
    const read = spyOn(fs, 'readFileSync');
    try {
      overlay['connectSocket']();
      const close = socket.listeners('close')[0] as () => void;
      const data = socket.listeners('data')[0] as (data: Buffer) => void;
      const error = socket.listeners('error')[0] as () => void;
      writeInfo({ contextUsage: { tokens: 60_000, contextWindow: 500_000, percent: 12 } });
      close();
      expect(overlay['socket']).toBeNull();
      expect(contextLine(overlay)).toContain('12%/500k');
      expect(read.mock.calls.filter(([file]) => file === infoFile)).toHaveLength(1);
      writeInfo({ contextUsage: { tokens: 70_000, contextWindow: 500_000, percent: 14 } });
      overlay['poll']();
      expect(contextLine(overlay)).toContain('12%/500k');
      clock!.advance(1000);
      overlay['poll']();
      expect(contextLine(overlay)).toContain('14%/500k');
      expect(read.mock.calls.filter(([file]) => file === infoFile)).toHaveLength(2);
      const queuedPoll = [...clock!.timers.values()].find((timer) => timer.delay === 200)!;
      overlay.dispose();
      const requests = requestRender.mock.calls.length;
      const usage = overlay['contextUsage'];
      clock!.advance(1000);
      close();
      data(Buffer.from(JSON.stringify({ type: 'message_start', message: assistant() }) + '\n'));
      error();
      queuedPoll.callback();
      expect(overlay['refreshContextUsage']()).toBe(false);
      expect(overlay['contextUsage']).toBe(usage);
      expect(read.mock.calls.filter(([file]) => file === infoFile)).toHaveLength(2);
      expect(requestRender.mock.calls).toHaveLength(requests);
      expect(clock!.timers.size).toBe(0);
    } finally {
      read.mockRestore();
      connect.mockRestore();
    }
  });

  test('disposal during a metadata read discards the result and stops the rest of the poll', () => {
    const { overlay, requestRender, writeInfo, infoFile } = createSavedOverlay();
    writeInfo({ contextUsage: { tokens: 60_000, contextWindow: 500_000, percent: 12 } });
    const original = fs.readFileSync;
    const read = spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
      const result = (original as any)(file, ...args);
      if (file === infoFile) overlay.dispose();
      return result;
    }) as any);
    const stat = spyOn(fs, 'statSync');
    try {
      clock!.advance(1000);
      overlay['poll']();
      expect(overlay['disposed']).toBe(true);
      expect(overlay['contextUsage']).toEqual(savedContextUsage);
      expect(requestRender).not.toHaveBeenCalled();
      expect(stat).not.toHaveBeenCalled();
      expect(clock!.timers.size).toBe(0);
    } finally {
      stat.mockRestore();
      read.mockRestore();
    }
  });

  test('constructor failure before resource startup leaves no poll or socket', () => {
    const rebuild = spyOn(SubagentPeekOverlay.prototype as any, 'rebuildChat').mockImplementation(
      () => {
        throw new Error('failed to construct chat');
      },
    );
    const connect = spyOn(net, 'connect');
    try {
      expect(() => createOverlay()).toThrow('failed to construct chat');
      expect(connect).not.toHaveBeenCalled();
      expect(clock!.timers.size).toBe(0);
      expect(clock!.set).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
      rebuild.mockRestore();
    }
  });

  test.each(['regular', 'fullscreen'] as const)(
    '%s TUI keeps context visible across metadata updates, resize and navigation',
    (mode) => {
      let input = (_data: string) => {};
      let resize = () => {};
      const writes: string[] = [];
      const terminal: Terminal & { columns: number; rows: number } = {
        columns: 100,
        rows: 35,
        kittyProtocolActive: false,
        start(onInput, onResize) {
          input = onInput;
          resize = onResize;
        },
        stop() {},
        async drainInput() {},
        write(data) {
          writes.push(data);
        },
        moveBy() {},
        hideCursor() {},
        showCursor() {},
        clearLine() {},
        clearFromCursor() {},
        clearScreen() {},
        setTitle() {},
        setProgress() {},
        setProgramStatus() {},
      };
      const tui = mode === 'regular' ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
      const { overlay, writeInfo, done } = createSavedOverlay(savedContextUsage, () => tui);
      const handle = tui.showOverlay(overlay, {
        anchor: 'right-center',
        width: '100%',
        maxHeight: 60,
      });
      const draw = () => {
        writes.length = 0;
        tui.renderNow(true);
        return stripVTControlCharacters(writes.join(''));
      };
      tui.start();
      try {
        input('G');
        expect(draw()).toContain(' │ 10%/500k │ ←/→ agent');
        writeInfo({ contextUsage: { tokens: 60_000, contextWindow: 500_000, percent: 12 } });
        clock!.advance(1000);
        overlay['poll']();
        expect(draw()).toContain(' │ 12%/500k │ ←/→ agent');
        for (const columns of [32, 38, 50, 80, 120]) {
          terminal.columns = columns;
          terminal.rows = 12;
          resize();
          expect(draw()).toContain(' │ 12%/500k');
        }
        input('\r'); // Enter
        expect(done).not.toHaveBeenCalled();
        input('\x1b[C');
        expect(done).toHaveBeenCalledWith('next');
        expect(overlay['disposed']).toBe(true);
      } finally {
        overlay.dispose();
        handle.hide();
        tui.stop();
      }
      expect(clock!.timers.size).toBe(0);
    },
  );
});

describe('overlay creation paths and native lifecycle', () => {
  beforeEach(() => {
    clock = controlledClock();
  });

  test('native refresh facade never writes through the real UI proxy to its shared TUI', () => {
    let target!: TUI;
    const forwardedSet = mock((object: TUI, key: PropertyKey, value: unknown) =>
      Reflect.set(object, key, value),
    );
    const { overlay, requestRender } = createOverlay({}, undefined, (tui) => {
      target = tui;
      // Pi forwards writes to its shared renderer and binds method reads to that renderer.
      return new Proxy(tui, {
        get(object, key) {
          const value = Reflect.get(object, key);
          return typeof value === 'function' ? value.bind(object) : value;
        },
        set: forwardedSet,
      });
    });
    expect(forwardedSet).not.toHaveBeenCalled();
    expect(target.requestRender).toBe(requestRender);
    expect(Object.hasOwn(overlay['toolRenderUi'], 'requestRender')).toBe(true);
    const component = start(overlay);
    progress(overlay);
    overlay.render(82);
    const requests = requestRender.mock.calls.length;
    clock!.nativeTimers()[0][1].callback();
    expect(requestRender.mock.calls).toHaveLength(requests + 1);
    expect(overlay['cachedLines']).toBeNull();
    expect(target.requestRender).toBe(requestRender);
    expect(forwardedSet).not.toHaveBeenCalled();
    expect(component['expanded']).toBe(false);
    overlay.dispose();
  });

  test('history replays without live args-complete or execution-start hooks, including aborted calls', () => {
    const { overlay } = createOverlay();
    const completed = freeze(
      textResult('persisted output', { details: { calls: calls(3) }, durationMs: 2400 }),
    );
    overlay['sessionManager'] = history([
      assistant([
        toolCall(),
        toolCall('powershell', 'pending', { command: 'echo history' } as any),
      ]),
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'codemode',
        ...completed,
        timestamp: 1001,
      },
      {
        ...assistant([toolCall('read', 'aborted', { path: 'file.ts' } as any)]),
        stopReason: 'aborted',
        errorMessage: 'Operation aborted',
      },
    ]);
    overlay['rebuildChat']();
    expect(toolRows(overlay)).toHaveLength(3);
    for (const component of toolRows(overlay)) {
      expect(component['expanded']).toBe(false);
      expect(component['argsComplete']).toBe(false);
      expect(component['executionStarted']).toBe(false);
      expect(renderTool(component)).not.toContain('Elapsed');
    }
    const reference = referenceTool('codemode', codeArgs, nativeCodemodeRenderers);
    reference.updateResult(completed);
    expectNativeLines(toolRows(overlay)[0], reference);
    expect(overlay['pendingTools'].get('pending')!.executing).toBe(false);
    expect(overlay['pendingTools'].has('aborted')).toBe(false);
    expect(clock!.nativeTimers()).toHaveLength(0);
  });

  test.each([
    ['history', 'aborted'],
    ['history', 'error'],
    ['history', 'success'],
    ['sync', 'aborted'],
    ['sync', 'error'],
    ['sync', 'success'],
  ] as const)(
    '%s %s edit replay does not invent a missing-file preview or alter recorded data',
    async (source, status) => {
      const { overlay } = createOverlay();
      const args = missingEditArgs();
      const recorded =
        status === 'success' ? 'Previously completed edit' : 'Recorded ' + status + ' result';
      const result = freeze(
        textResult(recorded, {
          isError: status !== 'success',
          durationMs: 1500,
          details: { retained: 'old metadata without diff' },
        }),
      );
      const original = structuredClone({ args, result });
      const expected =
        source === 'history' && status !== 'success'
          ? textResult(recorded, { isError: true })
          : result;
      if (source === 'history') {
        const message = freeze({
          ...assistant([toolCall('edit', 'call-1', args)]),
          stopReason: status === 'success' ? 'toolUse' : status,
          errorMessage: status === 'success' ? undefined : recorded,
        });
        overlay['sessionManager'] = history([
          message,
          ...(status === 'success'
            ? [
                {
                  role: 'toolResult',
                  toolCallId: 'call-1',
                  toolName: 'edit',
                  ...result,
                  timestamp: 1001,
                },
              ]
            : []),
        ]);
        overlay['rebuildChat']();
      } else {
        overlay['handleEvent'](
          freeze({
            type: 'sync',
            status: 'done',
            activeTools: [
              {
                toolCallId: 'call-1',
                toolName: 'edit',
                args,
                result,
                isError: result.isError,
              },
            ],
          }),
        );
      }
      const component = toolRows(overlay)[0];
      const reference = referenceTool('edit', args, nativeDefinition('edit'));
      // Replay stored results through the native result renderer.
      reference.updateResult(expected);
      const before = widths.map((width) => component.render(width));

      // Wait for the live argument hook to read the missing file.
      const liveControl = referenceTool('edit', args, nativeDefinition('edit'));
      liveControl.setArgsComplete();
      liveControl.updateResult(expected);
      await waitForEditPreview(liveControl);
      expect(renderTool(liveControl)).toContain('Could not edit file');

      expectNativeLines(component, reference);
      for (const [index, width] of widths.entries())
        expect(component.render(width)).toEqual(before[index]);
      expect(component['argsComplete']).toBe(false);
      expect(component['executionStarted']).toBe(false);
      expect(component['expanded']).toBe(false);
      expect(component['result']?.content).toEqual(expected.content);
      expect(component['result']?.isError).toBe(expected.isError);
      expect(renderTool(component)).not.toMatch(/ENOENT|Could not edit file|preview error/i);
      expect(overlay['pendingTools'].size).toBe(0);
      expect(fs.existsSync(args.path)).toBe(false);
      overlay.dispose();
      expect({ args, result }).toEqual(original);
    },
  );

  test.each(['message_end', 'execution_start', 'sync-running'])(
    '%s edit keeps the genuine live args-complete preview',
    async (source) => {
      const { overlay, requestRender } = createOverlay();
      const args = missingEditArgs();
      const original = structuredClone(args);
      if (source === 'message_end') {
        const message = assistant([toolCall('edit', 'call-1', args)]);
        overlay['handleEvent']({ type: 'message_start', message: assistant() });
        overlay['handleEvent']({
          type: 'message_update',
          message,
          assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0 },
        });
        expect(overlay['pendingTools'].get('call-1')!.component['argsComplete']).toBe(false);
        overlay['handleEvent']({ type: 'message_end', message });
      } else if (source === 'execution_start') {
        start(overlay, 'edit', args);
      } else {
        overlay['handleEvent']({
          type: 'sync',
          status: 'tool',
          activeTools: [
            {
              toolCallId: 'call-1',
              toolName: 'edit',
              args,
            },
          ],
        });
      }
      const pending = overlay['pendingTools'].get('call-1')!;
      const component = pending.component;
      expect(component['argsComplete']).toBe(true);
      expect(component['executionStarted']).toBe(source !== 'message_end');
      expect(pending.executing).toBe(source !== 'message_end');
      expect(component['expanded']).toBe(false);
      const reference = referenceTool('edit', args, nativeDefinition('edit'));
      reference.setArgsComplete();
      if (source !== 'message_end') reference.markExecutionStarted();
      const requests = requestRender.mock.calls.length;
      await Promise.all([waitForEditPreview(component), waitForEditPreview(reference)]);
      expect(requestRender.mock.calls.length).toBeGreaterThan(requests);
      expectNativeLines(component, reference);
      expect(component['result']).toBeUndefined();
      expect(fs.existsSync(args.path)).toBe(false);
      expect(args).toEqual(original);
    },
  );

  test('coalesces argument parsing until render without creating a render-request loop', () => {
    const { overlay, requestRender } = createOverlay();
    overlay['handleEvent']({ type: 'message_start', message: assistant() });
    overlay['handleEvent']({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 0,
        id: 'call-1',
        toolName: 'custom_tool',
      },
    });
    const component = overlay['pendingTools'].get('call-1')!.component;
    const args = { path: '中文😀', nested: { items: [1, true] }, text: 'x'.repeat(4096) };
    const raw = JSON.stringify(args);
    const parse = spyOn(JSON, 'parse');
    try {
      for (let index = 0; index < raw.length; index += 128)
        overlay['handleEvent']({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'toolcall_delta',
            contentIndex: 0,
            delta: raw.slice(index, index + 128),
          },
        });
      expect(parse).not.toHaveBeenCalled();
      expect(component['args']).toEqual({});
      overlay.render(82);
      expect(overlay['pendingTools'].get('call-1')!.component).toBe(component);
      expect(component['args']).toEqual(args);
      const parsed = parse.mock.calls.length;
      expect(parsed).toBeGreaterThan(0);
      const requests = requestRender.mock.calls.length;
      overlay.render(82);
      expect(parse.mock.calls.length).toBe(parsed);
      expect(requestRender.mock.calls.length).toBe(requests);
    } finally {
      parse.mockRestore();
    }
  });

  test.each(['toolUse', 'aborted', 'error'] as const)(
    '%s final arguments reach tool rows even when no intermediate frame was rendered',
    (stopReason) => {
      const { overlay } = createOverlay();
      overlay['handleEvent']({ type: 'message_start', message: assistant() });
      overlay['handleEvent']({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_start',
          contentIndex: 0,
          id: 'call-1',
          toolName: 'custom_tool',
        },
      });
      overlay['handleEvent']({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_delta',
          contentIndex: 0,
          delta: '{"path":"pending',
        },
      });
      const component = overlay['pendingTools'].get('call-1')!.component;
      const args = { path: 'final 中文😀' };
      const message = {
        ...assistant([toolCall('custom_tool', 'call-1', args)]),
        stopReason,
        errorMessage: 'stopped',
      };
      overlay['handleEvent']({ type: 'message_end', message });
      expect(component['args']).toEqual(args);
      if (stopReason === 'toolUse') expect(component['argsComplete']).toBe(true);
      else expect(component['result']?.isError).toBe(true);
      expect(overlay['assistantStream'].message).toBeNull();
    },
  );

  test('message_update creation and message_end args completion wait for actual execution evidence', () => {
    const { overlay } = createOverlay();
    const message = assistant([toolCall()]);
    overlay['handleEvent']({ type: 'message_start', message: assistant() });
    overlay['handleEvent']({
      type: 'message_update',
      message,
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0 },
    });
    const component = overlay['pendingTools'].get('call-1')!.component;
    expect(overlay['pendingTools'].get('call-1')!.executing).toBe(false);
    expect(component).toBeInstanceOf(ToolExecutionComponent);
    expect(component['toolDefinition']).toBe(nativeCodemodeRenderers);
    expect(component['expanded']).toBe(false);
    expect(component['argsComplete']).toBe(false);
    expect(component['executionStarted']).toBe(false);
    overlay['handleEvent']({ type: 'message_end', message });
    expect(component['argsComplete']).toBe(true);
    expect(component['executionStarted']).toBe(false);
    expect(clock!.nativeTimers()).toHaveLength(0);
    expect(start(overlay)).toBe(component);
    expect(overlay['pendingTools'].get('call-1')!.executing).toBe(true);
    expect(component['executionStarted']).toBe(true);
    progress(overlay);
    expect(clock!.nativeTimers()).toHaveLength(1);
    const before = component.render(80);
    for (const key of ['\x0f', '\r', ' ']) overlay.handleInput(key);
    expect(component['expanded']).toBe(false);
    expect(component.render(80)).toEqual(before);
  });

  test.each(['codemode', 'powershell', 'tool_search'])(
    'direct %s execution creates a fixed collapsed, args-complete, started native instance',
    (name) => {
      const options = { showImages: false, imageWidthCells: 17, outputPad: 3 };
      const { overlay } = createOverlay(options);
      const args = name === 'codemode' ? codeArgs : { command: 'echo 中文', query: 'search' };
      const component = start(overlay, name, args);
      expect(component).toBeInstanceOf(ToolExecutionComponent);
      expect(component['expanded']).toBe(false);
      expect(component['argsComplete']).toBe(true);
      expect(component['executionStarted']).toBe(true);
      expect(overlay['pendingTools'].get('call-1')!.executing).toBe(true);
      const reference = referenceTool(name, args, nativeDefinition(name), options);
      reference.setArgsComplete();
      reference.markExecutionStarted();
      const result = freeze(textResult('final result', { durationMs: 100 }));
      overlay['handleEvent']({
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        result,
        isError: true,
        durationMs: 6543,
      });
      reference.updateResult({ ...result, isError: true, durationMs: 6543 });
      expectNativeLines(component, reference);
      expect(component['result']?.durationMs).toBe(6543);
      expect(component['result']?.isError).toBe(true);
      expect(result.durationMs).toBe(100);
      expect(result.isError).toBe(false);
      expect(overlay['pendingTools'].size).toBe(0);
    },
  );

  test('sync partial assistant arguments alone do not imply execution or completed arguments', () => {
    const { overlay } = createOverlay();
    overlay['handleEvent']({
      type: 'sync',
      status: 'calling',
      partialMessage: assistant([toolCall()]),
      activeTools: [],
    });
    const pending = overlay['pendingTools'].get('call-1')!;
    expect(pending.executing).toBe(false);
    expect(pending.component['expanded']).toBe(false);
    expect(pending.component['argsComplete']).toBe(false);
    expect(pending.component['executionStarted']).toBe(false);
    expect(clock!.nativeTimers()).toHaveLength(0);
    expectNativeLines(
      pending.component,
      referenceTool('codemode', codeArgs, nativeCodemodeRenderers),
    );
  });

  test('sync recovers running evidence, reuses history rows, and does not start final rows', () => {
    const { overlay } = createOverlay();
    overlay['sessionManager'] = history([assistant([toolCall()])]);
    const partial = freeze(
      textResult('partial text is not codemode output', { details: { calls: calls() } }),
    );
    const final = freeze(
      textResult('sync final', { details: { calls: calls(3) }, durationMs: 3200 }),
    );
    overlay['handleEvent']({
      type: 'sync',
      status: 'tool',
      activeTools: [
        { toolCallId: 'call-1', toolName: 'codemode', args: codeArgs, partialResult: partial },
        { toolCallId: 'final', toolName: 'codemode', args: codeArgs, result: final },
        { toolCallId: 'no-partial', toolName: 'tool_search', args: { query: '中文' } },
      ],
    });
    const rows = toolRows(overlay);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row['expanded']).toBe(false);
    expect(rows[0]['argsComplete']).toBe(true);
    expect(rows[1]['argsComplete']).toBe(false);
    expect(rows[2]['argsComplete']).toBe(true);
    expect(rows[0]['executionStarted']).toBe(true);
    expect(rows[1]['executionStarted']).toBe(false);
    expect(rows[2]['executionStarted']).toBe(true);
    expect(overlay['pendingTools'].get('call-1')!.executing).toBe(true);
    expect(overlay['pendingTools'].get('no-partial')!.executing).toBe(true);
    expect(overlay['pendingTools'].has('final')).toBe(false);
    expect(rows[1]['result']?.durationMs).toBe(3200);
    expect(clock!.nativeTimers()).toHaveLength(1);
    const reference = referenceTool('codemode', codeArgs, nativeCodemodeRenderers);
    reference.setArgsComplete();
    reference.markExecutionStarted();
    reference.updateResult(partial, true);
    expectNativeLines(rows[0], reference);
    const finalReference = referenceTool('codemode', codeArgs, nativeCodemodeRenderers);
    finalReference.updateResult(final);
    expectNativeLines(rows[1], finalReference);
  });

  test('a partial execution update can start a reconstructed row, but history alone cannot', () => {
    const { overlay } = createOverlay();
    overlay['sessionManager'] = history([assistant([toolCall()])]);
    overlay['rebuildChat']();
    const component = overlay['pendingTools'].get('call-1')!.component;
    expect(overlay['pendingTools'].get('call-1')!.executing).toBe(false);
    expect(component['executionStarted']).toBe(false);
    expect(clock!.nativeTimers()).toHaveLength(0);
    progress(overlay);
    expect(overlay['pendingTools'].get('call-1')!.component).toBe(component);
    expect(overlay['pendingTools'].get('call-1')!.executing).toBe(true);
    expect(component['executionStarted']).toBe(true);
    expect(component['argsComplete']).toBe(true);
    expect(component['expanded']).toBe(false);
    expect(clock!.nativeTimers()).toHaveLength(1);
  });

  test.each(['live', 'sync', 'history'])(
    '%s final results use identical native lines and preserve full original data',
    (path) => {
      const { overlay } = createOverlay();
      const result = freeze(
        textResult(lines('persisted_中文_', 100), {
          details: { calls: calls(12), fullOutputPath: '/tmp/full-output.txt' },
          durationMs: 7200,
        }),
      );
      const original = structuredClone(result);
      if (path === 'live') {
        start(overlay);
        overlay['handleEvent']({ type: 'tool_execution_end', toolCallId: 'call-1', result });
      } else if (path === 'sync') {
        overlay['handleEvent']({
          type: 'sync',
          activeTools: [{ toolCallId: 'call-1', toolName: 'codemode', args: codeArgs, result }],
        });
      } else {
        overlay['sessionManager'] = history([
          assistant([toolCall()]),
          {
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'codemode',
            ...result,
            timestamp: 1001,
          },
        ]);
        overlay['rebuildChat']();
      }
      const component = toolRows(overlay)[0];
      const reference = referenceTool('codemode', codeArgs, nativeCodemodeRenderers);
      if (path === 'live') reference.setArgsComplete();
      reference.updateResult(result);
      expectNativeLines(component, reference);
      expect(component['expanded']).toBe(false);
      expect(component['argsComplete']).toBe(path === 'live');
      expect(component['result']?.durationMs).toBe(7200);
      overlay.dispose();
      expect(result).toEqual(original);
    },
  );

  test.each(['codemode', 'bash', 'powershell'])(
    '%s native refresh invalidates overlay cachedLines and final duration stops refresh',
    (name) => {
      const { overlay, requestRender, tui } = createOverlay();
      const originalRequestRender = tui.requestRender;
      const args = name === 'codemode' ? codeArgs : { command: 'echo 中文' };
      const component = start(overlay, name, args);
      progress(overlay);
      const [timerId, timer] = clock!.nativeTimers()[0];
      expect(clock!.nativeTimers()).toHaveLength(1);
      expect([...clock!.timers.values()].map((entry) => entry.delay).sort()).toEqual(
        [200, 1000].sort(),
      );
      const reference = referenceTool(name, args, nativeDefinition(name));
      reference.setArgsComplete();
      reference.markExecutionStarted();
      reference.updateResult(textResult('', { details: { calls: calls() } }), true);
      const referenceTimer = clock!.nativeTimers().find(([id]) => id !== timerId)![1];

      expect(stripVTControlCharacters(overlay.render(82).join('\n'))).toContain('Elapsed 0.0s');
      const cached = overlay['cachedLines'];
      expect(overlay['cachedWidth']).toBe(80);
      const requests = requestRender.mock.calls.length;
      clock!.advance(4200);
      timer.callback();
      expect(overlay['cachedLines']).toBeNull();
      expect(overlay['cachedWidth']).toBeNull();
      expect(requestRender.mock.calls).toHaveLength(requests + 1);
      expect(tui.requestRender).toBe(originalRequestRender);
      referenceTimer.callback();
      expect(stripVTControlCharacters(overlay.render(82).join('\n'))).toContain('Elapsed 4.2s');
      expect(overlay['cachedLines']).not.toBe(cached);
      expect(component.render(80)).toEqual(reference.render(80));

      const final = freeze(textResult('completed', { durationMs: 7654 }));
      overlay['handleEvent']({ type: 'tool_execution_end', toolCallId: 'call-1', result: final });
      reference.updateResult(final);
      expect(clock!.clear).toHaveBeenCalledWith(timerId);
      expect(clock!.nativeTimers()).toHaveLength(0);
      expectNativeLines(component, reference);
      expect(renderTool(component)).toContain('Took 7.7s');
      clock!.advance(9000);
      component.invalidate();
      expectNativeLines(component, reference);
      expect(renderTool(component)).not.toContain('Elapsed');
    },
  );

  test('resize and theme invalidation drop outer caches and still match same-theme native lines', () => {
    const { overlay } = createOverlay();
    const component = start(overlay);
    const result = textResult(lines('中文结果_', 30), { durationMs: 1100 });
    overlay['handleEvent']({ type: 'tool_execution_end', toolCallId: 'call-1', result });
    const reference = referenceTool('codemode', codeArgs, nativeCodemodeRenderers);
    reference.setArgsComplete();
    reference.updateResult(result);
    try {
      for (const theme of ['light', 'dark']) {
        initTheme(theme, false);
        overlay.invalidate();
        reference.invalidate();
        expect(overlay['cachedLines']).toBeNull();
        for (const width of widths) {
          overlay.render(width + 2);
          expect(overlay['cachedWidth']).toBe(width);
          expect(component.render(width)).toEqual(reference.render(width));
        }
      }
    } finally {
      initTheme('dark', false);
    }
  });

  test('rebuild releases discarded native renderers without changing their original results', () => {
    const { overlay } = createOverlay();
    const component = start(overlay);
    const partial = freeze(textResult('', { details: { calls: calls() } }));
    const original = structuredClone(partial);
    progress(overlay, partial);
    const [timerId] = clock!.nativeTimers()[0];
    overlay['rebuildChat']();
    expect(clock!.clear).toHaveBeenCalledWith(timerId);
    expect(clock!.nativeTimers()).toHaveLength(0);
    expect(component['isPartial']).toBe(false);
    expect(component['result']).toEqual({ content: [], isError: false });
    expect(toolRows(overlay)).toHaveLength(0);
    expect(overlay['pendingTools'].size).toBe(0);
    overlay['rebuildChat']();
    expect(clock!.nativeTimers()).toHaveLength(0);
    expect(partial).toEqual(original);
  });

  test.each(['agent_settled', 'close'])(
    '%s clears streaming state before native renderer cleanup can fail',
    (transition) => {
      const { overlay } = createOverlay();
      const socket = Object.assign(new EventEmitter(), { destroy() {} });
      const connect = spyOn(net, 'connect').mockReturnValue(socket as any);
      try {
        overlay['connectSocket']();
      } finally {
        connect.mockRestore();
      }
      overlay['handleEvent']({ type: 'message_start', message: assistant() });
      start(overlay);
      progress(overlay);
      expect(overlay['streamingComponent']).not.toBeNull();
      expect(overlay['pendingTools'].size).toBe(1);
      const cleanup = spyOn(overlay as any, 'finishToolComponents').mockImplementationOnce(
        () => {
          throw new Error('native renderer cleanup failed');
        },
      );
      try {
        expect(() => {
          if (transition === 'close') socket.emit('close');
          else overlay['handleEvent']({ type: transition });
        }).toThrow('native renderer cleanup failed');
        expect(overlay['streamingComponent']).toBeNull();
        expect(overlay['streamingMessage']).toBeNull();
        expect(overlay['assistantStream'].message).toBeNull();
        expect(overlay['pendingTools'].size).toBe(0);
      } finally {
        cleanup.mockRestore();
      }
    },
  );

  test('replacement of a provisional streaming call releases its native refresh resource', () => {
    const { overlay } = createOverlay();
    overlay['handleEvent']({ type: 'message_start', message: assistant() });
    overlay['handleEvent']({
      type: 'message_update',
      message: assistant([toolCall('codemode', 'temporary')]),
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0 },
    });
    overlay['handleEvent']({
      type: 'tool_execution_start',
      toolCallId: 'temporary',
      toolName: 'codemode',
      args: codeArgs,
    });
    overlay['handleEvent']({
      type: 'tool_execution_update',
      toolCallId: 'temporary',
      partialResult: textResult('', { details: { calls: calls() } }),
    });
    const [timerId] = clock!.nativeTimers()[0];
    overlay['handleEvent']({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: toolCall() },
    });
    expect(clock!.clear).toHaveBeenCalledWith(timerId);
    expect(clock!.nativeTimers()).toHaveLength(0);
    expect(toolRows(overlay)).toHaveLength(1);
    expect(overlay['pendingTools'].has('temporary')).toBe(false);
    const replacement = overlay['pendingTools'].get('call-1')!.component;
    expect(overlay['pendingTools'].get('call-1')!.executing).toBe(false);
    expect(replacement['expanded']).toBe(false);
    expect(replacement['argsComplete']).toBe(false);
    expect(replacement['executionStarted']).toBe(false);
  });

  test.each([
    ['dispose', undefined, undefined],
    ['close', 'q', undefined],
    ['escape', '\x1b', undefined],
    ['previous agent', '\x1b[D', 'previous'],
    ['next agent', '\x1b[C', 'next'],
  ])(
    '%s releases timers; repeat disposal and late events, polls and renderer callbacks are inert',
    (_name, key, navigation) => {
      const { overlay, requestRender, done } = createOverlay();
      start(overlay);
      const partial = freeze(textResult('', { details: { calls: calls() } }));
      progress(overlay, partial);
      const [timerId, nativeTimer] = clock!.nativeTimers()[0];
      const pollTimer = [...clock!.timers.values()].find((entry) => entry.delay === 200)!;
      const destroy = mock(() => {});
      overlay['socket'] = { destroy } as any;
      overlay.render(82);
      if (key) overlay.handleInput(key);
      else overlay.dispose();
      expect(clock!.clear).toHaveBeenCalledWith(timerId);
      expect(clock!.timers.size).toBe(0);
      expect(destroy).toHaveBeenCalledTimes(1);
      if (navigation) expect(done).toHaveBeenCalledWith(navigation);
      else if (key) expect(done).toHaveBeenCalledWith();
      else expect(done).not.toHaveBeenCalled();
      const requests = requestRender.mock.calls.length;
      const intervalCalls = clock!.set.mock.calls.length;
      overlay.dispose();
      overlay['handleEvent']({
        type: 'tool_execution_start',
        toolCallId: 'late',
        toolName: 'codemode',
        args: codeArgs,
      });
      overlay['handleEvent']({
        type: 'sync',
        activeTools: [
          { toolCallId: 'late', toolName: 'codemode', args: codeArgs, partialResult: partial },
        ],
      });
      pollTimer.callback();
      overlay['poll']();
      nativeTimer.callback();
      overlay['toolRenderUi'].requestRender();
      overlay.invalidate();
      overlay.handleInput('\x1b[C');
      expect(overlay.render(82)).toEqual([]);
      expect(toolRows(overlay)).toHaveLength(0);
      expect(overlay['pendingTools'].size).toBe(0);
      expect(overlay['cachedLines']).toBeNull();
      expect(requestRender.mock.calls).toHaveLength(requests);
      expect(clock!.set.mock.calls).toHaveLength(intervalCalls);
      expect(clock!.timers.size).toBe(0);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(done.mock.calls).toHaveLength(key ? 1 : 0);
    },
  );

  test('connected historical pending rows without execution evidence do not block file recovery', () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'pi-peek-history-'));
    temporaryDirectories.push(directory);
    const session = SessionManager.create(cwd, directory);
    session.appendMessage(assistant([toolCall()]));
    const { overlay } = createOverlay({}, session.getSessionFile()!);
    const historical = overlay['pendingTools'].get('call-1')!;
    expect(historical.executing).toBe(false);
    expect(historical.component['executionStarted']).toBe(false);
    overlay['socket'] = { connecting: false, destroyed: false, destroy() {} } as any;
    const final = textResult('late persisted result', { durationMs: 4600 });
    session.appendMessage({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'codemode',
      ...final,
      timestamp: 1001,
    });
    overlay['poll']();
    expect(overlay['pendingTools'].size).toBe(0);
    expect(overlay['historyDirty']).toBe(false);
    expect(clock!.nativeTimers()).toHaveLength(0);
    const restored = toolRows(overlay)[0];
    expect(restored).not.toBe(historical.component);
    const reference = referenceTool('codemode', codeArgs, nativeCodemodeRenderers);
    reference.updateResult(final);
    expectNativeLines(restored, reference);
  });

  test('defers history loading during execution and loads the latest snapshot once it ends', () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'pi-peek-deferred-'));
    temporaryDirectories.push(directory);
    const session = SessionManager.create(cwd, directory);
    session.appendMessage(assistant([toolCall()]));
    const file = session.getSessionFile()!;
    const { overlay, requestRender } = createOverlay({}, file);
    const component = start(overlay);
    progress(overlay);
    overlay['socket'] = { connecting: false, destroyed: false, destroy() {} } as any;
    const snapshot = overlay['sessionManager'];
    const previousSize = overlay['lastFileSize'];
    const final = freeze(textResult('persisted before end event', { durationMs: 5100 }));
    session.appendMessage({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'codemode',
      ...final,
      timestamp: 1001,
    });
    const open = spyOn(SessionManager, 'open');
    try {
      const requests = requestRender.mock.calls.length;
      for (let index = 0; index < 3; index++) {
        session.appendMessage({
          role: 'user',
          content: 'deferred update ' + index,
          timestamp: 1002 + index,
        });
        overlay['poll']();
        expect(overlay['historyDirty']).toBe(true);
        expect(overlay['pendingTools'].get('call-1')!.component).toBe(component);
        expect(overlay['sessionManager']).toBe(snapshot);
        expect(overlay['lastFileSize']).toBe(previousSize);
        expect(open).not.toHaveBeenCalled();
        expect(requestRender.mock.calls).toHaveLength(requests);
      }
      overlay['poll']();
      expect(open).not.toHaveBeenCalled();
      const size = fs.statSync(file).size;
      overlay['handleEvent']({ type: 'tool_execution_end', toolCallId: 'call-1', result: final });
      expect(clock!.nativeTimers()).toHaveLength(0);
      overlay['poll']();
      expect(open).toHaveBeenCalledTimes(1);
      expect(overlay['lastFileSize']).toBe(size);
      expect(overlay['historyDirty']).toBe(false);
      expect(overlay['sessionManager']!.buildSessionContext().messages.at(-1)).toMatchObject({
        role: 'user',
        content: 'deferred update 2',
      });
      const restored = toolRows(overlay)[0];
      expect(restored).not.toBe(component);
      expect(restored['executionStarted']).toBe(false);
      expect(restored['argsComplete']).toBe(false);
      const reference = referenceTool('codemode', codeArgs, nativeCodemodeRenderers);
      reference.updateResult(final);
      expectNativeLines(restored, reference);
      overlay['poll']();
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
    }
  });

  test('defers history loading while an assistant streams without changing manual scrolling', () => {
    const { overlay, session } = createSavedOverlay();
    overlay['socket'] = { connecting: false, destroyed: false, destroy() {} } as any;
    const message = {
      ...assistant([{ type: 'text', text: 'streamed final response' }]),
      stopReason: 'stop' as const,
    };
    overlay['handleEvent']({ type: 'message_start', message: assistant() });
    overlay['handleEvent']({
      type: 'message_update',
      message,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'streamed final response' },
    });
    overlay.handleInput('g');
    overlay.render(80);
    const streaming = overlay['streamingComponent'];
    const snapshot = overlay['sessionManager'];
    const previousSize = overlay['lastFileSize'];
    const cached = overlay['cachedLines'];
    const offset = overlay['scrollOffset'];
    const open = spyOn(SessionManager, 'open');
    try {
      session.appendMessage(message);
      for (let index = 0; index < 3; index++) overlay['poll']();
      expect(open).not.toHaveBeenCalled();
      expect(overlay['historyDirty']).toBe(true);
      expect(overlay['sessionManager']).toBe(snapshot);
      expect(overlay['lastFileSize']).toBe(previousSize);
      expect(overlay['streamingComponent']).toBe(streaming);
      expect(overlay['cachedLines']).toBe(cached);
      expect(overlay['scrollOffset']).toBe(offset);
      overlay['handleEvent']({ type: 'message_end', message });
      expect(overlay['streamingComponent']).toBeNull();
      overlay['poll']();
      expect(open).toHaveBeenCalledTimes(1);
      expect(overlay['historyDirty']).toBe(false);
      expect(overlay['lastFileSize']).toBe(fs.statSync(session.getSessionFile()!).size);
      expect(overlay['sessionManager']!.buildSessionContext().messages.at(-1)).toMatchObject(message);
      expect(overlay['followMode']).toBe(false);
      expect(overlay['scrollOffset']).toBe(offset);
      overlay.handleInput('G');
      expect(stripVTControlCharacters(overlay.render(80).join('\n'))).toContain(
        'streamed final response',
      );
      overlay['poll']();
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
    }
  });

  test.each([false, true])(
    'replays an observed file change even if its size returns to the loaded size (load failure=%s)',
    (failOnce) => {
      const directory = fs.mkdtempSync(join(tmpdir(), 'pi-peek-rewritten-'));
      temporaryDirectories.push(directory);
      const session = SessionManager.create(cwd, directory);
      session.appendMessage({ role: 'user', content: 'old content', timestamp: 1000 });
      session.appendMessage(assistant([toolCall()]));
      const file = session.getSessionFile()!;
      const original = fs.readFileSync(file, 'utf8');
      const { overlay } = createOverlay({}, file);
      start(overlay);
      overlay['socket'] = { connecting: false, destroyed: false, destroy() {} } as any;
      const previousSize = overlay['lastFileSize'];
      const open = spyOn(SessionManager, 'open');
      try {
        session.appendMessage({ role: 'user', content: 'temporary tail', timestamp: 1001 });
        overlay['poll']();
        expect(overlay['historyDirty']).toBe(true);
        expect(open).not.toHaveBeenCalled();
        fs.writeFileSync(file, original.replace('old content', 'new content'));
        expect(fs.statSync(file).size).toBe(previousSize);
        overlay['poll']();
        expect(overlay['historyDirty']).toBe(true);
        expect(open).not.toHaveBeenCalled();
        overlay['handleEvent']({
          type: 'tool_execution_end',
          toolCallId: 'call-1',
          result: textResult('completed'),
        });
        if (failOnce) {
          open.mockImplementationOnce(() => {
            throw new Error('temporary session read failure');
          });
          const children = [...overlay['chatContainer'].children];
          overlay['poll']();
          expect(open).toHaveBeenCalledTimes(1);
          expect(overlay['historyDirty']).toBe(true);
          expect(overlay['lastFileSize']).toBe(previousSize);
          expect(overlay['chatContainer'].children).toEqual(children);
        }
        overlay['poll']();
        expect(open).toHaveBeenCalledTimes(failOnce ? 2 : 1);
        expect(overlay['historyDirty']).toBe(false);
        expect(overlay['sessionManager']!.buildSessionContext().messages[0]).toMatchObject({
          role: 'user',
          content: 'new content',
        });
        overlay['poll']();
        expect(open).toHaveBeenCalledTimes(failOnce ? 2 : 1);
      } finally {
        open.mockRestore();
      }
    },
  );

  test.each(['sync', 'agent_settled', 'close'])(
    '%s retries deferred history after a failed explicit load without retaining native timers',
    (transition) => {
      const { overlay, session } = createSavedOverlay();
      const file = session.getSessionFile()!;
      const original = fs.readFileSync(file, 'utf8');
      const socket = Object.assign(new EventEmitter(), {
        connecting: false,
        destroyed: false,
        destroy() {},
      });
      const connect = spyOn(net, 'connect').mockReturnValue(socket as any);
      try {
        overlay['connectSocket']();
      } finally {
        connect.mockRestore();
      }
      const component = start(overlay);
      progress(overlay);
      const previousSize = overlay['lastFileSize'];
      session.appendMessage({ role: 'user', content: 'temporary tail', timestamp: 1001 });
      overlay['poll']();
      expect(overlay['historyDirty']).toBe(true);
      expect(overlay['lastFileSize']).toBe(previousSize);
      fs.writeFileSync(file, original.replace('chat_line_100', 'chat_line_999'));
      expect(fs.statSync(file).size).toBe(previousSize);
      const open = spyOn(SessionManager, 'open').mockImplementationOnce(() => {
        throw new Error('temporary explicit session read failure');
      });
      try {
        if (transition === 'close') socket.emit('close');
        else overlay['handleEvent']({ type: transition });
        expect(open).toHaveBeenCalledTimes(1);
        expect(clock!.nativeTimers()).toHaveLength(0);
        expect(component['isPartial']).toBe(false);
        expect(overlay['pendingTools'].size).toBe(0);
        expect(overlay['assistantStream'].message).toBeNull();
        expect(overlay['historyDirty']).toBe(true);
        overlay['poll']();
        expect(open).toHaveBeenCalledTimes(2);
        expect(overlay['historyDirty']).toBe(false);
        overlay.handleInput('G');
        expect(stripVTControlCharacters(overlay.render(80).join('\n'))).toContain('chat_line_999');
        overlay['poll']();
        expect(open).toHaveBeenCalledTimes(2);
      } finally {
        open.mockRestore();
      }
    },
  );

  test.each(['disconnected', 'destroyed', 'connecting'])(
    'poll preserves live pending rows but %s socket state permits file fallback and releases timers',
    (state) => {
      const directory = fs.mkdtempSync(join(tmpdir(), 'pi-peek-render-'));
      temporaryDirectories.push(directory);
      const session = SessionManager.create(cwd, directory);
      session.appendMessage(assistant([toolCall()]));
      const file = session.getSessionFile()!;
      const { overlay } = createOverlay({}, file);
      const component = start(overlay);
      progress(overlay);
      const [timerId] = clock!.nativeTimers()[0];
      const socket = { connecting: false, destroyed: false, destroy() {} };
      overlay['socket'] = socket as any;
      const previousSize = overlay['lastFileSize'];
      const final = textResult('file final output', {
        details: { calls: calls(3) },
        durationMs: 8600,
      });
      session.appendMessage({
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'codemode',
        ...final,
        timestamp: 1001,
      });
      overlay['poll']();
      expect(overlay['pendingTools'].get('call-1')!.component).toBe(component);
      expect(overlay['pendingTools'].get('call-1')!.executing).toBe(true);
      expect(toolRows(overlay)[0]).toBe(component);
      expect(clock!.timers.has(timerId)).toBe(true);
      expect(overlay['lastFileSize']).toBe(previousSize);
      expect(fs.statSync(file).size).toBeGreaterThan(previousSize);
      expect(overlay['historyDirty']).toBe(true);
      expect(
        overlay['sessionManager']!.buildSessionContext().messages.some(
          (message) => message.role === 'toolResult',
        ),
      ).toBe(false);
      session.appendMessage({ role: 'user', content: 'latest file fallback', timestamp: 1002 });
      if (state === 'disconnected') overlay['socket'] = null;
      else if (state === 'destroyed') socket.destroyed = true;
      else socket.connecting = true;
      // Load the latest history once live updates are unavailable.
      overlay['poll']();
      expect(overlay['lastFileSize']).toBe(fs.statSync(file).size);
      expect(overlay['historyDirty']).toBe(false);
      expect(overlay['sessionManager']!.buildSessionContext().messages.at(-1)).toMatchObject({
        role: 'user',
        content: 'latest file fallback',
      });
      expect(clock!.clear).toHaveBeenCalledWith(timerId);
      expect(clock!.nativeTimers()).toHaveLength(0);
      expect(overlay['pendingTools'].size).toBe(0);
      expect(toolRows(overlay)[0]).not.toBe(component);
      const restored = toolRows(overlay)[0];
      expect(restored['expanded']).toBe(false);
      expect(restored['executionStarted']).toBe(false);
      expect(restored['argsComplete']).toBe(false);
      const reference = referenceTool('codemode', codeArgs, nativeCodemodeRenderers);
      reference.updateResult(final);
      expectNativeLines(restored, reference);
    },
  );
});

describe('observer socket integration', () => {
  let broadcaster: InstanceType<typeof EventBroadcaster>;
  let agentId: string;
  let events: any[];
  let sockets: net.Socket[];

  beforeEach(async () => {
    agentId = randomUUID();
    events = [];
    sockets = [];
    broadcaster = new EventBroadcaster(agentId);
    broadcaster.start();
    await once(broadcaster['server']!, 'listening');
    const socket = net.connect(getSocketPath(agentId));
    sockets.push(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines.filter(Boolean)) events.push(JSON.parse(line));
    });
    let error: Error | undefined;
    socket.on('error', (value) => {
      error = value;
    });
    await waitUntil(() => {
      if (error) throw error;
      return events[0]?.type === 'sync';
    });
    events.length = 0;
  });

  afterEach(async () => {
    const server = broadcaster['server'];
    const closed = server ? once(server, 'close') : Promise.resolve();
    for (const overlay of overlays) overlay.dispose();
    for (const socket of sockets) socket.destroy();
    broadcaster.stop();
    await closed;
  });

  const start = (id: string, toolName = 'codemode', args: any = { code: 'script' }) => ({
    type: 'tool_execution_start',
    toolCallId: id,
    toolName,
    args,
  });
  const update = (id: string, partialResult: any) => ({
    type: 'tool_execution_update',
    toolCallId: id,
    toolName: 'codemode',
    partialResult,
  });
  const end = (id: string, result: any, isError = false) => ({
    type: 'tool_execution_end',
    toolCallId: id,
    toolName: 'codemode',
    result,
    isError,
  });
  const textResult = (text: string) => ({
    content: [{ type: 'text' as const, text }],
    details: {},
  });
  const emit = (...values: any[]) => {
    for (const value of values) broadcaster.broadcast(value);
  };
  const flush = async () => {
    const token = randomUUID();
    emit({ type: 'test_barrier', token });
    await waitUntil(() =>
      events.some((event) => event.type === 'test_barrier' && event.token === token),
    );
  };
  const nested = (event: any, parentToolCallId: string) => ({ ...event, parentToolCallId });

  test.each(['regular', 'fullscreen'] as const)(
    'isolated native %s TUI handles live socket previews, input, reopen, resize and offline recovery',
    async (mode) => {
      initTheme('dark', false);
      const sessionDir = fs.mkdtempSync(join(TEST_AGENT_DIR, 'tui-session-'));
      const session = SessionManager.create(TEST_AGENT_DIR, sessionDir);
      session.appendMessage({ role: 'user', content: 'isolated TUI task', timestamp: Date.now() });
      const args = { code: 'await Promise.allSettled([tools.read({ path: "中文.txt" })]);' };
      const assistant: any = {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tui-call', name: 'codemode', arguments: args }],
        api: 'test',
        provider: 'test',
        model: 'fake',
        stopReason: 'toolUse',
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      session.appendMessage(assistant);
      const partial = {
        ...textResult('hidden partial text'),
        details: { calls: [{ name: 'nested/read', args: 'path=中文.txt', status: 'running' }] },
      };
      emit(start('tui-call', 'codemode', args), update('tui-call', partial));
      const info = {
        id: agentId,
        taskName: 'isolated TUI',
        provider: 'test',
        modelId: 'fake',
        cwd: TEST_AGENT_DIR,
        sessionFile: session.getSessionFile()!,
      } as AgentInfo;
      let input: (data: string) => void = () => {};
      let resize = () => {};
      const writes: string[] = [];
      const terminal: Terminal & { columns: number; rows: number } = {
        columns: 120,
        rows: 35,
        kittyProtocolActive: false,
        start(onInput, onResize) {
          input = onInput;
          resize = onResize;
        },
        stop() {},
        async drainInput() {},
        write(data) {
          writes.push(data);
        },
        moveBy() {},
        hideCursor() {},
        showCursor() {},
        clearLine() {},
        clearFromCursor() {},
        clearScreen() {},
        setTitle() {},
        setProgress() {},
        setProgramStatus() {},
      };
      const tui = mode === 'regular' ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
      const navigation: Array<'previous' | 'next' | undefined> = [];
      let overlay: InstanceType<typeof SubagentPeekOverlay>;
      let hide = () => {};
      const mount = async () => {
        overlay = new SubagentPeekOverlay(
          tui,
          { fg: (_color: string, text: string) => text } as any,
          info,
          (value) => {
            navigation.push(value);
            hide();
          },
          nativeCodemodeRenderers,
          { outputPad: 0, showImages: false },
        );
        overlays.push(overlay);
        const socket = overlay['socket']!;
        await once(socket, 'data');
        const handle = tui.showOverlay(overlay, {
          anchor: 'right-center',
          width: '80%',
          minWidth: 38,
          maxHeight: 31,
        });
        hide = () => {
          overlay.dispose();
          handle.hide();
        };
        writes.length = 0;
        tui.renderNow(true);
      };
      const tool = () =>
        overlay!['chatContainer'].children.find(
          (child) => child instanceof ToolExecutionComponent,
        ) as ToolExecutionComponent;
      const output = () => stripVTControlCharacters(writes.join(''));
      const draw = () => {
        writes.length = 0;
        tui.renderNow(true);
        return output();
      };
      tui.start();
      try {
        await mount();
        expect(output()).toContain('… nested/read');
        expect(tool()['expanded']).toBe(false);
        expect(tool()['executionStarted']).toBe(true);
        input('\x0f'); // Ctrl+O
        if (mode === 'fullscreen') {
          input('\x1b[<0;70;15M');
          input('\x1b[<0;70;15m');
        }
        expect(tool()['expanded']).toBe(false);
        for (const key of ['k', 'j', 'g', 'G']) input(key);
        terminal.columns = 55;
        resize();
        expect(draw()).toContain('nested/read');
        terminal.columns = 120;
        resize();
        overlay!.invalidate();
        expect(draw()).toContain('… nested/read');
        expect(tool()['expanded']).toBe(false);
        input('q');
        expect(overlay!['disposed']).toBe(true);
        await mount();
        expect(output()).toContain('… nested/read');
        expect(tool()['executionStarted']).toBe(true);

        const result = {
          ...textResult('tui_final_output'),
          details: {
            calls: [
              {
                name: 'nested/read',
                args: 'path=中文.txt',
                status: 'error',
                error: 'caught failure',
                durationMs: 15,
              },
            ],
          },
        };
        const original = structuredClone(result);
        emit({ ...end('tui-call', result), durationMs: 2600 });
        await waitUntil(() => !overlay!['pendingTools'].has('tui-call'));
        draw();
        expect(output()).toContain('✗ nested/read');
        expect(output()).toContain('tui_final_output');
        expect(output()).toContain('Took 2.6s');
        expect(tool()['result']!.isError).toBe(false);
        expect(result).toEqual(original);
        const finalMessage: any = {
          role: 'toolResult',
          toolCallId: 'tui-call',
          toolName: 'codemode',
          ...result,
          durationMs: 2600,
          isError: false,
          timestamp: Date.now(),
        };
        emit({ type: 'message_end', message: finalMessage });
        session.appendMessage(finalMessage);
        emit({ type: 'agent_settled' });
        await waitUntil(() => overlay!['status'] === 'done');
        input('\x1b[D');
        expect(overlay!['disposed']).toBe(true);
        await mount();
        expect(output()).toContain('tui_final_output');
        expect(tool()['executionStarted']).toBe(false);
        expect(tool()['expanded']).toBe(false);
        input('\x1b[C');
        await mount();
        expect(output()).toContain('tui_final_output');
        expect(tool()['expanded']).toBe(false);
        expect(navigation).toEqual([undefined, 'previous', 'next']);

        const closed = once(broadcaster['server']!, 'close');
        broadcaster.stop();
        await closed;
        await waitUntil(() => overlay!['socket'] === null);
        session.appendMessage({
          role: 'user',
          content: 'offline TUI file update',
          timestamp: Date.now(),
        });
        overlay!['poll']();
        overlay!.handleInput('G');
        draw();
        expect(output()).toContain('offline TUI file update');
        expect(
          SessionManager.open(info.sessionFile)
            .buildSessionContext()
            .messages.find((message) => message.role === 'toolResult'),
        ).toMatchObject(finalMessage);
        input('q');
      } finally {
        hide();
        tui.stop();
      }
    },
  );

  test('defers file rebuilds only for executing rows and resumes deferred or disconnected file recovery', async () => {
    initTheme('dark', false);
    const sessionDir = fs.mkdtempSync(join(TEST_AGENT_DIR, 'poll-session-'));
    const session = SessionManager.create(TEST_AGENT_DIR, sessionDir);
    session.appendMessage({
      role: 'user',
      content: 'isolated polling task',
      timestamp: Date.now(),
    });
    const calls = ['file-only', 'a', 'c'].map((id) => ({
      type: 'toolCall' as const,
      id,
      name: 'custom_tool',
      arguments: { task: id },
    }));
    const assistant: any = {
      role: 'assistant',
      content: calls,
      api: 'test',
      provider: 'test',
      model: 'fake',
      stopReason: 'toolUse',
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    session.appendMessage(assistant);
    emit(
      start('a', 'custom_tool', calls[1].arguments),
      start('c', 'custom_tool', calls[2].arguments),
    );
    const info = {
      id: agentId,
      taskName: 'polling',
      provider: 'test',
      modelId: 'fake',
      cwd: TEST_AGENT_DIR,
      sessionFile: session.getSessionFile()!,
    } as AgentInfo;
    const overlay = new SubagentPeekOverlay(
      { terminal: { rows: 80 }, requestRender() {} } as any,
      { fg: (_color: string, text: string) => text } as any,
      info,
      () => {},
      nativeCodemodeRenderers,
    );
    overlays.push(overlay);
    await waitUntil(() => overlay['pendingTools'].get('c')?.executing === true);
    const a = overlay['pendingTools'].get('a')!.component;
    const c = overlay['pendingTools'].get('c')!.component;
    expect(overlay['pendingTools'].get('file-only')!.executing).toBe(false);
    const persistedResult = (id: string, text: string) => ({
      role: 'toolResult' as const,
      toolCallId: id,
      toolName: 'custom_tool',
      ...textResult(text),
      isError: false,
      durationMs: 100,
      timestamp: Date.now(),
    });

    // Persist an unresolved historical result during live execution.
    session.appendMessage(persistedResult('file-only', 'file_only_result'));
    overlay['poll']();
    expect(overlay['historyDirty']).toBe(true);
    expect(overlay['pendingTools'].get('a')!.component).toBe(a);
    expect(overlay['pendingTools'].get('c')!.component).toBe(c);
    emit(end('a', textResult('a result')));
    await waitUntil(() => !overlay['pendingTools'].has('a'));
    overlay['poll']();
    expect(overlay['pendingTools'].get('c')!.component).toBe(c);
    session.appendMessage(persistedResult('a', 'a result'));
    overlay['poll']();
    const deferredSize = fs.statSync(info.sessionFile).size;
    expect(overlay['lastFileSize']).toBeLessThan(deferredSize);
    emit(end('c', textResult('c result')));
    await waitUntil(() => !overlay['pendingTools'].has('c'));
    overlay['poll']();
    expect(overlay['lastFileSize']).toBe(deferredSize);
    expect(overlay['historyDirty']).toBe(false);
    expect(overlay['pendingTools'].has('file-only')).toBe(false);
    expect(stripVTControlCharacters(overlay.render(120).join('\n'))).toContain('file_only_result');

    // A reconnected execution reuses the unresolved historical row; disconnect permits file fallback.
    emit(start('c', 'custom_tool', calls[2].arguments));
    await waitUntil(() => overlay['pendingTools'].get('c')?.executing === true);
    session.appendMessage(persistedResult('c', 'disconnected_file_result'));
    overlay['socket']!.destroy();
    await waitUntil(() => overlay['socket'] === null && !overlay['pendingTools'].has('c'));
    expect(stripVTControlCharacters(overlay.render(120).join('\n'))).toContain(
      'disconnected_file_result',
    );
    session.appendMessage({ role: 'user', content: 'offline_file_tail', timestamp: Date.now() });
    overlay['poll']();
    expect(stripVTControlCharacters(overlay.render(120).join('\n'))).toContain('offline_file_tail');
  });

  test('renders live, reconnect and persisted history with the same top-level ownership', async () => {
    initTheme('dark', false);
    const sessionDir = fs.mkdtempSync(join(TEST_AGENT_DIR, 'observer-session-'));
    const session = SessionManager.create(TEST_AGENT_DIR, sessionDir);
    session.appendMessage({
      role: 'user',
      content: 'isolated observer task',
      timestamp: Date.now(),
    });
    const info = {
      id: agentId,
      taskName: 'observer',
      provider: 'test',
      modelId: 'fake',
      model: 'test:fake',
      cwd: TEST_AGENT_DIR,
      sessionFile: session.getSessionFile()!,
    } as AgentInfo;
    const navigation: Array<'previous' | 'next' | undefined> = [];
    const open = async (expectSync = true) => {
      const overlay = new SubagentPeekOverlay(
        {
          terminal: { rows: 80 },
          requestRender() {},
        } as any,
        { fg: (_color: string, text: string) => text } as any,
        info,
        (value) => navigation.push(value),
        nativeCodemodeRenderers,
      );
      overlays.push(overlay);
      const socket = overlay['socket']!;
      sockets.push(socket);
      const decoder = new ObserverJsonlDecoder();
      let synced = false;
      const onData = (chunk: Buffer) => {
        for (const line of decoder.push(chunk)) {
          if (JSON.parse(line).type === 'sync') synced = true;
        }
      };
      socket.on('data', onData);
      try {
        await waitUntil(() => (expectSync ? synced : overlay['socket'] === null));
      } finally {
        socket.off('data', onData);
      }
      return overlay;
    };
    const tools = (overlay: InstanceType<typeof SubagentPeekOverlay>) =>
      overlay['chatContainer'].children.filter((child) => child instanceof ToolExecutionComponent);
    const render = (overlay: InstanceType<typeof SubagentPeekOverlay>) =>
      stripVTControlCharacters(overlay.render(120).join('\n'));
    let overlay = await open();
    const parent = start('script', 'codemode', {
      code: 'await Promise.all([tools.read({path: "nested.txt"}), tools.powershell({command: "echo nested"})])',
    });
    const assistant: any = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'script', name: 'codemode', arguments: parent.args }],
      api: 'test',
      provider: 'test',
      model: 'fake',
      stopReason: 'toolUse',
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    emit(
      { type: 'message_start', message: { ...assistant, content: [] } },
      {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_start',
          contentIndex: 0,
          id: 'script',
          toolName: 'codemode',
        },
      },
      {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_delta',
          contentIndex: 0,
          delta: JSON.stringify(parent.args),
        },
      },
      {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_end',
          contentIndex: 0,
          toolCall: assistant.content[0],
        },
      },
      { type: 'message_end', message: assistant },
    );
    session.appendMessage(assistant);
    emit(
      parent,
      nested(start('script/1', 'read', { path: 'nested.txt' }), 'script'),
      nested(start('script/2', 'powershell', { command: 'echo nested' }), 'script'),
      update('script', {
        ...textResult('parent progress'),
        details: { calls: [{ name: 'nested/read', args: 'path=nested.txt', status: 'running' }] },
      }),
    );
    await waitUntil(() => render(overlay).includes('… nested/read'));
    expect(tools(overlay)).toHaveLength(1);
    expect(overlay['pendingTools'].has('script/1')).toBe(false);
    expect(overlay['pendingTools'].has('script/2')).toBe(false);

    overlay.dispose();
    overlay = await open();
    expect(tools(overlay)).toHaveLength(1);
    expect(render(overlay)).toContain('… nested/read');
    expect(render(overlay)).not.toContain('parent progress');
    const result = {
      ...textResult('final script output'),
      durationMs: 1234,
      details: {
        calls: [
          { name: 'nested/read', args: 'path=nested.txt', status: 'ok', durationMs: 12 },
          {
            name: 'nested/powershell',
            args: 'command=echo nested',
            status: 'error',
            durationMs: 23,
            error: 'caught error',
          },
          { name: 'nested/cancelled', args: '', status: 'cancelled' },
        ],
      },
    };
    emit(
      nested(end('script/1', textResult('nested file')), 'script'),
      nested(end('script/2', textResult('nested shell')), 'script'),
      end('script', result),
    );
    await waitUntil(() => render(overlay).includes('final script output'));
    overlay.dispose();
    overlay = await open();
    expect(tools(overlay)).toHaveLength(1);
    expect(render(overlay)).toContain('final script output');
    expect(render(overlay)).toContain('✓ nested/read');
    expect(render(overlay)).toContain('✗ nested/powershell');
    expect(render(overlay)).toContain('⊘ nested/cancelled');
    expect(render(overlay)).toContain('Took 1.2s');
    const reference = new ToolExecutionComponent(
      'codemode',
      'script',
      parent.args,
      {},
      nativeCodemodeRenderers,
      { requestRender() {} } as any,
      TEST_AGENT_DIR,
    );
    reference.setExpanded(false);
    reference.setArgsComplete();
    reference.updateResult({ ...result, isError: false }, false);
    expect(tools(overlay)[0].render(118)).toEqual(reference.render(118));

    const toolResult: any = {
      role: 'toolResult',
      toolCallId: 'script',
      toolName: 'codemode',
      ...result,
      isError: false,
      timestamp: Date.now(),
    };
    emit({ type: 'message_end', message: toolResult });
    // Observe event delivery before the transcript write.
    await flush();
    expect(
      SessionManager.open(info.sessionFile)
        .buildSessionContext()
        .messages.some((message) => message.role === 'toolResult'),
    ).toBe(false);
    overlay.dispose();
    overlay = await open();
    expect(tools(overlay)).toHaveLength(1);
    expect(render(overlay)).not.toContain('final script output');
    session.appendMessage(toolResult);
    await waitUntil(() => render(overlay).includes('final script output'));
    const direct = start('direct/read', 'read', { path: 'real-top-level.txt' });
    const directAssistant = {
      ...assistant,
      content: [{ type: 'toolCall', id: direct.toolCallId, name: 'read', arguments: direct.args }],
    };
    session.appendMessage(directAssistant);
    emit(direct, { ...end(direct.toolCallId, textResult('top-level file')), toolName: 'read' });
    const directResult: any = {
      role: 'toolResult',
      toolCallId: direct.toolCallId,
      toolName: 'read',
      ...textResult('top-level file'),
      isError: false,
      timestamp: Date.now(),
    };
    emit({ type: 'message_end', message: directResult });
    session.appendMessage(directResult);
    await waitUntil(() => render(overlay).includes('real-top-level.txt'));
    expect(tools(overlay)).toHaveLength(2);
    emit({ type: 'agent_settled' });
    await waitUntil(() => overlay['status'] === 'done');
    expect(render(overlay)).toContain('final script output');
    expect(render(overlay)).toContain('real-top-level.txt');
    expect(tools(overlay)).toHaveLength(2);

    overlay.dispose();
    overlay = await open();
    expect(tools(overlay)).toHaveLength(2);
    expect(render(overlay)).toContain('final script output');
    expect(render(overlay)).toContain('real-top-level.txt');
    for (const key of ['k', 'j', 'g', 'G']) expect(() => overlay.handleInput(key)).not.toThrow();
    overlay.handleInput('\x1b[D');
    overlay = await open();
    overlay.handleInput('\x1b[C');
    overlay = await open();
    overlay.handleInput('q');
    expect(navigation).toEqual(['previous', 'next', undefined]);
    const closed = once(broadcaster['server']!, 'close');
    broadcaster.stop();
    await closed;
    overlay = await open(false);
    expect(tools(overlay)).toHaveLength(2);
    expect(render(overlay)).toContain('final script output');
    expect(render(overlay)).toContain('real-top-level.txt');
    expect(
      SessionManager.open(info.sessionFile)
        .buildSessionContext()
        .messages.filter((message) => message.role === 'toolResult')
        .map((message: any) => message.toolCallId),
    ).toEqual(['script', 'direct/read']);
  });
});
