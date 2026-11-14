import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { classifyHandoff } from "./adapter.ts";
import { queueRequest } from "./client.ts";
import { currentBranch, repositoryIdentity } from "./repository.ts";

const stateRoot = process.env.PI_GIT_QUEUE_STATE_DIR ?? join(homedir(), ".pi", "agent", "git-queues");
const daemonPath = fileURLToPath(new URL("./daemon.ts", import.meta.url));

export function socketPath(repositoryId: string, root = stateRoot): string {
  const socketDir = process.env.PI_GIT_QUEUE_SOCKET_DIR ?? (process.platform === "darwin" ? "/tmp" : tmpdir());
  const socketKey = createHash("sha256").update(`${root}\0${repositoryId}`).digest("hex").slice(0, 20);
  const candidate = join(socketDir, `pi-gq-${socketKey}.sock`);
  if (Buffer.byteLength(candidate) <= 104) return candidate;
  const fallback = join("/tmp", `pi-gq-${socketKey}.sock`);
  if (Buffer.byteLength(fallback) > 104) throw new Error("git queue socket path exceeds platform limit");
  return fallback;
}

export async function ensureGitQueueDaemon(repositoryRoot: string): Promise<{ repositoryId: string; socket: string }> {
  const identity = repositoryIdentity(repositoryRoot);
  const socket = socketPath(identity.repositoryId, stateRoot);
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
    if (candidate.receipt.outcome !== "enqueued" || !candidate.source || candidate.source.kind !== "handoff-patch") { results.push(candidate.receipt); continue; }
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
