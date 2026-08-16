import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";

const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
const plain = (v) => v && typeof v === "object" && !Array.isArray(v);
const emptyRepo = () => ({ root: null, head: null, branch: null, trackedDirty: [], untracked: [], unmerged: [], sequencer: null });
function unsafe(reason = "capture-failed") { return Object.freeze({ safe: false, reason, repo: emptyRepo(), adapters: [], environments: [], fixtures: [], resources: [], activeRuns: [], capturedAt: new Date().toISOString() }); }
function defaultGit(root, args) { return execFileSync("git", args, { cwd: root, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] }); }
function text(value) { const b = Buffer.isBuffer(value) ? value : Buffer.from(value); const out = b.toString("utf8"); if (!Buffer.from(out).equals(b)) throw Error("non-utf8 git output"); return out.trim(); }
function relative(path) { return typeof path === "string" && path && !path.includes("\0") && !path.startsWith("/") && !path.split("/").some((part) => !part || part === "." || part === "..") && !/^[A-Za-z]:/.test(path); }
function afterSpaces(record, count) { let at = -1; while (count--) { at = record.indexOf(" ", at + 1); if (at < 0) throw Error("invalid porcelain v2"); } return record.slice(at + 1); }
function status(root, git) { const raw = git(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]); const buffers = Buffer.isBuffer(raw) ? raw.toString("binary").split("\0").map((part) => Buffer.from(part, "binary")) : String(raw).split("\0").map((part) => Buffer.from(part)); const parts = buffers.map((part) => { const decoded = part.toString("utf8"); if (!Buffer.from(decoded).equals(part)) throw Error("non-utf8 status path"); return decoded; }); const trackedDirty = [], untracked = [], unmerged = [];
  for (let i = 0; i < parts.length; i++) { const entry = parts[i]; if (!entry) continue; let code, paths;
    if (entry.startsWith("? ")) { code = "??"; paths = [entry.slice(2)]; }
    else if (entry.startsWith("u ")) { code = "UU"; paths = [afterSpaces(entry, 10)]; }
    else if (entry.startsWith("1 ")) { code = entry.slice(2, 4); paths = [afterSpaces(entry, 8)]; }
    else if (entry.startsWith("2 ")) { code = entry.slice(2, 4); paths = [afterSpaces(entry, 9), parts[++i]]; }
    else throw Error("unknown porcelain record");
    if (paths.some((path) => !relative(path))) throw Error("unsafe repo relative path");
    const target = code === "??" ? untracked : code.includes("U") || code === "AA" || code === "DD" ? unmerged : trackedDirty;
    target.push(...paths);
  }
  return { trackedDirty: [...new Set(trackedDirty)].sort(), untracked: [...new Set(untracked)].sort(), unmerged: [...new Set(unmerged)].sort() };
}
function registry(value, kind, fields) { if (!plain(value)) throw Error("unknown registry"); const seen = new Set(); return Object.entries(value).map(([ref, row]) => { if (!relative(ref) || !plain(row)) throw Error("unknown registry"); const identity = row.identity ?? ref; if (typeof identity !== "string" || seen.has(identity)) throw Error(`duplicate ${kind} identity`); seen.add(identity); const out = { ref }; for (const field of fields) { if (typeof row[field] !== "string" && typeof row[field] !== "boolean" && typeof row[field] !== "number") throw Error("unknown registry"); out[field] = row[field]; } return out; }).sort((a, b) => a.ref.localeCompare(b.ref)); }
function resources(value) { if (!plain(value)) throw Error("unknown resources"); const seen = new Set(); return Object.entries(value).map(([key, row]) => { if (!relative(key) || !plain(row) || seen.has(key) || !Number.isSafeInteger(row.capacity) || row.capacity < 0 || !Array.isArray(row.holders) || row.holders.some((x) => typeof x !== "string" || !x)) throw Error("unknown resources"); seen.add(key); return { key, holders: [...new Set(row.holders)].sort(), capacity: row.capacity }; }).sort((a, b) => a.key.localeCompare(b.key)); }
function hasSequencer(root, git) { for (const ref of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"]) { try { if (text(git(root, ["rev-parse", "-q", "--verify", ref]))) return ref.toLowerCase(); } catch {} } for (const name of ["rebase-merge", "rebase-apply"]) { try { const path = text(git(root, ["rev-parse", "--git-path", name])); if (lstatSync(path).isDirectory()) return name; } catch {} } return null; }
export function captureCurrentWorld({ repoRoot, adapterRegistry, environmentRegistry, fixtureRegistry, resourceRegistry = {}, runInventory = [], gitRunner = defaultGit } = {}) { try {
  if (typeof repoRoot !== "string" || lstatSync(repoRoot).isSymbolicLink() || !lstatSync(repoRoot).isDirectory() || typeof gitRunner !== "function") return unsafe("unsafe-repo-root");
  const root = realpathSync(repoRoot), git = gitRunner; const top = text(git(root, ["rev-parse", "--show-toplevel"])); if (realpathSync(top) !== root) return unsafe("repo-root-mismatch");
  const head = text(git(root, ["rev-parse", "HEAD"])); if (!/^[a-f0-9]{40}$/.test(head)) return unsafe("invalid-head"); let branch = null; try { branch = text(git(root, ["symbolic-ref", "--short", "-q", "HEAD"])) || null; } catch {}
  const dirty = status(root, git), sequencer = hasSequencer(root, git), adapters = registry(adapterRegistry, "adapter", ["version"]), environments = registry(environmentRegistry, "environment", ["fingerprint", "available"]), fixtures = registry(fixtureRegistry, "fixture", ["fingerprint", "available"]), resourceRows = resources(resourceRegistry);
  if (!Array.isArray(runInventory) || runInventory.some((r) => !plain(r) || typeof r.runId !== "string" || !["executor", "observation"].includes(r.kind) || typeof r.state !== "string")) throw Error("unknown runs");
  const activeRuns = runInventory.map(({ runId, kind, state }) => ({ runId, kind, state })).sort((a, b) => a.runId.localeCompare(b.runId)); const safe = !dirty.trackedDirty.length && !dirty.untracked.length && !dirty.unmerged.length && !sequencer && environments.every((x) => x.available) && fixtures.every((x) => x.available);
  return Object.freeze({ safe, repo: { root: digest(root), head, branch, ...dirty, sequencer }, adapters, environments, fixtures, resources: resourceRows, activeRuns, capturedAt: new Date().toISOString() });
} catch (error) { return unsafe(error?.message === "git unavailable" ? "git-unavailable" : "capture-failed"); } }
