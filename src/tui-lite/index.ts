import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, matchesKey, Key, type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { BASH_ASYNC_FOOTER_EVENT, type BashAsyncFooterSnapshot } from "../bash-async/index.ts";
import { NativeConversation } from "./native-conversation.ts";

const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY = "subagents:rpc:v1:reply:";
type RpcReply = { success: boolean; data?: { text?: string; asyncSnapshot?: { runs?: AsyncNode[] } }; error?: { message?: string } };
type AsyncNode = { id: string; kind?: string; label?: string; state?: string; agent?: string; model?: string; activity?: { currentTool?: string } };

function callRpc(pi: ExtensionAPI, method: string, params: Record<string, unknown>): Promise<RpcReply> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const unsubscribe = pi.events.on(`${RPC_REPLY}${requestId}`, (value) => {
      const reply = value as RpcReply;
      if (!reply || typeof reply.success !== "boolean") return;
      clearTimeout(timer);
      unsubscribe();
      resolve(reply);
    });
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`subagent RPC ${method} timed out`)); }, 5000);
    try { pi.events.emit(RPC_REQUEST, { version: 1, requestId, method, params }); }
    catch (error) { clearTimeout(timer); unsubscribe(); reject(error); }
  });
}

function stateLabel(state: string | undefined): string {
  return ({ history: "历史", queued: "排队中", running: "运行中", complete: "已完成", partial: "部分完成", rejected: "已拒绝", failed: "失败", paused: "已暂停", stopped: "已停止" } as Record<string, string>)[state ?? ""] ?? state ?? "未知";
}

