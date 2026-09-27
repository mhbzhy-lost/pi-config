import { spawn } from "node:child_process";
import process from "node:process";

const POSIX = process.platform !== "win32" && process.platform !== "android";

function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) {
    throw new Error("refusing to inspect an unknown process group");
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw new Error(`cannot prove process-group ownership (${error?.code ?? "unknown"})`);
  }
}

function sendGroupSignal(pgid, signal) {
  if (!Number.isInteger(pgid) || pgid <= 1) {
    throw new Error("refusing to signal an unknown process group");
  }
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw new Error(`cannot signal owned process group (${error?.code ?? "unknown"})`);
  }
}

function boundedText(limit) {
  let text = "";
  return {
    append(chunk) {
      if (text.length < limit) text += chunk.toString().slice(0, limit - text.length);
    },
    value() { return text; },
  };
}

/** Spawn a test-only detached POSIX process group and reclaim only that group. */
export function spawnIsolatedProcessGroup({
  command,
  args = [],
  cwd,
  env,
  totalTimeoutMs = 45_000,
  termGraceMs = 5_000,
  maxOutputBytes = 64 * 1024,
  pid,
}) {
  if (!POSIX) return Promise.reject(new Error("POSIX process-group semantics are unavailable"));
  if (pid !== undefined) return Promise.reject(new Error("unknown process-group identity; refusing to spawn"));
  if (!Number.isFinite(totalTimeoutMs) || totalTimeoutMs < 0 || !Number.isFinite(termGraceMs) || termGraceMs < 0) {
    return Promise.reject(new Error("invalid process-group timeout"));
  }

  const startedAt = Date.now();
  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return Promise.reject(error);
  }
  const pgid = child.pid;
  if (!Number.isInteger(pgid) || pgid <= 1) {
    child.kill();
    return Promise.reject(new Error("spawn did not provide an owned process-group identity"));
  }

  const stdout = boundedText(maxOutputBytes);
  const stderr = boundedText(maxOutputBytes);
  child.stdout.on("data", (chunk) => stdout.append(chunk));
  child.stderr.on("data", (chunk) => stderr.append(chunk));

  return new Promise((resolve, reject) => {
    let timedOut = false;
    let settled = false;
    let closeInfo;
    const signalsSent = [];
    let timer;
    const closePromise = new Promise((closeResolve) => {
      child.once("close", (code, signal) => {
        closeInfo = { code, signal };
        closeResolve();
      });
      child.once("error", (error) => {
        if (!closeInfo) closeInfo = { error };
      });
    });
    const finish = async () => {
      await closePromise;
      const alive = groupAlive(pgid);
      if (!timedOut && alive) throw new Error("owned process group survived normal exit");
      if (settled) return;
      settled = true;
      resolve({
        child,
        code: closeInfo?.code ?? null,
        signal: closeInfo?.signal ?? null,
        stdout: stdout.value(),
        stderr: stderr.value(),
        timedOut,
        termination: {
          signalsSent,
          groupId: pgid,
          groupAliveAfterTerm: timedOut ? groupAliveAfterTerm : false,
          groupAliveAfterKill: groupAlive(pgid),
          leaderClosed: true,
        },
        elapsedMs: Date.now() - startedAt,
      });
    };
    let groupAliveAfterTerm = false;
    const timeout = async () => {
      timedOut = true;
      try {
        if (sendGroupSignal(pgid, "SIGTERM")) signalsSent.push("SIGTERM");
        groupAliveAfterTerm = groupAlive(pgid);
        await new Promise((r) => setTimeout(r, termGraceMs));
        if (groupAlive(pgid) && sendGroupSignal(pgid, "SIGKILL")) signalsSent.push("SIGKILL");
        await finish();
      } catch (error) {
        if (!settled) { settled = true; reject(error); }
      }
    };
    timer = setTimeout(timeout, totalTimeoutMs);
    child.once("close", () => {
      if (!timedOut) {
        clearTimeout(timer);
        finish().catch((error) => { if (!settled) { settled = true; reject(error); } });
      }
    });
  });
}
