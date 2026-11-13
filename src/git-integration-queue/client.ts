import net from "node:net";
import { randomUUID } from "node:crypto";

export async function queueRequest<T>(socketPath: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const response = JSON.parse(buffer.slice(0, newline));
      socket.end();
      if (response.ok) resolve(response.result as T);
      else reject(new Error(response.error ?? "git queue request failed"));
    });
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: randomUUID(), method, params })}\n`));
  });
}
