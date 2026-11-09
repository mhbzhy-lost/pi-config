import type { BashAsyncController, BashAsyncLaunchReceipt, BashAsyncTerminalReceipt } from "../bash-async/contracts.ts";
import type { SchedulerActivityObserver } from "../task-scheduler/index.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ActivityRow, ActivitySnapshot, ActivitySource, DetailComponent, DetailRequest } from "./background-activity.ts";

function textDetail(lines: () => string[], request: DetailRequest): DetailComponent {
  return {
    render(width) {
      const safeWidth = Math.max(0, width);
      return lines().map((line) => truncateToWidth(line, safeWidth, "…"));
    },
    invalidate() { request.requestRender(); },
  };
}

function bashRow(receipt: BashAsyncLaunchReceipt | BashAsyncTerminalReceipt, placement: "main" | "recent"): ActivityRow {
  const terminal = receipt.kind === "bash-async-complete" ? receipt : undefined;
  return {
    key: `bash_async:${receipt.jobId}`,
    kind: "bash_async",
    label: receipt.command,
    stateLabel: terminal ? terminal.outcome : "运行中",
    placement,
    metaLabel: receipt.cwd,
  };
}

export function createBashActivitySource(controller: BashAsyncController): ActivitySource {
  return {
    kind: "bash_async",
    snapshot() {
      const current = controller.snapshot();
      return {
        availability: "available",
        rows: [
          ...current.active.map((receipt) => bashRow(receipt, "main")),
          ...current.completed.map((receipt) => bashRow(receipt, "recent")),
        ],
      };
    },
    subscribe(listener) { return controller.subscribe(listener); },
    async detail(key, request) {
      const jobId = key.startsWith("bash_async:") ? key.slice("bash_async:".length) : "";
      const receipt = [...controller.snapshot().active, ...controller.snapshot().completed]
        .find((candidate) => candidate.jobId === jobId);
      if (!receipt) return undefined;
      return textDetail(() => {
        if (receipt.kind !== "bash-async-complete") return [receipt.command, receipt.cwd, "运行中"];
        const output = receipt.output && "error" in receipt.output
          ? receipt.output.error.message
          : JSON.stringify(receipt.output);
        return [receipt.command, receipt.cwd, `${receipt.outcome} exit=${receipt.exitCode ?? "?"}`, output];
      }, request);
    },
  };
}

export function createSchedulerActivitySource(observer: SchedulerActivityObserver): ActivitySource {
  return {
    kind: "scheduler",
    snapshot() {
      const current = observer.snapshot();
      return {
        availability: current.availability,
        rows: current.records.map((record) => ({
          key: `scheduler:${record.id}`,
          kind: "scheduler" as const,
          label: record.name || record.id,
          stateLabel: record.lastStatus || (record.enabled ? "已启用" : "已暂停"),
          placement: "main" as const,
          metaLabel: record.nextRunAt,
        })),
        ...(current.observedAt ? { observedAt: current.observedAt } : {}),
        ...(current.errorLabel ? { errorLabel: current.errorLabel } : {}),
      };
    },
    subscribe(listener) { return observer.subscribe(listener); },
    async detail(key, request) {
      if (!key.startsWith("scheduler:")) return undefined;
      const id = key.slice("scheduler:".length);
      if (!id) return undefined;
      const result = await observer.detail(id);
      if (!result.ok) return undefined;
      return textDetail(() => result.result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text), request);
    },
  };
}
