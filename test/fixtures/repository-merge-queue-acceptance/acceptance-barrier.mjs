// Test-only extension source: production package manifests never include this file.
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const locator = "PI_ACCEPTANCE_BARRIER_DIR";
const runtimeRunKey = "PI_SUBAGENT_RUN_ID";
const execFileAsync = promisify(execFile);

/**
 * child run 身份来源（按当前生产合同，不再假设 launcher 会注入 PI_SUBAGENT_RUN_ID）：
 * 1. 已有 `PI_SUBAGENT_RUN_ID`（测试直接注入，或 integration-queue child extension 已解析并写回）；
 * 2. 否则用生产 helper `resolveChildBrokerIdentity` 从 `PI_SUBAGENT_EXTENSION_BINDINGS`
 *    与 root-broker authority 解析（helper 经 `PI_CODING_AGENT_DIR` 定位本仓源码，
 *    fixture 不复制一份绑定解码逻辑）。
 * 上游 pi-subagents 0.75 并不设置 `PI_SUBAGENT_RUN_ID`，而 profile 的
 * `subagentOnlyExtensions` 又先于 required child extensions 加载，因此本扩展不能
 * 依赖其它 child extension 之后才写入的环境变量；无法解析时 fail closed。
 */
async function resolveRunId(environment) {
  const direct = environment[runtimeRunKey];
  if (typeof direct === "string" && direct) return direct;
  if (environment.PI_SUBAGENT_CHILD !== "1" || !environment.PI_SUBAGENT_EXTENSION_BINDINGS) return undefined;
  const agentDir = environment.PI_CODING_AGENT_DIR;
  if (typeof agentDir !== "string" || !agentDir) return undefined;
  const helper = pathToFileURL(resolve(
    agentDir,
    "../packages/pi-subagents-enhanced/src/subagent-dispatch/child-broker-binding.ts",
  )).href;
  const { resolveChildBrokerIdentity } = await import(helper);
  const identity = await resolveChildBrokerIdentity(environment);
  return identity?.runId;
}

async function resolveRuntimeIdentity(environment) {
  const runId = await resolveRunId(environment);
  if (!runId) throw new Error("acceptance barrier cannot resolve the child run identity");
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
