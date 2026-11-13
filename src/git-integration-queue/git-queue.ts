import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyHandoff } from "./adapter.ts";
import { queueRequest } from "./client.ts";
import { currentBranch, repositoryIdentity, inspectWorktree } from "./repository.ts";

const stateRoot = process.env.PI_GIT_QUEUE_STATE_DIR ?? join(homedir(), ".pi", "agent", "git-queues");
const daemonPath = fileURLToPath(new URL("./daemon.ts", import.meta.url));

function socketPath(repositoryId: string): string { return join(stateRoot, `${repositoryId}.sock`); }

export async function ensureGitQueueDaemon(repositoryRoot: string): Promise<{ repositoryId: string; socket: string }> {
  const identity = repositoryIdentity(repositoryRoot);
  const socket = socketPath(identity.repositoryId);
  try { await queueRequest(socket, "status"); return { repositoryId: identity.repositoryId, socket }; }
  catch {
    const child = spawn(process.execPath, [daemonPath, "--socket", socket, "--state-root", stateRoot, "--repo", identity.repositoryRoot], { detached: true, stdio: "ignore" });
    child.unref();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { await queueRequest(socket, "status"); return { repositoryId: identity.repositoryId, socket }; }
      catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    throw new Error("git queue daemon did not become ready");
  }
}

export async function enqueueHandoffPath(handoffPath: string, metadata: Record<string, string> = {}): Promise<unknown[]> {
  const candidates = classifyHandoff(handoffPath);
  const results: unknown[] = [];
  for (const candidate of candidates) {
    if (candidate.receipt.outcome !== "enqueued" || !candidate.source) { results.push(candidate.receipt); continue; }
    if (candidate.source.kind !== "handoff-patch") { results.push(candidate.receipt); continue; }
    const repositoryRoot = candidate.receipt.repositoryRoot;
    const connection = await ensureGitQueueDaemon(repositoryRoot);
    const result = await queueRequest<{ requestId: string }>(connection.socket, "enqueue", {
      targetRef: currentBranch(repositoryRoot),
      requestId: `handoff:${candidate.receipt.repositoryId}:${candidate.source.patchDigest}`,
      source: candidate.source,
      metadata,
    });
    results.push({ ...candidate.receipt, outcome: "enqueued", queueRequestId: result.requestId });
  }
  return results;
}

const inspectParameters = Type.Object({ worktreePath: Type.Optional(Type.String({ minLength: 1 })), handoffPath: Type.Optional(Type.String({ minLength: 1 })), baseCommit: Type.Optional(Type.String()), targetRef: Type.Optional(Type.String()) }, { additionalProperties: false });
const statusParameters = Type.Object({}, { additionalProperties: false });
const enqueueParameters = Type.Object({ targetRef: Type.String({ minLength: 1 }), requestId: Type.Optional(Type.String({ minLength: 1 })), sourceCommit: Type.Optional(Type.String({ minLength: 1 })), handoffPath: Type.Optional(Type.String({ minLength: 1 })), metadata: Type.Optional(Type.Record(Type.String(), Type.String())) }, { additionalProperties: false });

export default function gitQueue(pi: ExtensionAPI): void {
  pi.registerTool(defineTool({ name: "git_queue_inspect", label: "git_queue_inspect", description: "只读检查 Git worktree 或 pi-subagents handoff 的集成资格。不会修改 Git 或 queue。", parameters: inspectParameters, exposure: "deferred", defaultActive: false, async execute(_id, input, _signal, _update, ctx) {
    if (input.handoffPath) return { content: [{ type: "text", text: JSON.stringify(classifyHandoff(input.handoffPath)) }], details: { handoffPath: input.handoffPath } };
    const facts = inspectWorktree({ worktreePath: input.worktreePath ?? ctx.cwd, baseCommit: input.baseCommit, targetRef: input.targetRef });
    return { content: [{ type: "text", text: JSON.stringify(facts) }], details: facts };
  }}));
  pi.registerTool(defineTool({ name: "git_queue_status", label: "git_queue_status", description: "查看当前 Git repository 的 Durable FIFO 集成队列。", parameters: statusParameters, exposure: "deferred", defaultActive: false, async execute(_id, _input, _signal, _update, ctx) {
    const connection = await ensureGitQueueDaemon(ctx.cwd);
    const result = await queueRequest(connection.socket, "status");
    return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
  }}));
  pi.registerTool(defineTool({ name: "git_queue_enqueue", label: "git_queue_enqueue", description: "将已验证的 Git commit 或 pi-subagents handoff patch 提交到 repository Durable FIFO queue。不会自动 commit、stash、reset 或删除 worktree。", parameters: enqueueParameters, exposure: "deferred", defaultActive: false, async execute(_id, input, _signal, _update, ctx) {
    const connection = await ensureGitQueueDaemon(ctx.cwd);
    let source;
    if (input.handoffPath) {
      const candidate = classifyHandoff(input.handoffPath).find((entry) => entry.receipt.outcome === "enqueued" && entry.source);
      if (!candidate?.source) throw new Error("handoff is not eligible for enqueue");
      source = candidate.source;
    } else if (input.sourceCommit) source = { kind: "commit", commit: input.sourceCommit };
    else throw new Error("sourceCommit or handoffPath is required");
    const result = await queueRequest(connection.socket, "enqueue", { targetRef: input.targetRef, requestId: input.requestId, source, metadata: input.metadata });
    return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
  }}));
}
