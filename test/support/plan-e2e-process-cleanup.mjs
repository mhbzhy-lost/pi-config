import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function processTree(rootPid) {
  const { stdout } = await run("ps", ["-axo", "pid=,ppid="]);
  const children = new Map();
  for (const line of stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const entries = children.get(ppid) ?? [];
    entries.push(pid);
    children.set(ppid, entries);
  }
  const descendants = [];
  const visit = (pid) => {
    for (const child of children.get(pid) ?? []) {
      visit(child);
      descendants.push(child);
    }
  };
  visit(rootPid);
  return descendants;
}

export async function processesReferencing(...paths) {
  const { stdout } = await run("ps", ["-axo", "pid=,command="]);
  return stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match || !paths.some((path) => match[2].includes(path))) return [];
    return [{ pid: Number(match[1]), command: match[2] }];
  });
}

async function waitForExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !alive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return pids.every((pid) => !alive(pid));
}

export async function terminateDetachedRun(handle, { timeoutMs = 2_000 } = {}) {
  if (!handle?.runId || !handle?.asyncDir) return;
  let status;
  try {
    status = JSON.parse(await readFile(join(handle.asyncDir, "status.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (status.runId !== handle.runId || !Number.isInteger(status.pid) || status.pid <= 1) {
    throw new Error("Detached Plan run status does not match its handle");
  }
  const pids = [...await processTree(status.pid), status.pid];
  for (const pid of pids) signal(pid, "SIGTERM");
  if (await waitForExit(pids, timeoutMs)) return;
  for (const pid of pids) signal(pid, "SIGKILL");
  if (!(await waitForExit(pids, timeoutMs))) {
    throw new Error(`Detached Plan process tree did not exit: ${pids.filter(alive).join(",")}`);
  }
}
