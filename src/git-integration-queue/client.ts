import net from "node:net";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export async function queueRequest<T>(socketPath: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = randomUUID();
    const socket = net.createConnection(socketPath);
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result as T);
    };
    const timer = setTimeout(() => finish(new Error(`git queue request timed out: ${method}`)), timeoutMs);
    socket.on("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.id !== id && response.id !== null) return finish(new Error("git queue response id mismatch"));
        if (response.ok) finish(undefined, response.result as T);
        else finish(new Error(response.error ?? "git queue request failed"));
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
  });
}
