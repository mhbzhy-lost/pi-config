// async-progress feature 公共入口：从 pi/extensions/async-progress-watcher.ts
// 提取的 parser/tail/watch 与 UI-only 生命周期实现。普通进度只是 TUI status
// 投影（feature 专有 key "async-progress"），不发送消息、不进入 session/模型
// 上下文；context-usage handoff 与上游 async completion 通知不属于本领域。
import { watch } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

const POLL_INTERVAL_MS = 5000;

/** 本 feature 专有的 TUI status 聚合 key。 */
export const ASYNC_PROGRESS_STATUS_KEY = "async-progress";

export interface ProgressState {
  turnCount: number;
  lastTool?: string;
  lastToolDurationMs?: number;
  totalTokens?: number;
}

export function parseProgressEvents(
  lines: string[],
  state: ProgressState,
): { summary: string; state: ProgressState } | null {
  const next = { ...state };
  let hasActivity = false;
  const tools: string[] = [];

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "turn_start") {
      next.turnCount++;
      hasActivity = true;
    } else if (event.type === "tool_execution_start" && typeof event.tool === "string") {
      next.lastTool = event.tool;
    } else if (event.type === "tool_execution_end" && typeof event.tool === "string") {
      const durationMs = typeof event.durationMs === "number" ? event.durationMs : undefined;
      next.lastToolDurationMs = durationMs;
      tools.push(
        durationMs === undefined ? event.tool : `${event.tool} (${(durationMs / 1000).toFixed(1)}s)`,
      );
      hasActivity = true;
    } else if (
      event.type === "message_end"
      && event.usage !== null
      && typeof event.usage === "object"
      && typeof (event.usage as Record<string, unknown>).totalTokens === "number"
    ) {
      next.totalTokens = (event.usage as Record<string, number>).totalTokens;
      hasActivity = true;
    }
  }

  if (!hasActivity) return null;

  const parts = [`turn ${next.turnCount}`];
  if (tools.length > 0) parts.push(tools.join(", "));
  if (next.totalTokens !== undefined) parts.push(`${Math.round(next.totalTokens / 1000)}k tok`);

  return { summary: parts.join(" | "), state: next };
}

export async function tailEventsFile(
  filePath: string,
  fromOffset: number,
): Promise<{ lines: string[]; offset: number }> {
  let fh;
  try {
    fh = await open(filePath, "r");
    const stat = await fh.stat();
    if (stat.size <= fromOffset) return { lines: [], offset: fromOffset };
    const buf = Buffer.alloc(stat.size - fromOffset);
    await fh.read(buf, 0, buf.length, fromOffset);
    const text = buf.toString("utf8");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    return { lines, offset: stat.size };
  } catch {
    return { lines: [], offset: fromOffset };
  } finally {
    await fh?.close();
  }
}

export interface ProgressWatcher {
  stop: () => void;
}

export function startWatching(
  eventsPath: string,
  onProgress: (summary: string) => void,
): ProgressWatcher {
  let offset = 0;
  let state: ProgressState = { turnCount: 0 };
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    const { lines, offset: newOffset } = await tailEventsFile(eventsPath, offset);
    // 在途 tick 在 await 期间可能遇到 stop()；已停止则丢弃本次结果，避免清理后复写
    if (stopped) return;
    if (lines.length === 0) return;
    offset = newOffset;
    const result = parseProgressEvents(lines, state);
    if (result) {
      state = result.state;
      onProgress(result.summary);
    }
  };

  // fs.watch 即时通知 + 既有轮询 fallback，offset 语义保持 bounded 增量读取
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(eventsPath, () => { void tick(); });
  } catch { /* 文件可能尚未创建 */ }
  const interval = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);

  return {
    stop() {
      stopped = true;
      watcher?.close();
      clearInterval(interval);
    },
  };
}

/** 当代 session 的 UI 投影入口；Host 在非 TUI 模式下对 setStatus 自身处理，本领域不改写成 toast/通知。 */
export interface AsyncProgressUI {
  setStatus(text: string | undefined): void;
}

