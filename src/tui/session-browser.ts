import { Key, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ActivitySnapshot, DetailComponent } from "./background-activity.ts";

type BrowserTheme = { fg(color: string, value: string): string };
type BrowserComponent = Component & { dispose(): void };

export type BrowserModel = {
  snapshot(): ActivitySnapshot;
  detail(key: string, request: { expanded: boolean; requestRender(): void }): Promise<{ render(width: number): string[]; invalidate(): void; dispose?(): void } | undefined>;
  select?(key: string): void;
  subscribe?(listener: () => void): () => void;
};

export function createSubagentBrowser(options: {
  model: BrowserModel;
  theme: BrowserTheme;
  requestRender: () => void;
  close: () => void;
  getTerminalRows: () => number;
}): BrowserComponent {
  let selectedKey: string | undefined;
  let detail: { key: string; component: DetailComponent } | undefined;
  let detailLoadSerial = 0;
  let loadingKey: string | undefined;
  let disposed = false;

  const rows = () => options.model.snapshot().rows;
  const selectedRow = () => {
    const currentRows = rows();
    const index = selectedKey ? currentRows.findIndex((row) => row.key === selectedKey) : -1;
    return currentRows[index >= 0 ? index : 0];
  };
  const syncSelection = (): boolean => {
    const preferredKey = options.model.snapshot().selectedKey;
    if (preferredKey && rows().some((row) => row.key === preferredKey)) selectedKey = preferredKey;
    const row = selectedRow();
    if (!row) {
      const changed = selectedKey !== undefined;
      selectedKey = undefined;
      return changed;
    }
    if (selectedKey === row.key) return false;
    selectedKey = row.key;
    options.model.select?.(row.key);
    return true;
  };
  const loadDetail = async () => {
    syncSelection();
    const row = selectedRow();
    if (!row) return;
    if (loadingKey === row.key) return;
    detail?.component.dispose?.();
    detail = undefined;
    const key = row.key;
    const serial = ++detailLoadSerial;
    loadingKey = key;
    const component = await options.model.detail(key, { expanded: true, requestRender: options.requestRender }).catch(() => undefined);
    if (serial === detailLoadSerial) loadingKey = undefined;
    if (!component) return;
    if (disposed || serial !== detailLoadSerial || selectedRow()?.key !== key) {
      component.dispose?.();
      return;
    }
    detail = { key, component };
    options.requestRender();
  };

  const clearDetail = () => {
    detailLoadSerial += 1;
    loadingKey = undefined;
    detail?.component.dispose?.();
    detail = undefined;
  };

  const unsubscribe = options.model.subscribe?.(() => {
    if (disposed) return;
    const changed = syncSelection();
    if (changed || (selectedRow() && !detail && !loadingKey)) void loadDetail();
    options.requestRender();
  });

  const browser: BrowserComponent = {
    render(width) {
      if (disposed) return [];
      const snapshot = options.model.snapshot();
      const height = Math.max(1, options.getTerminalRows() - 4);
      syncSelection();
      const currentIndex = selectedKey ? snapshot.rows.findIndex((row) => row.key === selectedKey) : 0;
      const selected = Math.max(0, currentIndex);
      const maxListRows = detail ? Math.max(1, Math.min(snapshot.rows.length, 3)) : Math.max(1, height - 3);
      const listStart = Math.max(0, Math.min(selected - maxListRows + 1, snapshot.rows.length - maxListRows));
      const visibleRows = snapshot.rows.slice(listStart, listStart + maxListRows);
      const output = [options.theme.fg("accent", "Subagent runs"), ""];
      if (snapshot.rows.length === 0) output.push(options.theme.fg("dim", "No observed subagent runs."));
      visibleRows.forEach((row) => {
        const marker = row.key === selectedKey ? ">" : " ";
        const meta = row.metaLabel ? ` · ${row.metaLabel}` : "";
        output.push(`${marker} ${row.label} · ${row.stateLabel}${meta}`);
      });
      if (detail && detail.key === selectedKey) {
        const detailLines = detail.component.render(Math.max(0, width - 2));
        const detailHeight = Math.max(0, height - output.length - 2);
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
      const currentRows = rows();
      const count = currentRows.length;
      if (data === "q" || data === "\u001b" || data === "\u0003") {
        disposed = true;
        unsubscribe?.();
        clearDetail();
        options.close();
        return;
      }
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.alt("o"))) {
        disposed = true;
        unsubscribe?.();
        clearDetail();
        options.close();
        return;
      }
      const currentIndex = selectedKey ? currentRows.findIndex((row) => row.key === selectedKey) : 0;
      if ((matchesKey(data, Key.up) || data === "k") && count > 0) selectedKey = currentRows[Math.max(0, currentIndex - 1)]?.key;
      else if ((matchesKey(data, Key.down) || data === "j") && count > 0) selectedKey = currentRows[Math.min(count - 1, currentIndex + 1)]?.key;
      if (count > 0 && (matchesKey(data, Key.up) || data === "k" || matchesKey(data, Key.down) || data === "j")) {
        clearDetail();
        options.model.select?.(selectedKey ?? "");
        void loadDetail();
      } else if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") void loadDetail();
      options.requestRender();
    },
    invalidate() { options.requestRender(); },
    dispose() { disposed = true; unsubscribe?.(); clearDetail(); },
  };
  void loadDetail();
  return browser;
}
