import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ActivityRow, ActivitySnapshot, ActivitySource, DetailComponent, DetailRequest } from "./background-activity.ts";

const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY = "subagents:rpc:v1:reply:";
const REFRESH_EVENTS = [
  "subagents:rpc:v1:ready",
  "subagent:async-started",
  "subagent:async-complete",
  "subagent:child-status",
  "subagent:process-terminal",
  "subagent:jobs-changed",
] as const;

type RpcReply = {
  success: boolean;
  data?: { text?: string; asyncSnapshot?: AsyncSnapshot };
};

type AsyncNode = {
  id: string;
  label: string;
  state: string;
  agent?: string;
  model?: string;
  thinking?: string;
  activity?: { currentTool?: string };
  children?: AsyncNode[];
};

type AsyncSnapshot = { runs?: AsyncNode[] };

function callRpc(pi: ExtensionAPI, method: string, params: Record<string, unknown>): Promise<RpcReply> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const unsubscribe = pi.events.on(`${RPC_REPLY}${requestId}`, (value) => {
      const reply = value as RpcReply;
      if (!reply || typeof reply.success !== "boolean") return;
      clearTimeout(timer);
      unsubscribe();
      resolve(reply);
    });
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`subagent status RPC timed out (${requestId})`));
    }, 5000);
    try {
      pi.events.emit(RPC_REQUEST, { version: 1, requestId, method, params });
    } catch (error) {
      clearTimeout(timer);
      unsubscribe();
      reject(error);
    }
  });
}

function stateLabel(state: string): string {
  switch (state) {
    case "queued": return "排队中";
    case "running": return "运行中";
    case "complete": return "已完成";
    case "failed": return "失败";
    case "partial": return "部分完成";
    case "paused": return "已暂停";
    case "stopped": return "已停止";
    case "rejected": return "已拒绝";
    default: return "待处置";
  }
}

function isActive(state: string): boolean {
  return state === "queued" || state === "running";
}

function flattenRows(runs: readonly AsyncNode[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const run of runs) {
    const children = Array.isArray(run.children) && run.children.length > 0 ? run.children : [run];
    for (const child of children) {
      const key = `subagent:${run.id}:${child.id}`;
      const label = child.label || run.label || child.agent || "subagent";
      const meta = [child.agent, child.model, child.thinking, child.activity?.currentTool]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join(" · ");
      rows.push({
        key,
        kind: "subagent",
        label,
        stateLabel: stateLabel(child.state),
        placement: isActive(child.state) ? "main" : "recent",
        ...(meta ? { metaLabel: meta } : {}),
      });
    }
  }
  return rows;
}

function textDetail(lines: () => string[], request: DetailRequest): DetailComponent {
  return {
    render(width) {
      const safeWidth = Math.max(0, width);
      return lines().map((line) => truncateToWidth(line, safeWidth, "…"));
    },
    invalidate() { request.requestRender(); },
  };
}

