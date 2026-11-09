import type { Component, Theme } from "@earendil-works/pi-tui";
import type { ActivitySnapshot } from "./background-activity.ts";

function fit(value: string, width: number, truncateToWidth: (text: string, maxWidth: number, ellipsis?: string) => string): string {
  return truncateToWidth(value, Math.max(0, width), "…");
}

function rowText(snapshot: ActivitySnapshot): string {
  if (snapshot.rows.length === 0) return "后台任务：无";
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
  theme: Theme;
  visibleWidth: (text: string) => number;
  truncateToWidth: (text: string, width: number, ellipsis?: string) => string;
};

export function createFooterComponent(options: FooterComponentOptions): Component {
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
      const gap = Math.max(1, width - options.visibleWidth(right) - options.visibleWidth(left));
      const lines = [
        `${fit(left, Math.max(0, width - options.visibleWidth(right) - gap), options.truncateToWidth)}${" ".repeat(gap)}${fit(right, width, options.truncateToWidth)}`,
        fit(rowText(options.getSnapshot()), width, options.truncateToWidth),
        fit(`thinking: ${thinking}`, width, options.truncateToWidth),
      ];
      return lines.map((line) => options.theme.fg("dim", line));
    },
    invalidate() { if (!disposed) options.requestRender(); },
    dispose() { disposed = true; },
  };
}
