import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { captureCurrentWorld } from "../scripts/lib/goal-engine/current-world.mjs";

function repo() { const root = mkdtempSync(join(tmpdir(), "world-")); execFileSync("git", ["init"], { cwd: root }); execFileSync("git", ["config", "user.email", "a@b.invalid"], { cwd: root }); execFileSync("git", ["config", "user.name", "Test"], { cwd: root }); writeFileSync(join(root, "a"), "a"); execFileSync("git", ["add", "a"], { cwd: root }); execFileSync("git", ["commit", "-m", "init"], { cwd: root }); return root; }
const registries = { adapterRegistry: { oracle: { version: "1" } }, environmentRegistry: { local: { fingerprint: "e", available: true } }, fixtureRegistry: { sample: { fingerprint: "f", available: true } }, resourceRegistry: { cpu: { capacity: 1, holders: [] } }, runInventory: [] };
test("snapshot is canonical, redacted, and closes on dirty or unknown Git state", () => { const root = repo(); const clean = captureCurrentWorld({ repoRoot: root, ...registries }); assert.equal(clean.safe, true); assert.deepEqual(Object.keys(clean.repo).sort(), ["branch", "head", "root", "sequencer", "trackedDirty", "unmerged", "untracked"]); assert.equal(JSON.stringify(clean).includes(root), false); writeFileSync(join(root, "a"), "changed"); assert.equal(captureCurrentWorld({ repoRoot: root, ...registries }).safe, false); writeFileSync(join(root, "new"), "x"); assert.equal(captureCurrentWorld({ repoRoot: root, ...registries }).safe, false); });
test("snapshot rejects symlink roots and duplicate registry identity", () => { const root = repo(), link = `${root}-link`; symlinkSync(root, link); assert.equal(captureCurrentWorld({ repoRoot: link, ...registries }).safe, false); assert.equal(captureCurrentWorld({ repoRoot: root, ...registries, adapterRegistry: { a: { version: "1", identity: "x" }, b: { version: "2", identity: "x" } } }).safe, false); });
