// Test-only extension source: production package manifests never include this file.
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const locator = "PI_ACCEPTANCE_BARRIER_DIR";
const runtimeRunKey = "PI_SUBAGENT_RUN_ID";
const execFileAsync = promisify(execFile);

async function resolveRuntimeIdentity(environment) {
  const runId = environment[runtimeRunKey];
  if (!runId) throw new Error("PI_SUBAGENT_RUN_ID is unavailable");
  const worktree = process.cwd();
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" });
  return { runId, worktree, baseCommit: stdout.trim() };
}

async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx" });
  await rename(temporary, path);
}

export async function writeAcceptanceReadyReceipt(environment = process.env) {
  const directory = environment[locator];
  const { runId, worktree, baseCommit } = await resolveRuntimeIdentity(environment);
  if (!directory || !runId || !worktree || !baseCommit) throw new Error("acceptance barrier locator or process identity is unavailable");
  await mkdir(directory, { recursive: true });
  const receipt = { schemaVersion: "repository-merge-queue-ready.v1", runId, worktree, baseCommit, pid: process.pid };
  await atomicJson(join(directory, `${runId}.ready.json`), receipt);
  return receipt;
}

async function waitForRelease(environment = process.env, timeoutMs = 30 * 60 * 1000) {
  const directory = environment[locator];
  if (!directory) throw new Error("acceptance barrier locator is unavailable");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(join(directory, "release.json"), "utf8")); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("acceptance barrier release timed out");
}

export default async function acceptanceBarrierExtension() {
  await writeAcceptanceReadyReceipt();
  await waitForRelease();
}
