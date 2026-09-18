import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ALLOWED_TASKS = new Set(["parse", "validate", "transform", "serialize", "audit"]);

function contract(task) {
  const taskId = `acceptance-${task}`;
  // probe 经 PI_ACCEPTANCE_MODEL 注入 --model 的选择；仅合法 qualified id 生效，
  // 其余回退默认（R12 归因：硬编码曾使 --model 断链）。
  const requestedModel = process.env.PI_ACCEPTANCE_MODEL;
  const model = typeof requestedModel === "string" && /^[^/\s]+\/\S+$/.test(requestedModel) && !/fake|deterministic/i.test(requestedModel)
    ? requestedModel
    : "codex-pool/gpt-5.6-sol";
  return {
    version: "dispatch-ir.v1",
    taskId,
    title: `Acceptance pipeline ${task} stage`,
    agent: "executor",
    model,
    risk: "high",
    objective: `Modify the shared PIPELINE declaration line to add only the ${task} stage.`,
    workflow: { mode: "tdd" },
    requirements: [
      `Modify the same PIPELINE declaration line in src/pipeline.ts for the ${task} stage.`,
      "Add a focused behavior test in test/pipeline.test.mjs, run it, and create a commit.",
      `The commit message must use Conventional Commit format with a Chinese subject, for example 'feat: 添加 ${task} 阶段'; English-only or non-conventional subjects are rejected by the repository gate.`,
      "Only perform business-file changes and, when given a conflict continuation, resolve unmerged files and git add them; Auto Integration queues, rebases, resolves lifecycle, and publishes the candidate.",
    ],
    context: {
      knownFacts: ["All five acceptance tasks start at the same base commit and intentionally edit the same line."],
      decisions: ["Auto Integration owns serialized queue admission, rebase, conflict continuation, and publication."],
      relevantFiles: ["src/pipeline.ts", "test/pipeline.test.mjs"],
    },
    boundaries: {
      writePaths: ["src/pipeline.ts", "test/pipeline.test.mjs"],
      excludedWork: ["Do not modify repository coordinator production code."],
      forbiddenActions: ["Do not call or orchestrate integration mutation tools."],
    },
    acceptance: { criteria: [`The ${task} stage is present and covered by test/pipeline.test.mjs.`, "The business changes are committed with the required conventional message."] },
    execution: { worktree: true },
  };
}

// The real interactive Root owns the long-lived root.subscribe connection. RPC
// mode has no interactive owner, so the acceptance Host mirrors that contract
// for every managed child and keeps subscriptions alive until Root shutdown.
export function installAcceptanceRootBrokerSubscriptions(pi, options = {}) {
  const retryDelayMs = options.retryDelayMs ?? 25;
  const clients = new Map();
  let rootSessionId = options.rootSessionId;
  let disposed = false;
  pi.on?.("session_start", (_event, ctx) => { rootSessionId ??= ctx.sessionManager.getSessionId(); });
  const unsubscribe = pi.events?.on("subagent:async-started", async (event) => {
    const callerRunId = event?.runId ?? event?.id;
    if (disposed || typeof rootSessionId !== "string" || !rootSessionId || typeof callerRunId !== "string" || !callerRunId || clients.has(callerRunId)) return;
    const createClient = options.createClient ?? (await import(pathToFileURL(resolve(
      process.env.PI_CODING_AGENT_DIR,
      "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-client.ts",
    )).href)).createRootBrokerClient;
    const client = createClient({ rootSessionId, callerRunId, requiredCapability: "root.subscribe" });
    clients.set(callerRunId, { client });
    for (;;) {
      try {
        const subscription = await client.subscribe((push) => {
          if (push.type === "recovery.event") void Promise.resolve(pi.sendMessage?.({
            customType: "pi-root-recovery-event-v1",
            content: "Recovery event observed by acceptance root.",
            details: push.data,
          })).catch(() => {});
        });
        clients.set(callerRunId, { client, subscription });
        break;
      } catch (error) {
        if (disposed) { clients.delete(callerRunId); client.dispose(); return; }
        if (error?.code !== "GRANT_NOT_READY") { clients.delete(callerRunId); client.dispose(); throw error; }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  });
  pi.on?.("session_shutdown", () => {
    disposed = true;
    unsubscribe?.();
    for (const { client, subscription } of clients.values()) { subscription?.dispose(); client.dispose(); }
    clients.clear();
  });
}

// Deterministic root model used only to exercise the real RPC and production tool.
export default function acceptanceRootProvider(pi) {
  installAcceptanceRootBrokerSubscriptions(pi);
  pi.registerProvider("fake", {
    baseUrl: "http://127.0.0.1:9", api: "fake", apiKey: "acceptance-test",
    models: [{ id: "deterministic", name: "Acceptance root", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 512 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const tasks = (process.env.PI_ACCEPTANCE_TASKS ?? "").split(",").filter(Boolean);
      if (tasks.length === 0 || tasks.some((task) => !ALLOWED_TASKS.has(task)) || new Set(tasks).size !== tasks.length) throw new Error("PI_ACCEPTANCE_TASKS must contain distinct allowed acceptance tasks");
      const issuedIds = new Set((context.messages ?? []).filter((message) => message.role === "assistant").flatMap((message) => message.content ?? []).filter((part) => part?.type === "toolCall").map((part) => part.id));
      const calls = tasks.filter((task) => !issuedIds.has(`acceptance-${task}`)).map((task) => ({ type: "toolCall", id: `acceptance-${task}`, name: "subagent", arguments: contract(task) }));
      const text = "acceptance root settled";
      const message = { role: "assistant", content: calls.length ? calls : [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: calls.length ? "toolUse" : "stop", timestamp: Date.now() };
      stream.push({ type: "start", partial: message });
      for (let index = 0; index < calls.length; index += 1) {
        const toolCall = calls[index];
        stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
        stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(toolCall.arguments), partial: message });
        stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: message });
      }
      if (!calls.length) {
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
      }
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
      return stream;
    },
  });
}
