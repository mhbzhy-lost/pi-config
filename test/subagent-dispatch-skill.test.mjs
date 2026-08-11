import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { compileCodingDispatchIR } from "../scripts/lib/subagent-dispatch/ir.ts";

const skillPath = new URL("../skill-overrides/subagent-dispatch/SKILL.md", import.meta.url);
const whitelistPath = new URL("../skill-overrides/skills.list", import.meta.url);

async function loadSkill() {
  const source = await readFile(skillPath, "utf8");
  const body = source.replace(/^---[\s\S]*?---\s*/, "");
  return { source, body };
}

function extractCodingExample(source) {
  const match = source.match(/```js\nsubagent\(([\s\S]*?)\);\n```/);
  assert.ok(match, "coding example must be a fenced subagent({...}) call");
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${match[1]})`)));
}

test("allowlists the project subagent dispatch skill", async () => {
  const whitelist = await readFile(whitelistPath, "utf8");
  assert.ok(whitelist.split(/\r?\n/).map((line) => line.trim()).includes("subagent-dispatch"));
});

test("requires dispatch-ir.v1 for executor and spark coding work", async () => {
  const { source, body } = await loadSkill();

  assert.match(source, /^description: Use when /m);
  assert.match(body, /dispatch-ir\.v1/);
  assert.match(body, /executor/);
  assert.match(body, /spark/);
  for (const field of [
    "taskId", "title", "agent", "risk", "objective", "workflow", "requirements",
    "context", "boundaries", "acceptance", "execution",
  ]) {
    assert.match(body, new RegExp(`\\b${field}\\b`), `missing IR field ${field}`);
  }
  assert.match(body, /free-form task/i);
  assert.match(body, /missing|required information|complete contract/i);
  assert.match(body, /never.*delegate\s*\(/i);
  assert.match(body, /placeholder/i);
  assert.match(body, /deadline|urgency/i);
});

test("compiles the fenced coding example and teaches a checked first dispatch", async () => {
  const { source, body } = await loadSkill();
  const contract = extractCodingExample(source);

  assert.doesNotThrow(() => compileCodingDispatchIR(contract, { cwd: "/workspace" }));
  assert.deepEqual(Object.keys(contract.acceptance), ["criteria"]);
  assert.match(body, /核实 cwd、相关路径和事实|verify cwd, relevant paths, and facts/i);
  assert.match(body, /不确定.*不得.*knownFacts|unknown.*not.*knownFacts/i);
  assert.match(body, /exact top-level\/nested shape|精确.*顶层.*嵌套.*shape/i);
  assert.match(body, /repo-relative.*POSIX.*relevantFiles.*writePaths|仓库相对.*POSIX.*relevantFiles.*writePaths/i);
  assert.match(body, /tdd.*reason.*forbidden|tdd.*禁止.*reason/i);
  assert.match(body, /existing-tests.*docs-only.*reason.*required|existing-tests.*docs-only.*reason.*必填/i);
  assert.match(body, /enumeration|枚举/i);
  assert.match(body, /non-empty|required arrays|非空.*必填.*数组/i);
  assert.match(body, /positive integer.*timeout|正整数.*timeout/i);
  assert.match(body, /criteria-only/i);
  assert.match(body, /no extra fields|无额外字段/i);
});

test("forbids raw worktree lifecycle bypass and speculative cleanup in coding dispatches", async () => {
  const { body } = await loadSkill();

  assert.match(body, /raw[\s\S]{0,80}git worktree[\s\S]{0,120}(add|remove|prune|move|repair|lock|unlock)/i);
  assert.match(body, /managed lifecycle CLI|worktree-lifecycle\.mjs/i);
  assert.match(body, /owner CAS|owner.*compare-and-swap/i);
  assert.match(body, /typed Goal disposition/i);
  assert.match(body, /--force[\s\S]{0,100}(remove|删除|移除)|(?:remove|删除|移除)[\s\S]{0,100}--force/i);
  assert.match(body, /(\/tmp|TTL|clean)[\s\S]{0,140}(不.*授权|not.*authori)/i);
  assert.match(body, /branch[\s\S]{0,100}(cleanup|清理|delete|删除)/i);
});

test("documents generic passthrough without owning runtime wait policy", async () => {
  const { body } = await loadSkill();

  assert.match(body, /generic/i);
  assert.match(body, /delegate/);
  assert.doesNotMatch(body, /advisor|researcher|reviewer/);
  assert.match(body, /\{\s*agent\s*,\s*title\s*,\s*task\s*\}/);
  assert.match(body, /title/i);
  assert.match(body, /task.*unchanged|unchanged.*task/is);
  assert.doesNotMatch(body, /\bstatus\b|runId|asyncDir|busy-?poll|\bsleep\b|completion notification|end the turn/i);
  assert.doesNotMatch(body, /tasks\[\]|chain\[\]|fan-?out|Fable|proactive skill/i);
  assert.ok(body.trim().split(/\s+/).length <= 250, "skill body must stay within 250 words");
});
