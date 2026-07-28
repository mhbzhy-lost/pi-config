import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProcessFleetView } from "./process-fleet-view.mjs";

async function spawnFleetProcess({ task, cwd, model }) {
  const runDir = path.join(os.tmpdir(), `pi-process-fleet-${crypto.randomUUID()}`);
  await mkdir(runDir, { recursive: true });
  const statusPath = path.join(runDir, "status.json");
  const stdoutPath = path.join(runDir, "stdout.jsonl");
  const stderrPath = path.join(runDir, "stderr.log");
  const args = ["--mode", "json", "--no-session", "--no-extensions", "--no-skills"];
  if (model) args.push("--model", model);
  args.push("-p", task);
  const child = spawn("pi", args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.pipe(createWriteStream(stdoutPath, { flags: "a" }));
  child.stderr.pipe(createWriteStream(stderrPath, { flags: "a" }));
  child.unref();
  const startedAt = new Date().toISOString();
  await writeFile(statusPath, JSON.stringify({ state: "running", pid: child.pid, startedAt }));
  child.on("exit", (exitCode, signal) => {
    const state = exitCode === 0 ? "complete" : "failed";
    void writeFile(statusPath, JSON.stringify({ state, pid: child.pid, startedAt, endedAt: new Date().toISOString(), exitCode, signal })).catch(() => {});
  });
  child.on("error", (error) => {
    void writeFile(statusPath, JSON.stringify({ state: "failed", pid: child.pid, startedAt, endedAt: new Date().toISOString(), reason: "spawn_error", message: error.message })).catch(() => {});
  });
  return { pid: child.pid, runDir };
}

export default function fleetExtension(pi, { tui = null, matchesKey = null, Key = null } = {}) {
  const tracked = new Map();
  let fleet = null;
  let lastCtx = null;
  let focusMode = false;
  let selectedIndex = 0;
  let expandedIndex = -1;
  let unsubInput = null;

  function ensureFleet() {
    if (fleet) return fleet;
    fleet = createProcessFleetView(pi, {
      title: "Active Processes",
      entries: () => [...tracked.values()],
      tui,
      getState: () => ({ focusMode, selectedIndex, expandedIndex }),
    });
    if (lastCtx) fleet.bindContext(lastCtx);
    fleet.start();
    return fleet;
  }

  function activateFocusMode() {
    if (focusMode || !lastCtx?.hasUI) return;
    focusMode = true;
    const entries = [...tracked.values()];
    if (entries.length === 0) { focusMode = false; return; }
    selectedIndex = Math.min(selectedIndex, entries.length - 1);
    unsubInput = lastCtx.ui.onTerminalInput((data) => {
      const entries = [...tracked.values()];
      if (entries.length === 0) { deactivateFocusMode(); return { consume: true }; }

      const esc = matchesKey ? matchesKey(data, "escape") : (data === "\x1b" || (data.length === 1 && data.charCodeAt(0) === 27));
      if (esc) { deactivateFocusMode(); return { consume: true }; }

      const up = matchesKey ? matchesKey(data, "up") : (data === "\x1b[A" || data === "k");
      if (up) { selectedIndex = Math.max(0, selectedIndex - 1); if (fleet) fleet.refresh(); return { consume: true }; }

      const down = matchesKey ? matchesKey(data, "down") : (data === "\x1b[B" || data === "j");
      if (down) { selectedIndex = Math.min(entries.length - 1, selectedIndex + 1); if (fleet) fleet.refresh(); return { consume: true }; }

      const enter = matchesKey ? matchesKey(data, "return") : (data === "\r" || data === "\n");
      if (enter) { expandedIndex = expandedIndex === selectedIndex ? -1 : selectedIndex; if (fleet) fleet.refresh(); return { consume: true }; }
      return { consume: true }; // Consume all input in focus mode
    });
    if (fleet) fleet.refresh();
  }

  function deactivateFocusMode() {
    focusMode = false;
    expandedIndex = -1;
    if (unsubInput) { unsubInput(); unsubInput = null; }
    if (fleet) fleet.refresh();
  }

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    if (fleet) fleet.bindContext(ctx);

    // Register Alt+F to toggle focus mode
    if (ctx.hasUI) {
      ctx.ui.onTerminalInput((data) => {
        // Alt+F: \x1bf on Linux, ƒ on macOS
        if (data === "\x1bf" || data === "\u0192") {
          if (focusMode) deactivateFocusMode();
          else activateFocusMode();
          return { consume: true };
        }
        return undefined;
      });
    }
  });

  pi.on("tool_result", (_event, ctx) => {
    if (ctx) {
      lastCtx = ctx;
      if (fleet) fleet.bindContext(ctx);
    }
  });

  pi.registerTool({
    name: "spawn_process",
    label: "Spawn process",
    description: "Spawn a child pi process and track it in the fleet view. Use for long-running tasks that benefit from TUI observability.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", minLength: 1, description: "Task to delegate" },
        label: { type: "string", description: "Display label in fleet view" },
        model: { type: "string", description: "Optional model override" },
        cwd: { type: "string", description: "Working directory (defaults to current)" },
      },
      required: ["task"],
    },
    async execute(_id, params, _signal, _update, ctx) {
      const label = params.label || params.task.slice(0, 40);
      const cwd = params.cwd || ctx?.cwd || process.cwd();
      try {
        const handle = await spawnFleetProcess({
          task: params.task,
          cwd,
          model: params.model,
        });
        tracked.set(handle.runDir, { label, runDir: handle.runDir });
        if (ctx) lastCtx = ctx;
        const f = ensureFleet();
        if (ctx) f.bindContext(ctx);
        f.refresh();
        return {
          content: [{ type: "text", text: `Spawned: ${label} [pid=${handle.pid}]\nrunDir: ${handle.runDir}` }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : "Spawn failed" }],
          isError: true,
        };
      }
    },
  });

  pi.on("session_shutdown", () => {
    deactivateFocusMode();
    if (fleet) { fleet.dispose(); fleet = null; }
    tracked.clear();
  });
}
