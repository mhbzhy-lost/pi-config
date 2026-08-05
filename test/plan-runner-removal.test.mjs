import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

async function assertAbsent(relative) {
  await assert.rejects(access(path.join(repoRoot, relative)), { code: "ENOENT" }, relative);
}

test("retired Plan Runner production packages are not deployable", async () => {
  for (const relative of [
    "pi/agents/plan-runner.md",
    "pi/agents/plan-reviewer.md",
    "pi/extensions/plan-launcher.ts",
    "pi/child-extensions/plan-runner.ts",
    "pi/child-extensions/plan-capsule.ts",
    "scripts/lib/plan",
    "skill-overrides/plan-runner-dispatch",
  ]) await assertAbsent(relative);
});

test("retired Plan Runner Goal Contract state is removed from the active registry", async () => {
  await assertAbsent(".state/goal-contract/goals/plan-runner-pi-subagents-parallel-harness");
  await assertAbsent(".state/goal-contract/goals/plan-ir-v3-complete-capsule-contract");
  const registry = JSON.parse(await readFile(path.join(repoRoot, ".state/goal-contract/registry.json"), "utf8"));
  assert.deepEqual(registry.active_goal_ids, []);
  assert.deepEqual(Object.keys(registry.goals), ["footer-native-child-conversation"]);
});

test("package and global Skill contracts expose no Plan Runner launch path", async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(Object.keys(packageJson.scripts).some((name) => name.includes("plan")), false);
  const skills = await readFile(path.join(repoRoot, "skill-overrides", "skills.list"), "utf8");
  assert.equal(skills.includes("plan-runner-dispatch"), false);
});
