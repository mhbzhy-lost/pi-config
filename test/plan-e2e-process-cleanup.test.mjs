import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { terminateDetachedRun } from "./support/plan-e2e-process-cleanup.mjs";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`process ${pid} did not exit`);
}

test("terminateDetachedRun reaps the recorded runner and its child before fixture deletion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plan-e2e-cleanup-"));
  const asyncDir = join(root, "async-run");
  await mkdir(asyncDir);
  const runner = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    process.stdout.write(String(child.pid) + "\\n");
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(async () => {
    for (const pid of [runner.pid]) {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
    await rm(root, { recursive: true, force: true });
  });
  const childPid = Number(await new Promise((resolve, reject) => {
    runner.stdout.once("data", (chunk) => resolve(String(chunk).trim()));
    runner.once("error", reject);
  }));
  await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: "run-1", state: "running", pid: runner.pid }));

  await terminateDetachedRun({ runId: "run-1", asyncDir });
  await Promise.all([waitForExit(childPid), waitForExit(runner.pid)]);

  assert.equal(alive(childPid), false);
  assert.equal(alive(runner.pid), false);
});