/** 当代 bus 订阅契约：channel 数据按 unknown 传入，由本领域收窄字段。 */
export interface AsyncProgressChannelHandlers {
  onAsyncStarted(event: unknown): void;
  onAsyncComplete(event: unknown): void;
}

export interface AsyncProgressBindOptions {
  ui: AsyncProgressUI;
  /** 订阅当代 started/complete 事件；返回的 unsubscribe 必须在 cleanup 中被调用。 */
  subscribe(handlers: AsyncProgressChannelHandlers): Array<() => void>;
  /** 可注入的 watch 工厂，默认 startWatching。 */
  startWatch?: (eventsPath: string, onProgress: (summary: string) => void) => ProgressWatcher;
}

export interface AsyncProgressController {
  /** session_start（startup/reload/new/resume/fork）契约：先幂等 cleanup 前一代，再绑定当代监听。 */
  bind(options: AsyncProgressBindOptions): void;
  /** session_shutdown 契约：幂等停 watcher/timer、退订 bus、清状态与 UI key。 */
  cleanup(): void;
}

function stringField(event: unknown, field: "runId" | "asyncDir"): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = (event as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function createAsyncProgressController(
  { startWatch = startWatching }: Pick<AsyncProgressBindOptions, "startWatch"> = {},
): AsyncProgressController {
  let generation = 0;
  let stopped = true;
  let ui: AsyncProgressUI | undefined;
  let unsubscribes: Array<() => void> = [];
  const summaries = new Map<string, string>();
  const watchers = new Map<string, ProgressWatcher>();

  // 多 run 最新摘要按 runId 聚合；全空时清整个 status key
  const render = () => {
    if (!ui) return;
    if (summaries.size === 0) {
      ui.setStatus(undefined);
      return;
    }
    const parts: string[] = [];
    for (const [runId, summary] of summaries) {
      parts.push(`[${runId.slice(0, 8)}] ${summary}`);
    }
    ui.setStatus(parts.join("；"));
  };

  // generation 不匹配或已停止时丢弃回调，避免旧一代在途 tick 复写当前 UI
  const applyProgress = (runId: string, summary: string, gen: number) => {
    if (stopped || gen !== generation) return;
    summaries.set(runId, summary);
    render();
  };

  const handleStarted = (event: unknown, gen: number) => {
    if (stopped || gen !== generation) return;
    const runId = stringField(event, "runId");
    const asyncDir = stringField(event, "asyncDir");
    if (!runId || !asyncDir || watchers.has(runId)) return;
    const watcher = startWatch(join(asyncDir, "events.jsonl"), (summary) => {
      applyProgress(runId, summary, gen);
    });
    watchers.set(runId, watcher);
  };

  const handleComplete = (event: unknown, gen: number) => {
    if (stopped || gen !== generation) return;
    const runId = stringField(event, "runId");
    if (!runId) return;
    const watcher = watchers.get(runId);
    if (watcher) {
      watcher.stop();
      watchers.delete(runId);
    }
    // 结束一个 run 只移除该项；最后一个结束后由 render 清 key
    if (summaries.delete(runId)) render();
  };

  const cleanup = () => {
    stopped = true;
    generation += 1; // 让已捕获旧 generation 的在途 tick/回调全部失效
    for (const watcher of watchers.values()) watcher.stop();
    watchers.clear();
    for (const unsubscribe of unsubscribes) unsubscribe();
    unsubscribes = [];
    summaries.clear();
    const previousUi = ui;
    ui = undefined;
    previousUi?.setStatus(undefined);
  };

  const bind = (options: AsyncProgressBindOptions) => {
    cleanup(); // 幂等清理前一代 watcher/timer/状态/bus subscription
    const gen = ++generation;
    stopped = false;
    ui = options.ui;
    unsubscribes = options.subscribe({
      onAsyncStarted: (event) => handleStarted(event, gen),
      onAsyncComplete: (event) => handleComplete(event, gen),
    });
  };

  return { bind, cleanup };
}
