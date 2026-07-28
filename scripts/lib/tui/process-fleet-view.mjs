import { readFile } from "node:fs/promises";
import path from "node:path";

async function readProcessState(runDir) {
  try {
    return JSON.parse(await readFile(path.join(runDir, "status.json"), "utf8"));
  } catch {
    return { state: "unknown" };
  }
}

async function readRecentActivity(runDir) {
  try {
    const lines = (await readFile(path.join(runDir, "stdout.jsonl"), "utf8")).trim().split("\n").slice(-40);
    for (let index = lines.length - 1; index >= 0; index--) {
      const record = JSON.parse(lines[index]);
      if (record.type === "tool_execution_start") return { summary: `tool: ${record.toolName}` };
      if (record.type === "message_end" && record.message?.role === "assistant") {
        const text = record.message.content?.find((part) => part.type === "text")?.text;
        if (text) return { summary: text.replace(/\s+/g, " ") };
      }
    }
  } catch {}
  return null;
}

const DEFAULT_WIDGET_KEY = "pi-process-fleet";
const REFRESH_INTERVAL_MS = 1000;

export function createProcessFleetView(pi, {
  title = "Processes",
  entries = () => [],
  widgetKey = DEFAULT_WIDGET_KEY,
  refreshIntervalMs = REFRESH_INTERVAL_MS,
  tui = null,
  getState = () => ({ focusMode: false, selectedIndex: 0, expandedIndex: -1 }),
} = {}) {
  let timer = null;
  let disposed = false;
  let cachedLines = [];
  let ctx = null;

  function getEntries() {
    const result = entries();
    return Array.isArray(result) ? result : [];
  }

  async function buildLines() {
    const runs = getEntries();
    if (runs.length === 0) return [];

    const { focusMode, selectedIndex, expandedIndex } = getState();
    const lines = [];

    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const status = await readProcessState(run.runDir);
      const state = status.state ?? "unknown";

      const icon = state === "running" ? "●" : state === "complete" ? "✓" : "✗";
      const prefix = focusMode ? (i === selectedIndex ? "▸" : " ") : " ";

      const activity = await readRecentActivity(run.runDir);
      const summary = activity?.summary ? `  ${activity.summary.slice(0, 50)}` : "";

      lines.push(`${prefix} ${icon} ${run.label} [${state}]${summary}`);

      // Expanded view for selected item
      if (i === expandedIndex) {
        lines.push(`    pid: ${status.pid ?? "unknown"}`);
        lines.push(`    started: ${status.startedAt ?? "unknown"}`);
        if (status.endedAt) lines.push(`    ended: ${status.endedAt}`);
      }
    }

    if (focusMode) {
      lines.push("  [↑/↓] select  [Enter] expand  [Esc] close");
    }

    return lines;
  }

  function renderWidget() {
    const effectiveCtx = ctx ?? pi.getExtensionContext?.();
    if (!effectiveCtx?.hasUI) return;
    if (cachedLines.length === 0) {
      effectiveCtx.ui.setWidget(widgetKey, undefined);
      return;
    }
    if (!tui) return;
    const { Container, Text } = tui;
    const snapshot = [...cachedLines];
    effectiveCtx.ui.setWidget(widgetKey, (_tuiArg, _theme) => {
      const container = new Container();
      container.addChild(new Text(`─ ${title} ─`, 1, 0));
      for (const line of snapshot) {
        container.addChild(new Text(line, 1, 0));
      }
      return container;
    });
  }

  async function refresh() {
    if (disposed) return;
    try {
      cachedLines = await buildLines();
      renderWidget();
    } catch {
      // Best effort render
    }
  }

  function start() {
    if (timer || disposed) return;
    timer = setInterval(refresh, refreshIntervalMs);
    timer.unref?.();
    refresh();
  }

  function dispose() {
    disposed = true;
    if (timer) { clearInterval(timer); timer = null; }
    try {
      const effectiveCtx = ctx ?? pi.getExtensionContext?.();
      if (effectiveCtx?.hasUI) {
        effectiveCtx.ui.setWidget(widgetKey, undefined);
      }
    } catch {
      // Cleanup best effort
    }
  }

  function bindContext(extensionCtx) {
    ctx = extensionCtx;
  }

  return { start, refresh, dispose, bindContext };
}
