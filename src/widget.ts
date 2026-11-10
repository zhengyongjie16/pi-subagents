import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth, type Component, type TUI } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import type { AgentWidgetSnapshot } from './core.js';

const WIDGET_KEY = 'pi-subagents';
const MAX_LINES = 12;
const SUMMARY_STATUSES = ['running', 'completed', 'failed', 'interrupted'] as const;
export type AgentStatusCounts = Readonly<Record<typeof SUMMARY_STATUSES[number], number>>;
const EMPTY_STATUS_COUNTS: AgentStatusCounts = { running: 0, completed: 0, failed: 0, interrupted: 0 };
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// Exact Pi built-in names (including native codemode) get labels; other names stay dynamic.
const BUILTIN_TOOL_ACTIONS = new Map([
  ['read', 'reading'],
  ['write', 'writing'],
  ['edit', 'editing'],
  ['bash', 'running command'],
  ['powershell', 'running command'],
  ['grep', 'searching'],
  ['find', 'finding files'],
  ['ls', 'listing'],
  ['codemode', 'using codemode'],
]);

type WidgetComponent = Component & { dispose(): void };
interface Mount {
  tui?: TUI;
  theme?: Theme;
  disposed: boolean;
  component: WidgetComponent;
}

// Strip terminal escapes before controls: deleting ESC first would expose escape payloads.
function sanitize(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function preview(value: string | undefined): string | undefined {
  return value === undefined
    ? undefined
    : stripVTControlCharacters(value)
        .split(/\r\n?|\n|\u0085|\u2028|\u2029/u)
        .map(sanitize)
        .find(Boolean);
}

function activity(snapshot: AgentWidgetSnapshot): string {
  if (snapshot.status === 'starting') return 'initializing…';
  if (snapshot.activeTools.length) {
    const actions = snapshot.activeTools.map(
      (name) => {
        const cleanName = sanitize(name);
        return BUILTIN_TOOL_ACTIONS.get(cleanName) ?? (cleanName || 'using tool');
      },
    );
    return [...new Set(actions)].join(', ') + '…';
  }
  return preview(snapshot.responsePreview) ?? 'thinking…';
}

function fit(line: string, width: number): string {
  return truncateToWidth(line, width, '…');
}

// Native truncation can add reset escapes even to plain text; do not feed those into a theme.
function fitText(text: string, width: number): string {
  return stripVTControlCharacters(fit(text, width));
}

function paint(theme: Theme | undefined, color: 'accent' | 'dim' | 'warning' | 'error', text: string): string {
  return theme ? theme.fg(color, text) : text;
}

function tokenText(snapshot: AgentWidgetSnapshot, theme: Theme | undefined, compact = false): string {
  const count = snapshot.tokens;
  if (count === undefined || !Number.isFinite(count) || count <= 0) return '';
  const amount = count >= 1_000_000
    ? `${(count / 1_000_000).toFixed(1)}M`
    : count >= 1_000
      ? `${(count / 1_000).toFixed(1)}k`
      : String(count);
  const annotations: string[] = [];
  const percent = snapshot.contextUsage?.percent;
  if (typeof percent === 'number' && Number.isFinite(percent) && percent >= 0) {
    const color = percent >= 85 ? 'error' : percent >= 70 ? 'warning' : 'dim';
    annotations.push(paint(theme, color, `${Math.round(percent)}%`));
  }
  const compactions = snapshot.compactionCount;
  if (compactions !== undefined && Number.isFinite(compactions) && compactions > 0)
    annotations.push(paint(theme, 'dim', `⇊${compactions}`));
  const annotation = annotations.length
    ? `${compact ? '' : ' '}(${annotations.join(compact ? '·' : ' · ')})`
    : '';
  return paint(theme, 'dim', amount + (compact ? '' : ' token')) + annotation;
}

function modelText(snapshot: AgentWidgetSnapshot, width: number): string {
  const base = [sanitize(snapshot.provider ?? ''), sanitize(snapshot.modelId ?? '')]
    .filter(Boolean).join('/');
  const thinking = sanitize(snapshot.thinking ?? '');
  const suffix = thinking ? `/${thinking}` : '';
  const baseWidth = width - visibleWidth(suffix);
  // The model ID may be clipped, but its separately supplied thinking suffix is reserved.
  return baseWidth > 0 ? fitText(base, baseWidth) + suffix : fitText(suffix, width);
}

function agentHeader(
  snapshot: AgentWidgetSnapshot,
  width: number,
  prefix: string,
  theme: Theme | undefined,
): string {
  const name = sanitize(snapshot.canonicalName);
  const thinking = sanitize(snapshot.thinking ?? '');
  const elapsed = snapshot.elapsedMs;
  const duration = elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= 0
    ? `${(elapsed / 1000).toFixed(1)}s`
    : '';
  const tail = [
    tokenText(snapshot, theme),
    duration ? paint(theme, 'dim', duration) : '',
  ].filter(Boolean).join(' · ');
  const hasModel = Boolean(snapshot.provider || snapshot.modelId || thinking);
  const suffixWidth = thinking ? visibleWidth(`/${thinking}`) : 0;
  const fixedWidth = visibleWidth(prefix) + visibleWidth(tail) + (tail ? 3 : 0);
  const nameBudget = width - fixedWidth - (hasModel ? 3 + suffixWidth : 0);
  if (nameBudget >= Math.min(visibleWidth(name), 4)) {
    // Keep statistics and /thinking intact; use only the remaining columns for the model.
    const shownName = fitText(name, hasModel
      ? Math.min(nameBudget, Math.max(8, Math.floor(width / 4)))
      : nameBudget);
    const modelBudget = width - fixedWidth - visibleWidth(shownName) - 3;
    const model = hasModel ? modelText(snapshot, modelBudget) : '';
    return prefix + paint(theme, 'accent', shownName)
      + (model ? ` · ${paint(theme, 'dim', model)}` : '')
      + (tail ? ` · ${tail}` : '');
  }

  // Compact statistics still outrank the model at narrow widths.
  const compactStats = [tokenText(snapshot, theme, true), duration].filter(Boolean).join(' ');
  const compactTail = [thinking ? `/${thinking}` : '', compactStats].filter(Boolean).join(' ');
  const compactNameBudget = width - visibleWidth(compactTail) - (compactTail ? 1 : 0);
  if (compactNameBudget >= Math.min(visibleWidth(name), 4)) {
    const shownName = fitText(name, compactNameBudget);
    const modelBudget = width - visibleWidth(shownName) - visibleWidth(compactStats)
      - (compactStats ? 1 : 0) - 1;
    const model = hasModel ? modelText(snapshot, modelBudget) : '';
    return [paint(theme, 'accent', shownName), model ? paint(theme, 'dim', model) : '', compactStats]
      .filter(Boolean).join(' ');
  }
  const status = snapshot.status === 'starting' ? 'initializing' : 'running';
  return paint(theme, 'accent', name) + ' ' + paint(theme, 'dim', status);
}

function heading(width: number, counts: AgentStatusCounts, theme?: Theme): string {
  const active = counts.running > 0;
  const parts = SUMMARY_STATUSES
    .filter((status) => counts[status] > 0)
    .map((status) => `${counts[status]} ${status}`);
  const title = [active ? '● Agents' : '○ Agents', ...parts].join(' · ');
  const suffix = ' · /subagents';
  const available = width - visibleWidth(suffix);
  const text = available >= visibleWidth('● Agents')
    ? fitText(title, available) + suffix
    : fitText('/subagents', width);
  return paint(theme, active ? 'accent' : 'dim', text);
}

/** Parent-editor widget. Snapshot sampling and its timer never run from render(). */
export class AgentSummaryWidget {
  private ctx?: ExtensionContext;
  private parentId?: string;
  private snapshots: readonly AgentWidgetSnapshot[] = [];
  private statusCounts: AgentStatusCounts = EMPTY_STATUS_COUNTS;
  private registration?: object;
  private mount?: Mount;
  private timer?: ReturnType<typeof setInterval>;
  private frame = 0;
  private disposed = false;
  private sampleFailed = false;
  private renderFailed = false;

  constructor(
    private readonly getSnapshots: () => readonly AgentWidgetSnapshot[],
    private readonly onError: (error: unknown) => void,
    private readonly getStatusCounts?: () => AgentStatusCounts,
  ) {}

  attach(ctx: ExtensionContext): void {
    if (this.disposed) return;
    try {
      if (ctx.mode !== 'tui') {
        this.clearWidget();
        this.ctx = undefined;
        this.parentId = undefined;
        this.snapshots = [];
        this.statusCounts = EMPTY_STATUS_COUNTS;
        return;
      }
      const parentId = ctx.sessionManager.getSessionId();
      if (this.parentId !== parentId) {
        this.clearWidget();
        this.snapshots = [];
        this.statusCounts = EMPTY_STATUS_COUNTS;
      }
      // Event handlers receive fresh contexts even when the parent TUI is unchanged.
      this.ctx = ctx;
      this.parentId = parentId;
      this.refresh();
    } catch (error) {
      this.report(error);
    }
  }

  refresh(): void {
    try {
      if (this.disposed || !this.ctx) return;
      if (this.ctx.mode !== 'tui') {
        this.clearWidget();
        return;
      }
      try {
        const snapshots = this.getSnapshots();
        const counts = this.getStatusCounts?.() ?? { ...EMPTY_STATUS_COUNTS, running: snapshots.length };
        this.snapshots = snapshots;
        this.statusCounts = { ...counts };
        this.sampleFailed = false;
      } catch (error) {
        // Unknown is not empty. Keep the last frame and retry even before the first mount.
        if (!this.sampleFailed) {
          this.sampleFailed = true; // Diagnostics may synchronously reenter refresh().
          this.report(error);
        }
        this.startTimer();
        return;
      }
      if (this.disposed) return;
      if (!this.hasSummary()) {
        this.clearWidget();
        return;
      }
      this.frame = (this.frame + 1) % SPINNER.length;
      if (!this.registration) this.registerWidget();
      if (!this.registration) return;
      if (this.snapshots.length || this.statusCounts.running > 0) this.startTimer();
      else this.stopTimer(); // Keep settled totals visible without a background timer.
      this.requestRender();
    } catch (error) {
      this.report(error);
    }
  }

  private hasSummary(): boolean {
    return this.snapshots.length > 0 || SUMMARY_STATUSES.some((status) => this.statusCounts[status] > 0);
  }

  private registerWidget(): void {
    const registration = {};
    this.registration = registration;
    try {
      this.ctx!.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        const mount: Mount = {
          tui,
          theme,
          disposed: false,
          component: {
            render: (width) => this.render(mount, width),
            invalidate() {}, // Rendering is stateless and always uses the current theme.
            dispose: () => {
              if (mount.disposed) return;
              mount.disposed = true;
              mount.tui = undefined;
              mount.theme = undefined;
              if (this.mount !== mount) return;
              this.mount = undefined;
              if (this.registration === registration) this.registration = undefined;
              this.stopTimer();
            },
          },
        };
        if (this.disposed || this.registration !== registration) mount.component.dispose();
        else this.mount = mount;
        return mount.component;
      }, { placement: 'aboveEditor' });
    } catch (error) {
      this.clearWidget();
      this.report(error);
    }
  }

  private render(mount: Mount, availableWidth: number): string[] {
    const width = Number.isFinite(availableWidth) ? Math.max(0, Math.floor(availableWidth)) : 0;
    try {
      if (this.disposed || mount.disposed || this.ctx?.mode !== 'tui' || !this.hasSummary() || width === 0)
        return [];
      const theme = this.ctx?.ui.theme ?? mount.theme;
      const rows = mount.tui?.terminal?.rows;
      // Reserve parent editor/status space rather than consuming a short terminal.
      const budget = typeof rows === 'number' && Number.isFinite(rows)
        ? Math.max(1, Math.min(MAX_LINES, Math.floor(rows) - 10))
        : MAX_LINES;
      const lines = [heading(width, this.statusCounts, theme)];
      if (budget === 1 || width === 1) {
        const fitted = lines.map((line) => fit(line, width));
        this.renderFailed = false;
        return fitted;
      }
      const allFit = 1 + this.snapshots.length * 2 <= budget;
      const count = allFit ? this.snapshots.length : Math.max(0, Math.floor((budget - 2) / 2));
      const hidden = this.snapshots.length - count;
      for (let index = 0; index < count; index++) {
        const last = index === count - 1 && hidden === 0;
        const prefix = paint(theme, 'dim', last ? '└─ ' : '├─ ')
          + paint(theme, 'accent', SPINNER[this.frame]) + ' ';
        const snapshot = this.snapshots[index];
        lines.push(agentHeader(snapshot, width, prefix, theme));
        lines.push(paint(theme, 'dim', (last ? '   ' : '│  ') + '  ⎿  ' + activity(snapshot)));
      }
      if (hidden) lines.push(paint(theme, 'dim', `└─ +${hidden} more · /subagents`));
      const fitted = lines.map((line) => fit(line, width));
      this.renderFailed = false;
      return fitted;
    } catch (error) {
      if (!this.renderFailed) {
        this.renderFailed = true; // notify() can immediately request another render.
        this.report(error);
      }
      // A bad getter/theme must not escape into the SDK render loop or poison future frames.
      return [fit('/subagents', width)];
    }
  }

  private startTimer(): void {
    if (this.timer !== undefined || this.disposed || this.ctx?.mode !== 'tui') return;
    try {
      const timer = setInterval(() => {
        if (this.timer === timer) this.refresh();
      }, 200);
      this.timer = timer;
      timer.unref?.();
    } catch (error) {
      this.report(error);
    }
  }

  private stopTimer(): void {
    const timer = this.timer;
    this.timer = undefined;
    if (timer === undefined) return;
    try {
      clearInterval(timer);
    } catch (error) {
      this.report(error);
    }
  }

  private requestRender(): void {
    try {
      this.mount?.tui?.requestRender?.();
    } catch (error) {
      this.report(error);
    }
  }

  private clearWidget(): void {
    const registered = this.registration !== undefined;
    this.registration = undefined;
    this.stopTimer();
    try {
      this.mount?.component.dispose();
    } catch (error) {
      this.report(error);
    }
    this.mount = undefined;
    if (!registered) return;
    try {
      this.ctx?.ui.setWidget(WIDGET_KEY, undefined);
    } catch (error) {
      this.report(error);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.snapshots = [];
    this.statusCounts = EMPTY_STATUS_COUNTS;
    this.clearWidget();
    this.ctx = undefined;
    this.parentId = undefined;
  }

  private report(error: unknown): void {
    try {
      this.onError(error);
    } catch {} // Diagnostics cannot prevent the caller from shutting down its manager.
  }
}
