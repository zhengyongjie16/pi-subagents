import type { Theme } from '@earendil-works/pi-coding-agent';
import {
  backgroundAnsi,
  colorToRgb,
  indexedColor,
  parseColor,
  styleText,
  truncateToWidth,
} from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';

// Claude Code's named colors, followed by the reference's Agency Agents aliases.
const NAMED_AGENT_COLORS: Readonly<Record<string, string>> = {
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
const BLACK = parseColor('#000000');
const WHITE = parseColor('#FFFFFF');

/** Shared by the browser, completion messages and summary status counts. */
export function agentStatusColor(status: string | undefined): 'success' | 'error' | 'warning' {
  return status === 'completed' ? 'success' : status === 'failed' ? 'error' : 'warning';
}

/** Invalid configuration (including malformed old metadata) is always plain text. */
export function resolveAgentColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  const resolved = NAMED_AGENT_COLORS[normalized] ?? normalized;
  return /^#[0-9a-f]{6}$/i.test(resolved) ? resolved.toUpperCase() : undefined;
}

// Strip terminal escapes before controls: deleting ESC first exposes escape payloads.
export function sanitizeAgentText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Callers reserve two columns for badge padding before clipping the plain name. */
export function renderAgentBadge(
  name: string,
  theme: Theme | undefined,
  color: string | undefined,
  fallback: 'accent' | 'text' = 'accent',
): string {
  // Native truncation can append a full reset; never allow it inside the badge.
  // Preserve caller-supplied column padding, unlike ordinary untrusted text.
  const text = stripVTControlCharacters(name).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  const resolved = resolveAgentColor(color);
  if (!resolved) return theme ? theme.fg(fallback, text) : text;
  const mode = theme?.getColorMode?.() ?? 'truecolor';
  const rgb = parseColor(resolved);
  // Pi's quantizer is not exported. Decode its emitted index rather than duplicating
  // a color engine: contrast must use the background the terminal actually displays.
  const index = /\x1b\[48;5;(\d+)m/.exec(backgroundAnsi(rgb, mode));
  const bg = index ? indexedColor(Number(index[1])) : rgb;
  const { r, g, b } = colorToRgb(bg);
  const linear = [r, g, b].map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  return styleText(` ${text} `, { fg: luminance > 0.179 ? BLACK : WHITE, bg }, mode);
}

/** Only UI selection paints a whole row; identity color belongs to the name badge. */
export function paintAgentLine(
  line: string,
  width: number,
  theme: Theme | undefined,
  selected = false,
): string {
  if (width <= 0) return '';
  const hasSelection = selected && Boolean(theme?.style && theme.colors);
  const fitted = truncateToWidth(line, width, '…', hasSelection);
  if (!hasSelection) return fitted;
  const bg = theme!.colors.selectedBg;
  const open = backgroundAnsi(bg, theme!.getColorMode());
  // Badge closure and native truncation resets must restore the enclosing selection,
  // not the badge foreground/background. Always close the row before the editor.
  return theme!.style(
    fitted.replace(/\x1b\[(?:0|49)m/g, (reset) => reset + open),
    { bg },
  );
}
