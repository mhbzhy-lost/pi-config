import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { createManagedWorktree, releaseManagedWorktree } from "../worktree-lifecycle/managed-worktree.mjs";
import { markDisposition } from "../worktree-lifecycle/registry.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function safe(value, name) { if (typeof value !== "string" || !ID.test(value)) throw new Error(`Invalid ${name}`); return value; }
function allocationId(root, goalId, taskId, attempt) { return `validation-${createHash("sha256").update(`${root}\0${goalId}\0${taskId}\0${attempt}`).digest("hex")}`; }
function birth(pid) {
  try { return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim() || null; } catch { return null; }
}
function cleanAt(lease) {
  if (!existsSync(lease.path) || git(lease.path, "rev-parse", "HEAD") !== lease.integratedHead) throw new Error("Validation workspace Git identity mismatch");
  if (git(lease.path, "status", "--porcelain=v1", "-z") !== "") throw new Error("Validation workspace must be clean");
}

/** Create an independent checkout at the exact integrated commit, never from executor state. */
export function createValidationWorkspace({ originRoot, stateRoot, goalId, taskId, attempt, integratedHead } = {}) {
  safe(goalId, "goalId"); safe(taskId, "taskId");
  if (!Number.isInteger(attempt) || attempt < 1 || typeof stateRoot !== "string") throw new Error("Invalid validation allocation");
  const root = realpathSync(originRoot);
  const head = git(root, "rev-parse", "--verify", `${integratedHead}^{commit}`);
  if (head !== integratedHead) throw new Error("integratedHead must be a full current commit SHA");
  const id = allocationId(root, goalId, taskId, attempt);
  const workspacePath = path.resolve(stateRoot, "validation-worktrees", `${goalId}-${taskId}-${attempt}`);
  const managed = createManagedWorktree({ originRoot: root, id, branch: `ge-validation/${goalId}/${taskId}/${attempt}`, baseCommit: head, path: workspacePath, owner: { kind: "goal-validation", id } });
  const lease = { id, originRoot: root, path: managed.path, ownerToken: managed.ownerToken, integratedHead: head, goalId, taskId, attempt };
  cleanAt(lease);
  return lease;
}

function killGroup(pid) { try { process.kill(-pid, "SIGTERM"); } catch {} }
function forceKillGroup(pid) { try { process.kill(-pid, "SIGKILL"); } catch {} }

/** Run an explicit host-provided action in a detached process group and return terminal proof. */
export function runCleanValidation({ lease, command, args = [], timeoutMs = 30 * 60_000, maxOutputBytes = 1_000_000 } = {}) {
  if (!lease || typeof command !== "string" || !Array.isArray(args) || !Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid validation plan");
  cleanAt(lease);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: lease.path, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: path.join(lease.path, ".validation-home"), TMPDIR: path.join(lease.path, ".validation-tmp") } });
    const identity = birth(child.pid);
    if (!identity) { killGroup(child.pid); reject(new Error("Unable to establish PID birth identity")); return; }
    let output = ""; let timedOut = false; let settled = false;
    const collect = (chunk) => { if (Buffer.byteLength(output) < maxOutputBytes) output += chunk.toString().slice(0, maxOutputBytes - Buffer.byteLength(output)); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const timer = setTimeout(() => { timedOut = true; killGroup(child.pid); setTimeout(() => forceKillGroup(child.pid), 100); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      if (settled) return; settled = true; clearTimeout(timer);
      // A PID can be reused; terminal proof is the original birth identity plus no live matching PID.
      const terminal = birth(child.pid) === null;
      if (!terminal) { reject(new Error("Validation process group is not terminal")); return; }
      let workspaceClean = false;
      try { cleanAt(lease); workspaceClean = true; } catch (error) { reject(error); return; }
      resolve({ status: timedOut ? "timed_out" : code === 0 ? "passed" : "failed", code, signal, output, terminal, pid: child.pid, pidBirthIdentity: identity, workspaceClean });
    });
  });
}

export function releaseValidationWorkspace(lease, { expectedHead } = {}) {
  if (!lease || expectedHead !== lease.integratedHead) throw new Error("Validation release identity mismatch");
  cleanAt(lease);
  // No validation process may retain this workspace as cwd. A portable ps probe is
  // deliberately conservative: inability to inspect is a release failure.
  let cwdUsers;
  try { cwdUsers = execFileSync("lsof", ["-t", "+D", lease.path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch (error) { if (error.status === 1) cwdUsers = ""; else throw new Error("Unable to verify validation workspace processes"); }
  if (cwdUsers) throw new Error("Validation workspace has active cwd/process");
  const reclaimable = markDisposition({ originRoot: lease.originRoot, id: lease.id, ownerToken: lease.ownerToken, disposition: "reclaimable" });
  if (reclaimable.headCommit !== expectedHead) throw new Error("Validation release HEAD identity mismatch");
  return releaseManagedWorktree({ originRoot: lease.originRoot, id: lease.id, ownerToken: lease.ownerToken });
}
