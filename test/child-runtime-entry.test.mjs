import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { materializeChildRuntimeEntry, removeChildRuntimeEntry } from "../scripts/lib/subagent-dispatch/child-runtime-entry.ts";

async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "child-runtime-entry-"));
  const targetDir = path.join(cwd, "target space");
  await mkdir(targetDir);
  const target = path.join(targetDir, "runtime.mjs");
  await writeFile(target, "export default 42;\n");
  return { cwd, target, targetUrl: pathToFileURL(target).href };
}

function mode(stats) { return stats.mode & 0o777; }
function source(targetUrl) { return `export { default } from ${JSON.stringify(targetUrl)};\n`; }

async function rejects(input, message) {
  await assert.rejects(() => materializeChildRuntimeEntry(input), message);
}

test("materializes canonical quoted entry with private permissions and removable receipt", async (t) => {
  const { cwd, target, targetUrl } = await fixture(); t.after(() => rm(cwd, { recursive: true, force: true }));
  const receipt = await materializeChildRuntimeEntry({ cwd, fileName: "runner.mjs", targetUrl });
  const canonicalUrl = pathToFileURL(await (await import("node:fs/promises")).realpath(target)).href;
  assert.ok(Object.isFrozen(receipt));
  assert.deepEqual(Object.keys(receipt).sort(), ["created", "cwd", "directoryPath", "entryPath", "sourceSha256", "targetUrl"]);
  const canonicalCwd = await (await import("node:fs/promises")).realpath(cwd);
  assert.deepEqual(receipt, { cwd: canonicalCwd, directoryPath: path.join(canonicalCwd, ".pi-subagents"), entryPath: path.join(canonicalCwd, ".pi-subagents", "runner.mjs"), targetUrl: canonicalUrl, sourceSha256: createHash("sha256").update(source(canonicalUrl)).digest("hex"), created: true });
  assert.equal(await readFile(receipt.entryPath, "utf8"), source(canonicalUrl));
  assert.equal(mode(await lstat(receipt.directoryPath)), 0o700); assert.equal(mode(await lstat(receipt.entryPath)), 0o600);
  await removeChildRuntimeEntry(receipt); await assert.rejects(() => lstat(receipt.entryPath)); await assert.rejects(() => lstat(receipt.directoryPath));
});

test("is idempotent only for identical private regular entry", async (t) => {
  const { cwd, targetUrl } = await fixture(); t.after(() => rm(cwd, { recursive: true, force: true }));
  const first = await materializeChildRuntimeEntry({ cwd, fileName: "runner.mjs", targetUrl });
  const second = await materializeChildRuntimeEntry({ cwd, fileName: "runner.mjs", targetUrl });
  assert.equal(second.created, false); assert.equal(second.sourceSha256, first.sourceSha256); await removeChildRuntimeEntry(second);
  assert.equal((await lstat(first.entryPath)).isFile(), true);
  await chmod(first.entryPath, 0o644);
  await rejects({ cwd, fileName: "runner.mjs", targetUrl }, /permission|existing/i);
});

test("rejects unsafe names, non-file targets, and canonicalizes target symlinks", async (t) => {
  const { cwd, target, targetUrl } = await fixture(); t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const fileName of ["", ".", "..", "a/b.mjs", "a\\b.mjs", "/a.mjs", "../a.mjs", "a.js", "a.mjs\0x"]) await rejects({ cwd, fileName, targetUrl }, /fileName/i);
  await rejects({ cwd, fileName: "a.mjs", targetUrl: "https://example.test/a.mjs" }, /file:/i);
  const linked = path.join(cwd, "linked.mjs"); await symlink(target, linked);
  const receipt = await materializeChildRuntimeEntry({ cwd, fileName: "linked.mjs", targetUrl: pathToFileURL(linked).href });
  assert.equal(receipt.targetUrl, pathToFileURL(await (await import("node:fs/promises")).realpath(target)).href);
});

test("fails closed for namespace symlink and unsafe existing entries", async (t) => {
  const { cwd, targetUrl } = await fixture(); t.after(() => rm(cwd, { recursive: true, force: true }));
  const outside = await mkdtemp(path.join(os.tmpdir(), "child-runtime-outside-")); t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(cwd, ".pi-subagents"));
  await rejects({ cwd, fileName: "a.mjs", targetUrl }, /symlink|directory/i);
  await rm(path.join(cwd, ".pi-subagents")); await mkdir(path.join(cwd, ".pi-subagents"), { mode: 0o700 });
  for (const setup of [async (entry) => symlink("/tmp", entry), async (entry) => mkdir(entry), async (entry) => writeFile(entry, "foreign\n")]) {
    const entry = path.join(cwd, ".pi-subagents", "a.mjs"); await setup(entry); await rejects({ cwd, fileName: "a.mjs", targetUrl }, /existing|symlink|regular|conflict/i); await rm(entry, { recursive: true, force: true });
  }
});

test("removal preserves changed entries and foreign namespace content", async (t) => {
  const { cwd, targetUrl } = await fixture(); t.after(() => rm(cwd, { recursive: true, force: true }));
  const receipt = await materializeChildRuntimeEntry({ cwd, fileName: "owned.mjs", targetUrl });
  await writeFile(receipt.entryPath, "changed\n"); await assert.rejects(() => removeChildRuntimeEntry(receipt), /changed|ownership|hash/i);
  assert.equal(await readFile(receipt.entryPath, "utf8"), "changed\n");
  const fresh = await materializeChildRuntimeEntry({ cwd, fileName: "fresh.mjs", targetUrl });
  const foreign = path.join(fresh.directoryPath, "foreign.txt"); await writeFile(foreign, "keep\n"); await removeChildRuntimeEntry(fresh);
  assert.equal(await readFile(foreign, "utf8"), "keep\n");
});

test("cleans temporary files when publication fails", async (t) => {
  const { cwd, targetUrl } = await fixture(); t.after(() => rm(cwd, { recursive: true, force: true }));
  const dir = path.join(cwd, ".pi-subagents"); await mkdir(dir, { mode: 0o700 }); await writeFile(path.join(dir, "race.mjs"), "foreign\n");
  await rejects({ cwd, fileName: "race.mjs", targetUrl }, /existing|conflict/i);
  assert.deepEqual((await readdir(dir)).sort(), ["race.mjs"]);
});