export function createSubagentActivitySource(pi: ExtensionAPI): ActivitySource {
  let active = false;
  let snapshot: ActivitySnapshot = { availability: "unavailable", rows: [] };
  let asyncSnapshot: AsyncSnapshot = { runs: [] };
  let selectedKey: string | undefined;
  let refreshInFlight: Promise<void> | undefined;
  let refreshPending = false;
  let disposed = false;
  const listeners = new Set<() => void>();
  const detailRefreshers = new Set<() => void>();
  const unsubscribers: Array<() => void> = [];

  const notify = () => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* TUI invalidation is isolated */ }
    }
  };

  const notifyDetails = () => {
    for (const refreshDetail of [...detailRefreshers]) {
      try { refreshDetail(); } catch { /* detail refresh is best effort */ }
    }
  };

  const refresh = async () => {
    if (!active || disposed) return;
    if (refreshInFlight) {
      refreshPending = true;
      return refreshInFlight;
    }
    refreshInFlight = callRpc(pi, "status", {}).then((reply) => {
      if (!active) return;
      if (!reply.success || !reply.data?.asyncSnapshot) {
        snapshot = { availability: "stale", rows: snapshot.rows, ...(selectedKey ? { selectedKey } : {}), observedAt: new Date().toISOString(), errorLabel: "状态不可用" };
        return;
      }
      asyncSnapshot = reply.data.asyncSnapshot;
      const rows = flattenRows(asyncSnapshot.runs ?? []);
      if (!rows.some((row) => row.key === selectedKey)) selectedKey = rows[0]?.key;
      snapshot = {
        availability: "available",
        rows,
        ...(selectedKey ? { selectedKey } : {}),
        observedAt: new Date().toISOString(),
      };
    }).catch(() => {
      if (active) snapshot = {
        availability: "stale",
        rows: snapshot.rows,
        ...(selectedKey ? { selectedKey } : {}),
        observedAt: new Date().toISOString(),
        errorLabel: "状态读取失败",
      };
    }).finally(() => {
      refreshInFlight = undefined;
      const rerun = refreshPending;
      refreshPending = false;
      if (rerun && active && !disposed) void refresh();
      notifyDetails();
      notify();
    });
    return refreshInFlight;
  };

  const start = () => {
    if (disposed) return;
    active = true;
    void refresh();
  };
  const stop = () => {
    active = false;
    asyncSnapshot = { runs: [] };
    selectedKey = undefined;
    snapshot = { availability: "unavailable", rows: [] };
    notify();
  };

  unsubscribers.push(pi.on("session_start", () => {
    if (disposed) return;
    stop();
    start();
  }));
  unsubscribers.push(pi.on("session_shutdown", () => {
    if (!disposed) stop();
  }));
  for (const event of REFRESH_EVENTS) {
    unsubscribers.push(pi.events.on(event, () => { if (!disposed) void refresh(); }));
  }

  // Footer creates this source from inside the current session_start handler, so
  // it cannot observe that event itself. Activate the first generation explicitly;
  // later generations use the registered session_start/session_shutdown handlers.
  active = true;
  void refresh();

  return {
    kind: "subagent",
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async detail(key, request) {
      const match = /^subagent:([^:]+):/.exec(key);
      if (!match) return undefined;
      const runId = match[1];
      let lines = ["正在读取 subagent 输出…"];
      let disposed = false;
      let refreshInFlight: Promise<void> | undefined;
      let refreshDirty = false;
      const timer = setInterval(() => { void refreshDetail(); }, 500);
      timer.unref?.();
      const refreshDetail = async () => {
        if (disposed) return undefined;
        if (refreshInFlight) {
          refreshDirty = true;
          return refreshInFlight;
        }
        refreshInFlight = callRpc(pi, "status", { runId, view: "transcript", lines: 240 })
          .then((result) => {
            if (disposed) return;
            lines = result.success
              ? (result.data?.text ?? "尚无 subagent 输出").split("\n")
              : ["状态详情不可用"];
            request.requestRender();
          })
          .catch(() => {
            if (!disposed) {
              lines = ["状态详情读取失败，等待下一次刷新…"];
              request.requestRender();
            }
          })
          .finally(() => {
            refreshInFlight = undefined;
            if (refreshDirty && !disposed) {
              refreshDirty = false;
              void refreshDetail();
            }
          });
        return refreshInFlight;
      };
      const onSourceRefresh = () => { void refreshDetail(); };
      detailRefreshers.add(onSourceRefresh);
      await refreshDetail();
      if (disposed) return undefined;
      return {
        render(width) {
          return lines.map((line) => truncateToWidth(line, Math.max(0, width), "…"));
        },
        invalidate() {
          void refreshDetail();
          request.requestRender();
        },
        dispose() {
          disposed = true;
          clearInterval(timer);
          detailRefreshers.delete(onSourceRefresh);
        },
      };
    },
    select(key) {
      if (!snapshot.rows.some((row) => row.key === key)) return;
      if (selectedKey === key) return;
      selectedKey = key;
      snapshot = { ...snapshot, selectedKey };
      notify();
    },
    dispose() {
      disposed = true;
      stop();
      for (const unsubscribe of unsubscribers.splice(0)) {
        try { unsubscribe(); } catch { /* stale extension context */ }
      }
      listeners.clear();
      detailRefreshers.clear();
    },
  };
}
