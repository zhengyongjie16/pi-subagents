import { describe, expect, test } from 'bun:test';
import type { Theme } from '@earendil-works/pi-coding-agent';
import {
  backgroundAnsi,
  colorToRgb,
  foregroundAnsi,
  indexedColor,
  parseColor,
  rgbColor,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import {
  agentStatusColor,
  paintAgentLine,
  renderAgentBadge,
  resolveAgentColor,
} from '../src/color.js';
import { nativeTheme } from './fixtures/ui-theme.js';

const palette = {
  red: '#DC2626',
  blue: '#6A9BCC',
  green: '#16A34A',
  yellow: '#CA8A04',
  purple: '#827DBD',
  orange: '#D97757',
  pink: '#C46686',
  cyan: '#0891B2',
  amber: '#F59E0B',
  teal: '#008080',
  indigo: '#6366F1',
  gold: '#EAB308',
  'neon-green': '#10B981',
  'neon-cyan': '#06B6D4',
  'metallic-blue': '#3B82F6',
  violet: '#8B5CF6',
  rose: '#F43F5E',
  lime: '#84CC16',
  gray: '#6B7280',
  grey: '#6B7280',
  fuchsia: '#D946EF',
  slate: '#64748B',
  navy: '#1E3A8A',
};
const invalid: unknown[] = [
  undefined,
  null,
  '',
  ' ',
  'auto',
  'accent',
  'toString',
  '__proto__',
  '#123',
  '#12345g',
  '#12345678',
  'rgb(1,2,3)',
  '\x1b[31mred',
  0,
  true,
  {},
  ['red'],
  Symbol('red'),
  {
    toString() {
      throw new Error('must not coerce configuration');
    },
  },
  Object.create(null),
];

function ansiRgb(text: string, layer: '38' | '48') {
  const match = new RegExp(`\\x1b\\[${layer};(2;([0-9]+);([0-9]+);([0-9]+)|5;([0-9]+))m`).exec(
    text,
  )!;
  expect(match).not.toBeNull();
  return colorToRgb(
    match[5] !== undefined
      ? indexedColor(Number(match[5]))
      : rgbColor(Number(match[2]), Number(match[3]), Number(match[4])),
  );
}

function luminance({ r, g, b }: { r: number; g: number; b: number }) {
  const channels = [r, g, b].map((value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

test('lifecycle status colors retain the original browser mapping', () => {
  for (const [status, color] of [
    ['starting', 'warning'],
    ['running', 'warning'],
    ['completed', 'success'],
    ['failed', 'error'],
    ['interrupted', 'warning'],
    [undefined, 'warning'],
  ] as const)
    expect(agentStatusColor(status)).toBe(color);
});

describe('configured agent colors', () => {
  test.each(Object.entries(palette))('normalizes %s and its explicit hex', (name, hex) => {
    expect(resolveAgentColor(name)).toBe(hex);
    expect(resolveAgentColor('  ' + name.toUpperCase() + '  ')).toBe(hex);
    expect(resolveAgentColor('  ' + hex.toLowerCase() + '  ')).toBe(hex);
  });

  test('invalid/missing values never throw or allocate an automatic color', () => {
    const theme = nativeTheme('dark');
    for (const value of invalid) {
      expect(resolveAgentColor(value)).toBeUndefined();
      const label = renderAgentBadge('/worker', theme, value as any, 'text');
      expect(label).toBe(theme.fg('text', '/worker'));
      expect(label).not.toMatch(/\x1b\[(?:48;|7m)/);
    }
    expect(renderAgentBadge('/worker', undefined, undefined)).toBe('/worker');
  });

  for (const appearance of ['dark', 'light'] as const) {
    test.each(['truecolor', '256color'] as const)(
      `${appearance} badges use explicit RGB and readable text in %s`,
      (mode) => {
        const theme = nativeTheme(appearance, mode);
        for (const color of [
          ...Object.keys(palette),
          '#000000',
          '#FFFFFF',
          '#007777',
          '#0077aa',
          '#0077cc',
        ]) {
          const badge = renderAgentBadge('/中文😀é', theme, color);
          expect(stripVTControlCharacters(badge)).toBe(' /中文😀é ');
          expect(visibleWidth(badge)).toBe(visibleWidth('/中文😀é') + 2);
          expect(badge).toContain(backgroundAnsi(parseColor(resolveAgentColor(color)!), mode));
          expect(badge).toEndWith('\x1b[49m\x1b[39m');
          expect(badge).not.toContain('\x1b[7m');
          const foreground = ansiRgb(badge, '38'),
            background = ansiRgb(badge, '48');
          expect([0, 255]).toContain(foreground.r);
          expect(foreground.r).toBe(foreground.g);
          expect(foreground.g).toBe(foreground.b);
          const a = luminance(foreground),
            b = luminance(background);
          expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
          if (mode === '256color') expect(badge).not.toMatch(/\x1b\[(?:38|48);2;/);
        }
      },
    );
  }

  test.each(['#007777', '#0077aa', '#0077cc'])(
    'contrast follows native 256-color quantization for %s',
    (color) => {
      const raw = renderAgentBadge('worker', nativeTheme('dark'), color);
      const quantized = renderAgentBadge('worker', nativeTheme('light', '256color'), color);
      expect(ansiRgb(raw, '38')).toEqual({ r: 255, g: 255, b: 255 });
      expect(ansiRgb(quantized, '38')).toEqual({ r: 0, g: 0, b: 0 });
    },
  );

  test('badge sanitizes controls and native truncation resets before styling', () => {
    const name = truncateToWidth('/中文review'.repeat(5), 12, '…');
    const badge = renderAgentBadge(
      '\x1b]8;;https://example.com\x07' + name + '\x1b]8;;\x07\n',
      nativeTheme('dark'),
      'blue',
    );
    expect(badge).not.toContain('\x1b[0m');
    expect(badge).not.toContain('https://');
    expect(stripVTControlCharacters(badge)).toMatch(/^ .*…  $/);
    expect(stripVTControlCharacters(badge)).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });

  for (const appearance of ['dark', 'light'] as const) {
    test.each(['truecolor', '256color'] as const)(
      `${appearance} selection alone paints rows in %s and restores nested resets`,
      (mode) => {
        const theme = nativeTheme(appearance, mode);
        const open = backgroundAnsi(theme.colors.selectedBg, mode);
        for (const color of ['red', undefined, 'invalid']) {
          const badge = renderAgentBadge('/worker', theme, color);
          for (const width of [0, 1, 2, 10, 32, 80]) {
            const text = badge + theme.fg('dim', ' 中文😀é'.repeat(30));
            const selected = paintAgentLine(text, width, theme, true);
            expect(visibleWidth(selected)).toBe(width);
            if (width === 0) {
              expect(selected).toBe('');
              continue;
            }
            expect(selected).toStartWith(open);
            expect(selected).toEndWith('\x1b[49m');
            for (const reset of selected.matchAll(/\x1b\[(?:0|49)m/g)) {
              const end = reset.index! + reset[0].length;
              if (end < selected.length) expect(selected.slice(end)).toStartWith(open);
            }
            const ordinary = paintAgentLine(text, width, theme);
            expect(visibleWidth(ordinary)).toBeLessThanOrEqual(width);
            expect(ordinary).not.toStartWith(open);
            if (!resolveAgentColor(color)) expect(ordinary).not.toMatch(/\x1b\[48;/);
          }
        }
      },
    );
  }

  test('plain hosts can render configured badges without theme identity colors', () => {
    const theme = { fg: (_: string, text: string) => text } as Theme;
    expect(renderAgentBadge('/worker', theme, 'red')).toBe(
      renderAgentBadge('/worker', undefined, 'red'),
    );
    expect(paintAgentLine('short', 80, theme, true)).toBe('short');
    expect(paintAgentLine('longer', 3, undefined)).toBe(truncateToWidth('longer', 3, '…'));
    expect(renderAgentBadge('/worker', nativeTheme('dark'), 'red')).toBe(
      renderAgentBadge('/worker', nativeTheme('light'), 'red'),
    );
    expect(renderAgentBadge('/worker', nativeTheme('dark'), '#000000')).toContain(
      foregroundAnsi(parseColor('#FFFFFF'), 'truecolor'),
    );
  });
});
