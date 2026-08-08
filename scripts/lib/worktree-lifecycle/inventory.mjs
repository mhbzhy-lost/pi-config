import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

const MANIFEST_KEYS = ["schemaVersion", "id", "ownerKind", "ownerId", "ownerToken", "originRoot", "gitCommonDir", "path", "branchRef", "baseCommit", "headCommit", "state", "createdAt", "updatedAt", "disposition", "lastError"];
const STATES = new Set(["allocating", "active", "reclaimable", "preserved", "cleanup-debt", "released"]);
const CODES = { active: "WORKTREE_OWNER_ACTIVE", reclaimable: "WORKTREE_CLEANUP_DEBT", preserved: "WORKTREE_PRESERVED", dirty: "WORKTREE_DIRTY", sequencer: "WORKTREE_SEQUENCER_ACTIVE", "cleanup-debt": "WORKTREE_CLEANUP_DEBT", unmanaged: "WORKTREE_UNMANAGED", missing: "WORKTREE_IDENTITY_MISMATCH", mismatch: "WORKTREE_IDENTITY_MISMATCH", released: null, main: null };
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const tokenPattern = /^worktree-owner\.v1:[a-f0-9]{64}$/;
const hashPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export function parseWorktreePorcelain(text) {
  const records = [];
  let current;
  for (const entry of String(text).split("\0")) {
    if (!entry) continue;
    const space = entry.indexOf(" ");
    const key = space < 0 ? entry : entry.slice(0, space);
    const value = space < 0 ? "" : entry.slice(space + 1);
    if (key === "worktree") { current = { path: value }; records.push(current); }
    else if (current) current[key] = key === "bare" || key === "detached" ? true : value || true;
  }
  return records;
}

function run(cwd, args, kind, probe) {
  const injected = probe?.({ kind, cwd, args });
  if (injected) return injected;
  try { return { ok: true, stdout: execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }), stderr: "" }; }
  catch { return { ok: false, stdout: "", stderr: "" }; }
}
function exactKeys(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()); }
function validTime(value) { return typeof value === "string" && !Number.isNaN(Date.parse(value)); }
function validManifest(manifest, filename, root, mode) {
  if (mode !== 0o600 || !exactKeys(manifest, MANIFEST_KEYS) || manifest.schemaVersion !== "worktree-lifecycle.owner.v1") return false;
  if (typeof manifest.id !== "string" || !idPattern.test(manifest.id) || basename(manifest.id) !== manifest.id || filename !== `${manifest.id}.json`) return false;
  if (!["ownerKind", "ownerId"].every((key) => typeof manifest[key] === "string" && manifest[key].trim()) || !tokenPattern.test(manifest.ownerToken)) return false;
  if (!["originRoot", "gitCommonDir", "path"].every((key) => typeof manifest[key] === "string" && isAbsolute(manifest[key]))) return false;
  if (resolve(manifest.originRoot) !== root || !manifest.branchRef?.startsWith("refs/heads/") || !hashPattern.test(manifest.baseCommit) || !(manifest.headCommit === null || hashPattern.test(manifest.headCommit))) return false;
  if (!STATES.has(manifest.state) || !validTime(manifest.createdAt) || !validTime(manifest.updatedAt)) return false;
  if (!(manifest.disposition === null || (exactKeys(manifest.disposition, ["state", "reason"]) && STATES.has(manifest.disposition.state) && (manifest.disposition.reason === null || typeof manifest.disposition.reason === "string")))) return false;
  return manifest.lastError === null || (exactKeys(manifest.lastError, ["code", "message", "at"]) && typeof manifest.lastError.code === "string" && typeof manifest.lastError.message === "string" && validTime(manifest.lastError.at));
}
function readManifests(root) {
  const directory = resolve(root, ".state/worktree-lifecycle/leases");
  try {
    return readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => {
      const file = resolve(directory, name);
      try {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe");
        const manifest = JSON.parse(readFileSync(file, "utf8"));
        if (manifest.schemaVersion === 1) return { manifest, legacy: true, name };
        return validManifest(manifest, name, root, stat.mode & 0o777) ? { manifest, name } : { invalid: true, name };
      } catch { return { invalid: true, name }; }
    });
  } catch { return []; }
}
function hasExactIdentity(root, registration, owner, probe) {
  if (!owner || !registration || !existsSync(registration.path)) return false;
  try {
    const top = run(registration.path, ["rev-parse", "--show-toplevel"], "identity", probe);
    const common = run(registration.path, ["rev-parse", "--git-common-dir"], "identity", probe);
    const branch = run(registration.path, ["symbolic-ref", "-q", "HEAD"], "identity", probe);
    const head = run(registration.path, ["rev-parse", "--verify", "HEAD^{commit}"], "identity", probe);
    if (![top, common, branch, head].every((result) => result.ok)) return false;
    const commonPath = resolve(registration.path, common.stdout.trim());
    return realpathSync(registration.path) === owner.path && realpathSync(top.stdout.trim()) === owner.path && realpathSync(commonPath) === owner.gitCommonDir && branch.stdout.trim() === owner.branchRef && head.stdout.trim() === owner.headCommit && registration.branch === owner.branchRef && owner.originRoot === root;
  } catch { return false; }
}

