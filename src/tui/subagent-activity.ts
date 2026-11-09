import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
      return lines().map((line) => line.length > safeWidth ? line.slice(0, safeWidth) : line);
    },
    invalidate() { request.requestRender(); },
  };
}

export function createSubagentActivitySource(pi: ExtensionAPI): ActivitySource {
  let active = false;
  let snapshot: ActivitySnapshot = { availability: "unavailable", rows: [] };
  let asyncSnapshot: AsyncSnapshot = { runs: [] };
  let refreshInFlight: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const unsubscribers: Array<() => void> = [];

  const notify = () => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* TUI invalidation is isolated */ }
    }
  };

  const refresh = async () => {
    if (!active) return;
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = callRpc(pi, "status", {}).then((reply) => {
      if (!active) return;
      if (!reply.success || !reply.data?.asyncSnapshot) {
        snapshot = { availability: "stale", rows: snapshot.rows, observedAt: new Date().toISOString(), errorLabel: "状态不可用" };
        return;
      }
      asyncSnapshot = reply.data.asyncSnapshot;
      snapshot = { availability: "available", rows: flattenRows(asyncSnapshot.runs ?? []), observedAt: new Date().toISOString() };
    }).catch(() => {
      if (active) snapshot = { availability: "stale", rows: snapshot.rows, observedAt: new Date().toISOString(), errorLabel: "状态读取失败" };
    }).finally(() => {
      refreshInFlight = undefined;
      notify();
    });
    return refreshInFlight;
  };

  const start = () => {
    active = true;
    void refresh();
  };
  const stop = () => {
    active = false;
    asyncSnapshot = { runs: [] };
    snapshot = { availability: "unavailable", rows: [] };
    notify();
  };

  unsubscribers.push(pi.on("session_start", () => {
    stop();
    start();
  }));
  unsubscribers.push(pi.on("session_shutdown", stop));
  for (const event of REFRESH_EVENTS) {
    unsubscribers.push(pi.events.on(event, () => { void refresh(); }));
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
      const result = await callRpc(pi, "status", { runId, view: "transcript", lines: 120 }).catch(() => undefined);
      if (!result?.success) return undefined;
      const lines = (result.data?.text ?? "状态详情不可用").split("\n");
      return textDetail(() => lines, request);
    },
    dispose() {
      stop();
      for (const unsubscribe of unsubscribers.splice(0)) {
        try { unsubscribe(); } catch { /* stale extension context */ }
      }
      listeners.clear();
    },
  };
}
