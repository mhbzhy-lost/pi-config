import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
const repoRoot = dirname(new URL(import.meta.url).pathname);
const wsRoot = join(repoRoot, "..", "packages", "pi-subagents-enhanced", "src", "workspace");
const { MANAGED_WORKSPACE_STATES, allowedActionsFor } = await import("../packages/pi-subagents-enhanced/src/workspace/ledger.ts");
const service = await import("../packages/pi-subagents-enhanced/src/workspace/service.ts");

test("状态词表是单一权威来源且内容固定", () => {
  assert.equal(typeof MANAGED_WORKSPACE_STATES, "object", "MANAGED_WORKSPACE_STATES 必须已导出");
  assert.deepEqual([...MANAGED_WORKSPACE_STATES], [
    "reserved", "allocating", "active", "disposing", "preserved", "released", "cleanup-debt",
  ]);
});

test("allowedActionsFor 覆盖全部状态且 fail closed", () => {
  assert.equal(typeof allowedActionsFor, "function", "allowedActionsFor 必须已导出");
  const expected = {
    reserved: [], allocating: [], active: ["status", "dispose"], disposing: ["dispose"],
    preserved: ["release"], "cleanup-debt": ["release"], released: [],
  };
  for (const state of MANAGED_WORKSPACE_STATES) {
    assert.deepEqual([...allowedActionsFor(state)], expected[state], `state=${state}`);
  }
  assert.throws(() => allowedActionsFor("awaiting-disposition"), /not a managed workspace state/);
  assert.throws(() => allowedActionsFor(undefined), /not a managed workspace state/);
});

test("service 导出的错误构造把 state/allowedActions/nextAction 放进 detail", () => {
  assert.equal(typeof service.managedWorkspaceStateFailure, "function", "managedWorkspaceStateFailure 必须已导出");
  const error = service.managedWorkspaceStateFailure("preserved", "workspace status is unavailable in preserved");
  assert.equal(error.code, "MANAGED_WORKSPACE_STATE");
  assert.deepEqual(error.detail.state, "preserved");
  assert.deepEqual([...error.detail.allowedActions], ["release"]);
  assert.equal(typeof error.detail.nextAction, "string");
  assert.ok(error.detail.nextAction.length > 0);
  assert.match(error.message, /state=preserved/);
  assert.match(error.message, /allowed actions: release/);
  assert.match(error.message, /next: /);
});

test("工具描述与生产源码不再把非 ledger 状态当作 workspace state", () => {
  const files = readdirSync(wsRoot).filter((f) => f.endsWith(".ts")).map((f) => join(wsRoot, f));
  const offenders = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const label of ["awaiting-disposition", "integrated", "discarded"]) {
      const asState = new RegExp("state\\\\s*===?\\\\s*[\\\"'`]" + label + "[\\\"'`]|state:\\\\s*[\\\"'`]" + label + "[\\\"'`]", "g");
      if (asState.test(text)) offenders.push(`${file.split("/").pop()}: ${label} 被当作 state 使用`);
    }
  }
  assert.deepEqual(offenders, []);
  const tool = readFileSync(join(wsRoot, "tool.ts"), "utf8");
  assert.match(tool, /MANAGED_WORKSPACE_STATES/, "tool 描述应由权威词表生成，而非硬编码");
});
