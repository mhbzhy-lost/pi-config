import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const STATES = new Set(["main", "active", "reclaimable", "preserved", "dirty", "sequencer", "cleanup-debt", "unmanaged", "missing"]);
const ACTIONS = new Set(["none", "report", "release-worktree-only"]);

export function parseWorktreePorcelain(text) {
  const records = [];
  let current;
  for (const entry of String(text).split("\0")) {
    if (!entry) continue;
    const space = entry.indexOf(" ");
    const key = space < 0 ? entry : entry.slice(0, space);
    const value = space < 0 ? "" : entry.slice(space + 1);
    if (key === "worktree") {
      current = { path: value };
      records.push(current);
    } else if (current) {
      if (key === "bare" || key === "detached") current[key] = true;
      else if (key === "locked" || key === "prunable") current[key] = value || true;
      else current[key] = value;
    }
  }
  return records;
}

function run(cwd, args, kind, probe) {
  const injected = probe?.({ kind, cwd, args });
  if (injected) return injected;
  try { return { ok: true, stdout: execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" }; }
  catch (error) { return { ok: false, stdout: error.stdout?.toString() || "", stderr: error.stderr?.toString() || error.message }; }
}

function ownerFor(root, path) {
  const directory = resolve(root, ".state/worktree-lifecycle/leases");
  try {
    for (const file of requireFiles(directory)) {
      const owner = JSON.parse(readFileSync(resolve(directory, file), "utf8"));
      if (resolve(owner.path) === resolve(path)) return owner;
    }
  } catch { return { state: "cleanup-debt", error: "owner-manifest-unreadable" }; }
  return null;
}
function requireFiles(directory) {
  // An absent registry is an ordinary unmanaged fact.
  try { return readdirSync(directory).filter((file) => file.endsWith(".json")); } catch { return []; }
}

export function classifyWorktreeFact(fact) {
  const reasons = [];
  let state;
  if (fact.probeFailed || fact.registration.locked || fact.owner?.state === "cleanup-debt") state = "cleanup-debt";
  else if (fact.main) state = "main";
  else if (!fact.pathExists) state = "missing";
  else if (fact.active) state = "active";
  else if (fact.operation) state = "sequencer";
  else if (fact.clean === false) state = "dirty";
  else if (!fact.owner) state = "unmanaged";
  else if (fact.owner.state === "preserved") state = "preserved";
  else if (fact.owner.state === "reclaimable" && fact.clean === true) state = "reclaimable";
  else state = "active";
  if (fact.probeFailed) reasons.push("probe-failed");
  if (fact.registration.locked) reasons.push("locked");
  if (fact.operation) reasons.push(`sequencer:${fact.operation}`);
  if (fact.clean === false) reasons.push("dirty");
  if (!fact.owner && !fact.main) reasons.push("no-owner");
  const automaticAction = state === "reclaimable" ? "release-worktree-only" : "none";
  if (!STATES.has(state) || !ACTIONS.has(automaticAction)) throw new Error("invalid worktree classification");
  return { state, reasons, automaticAction };
}

export async function inventoryRepositoryWorktrees({ originRoot, activeProcessCwds = [], probe } = {}) {
  const root = resolve(originRoot);
  const listed = run(root, ["worktree", "list", "--porcelain", "-z"], "list", probe);
  if (!listed.ok) {
    const registration = { path: root, probeError: "worktree-list" };
    return [{ registration, main: true, pathExists: existsSync(root), probeFailed: true, ...classifyWorktreeFact({ registration, main: true, pathExists: existsSync(root), probeFailed: true }) }];
  }
  return parseWorktreePorcelain(listed.stdout).map((registration, index) => {
    const pathExists = existsSync(registration.path);
    const main = index === 0 || resolve(registration.path) === root;
    const owner = main ? null : ownerFor(root, registration.path);
    const active = activeProcessCwds.some((cwd) => resolve(cwd).startsWith(`${resolve(registration.path)}/`) || resolve(cwd) === resolve(registration.path));
    let clean; let operation = null; let probeFailed = false;
    if (pathExists) {
      const status = run(registration.path, ["status", "--porcelain=v1", "-z"], "status", probe);
      const rev = run(registration.path, ["rev-parse", "--git-path", "MERGE_HEAD"], "rev-parse", probe);
      if (!status.ok || !rev.ok) probeFailed = true;
      else {
        clean = status.stdout.length === 0;
        for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
          const markerPath = run(registration.path, ["rev-parse", "--git-path", marker], "rev-parse", probe);
          if (!markerPath.ok) { probeFailed = true; break; }
          if (existsSync(markerPath.stdout.trim())) { operation = marker; break; }
        }
      }
    }
    const fact = { registration, main, pathExists, owner, active, clean, operation, probeFailed };
    return { ...fact, ...classifyWorktreeFact(fact) };
  });
}
