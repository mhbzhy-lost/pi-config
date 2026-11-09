import { Key, matchesKey, truncateToWidth, type Component, type Theme } from "@earendil-works/pi-tui";
import type { ActivitySnapshot } from "./background-activity.ts";

export type BrowserModel = {
  snapshot(): ActivitySnapshot;
  detail(key: string, request: { expanded: boolean; requestRender(): void }): Promise<{ render(width: number): string[]; invalidate(): void; dispose?(): void } | undefined>;
};

export function createSubagentBrowser(options: {
  model: BrowserModel;
  theme: Theme;
  requestRender: () => void;
  close: () => void;
  getTerminalRows: () => number;
}): Component {
  let selected = 0;
  let detail: { key: string; lines: string[] } | undefined;
  let disposed = false;

  const rows = () => options.model.snapshot().rows;
  const loadDetail = async () => {
    const row = rows()[selected];
    if (!row) return;
    const component = await options.model.detail(row.key, { expanded: true, requestRender: options.requestRender });
    if (!component) return;
    detail = { key: row.key, lines: component.render(120) };
    options.requestRender();
  };

  return {
    render(width) {
      if (disposed) return [];
      const snapshot = options.model.snapshot();
      const output = [options.theme.fg("accent", "Subagent runs"), ""];
      if (snapshot.rows.length === 0) output.push(options.theme.fg("dim", "No observed subagent runs."));
      snapshot.rows.forEach((row, index) => {
        const marker = index === selected ? ">" : " ";
        const meta = row.metaLabel ? ` · ${row.metaLabel}` : "";
        output.push(`${marker} ${row.label} · ${row.stateLabel}${meta}`);
      });
      if (detail) {
        output.push("", options.theme.fg("accent", "Details"));
        output.push(...detail.lines);
      }
      const lines = output.map((line) => truncateToWidth(line, Math.max(0, width), "…"));
      const height = Math.max(1, options.getTerminalRows() - 4);
      while (lines.length < height) lines.push("");
      return lines.slice(0, height);
    },
    handleInput(data: string) {
      if (disposed) return;
      const count = rows().length;
      if (data === "q" || data === "\u001b" || data === "\u0003") {
        disposed = true;
        options.close();
        return;
      }
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.alt("o"))) {
        disposed = true;
        options.close();
        return;
      }
      if ((matchesKey(data, Key.up) || data === "k") && count > 0) selected = Math.max(0, selected - 1);
      else if ((matchesKey(data, Key.down) || data === "j") && count > 0) selected = Math.min(count - 1, selected + 1);
      else if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") void loadDetail();
      options.requestRender();
    },
    invalidate() { options.requestRender(); },
    dispose() { disposed = true; detail = undefined; },
  };
}
