import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";

const TASK_SPILL_THRESHOLD = 4000;

export async function spawnPiAgent({
  task,
  systemPrompt,
  model,
  cwd,
  skills = [],
  extensions = [],
  noExtensions = false,
  noSkills = false,
  env = {},
  runDir,
}) {
  if (!task || typeof task !== "string") throw new Error("task is required");
  if (!cwd || typeof cwd !== "string") throw new Error("cwd is required");

  const effectiveRunDir = runDir || join(tmpdir(), `pi-plan-run-${randomUUID()}`);
  await mkdir(effectiveRunDir, { recursive: true });

  const stdoutPath = join(effectiveRunDir, "stdout.jsonl");
  const stderrPath = join(effectiveRunDir, "stderr.log");
  const statusPath = join(effectiveRunDir, "status.json");

  const args = ["--mode", "json", "--no-session"];

  if (model) args.push("--model", model);
  if (noExtensions) args.push("--no-extensions");
  if (noSkills) args.push("--no-skills");

  for (const ext of extensions) args.push("--extension", ext);
  for (const skill of skills) args.push("--skill", skill);

  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);

  // Handle long tasks via temp file spill
  let taskCleanup;
  if (task.length > TASK_SPILL_THRESHOLD) {
    const taskFile = join(effectiveRunDir, "task-prompt.txt");
    await writeFile(taskFile, task);
    args.push("--prompt-file", taskFile);
  } else {
    args.push("-p", task);
  }

  const childEnv = {
    ...process.env,
    ...env,
    PI_SUBAGENT_DEPTH: String(Number(process.env.PI_SUBAGENT_DEPTH || "0") + 1),
  };

  const stdoutStream = createWriteStream(stdoutPath, { flags: "a" });
  const stderrStream = createWriteStream(stderrPath, { flags: "a" });

  const child = spawn("pi", args, {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
    windowsHide: true,
  });

  child.stdout.pipe(stdoutStream);
  child.stderr.pipe(stderrStream);
  child.unref();

  const pid = child.pid;
  const startedAt = new Date().toISOString();

  await writeFile(statusPath, JSON.stringify({ state: "running", pid, startedAt }));

  // Listen for exit to update status
  child.on("exit", async (code, signal) => {
    const endedAt = new Date().toISOString();
    const state = code === 0 ? "complete" : "failed";
    const status = { state, pid, startedAt, endedAt, exitCode: code, signal };
    try {
      await writeFile(statusPath, JSON.stringify(status));
    } catch {
      // Best effort status write on exit
    }
  });

  child.on("error", async (err) => {
    const endedAt = new Date().toISOString();
    const status = { state: "failed", pid, startedAt, endedAt, reason: "spawn_error", message: err.message };
    try {
      await writeFile(statusPath, JSON.stringify(status));
    } catch {
      // Best effort
    }
  });

  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", () => resolve({ code: 1, signal: null }));
  });

  return { pid, runDir: effectiveRunDir, statusPath, stdoutPath, stderrPath, exited };
}
