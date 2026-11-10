import type { Theme } from '@earendil-works/pi-coding-agent';
import type { TerminalColorMode } from '@earendil-works/pi-tui';
import { fileURLToPath } from 'node:url';

// Tests use Pi's installed, complete palettes, not fg-only mocks. Production uses
// only public SDK exports; this test-only loader also lets us exercise 256-color.
const themeUrl = new URL(
  './modes/interactive/theme/theme.js',
  import.meta.resolve('@earendil-works/pi-coding-agent'),
);
const { loadThemeFromPath } = await import(themeUrl.href);

export function nativeTheme(name: 'dark' | 'light', mode: TerminalColorMode = 'truecolor'): Theme {
  return loadThemeFromPath(fileURLToPath(new URL(`${name}.json`, themeUrl)), mode);
}
