import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import {
  InteractiveMode,
  type ExtensionContext,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import {
  backgroundAnsi,
  Loader,
  parseColor,
  visibleWidth,
  type Component,
  type TUI,
} from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import * as fs from 'node:fs';
import type { AgentWidgetSnapshot } from '../src/core.js';
import { AgentSummaryWidget, type AgentStatusCounts } from '../src/widget.js';
import { renderAgentBadge } from '../src/color.js';
import { nativeTheme } from './fixtures/ui-theme.js';

type Widget = Component & { dispose?(): void };
type Factory = (tui: TUI, theme: Theme) => Widget;
type Content = Factory | string[] | undefined;
const plainTheme = { fg: (_color: string, text: string) => text } as Theme;
const controllers: AgentSummaryWidget[] = [];
let clock: ReturnType<typeof controlledTimers> | undefined;

// Only these two spies are restored; no module mocks, global fake clock or mock.restore().
function controlledTimers() {
  const timers = new Map<object, { callback: () => void; delay?: number }>();
  const set = spyOn(globalThis, 'setInterval').mockImplementation(((
    callback: () => void,
    delay?: number,
  ) => {
    const handle = { unref: mock(() => {}) };
    timers.set(handle, { callback, delay });
    return handle;
  }) as any);
  const clear = spyOn(globalThis, 'clearInterval').mockImplementation(((handle: object) => {
    timers.delete(handle);
  }) as any);
  return {
    timers,
    set,
    clear,
    tick(delay = 200) {
      for (const timer of [...timers.values()]) if (timer.delay === delay) timer.callback();
    },
    restore() {
      clear.mockRestore();
      set.mockRestore();
      timers.clear();
    },
  };
}

beforeEach(() => {
  clock = controlledTimers();
});
afterEach(() => {
  for (const widget of controllers.splice(0)) widget.dispose();
  clock?.restore();
  clock = undefined;
});

function snapshot(extra: Partial<AgentWidgetSnapshot> = {}): AgentWidgetSnapshot {
  return { canonicalName: '/worker', status: 'running', activeTools: [], ...extra };
}

function controller(
  getSnapshots: () => readonly AgentWidgetSnapshot[],
  onError = mock((_error: unknown) => {}),
  getStatusCounts?: () => AgentStatusCounts,
) {
  const widget = new AgentSummaryWidget(getSnapshots, onError, getStatusCounts);
  controllers.push(widget);
  return widget;
}

function host(
  options: {
    mode?: ExtensionContext['mode'];
    parentId?: string;
    rows?: number;
    theme?: Theme;
  } = {},
) {
  let component: Widget | undefined;
  const factoryTheme = options.theme ?? plainTheme;
  const requestRender = mock(() => {});
  const tui = { terminal: { rows: options.rows ?? 50 }, requestRender } as unknown as TUI;
  const setWidget = mock((_key: string, content: Content, _options?: { placement?: string }) => {
    // This is deliberately synchronous, like SDK setExtensionWidget().
    component?.dispose?.();
    component = undefined;
    if (typeof content === 'function') {
      component = content(tui, factoryTheme);
    }
  });
  const ui = { theme: factoryTheme as Theme | undefined, setWidget };
  const ctx = {
    mode: options.mode ?? 'tui',
    hasUI: true,
    ui,
    sessionManager: { getSessionId: () => options.parentId ?? 'parent' },
  } as unknown as ExtensionContext;
  return {
    ctx,
    ui,
    tui,
    setWidget,
    requestRender,
    factoryTheme,
    get component() {
      return component!;
    },
    render(width = 140) {
      return component?.render(width) ?? [];
    },
    text(width = 140) {
      return this.render(width).map(stripVTControlCharacters).join('\n');
    },
  };
}

function trackingTheme(accent = 36) {
  const calls: { color: string; text: string }[] = [];
  const colors: Record<string, number> = {
    accent,
    dim: accent + 1,
    warning: 33,
    error: 31,
    success: 32,
  };
  const theme = {
    fg(color: string, text: string) {
      calls.push({ color, text });
      return `\x1b[${colors[color]}m${text}\x1b[39m`;
    },
  } as Theme;
  return { theme, calls };
}

function usage(percent: number | null) {
  return { contextWindow: 100_000, tokens: percent === null ? null : percent * 1000, percent };
}

function expectFit(lines: string[], width: number) {
  for (const line of lines) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    expect(stripVTControlCharacters(line)).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  }
}

