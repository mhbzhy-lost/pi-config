import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";

const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
const plain = (v) => v && typeof v === "object" && !Array.isArray(v);
function unsafe() { return Object.freeze({ safe: false, repo: { root: null, head: null, branch: null, trackedDirty: [], untracked: [], unmerged: [], sequencer: null }, adapters: [], environments: [], fixtures: [], resources: [], activeRuns: [] }); }
function git(root, args) { return execFileSync("git", args, { cwd: root, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] }); }
function registry(value, kind, fields) { if (!plain(value)) throw Error("unknown registry"); const rows = Object.entries(value).map(([ref, item]) => { if (!plain(item) || typeof ref !== "string" || !ref) throw Error("unknown registry"); const row = { ref, identity: item.identity ?? ref }; for (const field of fields) { if (typeof item[field] !== "string" && typeof item[field] !== "boolean" && typeof item[field] !== "number") throw Error("unknown registry"); row[field] = item[field]; } return row; }).sort((a, b) => a.ref.localeCompare(b.ref)); const identities = new Set(); for (const row of rows) { if (identities.has(String(row.identity))) throw Error(`duplicate ${kind} identity`); identities.add(String(row.identity)); delete row.identity; } return rows; }
function status(root) { const data = git(root, ["status", "--porcelain=v1", "-z"]); const trackedDirty = [], untracked = [], unmerged = []; for (const entry of data.toString("utf8").split("\0")) { if (!entry) continue; const code = entry.slice(0, 2), file = entry.slice(3); if (!file || file.includes("\0")) throw Error("invalid git status"); if (code === "??") untracked.push(digest(file)); else if (code.includes("U") || code === "AA" || code === "DD") unmerged.push(digest(file)); else trackedDirty.push(digest(file)); } return { trackedDirty: trackedDirty.sort(), untracked: untracked.sort(), unmerged: unmerged.sort() }; }
export function captureCurrentWorld({ repoRoot, adapterRegistry, environmentRegistry, fixtureRegistry, resourceRegistry = {}, runInventory = [] } = {}) {
  try {
    if (typeof repoRoot !== "string" || lstatSync(repoRoot).isSymbolicLink() || !lstatSync(repoRoot).isDirectory()) return unsafe();
    const root = realpathSync(repoRoot);
    const top = git(root, ["rev-parse", "--show-toplevel"]).toString("utf8").trim(); if (realpathSync(top) !== root) return unsafe();
    const head = git(root, ["rev-parse", "HEAD"]).toString("utf8").trim(); if (!/^[a-f0-9]{40}$/.test(head)) return unsafe();
    const branch = git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).toString("utf8").trim() || null;
    const s = status(root); const sequencer = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"].some((ref) => { try { git(root, ["rev-parse", "-q", "--verify", ref]); return true; } catch { return false; } }) ? "active" : null;
    const adapters = registry(adapterRegistry, "adapter", ["version"]), environments = registry(environmentRegistry, "environment", ["fingerprint", "available"]), fixtures = registry(fixtureRegistry, "fixture", ["fingerprint", "available"]);
    const resources = registry(resourceRegistry, "resource", ["capacity"]).map((r) => ({ ...r, holders: Array.isArray(resourceRegistry[r.ref].holders) ? [...resourceRegistry[r.ref].holders].sort() : (() => { throw Error("unknown resource"); })() }));
    if (!Array.isArray(runInventory) || runInventory.some((r) => !plain(r) || typeof r.runId !== "string" || !["executor", "observation"].includes(r.kind) || typeof r.state !== "string")) throw Error("unknown runs");
    const activeRuns = runInventory.map(({ runId, kind, state }) => ({ runId, kind, state })).sort((a, b) => a.runId.localeCompare(b.runId));
    const safe = !s.trackedDirty.length && !s.untracked.length && !s.unmerged.length && !sequencer && environments.every((x) => x.available) && fixtures.every((x) => x.available);
    return Object.freeze({ safe, repo: { root: digest(root), head, branch, ...s, sequencer }, adapters, environments, fixtures, resources, activeRuns });
  } catch { return unsafe(); }
}
