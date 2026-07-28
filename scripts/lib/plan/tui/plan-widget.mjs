import { readFile } from "node:fs/promises";
import path from "node:path";

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function createPlanWidget(pi, { planId, stateRoot = process.cwd(), executorRuns = new Map(), refreshIntervalMs = 1_000 } = {}) {
  const planRoot = path.join(stateRoot, "var", "plan-runs", planId);
  const statusPath = path.join(planRoot, "status.json");
  const hostHandlePath = path.join(planRoot, "host-handle.json");
  const widgetKey = `pi-plan-${planId}`;
  let timer;
  let disposed = false;

  async function snapshot() {
    const [plan, host] = await Promise.all([readJson(statusPath), readJson(hostHandlePath)]);
    const executors = [];
    for (const [runId, binding] of executorRuns) {
      const artifact = binding?.asyncDir ? await readJson(path.join(binding.asyncDir, "status.json")) : null;
      executors.push({ runId, taskId: binding?.taskId ?? null, state: artifact?.state ?? "unknown" });
    }
    return { plan, host, executors };
  }

  async function refresh() {
    if (disposed) return;
    const ctx = pi.getExtensionContext?.();
    if (!ctx?.hasUI) return;
    try {
      const value = await snapshot();
      const lines = [
        `Plan ${planId}: ${value.plan?.lifecycle ?? "not-started"}`,
        `Host: ${value.host?.hostRunId ?? "unbound"}`,
      ];
      for (const task of value.plan?.tasks ?? []) {
        lines.push(`${task.taskId}: ${task.status}`);
        for (const attempt of task.attempts ?? []) {
          lines.push(`  ${attempt.attemptId}: ${attempt.status}${attempt.attention?.status === "pending" ? " attention" : ""}`);
        }
      }
      for (const executor of value.executors) lines.push(`run ${executor.runId}: ${executor.state}`);
      ctx.ui.setWidget(widgetKey, lines);
    } catch {
      // Projection rendering is best effort and never changes Plan state.
    }
  }

  return {
    start() {
      if (timer || disposed) return;
      timer = setInterval(refresh, refreshIntervalMs);
      timer.unref?.();
      void refresh();
    },
    refresh,
    addExecutor(runId, binding) { executorRuns.set(runId, binding); void refresh(); },
    removeExecutor(runId) { executorRuns.delete(runId); void refresh(); },
    handleInput() { return false; },
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      try { pi.getExtensionContext?.()?.ui?.setWidget?.(widgetKey, undefined); } catch {}
    },
  };
}
