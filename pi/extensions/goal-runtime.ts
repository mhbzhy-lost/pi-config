import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getPlanExecutionService, subscribePlanExecutionService } from "pi-subagents-enhanced/execution";
import { installGoalRuntime, readGoalRuntimeConfig } from "../../src/goal-runtime/index.ts";
import { resolveGoalEngineGate } from "../../src/goal-runtime/settings-gate.ts";

export default async function goalRuntime(pi: ExtensionAPI): Promise<void> {
  if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENT_FANOUT_CHILD === "1") return;
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir || !isAbsolute(agentDir)) return;
  const settingsPath = join(agentDir, "settings.json");
  // Pi 1.4 loader 的 factory 阶段 getSettings 仍为 notInitialized；仅读取可信全局文件快照。
  // 启动/重载 factory 关闭则零注册；开启后 session_start 再核验有效设置，期间不动态补注册。
  let settings: unknown;
  try { settings = JSON.parse(await readFile(settingsPath, "utf8")); }
  catch { settings = undefined; }
  const gate = resolveGoalEngineGate({ settings, settingsPath, emit: line => console.info(line) });
  if (!gate.enabled) return;
  try {
    const config = await readGoalRuntimeConfig(agentDir);
    installGoalRuntime(pi, { config, resolveExecution: sessionId => getPlanExecutionService(pi, sessionId),
      subscribeExecution: (sessionId, listener) => subscribePlanExecutionService(pi, sessionId, listener),
      sessionEnabled: () => {
        let effective: unknown;
        try { effective = pi.getSettings(); } catch { effective = undefined; }
        return resolveGoalEngineGate({ settings: effective, settingsPath, emit: line => console.info(line) }).enabled;
      },
    });
  } catch (error) {
    console.warn(`[goal-runtime] 未注册执行能力：${error instanceof Error ? error.message : String(error)}`);
  }
}