export function classifyWorktreeFact(fact) {
  let state = "active";
  if (fact.probeFailed || fact.mismatch || fact.registration?.locked || fact.owner?.state === "cleanup-debt") state = "cleanup-debt";
  else if (fact.main) state = "main";
  else if (!fact.pathExists) state = "missing";
  else if (fact.active) state = "active";
  else if (fact.operation) state = "sequencer";
  else if (fact.clean === false) state = "dirty";
  else if (!fact.owner) state = "unmanaged";
  else if (fact.owner.state === "preserved") state = "preserved";
  else if (fact.owner.state === "released") state = "released";
  else if (fact.owner.state === "reclaimable" && fact.clean === true && fact.identity !== false) state = "reclaimable";
  const reasons = [];
  if (fact.probeFailed) reasons.push("probe-failed");
  if (fact.operation) reasons.push(`sequencer:${fact.operation}`);
  if (fact.clean === false) reasons.push("dirty");
  if (!fact.owner && !fact.main) reasons.push("no-owner");
  return { state, reasons, automaticAction: state === "reclaimable" ? "release-worktree-only" : "none" };
}
function publicFact(fact) {
  const classified = classifyWorktreeFact(fact);
  const resources = `${fact.pathExists ? "1" : "0"}${fact.registration ? "1" : "0"}${fact.manifestPresent ? "1" : "0"}`;
  const state = fact.manifestOnlyReclaimable ? "reclaimable" : fact.manifestOnlyReleased ? "released" : classified.state;
  return { registration: fact.registration, path: fact.registration?.path ?? fact.owner?.path ?? fact.path, id: fact.owner?.id ?? fact.id, owner: fact.owner ? { kind: fact.owner.ownerKind, id: fact.owner.ownerId } : undefined, resources, state, reasons: classified.reasons, automaticAction: state === "reclaimable" && !fact.mismatch ? "release-worktree-only" : "none", code: fact.mismatch ? CODES.mismatch : CODES[state], severity: state === "reclaimable" || state === "cleanup-debt" ? "warning" : "diagnostic" };
}

export async function inventoryRepositoryWorktrees({ originRoot, activeProcessCwds = [], probe } = {}) {
  const root = resolve(originRoot);
  const listed = run(root, ["worktree", "list", "--porcelain", "-z"], "list", probe);
  if (!listed.ok) return [publicFact({ registration: { path: root }, main: true, pathExists: existsSync(root), probeFailed: true })];
  const entries = readManifests(root);
  const registrations = parseWorktreePorcelain(listed.stdout);
  const used = new Set();
  const facts = registrations.map((registration, index) => {
    const matches = entries.filter((entry) => entry.manifest && resolve(entry.manifest.path) === resolve(registration.path));
    matches.forEach((entry) => used.add(entry));
    const entry = matches.length === 1 ? matches[0] : null;
    const owner = entry?.manifest;
    const pathExists = existsSync(registration.path);
    let clean; let operation; let probeFailed = false;
    if (pathExists) {
      const status = run(registration.path, ["status", "--porcelain=v1", "-z"], "status", probe);
      if (!status.ok) probeFailed = true;
      else {
        clean = status.stdout.length === 0;
        for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
          const result = run(registration.path, ["rev-parse", "--git-path", marker], "rev-parse", probe);
          if (!result.ok) { probeFailed = true; break; }
          if (existsSync(result.stdout.trim())) { operation = marker; break; }
        }
      }
    }
    const main = index === 0 || resolve(registration.path) === root;
    const duplicate = matches.length > 1;
    return publicFact({ registration, main, owner, pathExists, manifestPresent: Boolean(owner), legacy: entry?.legacy, mismatch: duplicate || (owner && !entry.legacy && !hasExactIdentity(root, registration, owner, probe)), active: activeProcessCwds.some((cwd) => resolve(cwd) === resolve(registration.path) || resolve(cwd).startsWith(`${resolve(registration.path)}/`)), clean, operation, probeFailed, identity: entry?.legacy ? undefined : hasExactIdentity(root, registration, owner, probe) });
  });
  for (const entry of entries) {
    if (used.has(entry)) continue;
    if (entry.invalid) { facts.push(publicFact({ id: entry.name.replace(/\.json$/, ""), path: resolve(root, ".state/worktree-lifecycle/leases", entry.name), manifestPresent: true, mismatch: true })); continue; }
    const owner = entry.manifest;
    const duplicates = entries.filter((other) => other.manifest?.id === owner.id).length !== 1;
    const pathExists = existsSync(owner.path);
    const isReleased = owner.state === "released";
    facts.push(publicFact({ owner, path: owner.path, pathExists, manifestPresent: true, legacy: entry.legacy, mismatch: duplicates || (!entry.legacy && !isReleased), manifestOnlyReclaimable: !entry.legacy && owner.state === "reclaimable" && !pathExists, manifestOnlyReleased: !entry.legacy && isReleased && !pathExists }));
  }
  return facts;
}

export async function reconcileManagedWorktrees({ originRoot, apply = false, activeProcessCwds = [], ttlMs = 0, now = Date.now(), probe } = {}) {
  // Age is intentionally diagnostic only: authorization is based on current identity.
  void ttlMs; void now;
  let items = await inventoryRepositoryWorktrees({ originRoot, activeProcessCwds, probe });
  if (!apply) return { apply: false, items };
  const root = resolve(originRoot);
  const entries = readManifests(root);
  for (const item of items.filter((candidate) => candidate.automaticAction === "release-worktree-only" && candidate.id && (candidate.resources === "111" || candidate.resources === "001"))) {
    const entry = entries.find((candidate) => !candidate.legacy && candidate.manifest?.id === item.id);
    if (!entry) continue;
    try {
      const { releaseManagedWorktree } = await import("./managed-worktree.mjs");
      releaseManagedWorktree({ originRoot: root, id: entry.manifest.id, ownerToken: entry.manifest.ownerToken });
    } catch { /* a fresh inventory reports the durable cleanup-debt fact */ }
  }
  items = await inventoryRepositoryWorktrees({ originRoot, activeProcessCwds, probe });
  return { apply: true, items };
}