function formatTokens(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

function displayCwd(cwd: string): string {
  const home = homedir();
  return cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

function activityRows(runs: readonly AsyncNode[]): AsyncNode[] {
  return runs.filter((run) => typeof run.id === "string" && run.id.length > 0);
}

// Spawn receipts belong to the authoritative parent session, survive `pi -c`,
// and already carry structured run IDs. No directory scan or new registry.
function sessionHistory(ctx: ExtensionContext): AsyncNode[] {
  const runs = new Map<string, AsyncNode>();
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    const message = entry.message;
    if (message.toolName !== "subagent_spawn" || message.isError) continue;
    const details = message.details as { asyncId?: unknown; runId?: unknown } | undefined;
    const id = details?.asyncId ?? details?.runId;
    if (typeof id === "string" && id.length > 0) runs.set(id, { id, label: "executor", state: "history" });
  }
  return [...runs.values()];
}

function createSubagentView(pi: ExtensionAPI, close: () => void, tui: TUI, getRuns: () => Promise<AsyncNode[]>, onSelection: (rows: AsyncNode[], id?: string) => void, initialId?: string): Component & { dispose(): void } {
  const requestRender = () => tui.requestRender();
  let rows: AsyncNode[] = [];
  let selected = 0;
  let selectedId = initialId;
  let scrollBack = 0;
  let maxScrollBack = 0;
  let pageSize = 10;
  let transcript: string[] = ["正在读取 subagent 输出…"];
  let conversation: NativeConversation | undefined;
  let disposed = false;
  let refreshBusy = false;
  const refresh = async () => {
    if (disposed || refreshBusy) return;
    refreshBusy = true;
    try {
      const refreshedRows = await getRuns();
      if (disposed) return;
      rows = refreshedRows;
      const previousIndex = rows.findIndex((row) => row.id === selectedId);
      selected = previousIndex >= 0 ? previousIndex : Math.min(selected, Math.max(0, rows.length - 1));
      const row = rows[selected];
      selectedId = row?.id;
      if (row) {
        const requestedId = row.id;
        const detail = await callRpc(pi, "status", { runId: row.id });
        if (disposed || selectedId !== requestedId) return;
        if (!detail.success) throw new Error(`历史或运行详情不可用，任务记录保留（产物可能已清理）：${detail.error?.message ?? "查询失败"}`);
        const state = /^State: (\S+)/m.exec(detail.data?.text ?? "")?.[1];
        if (state) row.state = state;
        const sessionFile = /^Session: (.+)$/m.exec(detail.data?.text ?? "")?.[1];
        if (!sessionFile) {
          conversation = undefined;
          transcript = [row.state === "running" || row.state === "queued" ? "等待子会话建立…" : "该历史 run 没有可读取的子会话文件，产物可能已清理。"];
        }
        else {
          const next = conversation ?? new NativeConversation(tui);
          try { await next.refresh(sessionFile); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("子会话文件已不存在，可能已被清理；历史任务记录仍保留。");
            throw error;
          }
          if (disposed || selectedId !== requestedId) return;
          conversation = next;
          transcript = [];
        }
        onSelection(rows, selectedId);
      } else { conversation = undefined; transcript = ["暂无 subagent run"]; onSelection(rows, undefined); }
    } catch (error) {
      conversation = undefined;
      transcript = [error instanceof Error ? error.message : String(error)];
    } finally {
      refreshBusy = false;
      if (!disposed) requestRender();
    }
  };
  const timer = setInterval(() => { void refresh(); }, 750);
  timer.unref?.();
  const component: Component & { dispose(): void } = {
    render(width) {
      if (disposed) return [];
      const height = Math.max(1, tui.terminal.rows - 2);
      const selectedRow = rows[selected];
      pageSize = Math.max(1, height - 3);
      const wrapped = conversation ? conversation.render(Math.max(1, width))
        : transcript.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
      maxScrollBack = Math.max(0, wrapped.length - pageSize);
      scrollBack = Math.min(scrollBack, maxScrollBack);
      const end = Math.max(0, wrapped.length - scrollBack);
      const body = wrapped.slice(Math.max(0, end - pageSize), end);
      const lines = [...body];
      while (lines.length < pageSize) lines.push(" ".repeat(Math.max(0, width)));
      return lines.map(line => truncateToWidth(line, Math.max(0, width), "…")).slice(0, height);
    },
    handleInput(data) {
      if (data === "q" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.alt("o"))) { close(); return; }
      const previous = selected;
      if ((data === "k" || matchesKey(data, Key.up)) && rows.length) selected = Math.max(0, selected - 1);
      if ((data === "j" || matchesKey(data, Key.down)) && rows.length) selected = Math.min(rows.length - 1, selected + 1);
      if (selected !== previous) {
        selectedId = rows[selected]?.id;
        onSelection(rows, selectedId);
        scrollBack = 0;
        transcript = ["正在读取 subagent 输出…"];
        conversation = undefined;
      }
      if (matchesKey(data, Key.pageUp)) scrollBack += pageSize;
      if (matchesKey(data, Key.pageDown)) scrollBack = Math.max(0, scrollBack - pageSize);
      if (matchesKey(data, Key.end)) scrollBack = 0;
      void refresh();
      requestRender();
    },
    handleMouse(event) {
      if (disposed || event.type !== "wheel" || !Number.isFinite(event.wheelDelta)) return;
      scrollBack = Math.max(0, Math.min(maxScrollBack, scrollBack - event.wheelDelta!));
      requestRender();
      return { handled: true };
    },
    invalidate() { conversation?.invalidate(); requestRender(); },
    dispose() { disposed = true; clearInterval(timer); },
  };
  void refresh();
  return component;
}

