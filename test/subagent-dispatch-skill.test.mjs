import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Compile } from "../pi/npm/node_modules/typebox/build/compile/index.mjs";
import { compileCodingDispatchIR } from "../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts";
import { TYPED_SUBAGENT_PARAMETERS } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";
import { discoverManagedSkills } from "../src/skill-whitelist/skill.ts";

const validator = Compile(TYPED_SUBAGENT_PARAMETERS);
const skillPath = new URL("../skill-overrides/subagent-dispatch/SKILL.md", import.meta.url);

function documentedCalls(markdown) {
  return [...markdown.matchAll(/```js\nsubagent\((\{[\s\S]*?\})\);\n```/g)]
    .map(([, source]) => Function(`"use strict"; return (${source});`)());
}

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
  const compiled = compileCodingDispatchIR(coding, { cwd: process.cwd() });
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
