import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rootBrokerRegistryEntry } from "../../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts";
import { captureProcessBirthIdentity } from "../../packages/pi-subagents-enhanced/src/subagent-dispatch/process-birth-identity.ts";

// 此文件是实际 CLI 加载的测试入口，不另起 SDK Host，不写 session/authority。
export default function heartbeatParentProbe(pi: ExtensionAPI) {
  const root = process.env.PI_HEARTBEAT_FIXTURE_ROOT;
  if (!root || process.env.PI_SUBAGENT_CHILD === "1") throw new Error("heartbeat parent fixture 身份错误");
  const record = (kind: string, value: Record<string, unknown>) => {
    appendFileSync(join(root, "parent-observations.jsonl"), `${JSON.stringify({ kind, observedAt: Date.now(), ...value })}\n`, { mode: 0o600 });
  };
  const disposers = [
    pi.events.on("subagent:async-started", (event: any) => {
      // 只复制公开 lifecycle 的非正文身份字段，root/leaf 不凭 tool receipt 猜测。
      const { runId, id, asyncDir, pid, sessionId, agent, workflowKey, parentWorkflowRunId } = event;
      record("started", { runId: runId ?? id, asyncDir, pid, sessionId, agent, workflowKey, parentWorkflowRunId });
    }),
    pi.events.on("subagent:process-terminal", (event: any) => {
      // 保留官方 process proof；它是 fixture 公开事件，不是 raw session。
      record("process-terminal", { proof: event });
    }),
  ];
  pi.on("session_start", async (_event, ctx) => {
    pi.setActiveTools(["subagent", "subagent_worktree"]);
    const sessionId = ctx.sessionManager.getSessionId();
    const registry = await rootBrokerRegistryEntry(pi, sessionId);
    // 第二次 post-title 父身份取样：与 registry 各自独立调用 captureProcessBirthIdentity。
    // 此处必然晚于 physical SDK dist/cli/setup.js:4 的 process.title 赋值，spawn 瞬间的
    // pre-title 摘要此后不再代表本进程。session_start 处理器被等待完成后才处理 prompt，
    // 且 async-started 监听在模块加载时已注册，本等待不引入监听缺失；record 为同步 append，
    // 单条 parent-started 原子携带 hostBirth 与 registry。
    const hostBirth = await captureProcessBirthIdentity(process.pid);
    // 启动 env 事实：post-title 权威 birth 的取样 locale（Host env 由 harness fixtureEnvironment
    // 白名单固定 C，registry 与 hostBirth 双取样同域）；仅记录 LANG/LC_ALL 非敏感事实，
    // 供 harness 读取侧对齐核对与失败归因，不含凭据类变量。
    record("parent-started", { pid: process.pid, ppid: process.ppid, sessionId, cwd: ctx.cwd, hostBirth, registry,
      readLocale: { LANG: process.env.LANG ?? null, LC_ALL: process.env.LC_ALL ?? null } });
  });
  pi.on("session_shutdown", () => { for (const dispose of disposers) dispose(); });
}
