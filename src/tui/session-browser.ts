import { Key, matchesKey, truncateToWidth, type Component, type Theme } from "@earendil-works/pi-tui";
import type { ActivitySnapshot, DetailComponent } from "./background-activity.ts";

export type BrowserModel = {
  snapshot(): ActivitySnapshot;
  detail(key: string, request: { expanded: boolean; requestRender(): void }): Promise<{ render(width: number): string[]; invalidate(): void; dispose?(): void } | undefined>;
  select?(key: string): void;
};

export function createSubagentBrowser(options: {
  model: BrowserModel;
  theme: Theme;
  requestRender: () => void;
  close: () => void;
  getTerminalRows: () => number;
}): Component {
  let selected = 0;
  let detail: { key: string; component: DetailComponent } | undefined;
  let disposed = false;

  const rows = () => options.model.snapshot().rows;
  const loadDetail = async () => {
    const row = rows()[selected];
    if (!row) return;
    options.model.select?.(row.key);
    detail?.component.dispose?.();
    detail = undefined;
    const key = row.key;
    const component = await options.model.detail(key, { expanded: true, requestRender: options.requestRender });
    if (!component) return;
    if (disposed || rows()[selected]?.key !== key) {
      component.dispose?.();
      return;
    }
    detail = { key, component };
    options.requestRender();
  };

  const clearDetail = () => {
    detail?.component.dispose?.();
    detail = undefined;
  };

  const browser: Component = {
    render(width) {
      if (disposed) return [];
      const snapshot = options.model.snapshot();
      const height = Math.max(1, options.getTerminalRows() - 4);
      const output = [options.theme.fg("accent", "Subagent runs"), ""];
      if (snapshot.rows.length === 0) output.push(options.theme.fg("dim", "No observed subagent runs."));
      snapshot.rows.forEach((row, index) => {
        const marker = index === selected ? ">" : " ";
        const meta = row.metaLabel ? ` · ${row.metaLabel}` : "";
        output.push(`${marker} ${row.label} · ${row.stateLabel}${meta}`);
      });
      if (detail && detail.key === snapshot.rows[selected]?.key) {
        const detailLines = detail.component.render(Math.max(0, width - 2));
        const detailHeight = Math.max(0, height - output.length - 1);
        if (detailHeight > 0) {
          output.push("", options.theme.fg("accent", "Live output"));
          // Keep the newest transcript visible while the child is streaming. The
          // old browser auto-followed the tail; slicing from the head hides the
          // actual progress once the transcript exceeds the viewport.
          output.push(...detailLines.slice(-detailHeight));
        }
      }
      const lines = output.map((line) => truncateToWidth(line, Math.max(0, width), "…"));
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
      if (count > 0 && (matchesKey(data, Key.up) || data === "k" || matchesKey(data, Key.down) || data === "j")) {
        clearDetail();
        options.model.select?.(rows()[selected]?.key ?? "");
      } else if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") void loadDetail();
      options.requestRender();
    },
    invalidate() { options.requestRender(); },
    dispose() { disposed = true; clearDetail(); },
  };
  void loadDetail();
  return browser;
}
