import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { stopAgent, interruptAgent } from "../scripts/lib/runtime/control.mjs";

function spawnSleeper() {
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("stopAgent", () => {
  it("throws on invalid pid", async () => {
    await assert.rejects(() => stopAgent(0), /Invalid pid/);
    await assert.rejects(() => stopAgent(-1), /Invalid pid/);
  });

  it("returns already_dead for non-existent pid", async () => {
    const result = await stopAgent(2147483647);
    assert.equal(result, "already_dead");
  });

  it("stops a running process gracefully", async () => {
    const pid = spawnSleeper();
    assert.equal(pidAlive(pid), true);
    const result = await stopAgent(pid, { graceMs: 2000 });
    assert.ok(["stopped", "killed"].includes(result));
    assert.equal(pidAlive(pid), false);
  });

  it("force kills a process that ignores SIGTERM", async () => {
    // Use a shell that traps SIGTERM
    const child = spawn("sh", ["-c", "trap '' TERM; sleep 60"], { detached: true, stdio: "ignore" });
    child.unref();
    const pid = child.pid;
    await new Promise(r => setTimeout(r, 200));
    const result = await stopAgent(pid, { graceMs: 200 });
    assert.equal(result, "killed");
    const deadline = Date.now() + 500;
    while (pidAlive(pid) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(pidAlive(pid), false);
  });
});

describe("interruptAgent", () => {
  it("does not throw for non-existent pid", async () => {
    await interruptAgent(2147483647);
  });

  it("throws on invalid pid", async () => {
    await assert.rejects(() => interruptAgent(0), /Invalid pid/);
  });

  it("sends SIGINT to a running process", async () => {
    const pid = spawnSleeper();
    await interruptAgent(pid);
    // Give a moment for signal delivery
    await new Promise(r => setTimeout(r, 100));
    assert.equal(pidAlive(pid), false);
  });
});
