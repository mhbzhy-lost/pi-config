import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { existsSync, unlinkSync } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { GitIntegrationQueue } from "./queue.ts";
import { repositoryIdentity } from "./repository.ts";

const MAX_FRAME_BYTES = 1024 * 1024;

type Lease = { protocol: "pi-git-queue.lease.v1"; pid: number; token: string; epoch: number };

async function acquireLease(stateRoot: string, repositoryRoot: string): Promise<{ path: string; lease: Lease }> {
  const repositoryId = repositoryIdentity(repositoryRoot).repositoryId;
  const path = `${stateRoot}/${repositoryId}/daemon-lease.json`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lease: Lease = { protocol: "pi-git-queue.lease.v1", pid: process.pid, token: randomUUID(), epoch: Date.now() };
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(lease)}\n`);
      await handle.close();
      return { path, lease };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let current: Lease | undefined;
      try { current = JSON.parse(await readFile(path, "utf8")) as Lease; } catch { throw new Error("git queue lease exists but is unreadable"); }
      if (!current || !Number.isInteger(current.pid) || current.pid <= 0) throw new Error("git queue lease is invalid");
      try { process.kill(current.pid, 0); throw new Error("git queue daemon lease is held by a live process"); }
      catch (probeError) { if ((probeError as NodeJS.ErrnoException).code !== "ESRCH") throw probeError; }
      await unlink(path);
    }
  }
}

async function releaseLease(path: string, lease: Lease): Promise<void> {
  try {
    const current = JSON.parse(await readFile(path, "utf8")) as Lease;
    if (current.token === lease.token && current.pid === lease.pid) await unlink(path);
  } catch { /* cleanup is best effort; stale lease recovery is guarded by PID */ }
}

export async function startQueueDaemon(input: { socketPath: string; stateRoot: string; repositoryRoot: string }): Promise<void> {
  await mkdir(dirname(input.socketPath), { recursive: true, mode: 0o700 });
  const owner = await acquireLease(input.stateRoot, input.repositoryRoot);
  try {
    if (existsSync(input.socketPath)) unlinkSync(input.socketPath);
    const queue = new GitIntegrationQueue(input.stateRoot, input.repositoryRoot, owner.lease.epoch, owner.lease.token);
    await queue.init();
    return await serveQueue(input, owner, queue);
  } catch (error) {
    await releaseLease(owner.path, owner.lease);
    throw error;
  }
}

async function serveQueue(input: { socketPath: string; stateRoot: string; repositoryRoot: string }, owner: { path: string; lease: Lease }, queue: GitIntegrationQueue): Promise<void> {
  const server = net.createServer((socket) => {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
        socket.end(`${JSON.stringify({ id: null, ok: false, error: "request frame too large" })}\n`);
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const request = JSON.parse(line) as { id?: string; method?: string; params?: Record<string, unknown> };
          if (!request || typeof request !== "object" || typeof request.method !== "string" || (request.params !== undefined && (!request.params || typeof request.params !== "object" || Array.isArray(request.params)))) throw new Error("invalid queue request");
          const result = await dispatch(queue, request.method ?? "", request.params ?? {});
          socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
        } catch (error) {
          socket.write(`${JSON.stringify({ id: null, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
        }
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(input.socketPath, () => resolve()); });
  } catch (error) {
    await releaseLease(owner.path, owner.lease);
    throw error;
  }
  void queue.process().catch((error) => console.error(`[git-queue] startup process failed: ${error instanceof Error ? error.message : String(error)}`));
  const close = () => { server.close(); try { unlinkSync(input.socketPath); } catch {} void releaseLease(owner.path, owner.lease); };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}

async function dispatch(queue: GitIntegrationQueue, method: string, params: Record<string, unknown>): Promise<unknown> {
  if (method === "status") return queue.status();
  if (method === "process") return queue.process();
  if (method === "enqueue") return queue.enqueue(params as Parameters<GitIntegrationQueue["enqueue"]>[0]);
  throw new Error(`unknown git queue method: ${method}`);
}

if (import.meta.main) {
  const args = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index]!, process.argv[index + 1]!);
  if (!args.get("--socket") || !args.get("--state-root") || !args.get("--repo")) throw new Error("--socket, --state-root and --repo are required");
  await startQueueDaemon({ socketPath: args.get("--socket")!, stateRoot: args.get("--state-root")!, repositoryRoot: args.get("--repo")! });
}