describe('configured summary badges', () => {
  for (const appearance of ['dark', 'light'] as const) {
    test.each(['truecolor', '256color'] as const)(
      `${appearance} name badges fit and keep statistics in %s without row tint`,
      (mode) => {
        const theme = nativeTheme(appearance, mode);
        const f = host({ theme });
        controller(() => [
          snapshot({
            color: 'blue',
            provider: 'openai-codex',
            modelId: 'long-model/'.repeat(12),
            thinking: 'max',
            tokens: 1000,
            contextUsage: usage(86),
            compactionCount: 1,
            elapsedMs: 12_345,
            responsePreview: '中文😀'.repeat(100),
          }),
        ]).attach(f.ctx);
        const open = backgroundAnsi(parseColor('#6A9BCC'), mode);
        for (const width of [2, 9, 32, 38, 50, 80, 120]) {
          const lines = f.render(width);
          expectFit(lines, width);
          expect(lines).toHaveLength(3);
          expect(lines[2]).not.toMatch(/\x1b\[48;/);
          if (width >= 32) {
            const text = stripVTControlCharacters(lines[1]);
            for (const stat of ['/max', '1.0k', '86%', '↓1', '12s']) expect(text).toContain(stat);
            expect(lines[1]).toContain(theme.fg('error', '86%'));
            expect(lines[1]).toContain(open);
            expect(lines[1]).not.toContain('\x1b[7m');
          }
        }
        expect(f.render(0)).toEqual([]);
        expect(f.render(1)).toHaveLength(1);
        expect(clock!.timers.size).toBe(2);
        expect(f.setWidget).toHaveBeenCalledTimes(1);
      },
    );
  }

  test('shared template colors survive removal and theme invalidation without sampling, IO or remounting', () => {
    const dark = nativeTheme('dark');
    let agents = [
      snapshot({ canonicalName: '/review', color: '#DC2626' }),
      snapshot({ canonicalName: '/tests', color: '#DC2626' }),
    ];
    const getSnapshots = mock(() => agents);
    const widget = controller(getSnapshots);
    const f = host({ theme: dark });
    widget.attach(f.ctx);
    expect(f.render()[1]).toContain(renderAgentBadge('/review', dark, 'red'));
    expect(f.render()[3]).toContain(renderAgentBadge('/tests', dark, 'red'));
    agents = [agents[1]];
    widget.refresh();
    expect(f.render()[1]).toContain(renderAgentBadge('/tests', dark, 'red'));
    const samples = getSnapshots.mock.calls.length;
    const light = nativeTheme('light');
    f.ui.theme = light;
    f.component.invalidate();
    const updated = f.render()[1];
    expect(updated).toContain(renderAgentBadge('/tests', light, 'red'));
    expect(updated).toContain(light.fg('accent', '⠋'));
    expect(getSnapshots).toHaveBeenCalledTimes(samples);
    expect(f.setWidget).toHaveBeenCalledTimes(1);
    expect(clock!.timers.size).toBe(2);
    const reads = spyOn(fs, 'readFileSync'),
      scans = spyOn(fs, 'readdirSync');
    try {
      for (let frame = 0; frame < 5; frame++) {
        clock!.tick();
        expect(f.render()[1]).toContain(renderAgentBadge('/tests', light, 'red'));
      }
      expect(reads).not.toHaveBeenCalled();
      expect(scans).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
      scans.mockRestore();
    }
    agents = [];
    widget.refresh();
    expect(clock!.timers.size).toBe(0);
    expect(f.render()).toEqual([]);
  });

  test.each([undefined, 'invalid', '#123', null, {}, 12])(
    'missing/invalid snapshot color %j keeps both lines and ordinary themed names',
    (color) => {
      const theme = nativeTheme('dark');
      const f = host({ theme });
      controller(() => [
        snapshot({ color: color as any, responsePreview: 'plain activity' }),
      ]).attach(f.ctx);
      const lines = f.render();
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain(theme.fg('accent', '/worker'));
      expect(lines[2]).toContain('plain activity');
      expect(lines.join('')).not.toMatch(/\x1b\[48;/);
    },
  );
});

describe('summary content', () => {
  test('construction and an empty attachment allocate no widget or timer', () => {
    const getSnapshots = mock(() => []);
    const widget = controller(getSnapshots);
    const f = host();
    expect(getSnapshots).not.toHaveBeenCalled();
    expect(clock!.set).not.toHaveBeenCalled();
    widget.refresh();
    expect(getSnapshots).not.toHaveBeenCalled();
    widget.attach(f.ctx);
    expect(getSnapshots).toHaveBeenCalledTimes(1);
    expect(f.setWidget).not.toHaveBeenCalled();
    expect(clock!.timers.size).toBe(0);
    widget.dispose();
    widget.dispose();
    widget.attach(f.ctx);
    widget.refresh();
    expect(getSnapshots).toHaveBeenCalledTimes(1);
  });

  test('renders the agreed title, combined model metadata, cumulative tokens and this-run seconds only', () => {
    const agent = snapshot({
      provider: 'openai-codex',
      modelId: 'gpt-6.1-sol',
      thinking: 'max',
      tokens: 33_800,
      contextUsage: usage(62),
      compactionCount: 1,
      elapsedMs: 12_345,
      activeTools: Object.freeze(['read', 'read', 'edit']),
      responsePreview: 'hidden while tools run',
    });
    for (const key of [
      'description',
      'lastTaskMessage',
      'turns',
      'turnCount',
      'toolUses',
      'cost',
      'args',
      'messages',
    ])
      Object.defineProperty(agent, key, {
        get() {
          throw new Error('Must not read ' + key);
        },
      });
    Object.freeze(agent);
    const errors = mock((_error: unknown) => {});
    const f = host();
    controller(() => Object.freeze([agent]), errors).attach(f.ctx);
    const lines = f.render();
    expect(lines[0]).toBe('● Agents · 1 running · /subagents to view details');
    expect(lines[1]).toContain('/worker · openai-codex/gpt-6.1-sol/max');
    expect(lines[1]).toContain('33.8k token (62% · ↓1) · 12s');
    expect(lines[2]).toContain('reading, editing…');
    expect(lines.join('\n')).not.toMatch(/thinking:|hidden while|turns|tool use|cost|\$/);
    expect(errors).not.toHaveBeenCalled();
    expect(f.setWidget.mock.calls[0][0]).toBe('pi-subagents');
    expect(f.setWidget.mock.calls[0][2]).toEqual({ placement: 'aboveEditor' });
    expect(f.component).not.toHaveProperty('handleInput');
  });

  test('elapsed labels show completed whole seconds and omit unknown or invalid durations', () => {
    let agent = snapshot();
    const f = host();
    const widget = controller(() => [agent]);
    widget.attach(f.ctx);
    for (const [elapsedMs, seconds] of [
      [0, 0],
      [0.5, 0],
      [999, 0],
      [1000, 1],
      [1999, 1],
      [12_345, 12],
      [59_999, 59],
      [60_000, 60],
      [undefined, undefined],
      [-1, undefined],
      [NaN, undefined],
      [Infinity, undefined],
    ] as const) {
      agent = snapshot({ elapsedMs });
      widget.refresh();
      for (const width of [32, 140]) {
        const text = f.text(width).split('\n')[1];
        expect(text.match(/\b\d+s\b/g) ?? []).toEqual(seconds === undefined ? [] : [`${seconds}s`]);
        expect(text).not.toMatch(/\d+\.\d+s\b/);
        expectFit(f.render(width), width);
      }
    }
  });

  test('activity prefers initializing, then deduplicated tool actions, then the first public line, then thinking', () => {
    let agent = snapshot();
    const f = host();
    const widget = controller(() => [agent]);
    widget.attach(f.ctx);
    for (const [extra, expected] of [
      [{ status: 'starting', activeTools: ['read'], responsePreview: 'not yet' }, 'initializing…'],
      [{ activeTools: ['bash', 'powershell', 'read', 'read'] }, 'running command, reading…'],
      [{ activeTools: ['\x1b[31mmcp__search\x1b[0m\x07\nname'] }, 'mcp__search name…'],
      [
        { responsePreview: '\n\x1b[31m\x1b[0m\n  First public line  \r\nDO NOT SHOW SECOND' },
        'First public line',
      ],
      [{ responsePreview: '\n  \t\n' }, 'thinking…'],
      [{}, 'thinking…'],
    ] as const) {
      agent = snapshot(extra as Partial<AgentWidgetSnapshot>);
      widget.refresh();
      expect(f.render()[2]).toContain(expected);
      expect(f.text()).not.toContain('DO NOT SHOW SECOND');
    }
    expect(f.setWidget).toHaveBeenCalledTimes(1);
    expect(clock!.timers.size).toBe(2);
  });

  test('exact Pi built-in tool names, including native codemode, use short action labels', () => {
    let agent = snapshot();
    const f = host();
    const widget = controller(() => [agent]);
    widget.attach(f.ctx);
    for (const [name, label] of [
      ['read', 'reading'],
      ['write', 'writing'],
      ['edit', 'editing'],
      ['bash', 'running command'],
      ['powershell', 'running command'],
      ['grep', 'searching'],
      ['find', 'finding files'],
      ['ls', 'listing'],
      ['codemode', 'using codemode'],
    ]) {
      agent = snapshot({ activeTools: [name] });
      widget.refresh();
      expect(f.render()[2]).toEndWith(label + '…');
    }
  });

  test('extension tools display their dynamic SDK names without aliases, case folding, or namespace parsing', () => {
    let agent = snapshot();
    const f = host();
    const widget = controller(() => [agent]);
    widget.attach(f.ctx);
    for (const name of [
      'ffgrep',
      'fffind',
      'spawn_agent',
      'wait_agent',
      'send_message',
      'read_agent_response',
      'interrupt_agent',
      'list_agents',
      'my_new_extension_tool',
      'mcp__github__search_issues',
      'mcp__files__read',
      'extension.read',
      'Read',
      'GREP',
      'FFGrep',
      'CodeMode',
      'mcp__custom__codemode',
      'toString',
    ]) {
      agent = snapshot({ activeTools: [name] });
      widget.refresh();
      expect(f.render()[2]).toEndWith(name + '…');
    }
    agent = snapshot({
      activeTools: ['grep', 'ffgrep', 'Read', 'Read', 'codemode', 'mcp__files__read'],
    });
    widget.refresh();
    expect(f.render()[2]).toEndWith('searching, ffgrep, Read, using codemode, mcp__files__read…');
  });

  test('missing metadata is omitted and model IDs are never reverse-parsed', () => {
    let agent = snapshot();
    Object.defineProperty(agent, 'model', {
      get() {
        throw new Error('legacy model field');
      },
    });
    const f = host();
    const widget = controller(() => [agent]);
    widget.attach(f.ctx);
    expect(f.render()[1]).not.toMatch(/unknown|undefined|off|token|NaN/);
    agent = snapshot({ provider: 'proxy', modelId: 'vendor/name:max', thinking: 'low' });
    widget.refresh();
    expect(f.render()[1]).toContain('proxy/vendor/name:max/low');
    agent = snapshot({ provider: 'known-provider' });
    widget.refresh();
    expect(f.render()[1]).toContain('known-provider');
    expect(f.render()[1]).not.toMatch(/unknown|undefined|off|thinking:/);
  });

  test('formats k/M with one decimal and annotates only positive cumulative tokens', () => {
    let agent = snapshot();
    const f = host();
    const widget = controller(() => [agent]);
    widget.attach(f.ctx);
    for (const [tokens, expected] of [
      [1, '1 token'],
      [999, '999 token'],
      [1000, '1.0k token'],
      [33_800, '33.8k token'],
      [1_000_000, '1.0M token'],
      [1_250_000, '1.3M token'],
    ] as const) {
      agent = snapshot({ tokens, elapsedMs: 0 });
      widget.refresh();
      expect(f.render()[1]).toContain(expected);
      expect(f.render()[1]).toContain('0s');
    }
    for (const tokens of [undefined, 0, -1, NaN, Infinity]) {
      agent = snapshot({ tokens, contextUsage: usage(0), compactionCount: 2 });
      widget.refresh();
      expect(f.render()[1]).not.toMatch(/token|%|↓/);
    }
    for (const [percent, compactionCount, expected] of [
      [0, 0, '1.0k token (0%)'],
      [null, 2, '1.0k token (↓2)'],
      [62, 1, '1.0k token (62% · ↓1)'],
      [null, 0, '1.0k token'],
    ] as const) {
      agent = snapshot({ tokens: 1000, contextUsage: usage(percent), compactionCount });
      widget.refresh();
      expect(f.render()[1]).toContain(expected);
      if (percent === null) expect(f.render()[1]).not.toContain('%');
      if (!compactionCount) expect(f.render()[1]).not.toContain('↓');
    }
  });

  test('renders compact compaction markers with single and multi-digit counts in narrow and wide rows', () => {
    let compactionCount = 1;
    const f = host({ theme: nativeTheme('dark') });
    const widget = controller(() => [
      snapshot({
        color: 'blue',
        provider: 'provider',
        modelId: 'long-model/'.repeat(12),
        thinking: 'max',
        tokens: 1000,
        contextUsage: usage(62),
        elapsedMs: 12_345,
        compactionCount,
      }),
    ]);
    widget.attach(f.ctx);
    for (compactionCount of [1, 12, 123]) {
      widget.refresh();
      for (const width of [32, 80, 140]) {
        const lines = f.render(width);
        const line = stripVTControlCharacters(lines[1]);
        expect(line.match(/↓\d+/g)).toEqual([`↓${compactionCount}`]);
        expect(line).not.toMatch(/↓\s/);
        expect(line).toContain('/max');
        expect(line).toContain('12s');
        expectFit(lines, width);
      }
    }
  });

  test('percent colors use unrounded thresholds, including real zero and values over 100', () => {
    const { theme, calls } = trackingTheme();
    let percent = 0;
    const f = host({ theme });
    const widget = controller(() => [snapshot({ tokens: 1000, contextUsage: usage(percent) })]);
    widget.attach(f.ctx);
    for (const [value, color] of [
      [0, 'dim'],
      [69.6, 'dim'],
      [70, 'warning'],
      [84.6, 'warning'],
      [85, 'error'],
      [120, 'error'],
    ] as const) {
      percent = value;
      widget.refresh();
      calls.length = 0;
      f.render();
      expect(calls).toContainEqual({ text: `${Math.round(value)}%`, color });
    }
  });

  test('truncates the model before /thinking or statistics, including compact narrow rows', () => {
    const f = host();
    controller(() => [
      snapshot({
        provider: 'openai-codex',
        modelId: 'very-long-model-name/'.repeat(20),
        thinking: 'max',
        tokens: 1000,
        contextUsage: usage(0),
        compactionCount: 1,
        elapsedMs: 12_345,
      }),
    ]).attach(f.ctx);
    for (const width of [32, 80, 120, 140]) {
      const lines = f.render(width);
      expectFit(lines, width);
      expect(lines[1]).toContain('/max');
      expect(lines[1]).toContain('12s');
      expect(lines[1]).toContain('1.0k');
      expect(lines[1]).toContain('0%');
      expect(lines[1]).toContain('↓1');
      expect(lines[1]).not.toContain('thinking:');
    }
  });

  test('sanitizes ANSI, hyperlinks, C0/C1 and multiline Unicode before theming and fits every line', () => {
    const { theme, calls } = trackingTheme();
    const f = host({ theme });
    controller(() => [
      snapshot({
        canonicalName: '\x1b[31m/工人👩🏽‍💻e\u0301\x1b[0m\n\x07\x9fworker',
        provider: '\x1b]8;;https://example.com\x07代理\x1b]8;;\x07',
        modelId: '模型\t👨‍👩‍👧‍👦'.repeat(12),
        thinking: 'high',
        tokens: 33_800,
        contextUsage: usage(69.6),
        compactionCount: 2,
        elapsedMs: 1234,
        responsePreview:
          '\n\x1b[31m\x1b[0m\n\x1b]8;;https://example.com\x07public 中文 👩🏽‍💻\x1b]8;;\x07\x00\x85SECOND',
      }),
    ]).attach(f.ctx);
    for (const width of [0, 1, 32, 80, 120]) {
      calls.length = 0;
      const lines = f.render(width);
      expectFit(lines, width);
      for (const call of calls) {
        expect(call.text).toBe(stripVTControlCharacters(call.text));
        expect(call.text).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
      }
      if (width >= 80) {
        expect(stripVTControlCharacters(lines[2])).toContain('public 中文 👩🏽‍💻');
        expect(stripVTControlCharacters(lines[2])).not.toContain('SECOND');
      }
    }
    expect(f.render(0)).toEqual([]);
    expect(f.render(1)).toHaveLength(1);
    // Even incomplete fake themes that add visible decorations must not overflow.
    f.ui.theme = { fg: (_color: string, text: string) => `[${text}]` } as Theme;
    (f.tui.terminal as any).rows = 1;
    for (const width of [0, 1, 32, 80, 120]) expectFit(f.render(width), width);
  });

  test('reads the current theme each render without ANSI caching and can fall back to the factory theme', () => {
    const first = trackingTheme(36);
    const second = trackingTheme(34);
    const f = host({ theme: first.theme });
    const getSnapshots = mock(() => [
      snapshot({ provider: 'p', modelId: 'm', thinking: 'high', tokens: 1000 }),
    ]);
    controller(getSnapshots).attach(f.ctx);
    expect(f.render().join('')).toContain('\x1b[36m');
    const samples = getSnapshots.mock.calls.length;
    f.ui.theme = second.theme;
    f.component.invalidate();
    const updated = f.render().join('');
    expect(updated).toContain('\x1b[34m');
    expect(updated).not.toContain('\x1b[36m');
    f.ui.theme = undefined;
    expect(f.render().join('')).toContain('\x1b[36m');
    expect(getSnapshots).toHaveBeenCalledTimes(samples);
    expect(f.setWidget).toHaveBeenCalledTimes(1);
  });
});

describe('session status summary', () => {
  for (const appearance of ['dark', 'light'] as const) {
    test.each(['truecolor', '256color'] as const)(
      `${appearance} heading keeps each original status color in %s`,
      (mode) => {
        const theme = nativeTheme(appearance, mode);
        let agents = [snapshot()];
        let counts = { running: 2, completed: 3, failed: 1, interrupted: 1 };
        const source = mock(() => agents);
        const widget = controller(
          source,
          mock((_error: unknown) => {}),
          () => counts,
        );
        const f = host({ theme });
        widget.attach(f.ctx);
        const checkColors = (current: Theme) => {
          const line = f.render(140)[0];
          const active = counts.running > 0;
          expect(line).toContain(
            current.fg(active ? 'accent' : 'dim', active ? '● Agents' : '○ Agents'),
          );
          for (const [status, color] of [
            ['running', 'warning'],
            ['completed', 'success'],
            ['failed', 'error'],
            ['interrupted', 'warning'],
          ] as const) {
            if (counts[status])
              expect(line).toContain(current.fg(color, `${counts[status]} ${status}`));
          }
          expect(line).toEndWith(current.fg(active ? 'accent' : 'dim', ' · /subagents to view details'));
        };
        checkColors(theme);
        for (const width of [0, 1, 9, 10, 22, 32, 60, 80, 120]) {
          expectFit(f.render(width), width);
          if (width >= 10) expect(f.text(width).split('\n')[0]).toContain('/subagents');
        }
        const samples = source.mock.calls.length;
        const replacement = nativeTheme(appearance === 'dark' ? 'light' : 'dark', mode);
        f.ui.theme = replacement;
        f.component.invalidate();
        checkColors(replacement);
        expect(source).toHaveBeenCalledTimes(samples);
        expect(f.setWidget).toHaveBeenCalledTimes(1);
        agents = [];
        counts = { ...counts, running: 0 };
        widget.refresh();
        checkColors(replacement);
        expect(f.render()).toHaveLength(1);
        expect(clock!.timers.size).toBe(0);
      },
    );
  }

  test('shows all nonzero statuses while only active agents get detail rows', () => {
    let agents = [
      snapshot(),
      snapshot({ canonicalName: '/second' }),
      snapshot({ canonicalName: '/third', status: 'starting' }),
    ];
    let counts = { running: 3, completed: 3, failed: 3, interrupted: 3 };
    const source = mock(() => agents);
    const f = host();
    const widget = controller(
      source,
      mock((_error: unknown) => {}),
      () => counts,
    );
    widget.attach(f.ctx);
    expect(f.render()[0]).toBe(
      '● Agents · 3 running · 3 completed · 3 failed · 3 interrupted · /subagents to view details',
    );
    expect(f.render()).toHaveLength(7);
    const component = f.component;
    const staleTick = [...clock!.timers.values()][0].callback;
    agents = [];
    counts = { running: 0, completed: 6, failed: 3, interrupted: 3 };
    widget.refresh();
    expect(f.render()).toEqual(['○ Agents · 6 completed · 3 failed · 3 interrupted · /subagents to view details']);
    expect(f.component).toBe(component);
    expect(f.setWidget).toHaveBeenCalledTimes(1);
    expect(clock!.timers.size).toBe(0);
    const samples = source.mock.calls.length;
    staleTick();
    clock!.tick();
    expect(source).toHaveBeenCalledTimes(samples);
    counts.completed = 99;
    expect(f.text()).toContain('6 completed'); // The current frame owns a copy, not the caller's object.
    for (const width of [0, 1, 9, 10, 32, 60, 80, 120]) expectFit(f.render(width), width);
    expect(f.render(32)[0]).toContain('/subagents');
  });

  test('mounts historical-only counts without a timer, hides zeros, and resumes active work', () => {
    let agents: AgentWidgetSnapshot[] = [];
    let counts = { running: 0, completed: 2, failed: 0, interrupted: 0 };
    const f = host();
    const widget = controller(
      () => agents,
      mock((_error: unknown) => {}),
      () => counts,
    );
    widget.attach(f.ctx);
    expect(f.render()).toEqual(['○ Agents · 2 completed · /subagents to view details']);
    expect(clock!.set).not.toHaveBeenCalled();
    counts = { running: 0, completed: 0, failed: 0, interrupted: 0 };
    widget.refresh();
    expect(f.render()).toEqual([]);
    expect(clock!.timers.size).toBe(0);
    agents = [snapshot()];
    counts = { running: 1, completed: 0, failed: 0, interrupted: 0 };
    widget.refresh();
    expect(f.render()[0]).toBe('● Agents · 1 running · /subagents to view details');
    expect(f.render()).toHaveLength(3);
    expect(clock!.timers.size).toBe(2);
    expect(f.text()).not.toMatch(/0 completed|0 failed|0 interrupted/);
  });

  test('counts every active agent rather than just the visible overflow rows', () => {
    const f = host();
    controller(
      () => Array.from({ length: 6 }, (_, i) => snapshot({ canonicalName: '/worker' + i })),
      mock((_error: unknown) => {}),
      () => ({ running: 6, completed: 100, failed: 1, interrupted: 1 }),
    ).attach(f.ctx);
    const lines = f.render(140);
    expect(lines[0]).toBe(
      '● Agents · 6 running · 100 completed · 1 failed · 1 interrupted · /subagents to view details',
    );
    expect(lines).toHaveLength(12);
    expect(lines[11]).toContain('+1 more');
  });

  test('failed count sampling is atomic and automatically recovers to an idle heading', () => {
    let agents = [snapshot()];
    let counts = { running: 1, completed: 0, failed: 0, interrupted: 0 };
    let fail = false;
    const errors = mock((_error: unknown) => {});
    const f = host();
    const widget = controller(
      () => agents,
      errors,
      () => {
        if (fail) throw new Error('status source failed');
        return counts;
      },
    );
    widget.attach(f.ctx);
    agents = [];
    counts = { running: 0, completed: 1, failed: 0, interrupted: 0 };
    fail = true;
    widget.refresh();
    clock!.tick();
    expect(f.render()).toHaveLength(3);
    expect(f.text()).toContain('1 running');
    expect(errors).toHaveBeenCalledTimes(1);
    fail = false;
    clock!.tick();
    expect(f.render()).toEqual(['○ Agents · 1 completed · /subagents to view details']);
    expect(clock!.timers.size).toBe(0);
  });

  test('parent changes discard old settled counts even if the new source temporarily fails', () => {
    const f = host();
    let fail = false;
    const widget = controller(
      () => [],
      mock((_error: unknown) => {}),
      () => {
        if (fail) throw new Error('new parent unavailable');
        return { running: 0, completed: 7, failed: 0, interrupted: 0 };
      },
    );
    widget.attach(f.ctx);
    expect(f.text()).toContain('7 completed');
    fail = true;
    const next = host({ parentId: 'next' });
    widget.attach(next.ctx);
    expect(next.render()).toEqual([]);
    expect(f.render()).toEqual([]);
    expect(clock!.timers.size).toBe(1);
    widget.dispose();
    expect(clock!.timers.size).toBe(0);
  });
});

describe('layout budgets', () => {
  test('five agents occupy 11 lines and six reserve an overflow line instead of a four-agent cap', () => {
    let count = 1;
    const f = host();
    const widget = controller(() =>
      Array.from({ length: count }, (_, i) => snapshot({ canonicalName: '/worker' + i })),
    );
    widget.attach(f.ctx);
    for (count = 1; count <= 8; count++) {
      widget.refresh();
      const lines = f.render(120);
      expect(lines).toHaveLength(count <= 5 ? 1 + count * 2 : 12);
      expect(lines[0]).toBe(`● Agents · ${count} running · /subagents to view details`);
      expectFit(lines, 120);
      if (count > 5) {
        expect(lines[11]).toBe(`└─ +${count - 5} more · /subagents`);
        expect(lines[9]).toContain('/worker4');
        expect(lines.join('\n')).not.toContain('/worker5');
      } else {
        expect(lines.at(-2)!).toStartWith('└─');
        expect(lines.at(-1)!).toStartWith('     ⎿');
      }
    }
  });

  test('short terminals preserve the /subagents hint and reserve parent editor space', () => {
    const f = host();
    controller(() =>
      Array.from({ length: 6 }, (_, i) => snapshot({ canonicalName: '/worker' + i })),
    ).attach(f.ctx);
    for (const rows of [0, 1, 4, 10, 11, 12, 13, 16, 20, 24]) {
      (f.tui.terminal as any).rows = rows;
      const lines = f.render(80);
      expect(lines.length).toBeLessThanOrEqual(Math.max(1, Math.min(12, rows - 10)));
      expect(lines[0]).toContain('/subagents');
      expectFit(lines, 80);
    }
    (f.tui.terminal as any).rows = undefined;
    expect(f.render()).toHaveLength(12);
    for (const width of [0, 1, 9, 10, 32, 80, 120]) expectFit(f.render(width), width);
    expect(f.render(10)[0]).toBe('/subagents');
  });
});

describe('native spinner clock', () => {
  test('matches native Loader frames and cadence without sampling on animation ticks or advancing on refresh', () => {
    class NativeProbe extends Loader {
      frame() {
        return this.getRenderedIndicator();
      }
    }
    const f = host();
    const source = mock(() => [snapshot(), snapshot({ canonicalName: '/second' })]);
    const widget = controller(source);
    widget.attach(f.ctx);
    const sample = [...clock!.timers.values()].find((timer) => timer.delay === 200)!;
    const animation = [...clock!.timers.values()].find((timer) => timer.delay === 80)!;
    expect(sample).toBeDefined();
    expect(animation).toBeDefined();
    // Two agents share one native animation timer, not one timer per row.
    expect(clock!.timers.size).toBe(2);
    const previous = new Set(clock!.timers.keys());
    const native = new NativeProbe(
      f.tui,
      (text) => text,
      (text) => text,
      'Working',
    );
    const nativeTimer = [...clock!.timers].find(([key]) => !previous.has(key))![1];
    try {
      expect(animation.delay).toBe(nativeTimer.delay);
      expect(animation.delay).toBe(80);
      const checkFrame = () => {
        const lines = f.render().map(stripVTControlCharacters);
        expect(lines[1]).toStartWith('├─ ' + native.frame() + ' ');
        expect(lines[3]).toStartWith('└─ ' + native.frame() + ' ');
      };
      for (let frame = 0; frame < 25; frame++) {
        checkFrame();
        widget.refresh();
        widget.refresh();
        f.component.invalidate();
        checkFrame(); // Lifecycle refreshes and renders must not speed up the spinner.
        const samples = source.mock.calls.length;
        const redraws = f.requestRender.mock.calls.length;
        animation.callback();
        expect(source).toHaveBeenCalledTimes(samples);
        expect(f.requestRender).toHaveBeenCalledTimes(redraws + 1);
        nativeTimer.callback();
        checkFrame();
        sample.callback();
        checkFrame(); // 200ms SDK sampling is independent of the native animation.
      }
      expect(clock!.set).toHaveBeenCalledTimes(3);
    } finally {
      native.stop();
      widget.dispose();
    }
    expect(clock!.timers.size).toBe(0);
  });

  test('heading-only totals do not animate and stale frames cannot redraw a restarted widget', () => {
    let agents: AgentWidgetSnapshot[] = [];
    let counts = { running: 1, completed: 0, failed: 0, interrupted: 0 };
    const source = mock(() => agents);
    const widget = controller(
      source,
      mock((_error: unknown) => {}),
      () => counts,
    );
    const f = host();
    widget.attach(f.ctx);
    expect([...clock!.timers.values()].map((timer) => timer.delay)).toEqual([200]);
    agents = [snapshot()];
    widget.refresh();
    expect([...clock!.timers.values()].map((timer) => timer.delay)).toEqual([200, 80]);
    const staleFrame = [...clock!.timers.values()].find((timer) => timer.delay === 80)!.callback;
    agents = [];
    counts = { ...counts, running: 0, completed: 1 };
    widget.refresh();
    expect(f.render()).toHaveLength(1);
    expect(clock!.timers.size).toBe(0);
    agents = [snapshot()];
    counts = { ...counts, running: 1 };
    widget.refresh();
    const samples = source.mock.calls.length;
    const redraws = f.requestRender.mock.calls.length;
    staleFrame();
    expect(source).toHaveBeenCalledTimes(samples);
    expect(f.requestRender).toHaveBeenCalledTimes(redraws);
    expect([...clock!.timers.values()].map((timer) => timer.delay)).toEqual([200, 80]);
    widget.dispose();
    expect(clock!.timers.size).toBe(0);
  });

  test('a native animation allocation failure leaves sampling alive and retries without remounting', () => {
    const set = clock!.set.getMockImplementation()!;
    let fail = true;
    clock!.set.mockImplementation(((callback: () => void, delay?: number) => {
      if (delay === 80 && fail) {
        fail = false;
        throw new Error('native animation allocation');
      }
      return set(callback, delay);
    }) as any);
    const errors = mock((_error: unknown) => {});
    const source = mock(() => [snapshot()]);
    const widget = controller(source, errors);
    const f = host();
    expect(() => widget.attach(f.ctx)).not.toThrow();
    expect(f.text()).toContain('/worker');
    expect([...clock!.timers.values()].map((timer) => timer.delay)).toEqual([200]);
    expect(errors).toHaveBeenCalledTimes(1);
    widget.refresh();
    expect([...clock!.timers.values()].map((timer) => timer.delay)).toEqual([200, 80]);
    const samples = source.mock.calls.length;
    clock!.tick(80);
    expect(source).toHaveBeenCalledTimes(samples);
    expect(f.setWidget).toHaveBeenCalledTimes(1);
    widget.dispose();
    expect(clock!.timers.size).toBe(0);
  });
});

describe('widget and timer lifecycle', () => {
  test('caches snapshots outside render and reuses one factory, one sampler and one native animator across fresh same-parent contexts', () => {
    const order: string[] = [];
    let thinking: 'max' | 'high' = 'max';
    const getSnapshots = mock(() => {
      order.push('snapshot');
      return [snapshot({ provider: 'openai-codex', modelId: 'gpt-6.1-sol', thinking })];
    });
    const f = host();
    f.requestRender.mockImplementation(() => {
      order.push('render');
    });
    const widget = controller(getSnapshots);
    widget.attach(f.ctx);
    const component = f.component;
    const samples = getSnapshots.mock.calls.length;
    for (let i = 0; i < 4; i++) {
      component.invalidate();
      component.render(80);
    }
    expect(getSnapshots).toHaveBeenCalledTimes(samples);
    const setWidget = mock((...args: Parameters<typeof f.setWidget>) => f.setWidget(...args));
    widget.attach({ ...f.ctx, ui: { ...f.ui, setWidget } } as unknown as ExtensionContext);
    widget.refresh();
    expect(setWidget).not.toHaveBeenCalled();
    expect(f.component).toBe(component);
    expect(f.setWidget).toHaveBeenCalledTimes(1);
    expect(clock!.set).toHaveBeenCalledTimes(2);
    expect([...clock!.timers.values()].map((timer) => timer.delay)).toEqual([200, 80]);
    thinking = 'high';
    order.length = 0;
    clock!.tick();
    expect(order).toEqual(['snapshot', 'render']);
    expect(f.text()).toContain('openai-codex/gpt-6.1-sol/high');
    expect(f.setWidget).toHaveBeenCalledTimes(1);
  });

  test('empty state stops and clears immediately, rejects stale ticks, and can show a new run', () => {
    let agents: readonly AgentWidgetSnapshot[] = [snapshot()];
    const getSnapshots = mock(() => agents);
    const f = host();
    const widget = controller(getSnapshots);
    widget.attach(f.ctx);
    const previous = f.component;
    const staleTick = [...clock!.timers.values()][0].callback;
    agents = [];
    clock!.tick();
    expect(clock!.timers.size).toBe(0);
    expect(f.setWidget).toHaveBeenCalledTimes(2);
    expect(f.setWidget.mock.calls[1][1]).toBeUndefined();
    expect(previous.render(80)).toEqual([]);
    const samples = getSnapshots.mock.calls.length;
    agents = [snapshot({ responsePreview: 'new run' })];
    staleTick();
    expect(getSnapshots).toHaveBeenCalledTimes(samples);
    widget.refresh();
    expect(clock!.timers.size).toBe(2);
    expect(f.component).not.toBe(previous);
    expect(f.text()).toContain('new run');
    expect(f.setWidget).toHaveBeenCalledTimes(3);
  });

  test('actual SDK clear synchronously disposes without recursively clearing and permits later remount', () => {
    const f = host();
    const native = {
      extensionWidgetsAbove: new Map<string, Widget>(),
      extensionWidgetsBelow: new Map<string, Widget>(),
      ui: f.tui,
      renderWidgets: mock(() => {}),
    };
    const set = (InteractiveMode.prototype as any).setExtensionWidget;
    const clear = (InteractiveMode.prototype as any).clearExtensionWidgets;
    const setWidget = mock((key: string, content: Content, options?: object) =>
      set.call(native, key, content, options),
    );
    f.ui.setWidget = setWidget as any;
    const widget = controller(() => [snapshot()]);
    widget.attach(f.ctx);
    const previous = native.extensionWidgetsAbove.get('pi-subagents')!;
    clear.call(native);
    expect(clock!.timers.size).toBe(0);
    expect(native.extensionWidgetsAbove.size).toBe(0);
    expect(setWidget).toHaveBeenCalledTimes(1);
    expect(previous.render(80)).toEqual([]);
    widget.refresh();
    const current = native.extensionWidgetsAbove.get('pi-subagents')!;
    expect(current).not.toBe(previous);
    expect(clock!.timers.size).toBe(2);
    previous.dispose?.();
    expect(clock!.timers.size).toBe(2);
    widget.dispose();
    widget.dispose();
    expect(setWidget).toHaveBeenCalledTimes(3); // mount, remount, controller clear
    expect(native.extensionWidgetsAbove.size).toBe(0);
    expect(clock!.timers.size).toBe(0);
  });

  test('controller disposal releases timer and references before SDK clear, is idempotent, and never remounts', () => {
    const f = host();
    const widget = controller(() => [snapshot()]);
    widget.attach(f.ctx);
    const previous = f.component;
    const original = f.ui.setWidget;
    f.ui.setWidget = mock((key, content, options) => {
      if (content === undefined) {
        expect(clock!.timers.size).toBe(0);
        expect(previous.render(80)).toEqual([]);
      }
      original(key, content, options);
    });
    widget.attach(f.ctx);
    widget.dispose();
    widget.dispose();
    widget.refresh();
    widget.attach(f.ctx);
    expect(f.ui.setWidget).toHaveBeenCalledTimes(1);
    expect(f.setWidget).toHaveBeenCalledTimes(2);
    expect(clock!.timers.size).toBe(0);
  });

  test('parent changes clear the previous host and old components cannot stop a new timer', () => {
    const first = host({ parentId: 'one' });
    const second = host({ parentId: 'two' });
    const widget = controller(() => [snapshot()]);
    widget.attach(first.ctx);
    const previous = first.component;
    const staleTick = [...clock!.timers.values()][0].callback;
    widget.attach(second.ctx);
    expect(first.setWidget).toHaveBeenCalledTimes(2);
    expect(second.setWidget).toHaveBeenCalledTimes(1);
    expect(clock!.timers.size).toBe(2);
    previous.dispose?.();
    staleTick();
    expect(clock!.timers.size).toBe(2);
    expect(second.setWidget).toHaveBeenCalledTimes(1);
  });

  test('missing fake-host theme/requestRender and a host which only records the factory are supported', () => {
    const f = host({ theme: trackingTheme().theme });
    f.ui.theme = undefined;
    (f.tui as any).requestRender = undefined;
    const errors = mock((_error: unknown) => {});
    const widget = controller(() => [snapshot()], errors);
    widget.attach(f.ctx);
    clock!.tick();
    expect(f.render().join('')).toContain('\x1b[36m');
    expect(errors).not.toHaveBeenCalled();
    widget.dispose();
    const recording = host();
    recording.ui.setWidget = mock(() => {});
    const other = controller(() => [snapshot()], errors);
    other.attach(recording.ctx);
    clock!.tick();
    expect(errors).not.toHaveBeenCalled();
    expect(clock!.timers.size).toBe(1);
    other.dispose();
    expect(clock!.timers.size).toBe(0);
  });

  test('a late stale factory is inert after clear and does not replace a current component', () => {
    let agents: readonly AgentWidgetSnapshot[] = [snapshot()];
    const f = host();
    const factories: Factory[] = [];
    f.ui.setWidget = mock((_key, content) => {
      if (typeof content === 'function') factories.push(content);
    });
    const widget = controller(() => agents);
    widget.attach(f.ctx);
    agents = [];
    widget.refresh();
    const old = factories[0](f.tui, f.factoryTheme);
    expect(old.render(80)).toEqual([]);
    expect(clock!.timers.size).toBe(0);
    agents = [snapshot()];
    widget.refresh();
    const current = factories[1](f.tui, f.factoryTheme);
    factories[0](f.tui, f.factoryTheme).dispose?.();
    expect(current.render(80)).toHaveLength(3);
    expect(clock!.timers.size).toBe(2);
  });

  test('real 200ms ticks update model thinking by 450ms without remounting', async () => {
    clock!.restore();
    clock = undefined;
    let thinking: 'max' | 'high' = 'max';
    const f = host();
    const widget = controller(() => [
      snapshot({
        provider: 'openai-codex',
        modelId: 'gpt-6.1-sol',
        thinking,
        tokens: 33_800,
        contextUsage: usage(62),
        compactionCount: 1,
        elapsedMs: 12_345,
      }),
    ]);
    widget.attach(f.ctx);
    expect(f.text()).toContain('openai-codex/gpt-6.1-sol/max');
    thinking = 'high';
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(f.text()).toContain('openai-codex/gpt-6.1-sol/high');
    expect(f.text()).toContain('33.8k token (62% · ↓1) · 12s');
    expect(f.setWidget).toHaveBeenCalledTimes(1);
    expect(f.requestRender.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe('mode guards', () => {
  for (const mode of ['rpc', 'json', 'print'] as const) {
    test(`${mode} never samples, mounts or creates a timer even when hasUI is true`, () => {
      const f = host({ mode });
      const getSnapshots = mock(() => [snapshot()]);
      const widget = controller(getSnapshots);
      widget.attach(f.ctx);
      widget.refresh();
      widget.dispose();
      expect(getSnapshots).not.toHaveBeenCalled();
      expect(f.setWidget).not.toHaveBeenCalled();
      expect(clock!.set).not.toHaveBeenCalled();
    });
  }

  test('TUI uses mode rather than hasUI, and switching to any other mode releases the old UI only', () => {
    for (const mode of ['rpc', 'json', 'print'] as const) {
      const f = host();
      f.ctx.hasUI = false;
      const next = host({ mode });
      const widget = controller(() => [snapshot()]);
      widget.attach(f.ctx);
      expect(clock!.timers.size).toBe(2);
      widget.attach(next.ctx);
      expect(f.setWidget).toHaveBeenCalledTimes(2);
      expect(next.setWidget).not.toHaveBeenCalled();
      expect(clock!.timers.size).toBe(0);
      widget.attach(f.ctx);
      expect(clock!.timers.size).toBe(2);
      widget.dispose();
    }
  });

  test('a mode change on an existing context also stops its timer', () => {
    const f = host();
    controller(() => [snapshot()]).attach(f.ctx);
    f.ctx.mode = 'rpc';
    clock!.tick();
    expect(clock!.timers.size).toBe(0);
    expect(f.render()).toEqual([]);
  });
});

describe('exception isolation and recovery', () => {
  test('a first-sample failure automatically recovers on the same retry timer without external events', () => {
    let attempts = 0;
    let agents: readonly AgentWidgetSnapshot[] = [
      snapshot({ responsePreview: 'automatic recovery' }),
    ];
    const getSnapshots = mock(() => {
      if (++attempts === 1) throw new Error('first sample failed');
      return agents;
    });
    const errors = mock((_error: unknown) => {});
    const f = host();
    const widget = controller(getSnapshots, errors);
    widget.attach(f.ctx);
    expect(f.setWidget).not.toHaveBeenCalled();
    expect(clock!.timers.size).toBe(1);
    expect([...clock!.timers.values()][0].delay).toBe(200);
    const retryTick = [...clock!.timers.values()][0].callback;
    clock!.tick(); // No attach(), refresh(), activity event or previous snapshot is needed.
    expect(f.text()).toContain('automatic recovery');
    expect(clock!.set).toHaveBeenCalledTimes(2);
    expect(f.setWidget).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(1);
    agents = [];
    clock!.tick();
    expect(clock!.timers.size).toBe(0);
    expect(f.setWidget).toHaveBeenCalledTimes(2);
    const samples = getSnapshots.mock.calls.length;
    agents = [snapshot()];
    retryTick();
    expect(getSnapshots).toHaveBeenCalledTimes(samples);
    expect(clock!.timers.size).toBe(0);
    expect(f.setWidget).toHaveBeenCalledTimes(2);
  });

  test('successful empty sampling stops an unmounted retry timer and resets the sampling fault cycle', () => {
    let fail = true;
    const errors = mock((_error: unknown) => {});
    const getSnapshots = mock(() => {
      if (fail) throw new Error('source failed');
      return [];
    });
    const f = host();
    const widget = controller(getSnapshots, errors);
    widget.attach(f.ctx);
    for (let i = 0; i < 5; i++) clock!.tick();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(clock!.set).toHaveBeenCalledTimes(1);
    expect(f.setWidget).not.toHaveBeenCalled();
    fail = false;
    const staleTick = [...clock!.timers.values()][0].callback;
    clock!.tick();
    expect(clock!.timers.size).toBe(0);
    expect(f.setWidget).not.toHaveBeenCalled();
    fail = true;
    const samples = getSnapshots.mock.calls.length;
    staleTick();
    expect(getSnapshots).toHaveBeenCalledTimes(samples);
    widget.refresh(); // A new failure after a successful empty result is a new fault cycle.
    expect(errors).toHaveBeenCalledTimes(2);
    expect(clock!.timers.size).toBe(1);
    const currentTick = [...clock!.timers.values()][0].callback;
    const beforeDispose = getSnapshots.mock.calls.length;
    widget.dispose();
    expect(clock!.timers.size).toBe(0);
    staleTick();
    currentTick();
    expect(getSnapshots).toHaveBeenCalledTimes(beforeDispose);
    expect(clock!.timers.size).toBe(0);
  });

  test('unmounted retry timers stop in every non-TUI mode and stale retry callbacks cannot revive them', () => {
    for (const mode of ['rpc', 'json', 'print'] as const) {
      for (const change of ['attach', 'mutate'] as const) {
        const getSnapshots = mock((): readonly AgentWidgetSnapshot[] => {
          throw new Error('offline source');
        });
        const f = host();
        const next = host({ mode });
        const widget = controller(getSnapshots);
        widget.attach(f.ctx);
        const staleTick = [...clock!.timers.values()][0].callback;
        expect(clock!.timers.size).toBe(1);
        if (change === 'attach') widget.attach(next.ctx);
        else {
          f.ctx.mode = mode;
          clock!.tick();
        }
        expect(clock!.timers.size).toBe(0);
        const samples = getSnapshots.mock.calls.length;
        getSnapshots.mockImplementation(() => [snapshot()]);
        staleTick();
        widget.refresh();
        expect(getSnapshots).toHaveBeenCalledTimes(samples);
        expect(f.setWidget).not.toHaveBeenCalled();
        expect(next.setWidget).not.toHaveBeenCalled();
        widget.dispose();
      }
    }
  });

  test('sampling failures report once per fault cycle, including synchronous refresh reentry and throwing diagnostics', () => {
    let fail = true;
    const f = host();
    let widget: AgentSummaryWidget;
    const getSnapshots = mock(() => {
      if (fail) throw new Error('sample failed');
      return [snapshot()];
    });
    const errors = mock((_error: unknown) => {
      // Bound an unfixed regression rather than letting it recurse to stack exhaustion.
      if (errors.mock.calls.length < 5) widget.refresh();
      throw new Error('diagnostic failed');
    });
    widget = controller(getSnapshots, errors);
    expect(() => widget.attach(f.ctx)).not.toThrow();
    for (let i = 0; i < 5; i++) expect(() => clock!.tick()).not.toThrow();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(clock!.set).toHaveBeenCalledTimes(1);
    expect(f.setWidget).not.toHaveBeenCalled();
    fail = false;
    clock!.tick();
    expect(f.render()).toHaveLength(3);
    fail = true;
    for (let i = 0; i < 5; i++) clock!.tick();
    expect(errors).toHaveBeenCalledTimes(2);
    expect(f.setWidget).toHaveBeenCalledTimes(1); // Source failure must not clear the good frame.
    expect(f.render()).toHaveLength(3);
    clock!.tick();
    expect(errors).toHaveBeenCalledTimes(2); // A successful cached render cannot reset sampling failure.
  });

  test('render failures report once before synchronous notify/redraw reentry and rearm only after healthy rendering', () => {
    const f = host();
    const errors = mock((_error: unknown) => {
      if (errors.mock.calls.length < 5) f.component.render(80);
      throw new Error('diagnostic failed');
    });
    controller(() => [snapshot()], errors).attach(f.ctx);
    f.ui.theme = {
      fg() {
        throw new Error('bad theme');
      },
    } as unknown as Theme;
    expect(() => f.render()).not.toThrow();
    for (let i = 0; i < 5; i++) {
      clock!.tick(); // Successful sampling must not reset the rendering fault cycle.
      f.component.invalidate();
      expect(f.render(80)).toEqual(['/subagents']);
    }
    expect(errors).toHaveBeenCalledTimes(1);
    f.ui.theme = plainTheme;
    expect(f.render()).toHaveLength(3);
    f.ui.theme = {
      fg() {
        throw new Error('bad theme again');
      },
    } as unknown as Theme;
    for (let i = 0; i < 5; i++) expect(f.render(80)).toEqual(['/subagents']);
    expect(errors).toHaveBeenCalledTimes(2);
    expect(f.setWidget).toHaveBeenCalledTimes(1);
  });

  test('a retry is not armed after diagnostics synchronously dispose the controller or switch mode', () => {
    for (const action of ['dispose', 'mode'] as const) {
      const f = host();
      let widget: AgentSummaryWidget;
      const errors = mock((_error: unknown) => {
        if (action === 'dispose') widget.dispose();
        else f.ctx.mode = 'rpc';
        throw new Error('diagnostic failed');
      });
      widget = controller(() => {
        throw new Error('first source failure');
      }, errors);
      expect(() => widget.attach(f.ctx)).not.toThrow();
      expect(clock!.timers.size).toBe(0);
      expect(f.setWidget).not.toHaveBeenCalled();
      widget.dispose();
    }
  });

  test('snapshot failures retain the last frame and retry; failures after empty state do not poison later runs', () => {
    let fail = false;
    let agents: readonly AgentWidgetSnapshot[] = [snapshot({ responsePreview: 'last good frame' })];
    const errors = mock((_error: unknown) => {});
    const getSnapshots = mock(() => {
      if (fail) throw new Error('stats unavailable');
      return agents;
    });
    const widget = controller(getSnapshots, errors);
    const f = host();
    widget.attach(f.ctx);
    fail = true;
    expect(() => clock!.tick()).not.toThrow();
    expect(f.text()).toContain('last good frame');
    expect(clock!.timers.size).toBe(2);
    fail = false;
    agents = [];
    clock!.tick();
    fail = true;
    expect(() => widget.refresh()).not.toThrow();
    expect(clock!.timers.size).toBe(1); // Unknown source state must keep retrying after empty.
    fail = false;
    agents = [snapshot({ responsePreview: 'recovered' })];
    clock!.tick();
    expect(f.text()).toContain('recovered');
    expect(errors).toHaveBeenCalledTimes(2);
  });

  test('bad theme and snapshot getters fall back to one safe line and recover without re-registering', () => {
    let agent = snapshot();
    const errors = mock((_error: unknown) => {});
    const f = host();
    const widget = controller(() => [agent], errors);
    widget.attach(f.ctx);
    f.ui.theme = {
      fg() {
        throw new Error('theme failure');
      },
    } as unknown as Theme;
    expect(f.render(32)).toEqual(['/subagents']);
    f.component.invalidate();
    f.ui.theme = plainTheme;
    expect(f.render(32)).toHaveLength(3);
    agent = snapshot();
    Object.defineProperty(agent, 'tokens', {
      get() {
        throw new Error('stats getter');
      },
    });
    widget.refresh();
    expect(f.render(80)).toEqual(['/subagents']);
    agent = snapshot({ tokens: 1000 });
    clock!.tick();
    expect(f.text()).toContain('1.0k token');
    expect(f.setWidget).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(2);
  });

  test('attach and mounting exceptions never escape, including a throwing error reporter, and mounting can retry', () => {
    const failure = new Error('attach failure');
    const errors = mock((_error: unknown) => {
      throw new Error('reporter failure');
    });
    const widget = controller(() => [snapshot()], errors);
    const bad = host();
    bad.ctx.sessionManager.getSessionId = () => {
      throw failure;
    };
    expect(() => widget.attach(bad.ctx)).not.toThrow();
    expect(clock!.timers.size).toBe(0);
    const f = host();
    const setWidget = f.ui.setWidget;
    f.ui.setWidget = mock(() => {
      throw new Error('mount failure');
    });
    expect(() => widget.attach(f.ctx)).not.toThrow();
    expect(clock!.timers.size).toBe(0);
    f.ui.setWidget = setWidget;
    widget.refresh();
    expect(f.render()).toHaveLength(3);
    expect(clock!.timers.size).toBe(2);
    expect(errors.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test('render and timer diagnostics can throw without escaping into SDK callbacks', () => {
    let fail = false;
    const errors = mock((_error: unknown) => {
      throw new Error('reporter failure');
    });
    const widget = controller(() => {
      if (fail) throw new Error('snapshot failure');
      return [snapshot()];
    }, errors);
    const f = host();
    widget.attach(f.ctx);
    f.requestRender.mockImplementation(() => {
      throw new Error('requestRender failure');
    });
    fail = true;
    expect(() => clock!.tick()).not.toThrow();
    f.ui.theme = {
      fg() {
        throw new Error('render failure');
      },
    } as unknown as Theme;
    expect(() => f.component.invalidate()).not.toThrow();
    expect(() => f.render(1)).not.toThrow();
    expectFit(f.render(1), 1);
    f.requestRender.mockImplementation(() => {});
    f.ui.theme = plainTheme;
    fail = false;
    clock!.tick();
    expect(f.render()).toHaveLength(3);
  });

  test('a throwing clear still frees resources first and cannot prevent the caller manager shutdown', () => {
    const f = host();
    const errors = mock((_error: unknown) => {
      throw new Error('reporter failure');
    });
    const widget = controller(() => [snapshot()], errors);
    widget.attach(f.ctx);
    const component = f.component;
    f.ui.setWidget = mock(() => {
      expect(clock!.timers.size).toBe(0);
      expect(component.render(80)).toEqual([]);
      throw new Error('SDK clear failure');
    });
    const shutdown = mock(() => {});
    expect(() => {
      widget.dispose();
      shutdown();
    }).not.toThrow();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(clock!.timers.size).toBe(0);
    widget.dispose();
    expect(f.ui.setWidget).toHaveBeenCalledTimes(1);
  });

  test('empty-state clear failures can recover and render/invalidate never call setWidget', () => {
    let agents: readonly AgentWidgetSnapshot[] = [snapshot()];
    const f = host();
    const errors = mock((_error: unknown) => {});
    const widget = controller(() => agents, errors);
    widget.attach(f.ctx);
    const setWidget = f.ui.setWidget;
    f.ui.setWidget = mock(() => {
      throw new Error('clear failure');
    });
    f.component.invalidate();
    f.render();
    expect(f.ui.setWidget).not.toHaveBeenCalled();
    agents = [];
    expect(() => clock!.tick()).not.toThrow();
    expect(clock!.timers.size).toBe(0);
    f.ui.setWidget = setWidget;
    agents = [snapshot({ responsePreview: 'new work' })];
    widget.refresh();
    expect(f.text()).toContain('new work');
    expect(clock!.timers.size).toBe(2);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  test('timer cleanup failures disable stale callbacks and cannot escape component or controller disposal', () => {
    const f = host();
    const getSnapshots = mock(() => [snapshot()]);
    const errors = mock((_error: unknown) => {
      throw new Error('reporter failure');
    });
    const widget = controller(getSnapshots, errors);
    widget.attach(f.ctx);
    const staleTicks = [...clock!.timers.values()].map((timer) => timer.callback);
    clock!.clear.mockImplementation(() => {
      throw new Error('timer clear failure');
    });
    expect(() => f.component.dispose?.()).not.toThrow();
    const samples = getSnapshots.mock.calls.length;
    const renders = f.requestRender.mock.calls.length;
    for (const tick of staleTicks) tick();
    expect(f.requestRender).toHaveBeenCalledTimes(renders);
    expect(getSnapshots).toHaveBeenCalledTimes(samples);
    expect(() => widget.dispose()).not.toThrow();
    expect(errors).toHaveBeenCalledTimes(2);
  });

  test('an SDK wrapper with a throwing component disposer cannot prevent controller cleanup or caller shutdown', () => {
    const f = host();
    const errors = mock((_error: unknown) => {
      throw new Error('reporter failure');
    });
    const widget = controller(() => [snapshot()], errors);
    widget.attach(f.ctx);
    f.component.dispose = () => {
      throw new Error('host dispose wrapper');
    };
    const shutdown = mock(() => {});
    expect(() => {
      widget.dispose();
      shutdown();
    }).not.toThrow();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(clock!.timers.size).toBe(0);
    expect(f.render()).toEqual([]);
    expect(errors).toHaveBeenCalledTimes(2);
  });

  test('a failed timer allocation can retry on a later refresh', () => {
    const set = clock!.set.getMockImplementation()!;
    clock!.set.mockImplementationOnce(() => {
      throw new Error('timer allocation');
    });
    const f = host();
    const errors = mock((_error: unknown) => {});
    const widget = controller(() => [snapshot()], errors);
    expect(() => widget.attach(f.ctx)).not.toThrow();
    expect(clock!.timers.size).toBe(0);
    clock!.set.mockImplementation(set);
    widget.refresh();
    expect(clock!.timers.size).toBe(2);
    expect(f.setWidget).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(1);
  });
});
