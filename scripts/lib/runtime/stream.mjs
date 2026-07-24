import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export function createOutputStream(runDir) {
  let lastSize = 0;
  let listeners = [];
  let disposed = false;
  let pollTimer = null;

  const stdoutPath = join(runDir, "stdout.jsonl");

  function parseLines(content) {
    return content
      .split("\n")
      .filter(line => line.trim())
      .map(line => {
        try { return JSON.parse(line); } catch { return { raw: line }; }
      });
  }

  function summarize(event) {
    if (!event || typeof event !== "object") return { type: "unknown", summary: "" };

    // Pi JSON mode: message_update with assistant text delta
    if (event.type === "message_update" && event.assistantMessageEvent) {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta" && ame.delta) {
        return { type: "text", summary: ame.delta.slice(0, 80) };
      }
      if (ame.type === "text_end" && ame.content) {
        return { type: "text", summary: ame.content.slice(0, 80) };
      }
      return { type: "thinking", summary: "..." };
    }

    // Pi JSON mode: tool execution
    if (event.type === "tool_execution_start") {
      const name = event.toolName || "tool";
      const args = event.input ? Object.keys(event.input).map(k => `${k}=${JSON.stringify(event.input[k]).slice(0, 30)}`).join(", ") : "";
      return { type: "tool", summary: `${name}(${args})` };
    }
    if (event.type === "tool_execution_update") {
      return { type: "tool", summary: "..." };
    }
    if (event.type === "tool_execution_end") {
      const name = event.toolName || "tool";
      return { type: "tool_done", summary: `${name} ✓` };
    }

    // Pi JSON mode: message boundaries
    if (event.type === "message_start" && event.message?.role === "assistant") {
      return { type: "thinking", summary: "thinking..." };
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const content = event.message.content;
      if (Array.isArray(content)) {
        const text = content.filter(b => b.type === "text").map(b => b.text).join("");
        if (text) return { type: "response", summary: text.slice(0, 80) };
        const toolCall = content.find(b => b.type === "toolCall");
        if (toolCall) return { type: "tool_call", summary: `→ ${toolCall.name}(...)` };
      }
      return { type: "response", summary: "(done)" };
    }

    // Turn boundaries
    if (event.type === "turn_start") return { type: "turn", summary: "── new turn ──" };
    if (event.type === "turn_end") return { type: "turn_end", summary: "── turn end ──" };

    // Agent lifecycle
    if (event.type === "agent_start") return { type: "lifecycle", summary: "agent started" };
    if (event.type === "agent_end") return { type: "lifecycle", summary: "agent finished" };
    if (event.type === "agent_settled") return { type: "lifecycle", summary: "settled" };

    // Skip noisy events
    if (event.type === "session") return { type: "session", summary: "session init" };

    if (event.raw) return { type: "raw", summary: event.raw.slice(0, 80) };
    return { type: event.type ?? "unknown", summary: "" };
  }

  async function readAll() {
    try {
      const content = await readFile(stdoutPath, "utf8");
      return parseLines(content);
    } catch {
      return [];
    }
  }

  async function checkForUpdates() {
    if (disposed) return;
    try {
      const info = await stat(stdoutPath);
      if (info.size > lastSize) {
        lastSize = info.size;
        const events = await readAll();
        for (const cb of listeners) cb(events);
      }
    } catch {
      // File not ready yet
    }
  }

  return {
    async tail(maxLines = 10) {
      const events = await readAll();
      return events.slice(-maxLines).map(e => ({ ...summarize(e), timestamp: e?.timestamp ?? e?.occurredAt ?? null }));
    },

    async lastActivity() {
      const events = await readAll();
      if (events.length === 0) return null;
      const last = events[events.length - 1];
      return { ...summarize(last), timestamp: last?.timestamp ?? last?.occurredAt ?? null };
    },

    onUpdate(callback) {
      listeners.push(callback);
      if (!pollTimer && !disposed) {
        pollTimer = setInterval(checkForUpdates, 500);
        pollTimer.unref?.();
      }
      return () => {
        listeners = listeners.filter(cb => cb !== callback);
        if (listeners.length === 0 && pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      };
    },

    dispose() {
      disposed = true;
      listeners = [];
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },
  };
}