export function createTuiRuntime(pi: ExtensionAPI): void {
  let current: ExtensionContext | undefined;
  let closeOverlay: (() => void) | undefined;
  let footerTimer: ReturnType<typeof setInterval> | undefined;
  let footerRows: AsyncNode[] = [];
  let footerSelectedId: string | undefined;
  let bashAsyncTasks: BashAsyncFooterSnapshot['tasks'] = [];
  let footerRequestRender: (() => void) | undefined;
  let getRuns: (() => Promise<AsyncNode[]>) | undefined;
  const close = () => { closeOverlay?.(); closeOverlay = undefined; };
  const stopFooter = () => { clearInterval(footerTimer); footerTimer = undefined; footerRows = []; bashAsyncTasks = []; };

  pi.on("session_start", (_event, ctx) => {
    close();
    stopFooter();
    if (ctx.mode !== "tui") { current = undefined; return; }
    current = ctx;
    const unsubscribeBashAsync = pi.events.on(BASH_ASYNC_FOOTER_EVENT, (value) => {
      const snapshot = value as BashAsyncFooterSnapshot;
      bashAsyncTasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
      footerRequestRender?.();
    });
    const history = new Map(sessionHistory(ctx).map(row => [row.id, row]));
    let entryCount = ctx.sessionManager.getEntries().length;
    getRuns = async () => {
      const entries = ctx.sessionManager.getEntries();
      if (entries.length !== entryCount) {
        for (const row of sessionHistory(ctx)) if (!history.has(row.id)) history.set(row.id, row);
        entryCount = entries.length;
      }
      const status = await callRpc(pi, "status", {});
      if (!status.success) throw new Error(status.error?.message ?? "子代理列表不可用");
      const live = activityRows(status.data?.asyncSnapshot?.runs ?? []);
      const liveIds = new Set(live.map(row => row.id));
      return [...live, ...[...history.values()].filter(row => !liveIds.has(row.id))];
    };
    const loadRuns = getRuns;
    ctx.ui.setFooter((tui, theme) => {
      footerRequestRender = () => tui.requestRender();
      let busy = false;
      const refresh = async () => {
        if (busy || closeOverlay || current !== ctx) return;
        busy = true;
        try {
          const rows = await loadRuns();
            if (current !== ctx) return;
            footerRows = rows;
          tui.requestRender();
        } finally { busy = false; }
      };
      footerTimer = setInterval(() => { void refresh().catch(() => {}); }, 750);
      footerTimer.unref?.();
      void refresh().catch(() => {});
      return {
        render(width: number) {
          const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no-model";
          const usage = ctx.getContextUsage();
          const context = `${formatTokens(usage?.tokens)}/${formatTokens(usage?.contextWindow)}`;
          const right = `${model} ${ctx.thinkingLevel ?? "off"} ${context}`;
          const rightText = truncateToWidth(right, Math.max(0, width), "…");
          const leftBudget = Math.max(0, width - visibleWidth(rightText) - (rightText ? 1 : 0));
          const leftText = truncateToWidth(displayCwd(ctx.cwd), leftBudget, "…");
          const first = rightText && leftText
            ? `${leftText}${" ".repeat(Math.max(1, width - visibleWidth(leftText) - visibleWidth(rightText)))}${rightText}`
            : truncateToWidth(leftText || rightText, Math.max(0, width), "…");
          const active = footerRows.filter(row => row.state === "queued" || row.state === "running" || row.state === "paused");
          const subagents = active.map(row => `subagent ${row.label || row.agent || row.id} · ${stateLabel(row.state)}`);
          const bash = bashAsyncTasks.map(task => `bash_async "${task.command.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()}" · ${stateLabel(task.state)}`);
          return [theme.fg("dim", first), "", ...[...subagents, ...bash].map(task => truncateToWidth(task, Math.max(0, width), "…"))];
        },
        invalidate() { tui.requestRender(); },
        dispose() { footerRequestRender = undefined; unsubscribeBashAsync(); stopFooter(); },
      };
    });
  });

  pi.registerShortcut(Key.alt("o"), {
    description: "Open subagent output",
    handler: (shortcutCtx) => {
      if (closeOverlay) { close(); return; }
      if (!current || !getRuns || shortcutCtx.sessionManager !== current.sessionManager) return;
      const owner = current;
      const loadRuns = getRuns;
          void owner.ui.custom((tui, theme, _keybindings, done) => {
        let finished = false;
        let view: ReturnType<typeof createSubagentView> | undefined;
        const finish = () => {
          if (finished) return;
          finished = true;
          closeOverlay = undefined;
          view?.dispose();
          done(undefined);
        };
        closeOverlay = finish;
          view = createSubagentView(pi, finish, tui, loadRuns, (rows, id) => {
            footerRows = rows; footerSelectedId = id;
            tui.requestRender();
         }, footerSelectedId);
        return {
          render(width: number) { return view.render(width); },
          handleInput(data: string) { view.handleInput?.(data); },
          handleMouse(event) { return view.handleMouse?.(event); },
          invalidate() { view.invalidate?.(); },
           dispose() { view.dispose(); },
        };
      }, { overlay: true, overlayOptions: { row: 0, col: 0, width: "100%", maxHeight: "100%" }, onHandle: (handle) => handle.focus() }).catch((error) => {
        close();
        owner.ui.notify(`无法打开子代理视图：${error instanceof Error ? error.message : String(error)}`, "error");
      });
    },
  });

  pi.on("session_shutdown", () => { close(); stopFooter(); bashAsyncTasks = []; current = undefined; getRuns = undefined; });
}
