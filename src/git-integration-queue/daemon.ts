import net from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { GitIntegrationQueue } from "./queue.ts";

export async function startQueueDaemon(input: { socketPath: string; stateRoot: string; repositoryRoot: string }): Promise<void> {
  await mkdir(dirname(input.socketPath), { recursive: true, mode: 0o700 });
  if (existsSync(input.socketPath)) unlinkSync(input.socketPath);
  const queue = new GitIntegrationQueue(input.stateRoot, input.repositoryRoot);
  await queue.init();
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line) as { id?: string; method?: string; params?: Record<string, unknown> };
        try {
          const result = await dispatch(queue, request.method ?? "", request.params ?? {});
          socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
        } catch (error) {
          socket.write(`${JSON.stringify({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(input.socketPath, () => resolve()); });
  const close = () => { server.close(); try { unlinkSync(input.socketPath); } catch {} };
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
