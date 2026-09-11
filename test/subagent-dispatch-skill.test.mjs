import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Compile } from "../pi/npm/node_modules/typebox/build/compile/index.mjs";
import { preparePublicCodingDispatch, TYPED_SUBAGENT_PARAMETERS } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";
import { discoverManagedSkills } from "../src/skill-whitelist/skill.ts";

const validator = Compile(TYPED_SUBAGENT_PARAMETERS);
const skillPath = new URL("../skill-overrides/subagent-dispatch/SKILL.md", import.meta.url);

function documentedCalls(markdown) {
  return [...markdown.matchAll(/```js\nsubagent\((\{[\s\S]*?\})\);\n```/g)]
    .map(([, source]) => Function(`"use strict"; return (${source});`)());
}

test("subagent-dispatch documents only scoped subagent_worktree lifecycle actions", async () => {
  const skill = await readFile(skillPath, "utf8");
  assert.doesNotMatch(skill, /subagent\(\{action:\"workspace_(?:status|disposition)/);
  assert.match(skill, /subagent_worktree\(\{ action: "list" \}\)/);
  assert.match(skill, /subagent_worktree\(\{ action: "status", workspace_id: workspaceId \}\)/);
  assert.match(skill, /subagent_worktree\(\{ action: "dispose", workspace_id: workspaceId, disposition: "integrate", action_token: actionToken \}\)/);
  assert.match(skill, /subagent_worktree\(\{ action: "release", workspace_id: workspaceId \}\)/);
  assert.match(skill, /completion\/status.*terminal proof|terminal proof.*completion\/status/is);
  assert.match(skill, /raw git worktree add\/remove\/prune\/move\/repair\/lock\/unlock/i);
});

test("subagent-dispatch remains a discoverable managed Skill with executable typed and generic examples", async () => {
  const skill = await readFile(skillPath, "utf8");
  assert.match(skill, /^---\nname: subagent-dispatch\ndescription: .+\n---/);
  const skills = await discoverManagedSkills(process.cwd());
  assert.ok(skills.has("subagent-dispatch"));

  const calls = documentedCalls(skill);
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(validator.Check(call), true, JSON.stringify([...validator.Errors(call)]));

  const coding = calls.find((call) => call.version === "dispatch-ir.v1");
  assert.ok(coding);
  assert.equal(coding.risk, "normal");
  // public coding ABI 不提供 execution.timeoutMs；编译必须走 Host-inject 路径。
  assert.equal(Object.hasOwn(coding.execution ?? {}, "timeoutMs"), false);
  const compiled = preparePublicCodingDispatch(coding, { cwd: process.cwd(), timeoutMs: 30 * 60_000 });
  assert.equal(compiled.hash.length, 64);
  assert.equal(compiled.taskId, coding.taskId);

  const generic = calls.find((call) => call.agent === coding.agent && !Object.hasOwn(call, "version"));
  assert.ok(generic);
  assert.equal(generic.worktree, true);
  assert.equal(Object.hasOwn(generic, "execution"), false);
  const review = calls.find((call) => call.agent === "reviewer");
  assert.ok(review);
  assert.equal(Object.hasOwn(review, "version"), false);
  assert.equal(review.worktree ?? false, false);
});
