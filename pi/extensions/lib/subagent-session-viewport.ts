import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

export class ReadOnlyBrowserEditor extends CustomEditor {
  override render(_width: number): string[] {
    return [];
  }

  override handleInput(_data: string): void {}
}

type ViewportOptions = {
  getTerminalRows: () => number;
  reservedBottomRows: number;
  getLines: (width: number) => string[];
  requestRender: () => void;
  onInput?: (data: string) => void;
  onInvalidate?: () => void;
};

export function parseSgrWheelDirection(data: string): -1 | 1 | undefined {
  const match = /^\x1b\[<(\d+);\d+;\d+M$/.exec(data);
  if (!match) return undefined;
  const button = Number(match[1]) & ~(4 | 8 | 16);
  if (button === 64) return -1;
  if (button === 65) return 1;
  return undefined;
}

export class SubagentTranscriptViewport implements Component {
  private startIndex = 0;
  private autoFollow = true;
  private lastLines: string[] = [];
  private lastRenderWidth = 0;
  private disposed = false;

  constructor(private readonly options: ViewportOptions) {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    this.lastRenderWidth = safeWidth;
    const { height, lines, maxStart } = this.bounds();
    const start = this.autoFollow ? maxStart : this.startIndex;
    const visible = lines.slice(start, start + height);
    const padded = visible.map((line) => this.pad(line, safeWidth));
    while (padded.length < height) padded.unshift(this.pad("", safeWidth));
    return padded;
  }

  scrollLines(delta: number): void {
    if (this.disposed) return;
    const { maxStart } = this.bounds();
    const start = this.autoFollow ? maxStart : this.startIndex;
    this.startIndex = Math.max(0, Math.min(maxStart, start + delta));
    this.autoFollow = this.startIndex === maxStart;
    this.options.requestRender();
  }

  scrollPage(direction: -1 | 1): void {
    if (this.disposed) return;
    const { height, maxStart } = this.bounds();
    const start = this.autoFollow ? maxStart : this.startIndex;
    this.startIndex = Math.max(0, Math.min(maxStart, start + direction * height));
    this.autoFollow = this.startIndex === maxStart;
    this.options.requestRender();
  }

  scrollHome(): void {
    if (this.disposed) return;
    const { maxStart } = this.bounds();
    this.startIndex = 0;
    this.autoFollow = maxStart === 0;
    this.options.requestRender();
  }

  scrollEnd(): void {
    if (this.disposed) return;
    const { maxStart } = this.bounds();
    this.startIndex = maxStart;
    this.autoFollow = true;
    this.options.requestRender();
  }

  position(): { start: number; end: number; total: number; autoFollow: boolean } {
    const { height, lines, maxStart } = this.bounds();
    const start = this.autoFollow ? maxStart : this.startIndex;
    const end = Math.min(lines.length, start + height);
    return {
      start: lines.length === 0 ? 0 : start + 1,
      end,
      total: lines.length,
      autoFollow: this.autoFollow,
    };
  }

  resetScroll(): void {
    if (this.disposed) return;
    this.startIndex = 0;
    this.autoFollow = true;
    this.options.requestRender();
  }

  handleInput(data: string): void {
    if (!this.disposed) this.options.onInput?.(data);
  }

  refresh(): void {
    if (!this.disposed) this.options.requestRender();
  }

  invalidate(): void {
    if (this.disposed) return;
    this.options.onInvalidate?.();
    this.options.requestRender();
  }

  dispose(): void {
    this.disposed = true;
  }

  private bounds(): { height: number; lines: string[]; maxStart: number } {
    const height = this.height();
    const lines = this.lines(this.lastRenderWidth);
    const maxStart = Math.max(0, lines.length - height);
    this.startIndex = Math.max(0, Math.min(this.startIndex, maxStart));
    return { height, lines, maxStart };
  }

  private height(): number {
    const rows = this.options.getTerminalRows();
    const safeRows = Number.isFinite(rows) ? rows : 0;
    return Math.max(1, safeRows - this.options.reservedBottomRows);
  }

  private lines(width: number): string[] {
    try {
      const lines = this.options.getLines(width);
      if (Array.isArray(lines)) this.lastLines = lines;
    } catch {
      // Preserve the last confirmed transcript during transient source failures.
    }
    return this.lastLines;
  }

  private pad(line: string, width: number): string {
    const truncated = truncateToWidth(line, width);
    return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
  }
}
