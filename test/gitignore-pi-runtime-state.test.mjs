import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname;

function checkIgnore(path) {
  return spawnSync("git", ["check-ignore", "-v", "--", path], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

test("忽略 Pi runtime profiles 与 missions，但保留测试 fixture", () => {
  for (const path of [
    "pi/missions/index/runtime-state.json",
    "pi/missions/projects/demo/task.json",
    "pi/profiles/pi-subagents/demo.json",
    "pi/profiles/pi-subagents/providers/demo.models.json",
  ]) {
    const result = checkIgnore(path);
    assert.equal(result.status, 0, `${path} 应被忽略：${result.stderr}`);
  }

  const fixture = checkIgnore("test/fixtures/pi-subagents/profiles/demo.json");
  assert.equal(fixture.status, 1, `测试 fixture 不应被忽略：${fixture.stdout}`);
});
