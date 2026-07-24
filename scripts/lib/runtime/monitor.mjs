import { readFile } from "node:fs/promises";
import { join } from "node:path";

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function parseJsonLines(content) {
  return content
    .split("\n")
    .filter(line => line.trim())
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function extractFinalOutput(events) {
  let lastAssistant = "";
  for (const event of events) {
    if (event?.type === "message_end" && event?.role === "assistant") {
      lastAssistant = event?.content ?? event?.text ?? "";
    }
    if (event?.type === "assistant" && typeof event?.message === "string") {
      lastAssistant = event.message;
    }
    // Pi JSON mode: content blocks
    if (event?.type === "content_block_stop" || event?.type === "message_stop") {
      // accumulate from prior content_block_delta events
    }
    if (Array.isArray(event?.content)) {
      const text = event.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("");
      if (text) lastAssistant = text;
    }
  }
  return lastAssistant;
}

function extractUsage(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.usage || e?.result?.usage) {
      return e.usage ?? e.result.usage;
    }
  }
  return null;
}

export function createMonitor(runDir, { pollIntervalMs = 200 } = {}) {
  let cachedStatus = null;
  let cachedEvents = null;
  let disposed = false;

  async function readStatus() {
    try {
      const raw = await readFile(join(runDir, "status.json"), "utf8");
      cachedStatus = JSON.parse(raw);
    } catch {
      // status.json not ready yet
    }
    return cachedStatus;
  }

  async function readEvents() {
    try {
      const raw = await readFile(join(runDir, "stdout.jsonl"), "utf8");
      cachedEvents = parseJsonLines(raw);
    } catch {
      cachedEvents = [];
    }
    return cachedEvents;
  }

  async function reconcile() {
    const status = await readStatus();
    if (status?.state === "running" && status?.pid) {
      if (!pidAlive(status.pid)) {
        const updated = {
          ...status,
          state: "failed",
          reason: "process_disappeared",
          endedAt: new Date().toISOString(),
        };
        const { writeFile: wf } = await import("node:fs/promises");
        await wf(join(runDir, "status.json"), JSON.stringify(updated)).catch(() => {});
        cachedStatus = updated;
      }
    }
    return cachedStatus;
  }

  return {
    async state() {
      const status = await reconcile();
      return status?.state ?? "unknown";
    },

    async pid() {
      const status = await readStatus();
      return status?.pid ?? null;
    },

    async output() {
      const events = await readEvents();
      return extractFinalOutput(events);
    },

    async usage() {
      const events = await readEvents();
      return extractUsage(events);
    },

    async waitForTerminal({ timeoutMs = 300_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (!disposed && Date.now() < deadline) {
        const s = await reconcile();
        if (s && ["complete", "failed"].includes(s.state)) return s.state;
        await new Promise(r => setTimeout(r, pollIntervalMs));
      }
      return "unknown";
    },

    dispose() {
      disposed = true;
    },
  };
}
