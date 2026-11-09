import type { Component } from "@earendil-works/pi-tui";
import type { ActivitySnapshot } from "./background-activity.ts";

type FooterTheme = { fg(color: string, value: string): string };

function fit(value: string, width: number, truncateToWidth: (text: string, maxWidth: number, ellipsis?: string) => string): string {
  return truncateToWidth(value, Math.max(0, width), "…");
}

function layoutLine(options: {
  width: number;
  left: string;
  right: string;
  visibleWidth: (text: string) => number;
  truncateToWidth: (text: string, width: number, ellipsis?: string) => string;
}): string {
  const width = Math.max(0, options.width);
  if (width === 0) return "";
  const rightWidth = Math.min(width, options.visibleWidth(options.right));
  if (rightWidth >= width) return fit(options.right, width, options.truncateToWidth);
  const separatorWidth = options.left && options.right ? 1 : 0;
  const leftWidth = Math.max(0, width - rightWidth - separatorWidth);
  const left = fit(options.left, leftWidth, options.truncateToWidth);
  const right = fit(options.right, rightWidth, options.truncateToWidth);
  return `${left}${" ".repeat(Math.max(0, width - options.visibleWidth(left) - options.visibleWidth(right)))}${right}`;
}

function rowText(snapshot: ActivitySnapshot): string {
  if (snapshot.rows.length === 0) {
    return snapshot.availability === "available" ? "后台任务：无" : "后台任务：状态读取中";
  }
  const active = snapshot.rows.filter((row) => row.placement === "main");
  const recent = snapshot.rows.filter((row) => row.placement === "recent");
  const rows = [...active, ...recent].slice(0, 3);
  const text = rows.map((row) => `${row.key === snapshot.selectedKey ? "›" : " "} ${row.label} · ${row.stateLabel}`).join("  ");
  return snapshot.rows.length > rows.length ? `${text} | +${snapshot.rows.length - rows.length}` : text;
}

export type FooterComponentOptions = {
  getCwd: () => string;
  getModel: () => { provider?: string; id?: string; contextWindow?: number } | undefined;
  getThinking: () => string | undefined;
  getContextUsage: () => { percent?: number | null; contextWindow?: number } | undefined;
  getSnapshot: () => ActivitySnapshot;
  requestRender: () => void;
  theme: FooterTheme;
  visibleWidth: (text: string) => number;
  truncateToWidth: (text: string, width: number, ellipsis?: string) => string;
};

export function createFooterComponent(options: FooterComponentOptions): Component & { dispose(): void } {
  let disposed = false;
  return {
    render(width: number): string[] {
      if (disposed) return [];
      const model = options.getModel();
      const usage = options.getContextUsage?.() ?? {};
      const contextWindow = usage.contextWindow ?? model?.contextWindow ?? 1_000_000;
      const contextLabel = usage.percent === null || usage.percent === undefined
        ? `?/${contextWindow >= 1_000_000 ? `${(contextWindow / 1_000_000).toFixed(1)}M` : `${Math.round(contextWindow / 1000)}k`}`
        : `${usage.percent.toFixed(1)}%/${contextWindow >= 1_000_000 ? `${(contextWindow / 1_000_000).toFixed(1)}M` : `${Math.round(contextWindow / 1000)}k`}`;
      const modelLabel = model?.provider && model.id ? `${model.provider}/${model.id}` : "no-model";
      const thinking = options.getThinking?.() ?? "off";
      const left = options.getCwd();
      // Keep the model metadata as one atomic footer field. Splitting model,
      // thinking, and context across rows makes the footer harder to scan and
      // breaks the established `model · thinking · context` layout.
      const right = `${modelLabel} · ${thinking} · ${contextLabel}`;
      const lines = [
        layoutLine({ width, left, right, visibleWidth: options.visibleWidth, truncateToWidth: options.truncateToWidth }),
        fit(rowText(options.getSnapshot()), width, options.truncateToWidth),
        fit(`thinking: ${thinking}`, width, options.truncateToWidth),
      ];
      return lines.map((line) => options.theme.fg("dim", line));
    },
    invalidate() { if (!disposed) options.requestRender(); },
    dispose() { disposed = true; },
  };
}
