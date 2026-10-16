// S2 合同测试：workspace 每操作独立工具（managed_workspace_list/status/dispose/release）。
// 覆盖：schema 集合（单 object 根、无组合子、固定 action 不可由模型提供）、
// 薄委托（同一 execute 闭包、raw 结果原样）、factory 对 raw 未知字段/缺必填/action 注入的安全拒绝、
// strategy 条件仍由原 runtime INVALID_WORKSPACE_STRATEGY 裁决（schema 早拒降级为 runtime），
// 以及真实 service public fixture 的 status token / owner / CAS / child-owned / released 终态 /
// preserved 独立 release 合法链（release 是 preserved/cleanup-debt 的独立分支，非 dispose 串联续步）。
// cleanup-debt：模型工具面对已绑定 run 的 debt 释放保持 service 权威
// （MANAGED_WORKSPACE_ACTION fail closed），完整 debt 回收链属 recovery 工具路径（issueRelease），不在 S2。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createManagedWorkspaceRequestV2 } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { createManagedWorkspaceService } from "../packages/pi-subagents-enhanced/src/workspace/service.ts";
import { createSubagentWorkspaceTool } from "../packages/pi-subagents-enhanced/src/workspace/tool.ts";
import {
  createWorkspaceOperationTools,
  WORKSPACE_OPERATION_TOOL_NAMES,
} from "../packages/pi-subagents-enhanced/src/workspace/operation-tools.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function makeSpyService(calls = []) {
  const record = (name, input) => calls.push([name, input]);
  return {
    calls,
    listOwned(input) { record("listOwned", input); return []; },
    statusOwned(input) { record("statusOwned", input); return { receipt: { workspaceId: "workspace-a", state: "active", leaseId: "lease-a" } }; },
    issueOwnedDisposition(input) {
      record("issueOwnedDisposition", input);
      return {
        receipt: { workspaceId: "workspace-a", state: "active", leaseId: "lease-a" },
        terminalProof: { state: "observed" }, actionToken: "token-a",
        allowedDispositions: ["discard", "preserve", "release"], blockedReasons: [],
      };
    },
    disposeOwned(input) { record("disposeOwned", input); return { workspaceId: input.workspaceId, state: "released", leaseId: "lease-a" }; },
    releaseOwned(input) { record("releaseOwned", input); return { workspaceId: input.workspaceId, state: "released", leaseId: "lease-a" }; },
  };
}

function toolsFor(options) {
  return createWorkspaceOperationTools({ resolveRootSessionId: () => "session-a", ...options });
}

function byName(tools) {
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

const CTX = { sessionManager: { rootSessionId: "session-a" } };

test("workspace 操作工具 schema 集合：四 model-only 工具、单 object 根、无组合子、不暴露 action/owner", () => {
  const tools = toolsFor({ service: makeSpyService() });
  assert.deepEqual(tools.map((tool) => tool.name), [...WORKSPACE_OPERATION_TOOL_NAMES]);
  assert.deepEqual(WORKSPACE_OPERATION_TOOL_NAMES, [
    "managed_workspace_list", "managed_workspace_status", "managed_workspace_dispose", "managed_workspace_release",
  ]);
  for (const tool of tools) {
    assert.equal(tool.exposure, "model-only");
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description.length > 0);
    const schema = tool.parameters;
    assert.equal(schema.type, "object", `${tool.name} 根必须是单 object`);
    assert.equal(schema.additionalProperties, false, `${tool.name} 根必须 additionalProperties=false`);
    const serialized = JSON.stringify(schema);
    for (const combinator of ["anyOf", "oneOf", "allOf", "if", "then", "else"]) {
      assert.equal(serialized.includes(`"${combinator}"`), false, `${tool.name} 不得使用组合子 ${combinator}`);
    }
    assert.equal(Object.hasOwn(schema.properties ?? {}, "action"), false, `${tool.name} 不得暴露 action 参数`);
    assert.equal(serialized.includes("rootSessionId"), false, `${tool.name} 不得让模型填 root 身份`);
    assert.equal(serialized.includes("\"kind\""), false, `${tool.name} 不得让模型填 owner kind`);
    assert.match(tool.description, /权威/, `${tool.name} description 必须指明状态权威`);
  }
  const by = byName(tools);
  assert.equal(by.managed_workspace_list.parameters.required, undefined);
  assert.deepEqual(by.managed_workspace_list.parameters.properties, {});
  assert.deepEqual(by.managed_workspace_status.parameters.required, ["workspace_id"]);
  assert.deepEqual(by.managed_workspace_release.parameters.required, ["workspace_id"]);
  assert.deepEqual(by.managed_workspace_dispose.parameters.required, ["workspace_id", "disposition", "action_token"]);
  assert.deepEqual(by.managed_workspace_dispose.parameters.properties.disposition.enum, ["integrate", "discard", "preserve"]);
  assert.deepEqual(by.managed_workspace_dispose.parameters.properties.strategy.enum, ["cherry-pick", "merge"]);
  // strategy 条件早拒已从 schema 移除（顶层 allOf 降级为原 runtime INVALID_WORKSPACE_STRATEGY 裁决），
  // description 必须把该降级说清楚，且 child-owned 边界保持。
  assert.match(by.managed_workspace_dispose.description, /INVALID_WORKSPACE_STRATEGY/);
  assert.match(by.managed_workspace_dispose.description, /早拒降级|schema 不保留顶层 allOf/);
  assert.match(by.managed_workspace_dispose.description, /CHILD_OWNS_INTEGRATION/);
  // 计划 §2.1：release 不是 dispose 的串联续步，而是 preserved/cleanup-debt 各自独立可执行的分支；
  // released 为终态无需动作。文案不得要求“先 dispose 才能 release”。
  assert.match(by.managed_workspace_release.description, /独立可执行|各自独立/);
  assert.match(by.managed_workspace_release.description, /preserved[\s\S]*cleanup-debt/);
  assert.match(by.managed_workspace_release.description, /released[\s\S]*无需/);
  assert.doesNotMatch(by.managed_workspace_release.description, /必须先|先经|之后才能/);
});

test("四个新定义委托旧 createSubagentWorkspaceTool 的同一 execute：service 调用与 raw 结果原样", async () => {
  const invocations = [
    { tool: "managed_workspace_list", oldArgs: { action: "list" }, newArgs: {} },
    { tool: "managed_workspace_status", oldArgs: { action: "status", workspace_id: "workspace-a" }, newArgs: { workspace_id: "workspace-a" } },
    {
      tool: "managed_workspace_dispose",
      oldArgs: { action: "dispose", workspace_id: "workspace-a", disposition: "discard", action_token: "token-a" },
      newArgs: { workspace_id: "workspace-a", disposition: "discard", action_token: "token-a" },
    },
    { tool: "managed_workspace_release", oldArgs: { action: "release", workspace_id: "workspace-a" }, newArgs: { workspace_id: "workspace-a" } },
  ];
  for (const { tool, oldArgs, newArgs } of invocations) {
    const oldCalls = [];
    const newCalls = [];
    const oldTool = createSubagentWorkspaceTool({ service: makeSpyService(oldCalls), resolveRootSessionId: () => "session-a" });
    const newTool = byName(toolsFor({ service: makeSpyService(newCalls) }))[tool];
    const oldResult = await oldTool.execute("call", oldArgs, undefined, undefined, CTX);
    const newResult = await newTool.execute("call", newArgs, undefined, undefined, CTX);
    assert.deepEqual(newResult, oldResult, `${tool} 的 raw 结果必须与旧 execute 一致`);
    assert.deepEqual(newCalls, oldCalls, `${tool} 落到同一 service 调用序列`);
    assert.equal(newResult.isError, false);
  }
  // dispose 的 preserve reason 仍由旧 runtime 注入，不暴露为模型字段。
  const calls = [];
  const dispose = byName(toolsFor({ service: makeSpyService(calls) })).managed_workspace_dispose;
  await dispose.execute("call", { workspace_id: "workspace-a", disposition: "preserve", action_token: "token-a" }, undefined, undefined, CTX);
  const [, disposeInput] = calls.find(([name]) => name === "disposeOwned");
  assert.equal(disposeInput.reason, "subagent workspace preserved");
  assert.equal(disposeInput.strategy, "cherry-pick", "缺省 strategy 仍由旧闭包注入 cherry-pick");
  assert.deepEqual(disposeInput.ownerScope, { kind: "standalone-subagent", rootSessionId: "session-a" }, "owner 固定注入，模型不可指定");
});

test("factory 安全拒绝 raw 未知字段/缺必填/action 注入，错误 shape 与既有一致且不触达 service", async () => {
  const calls = [];
  const by = byName(toolsFor({ service: makeSpyService(calls) }));
  const rejections = [
    ["managed_workspace_list", { action: "list" }, "$.action", /固定注入/],
    ["managed_workspace_status", { action: "dispose", workspace_id: "workspace-a" }, "$.action", /固定注入/],
    ["managed_workspace_status", { workspace_id: "workspace-a", disposition: "discard" }, "$.disposition", /未知参数/],
    ["managed_workspace_status", { workspace_id: "workspace-a", owner: { kind: "standalone-subagent" } }, "$.owner", /未知参数/],
    ["managed_workspace_status", { workspace_id: "workspace-a", rootSessionId: "forged" }, "$.rootSessionId", /未知参数/],
    ["managed_workspace_status", {}, "$.workspace_id", /缺少必填/],
    ["managed_workspace_status", { workspace_id: "" }, "$.workspace_id", /1-4096/],
    ["managed_workspace_dispose", { workspace_id: "workspace-a", disposition: "keep", action_token: "token-a" }, "$.disposition", /integrate \| discard \| preserve/],
    ["managed_workspace_dispose", { workspace_id: "workspace-a", disposition: "discard", action_token: "token-a", strategy: "rebase" }, "$.strategy", /cherry-pick \| merge/],
    ["managed_workspace_dispose", { workspace_id: "workspace-a", disposition: "discard" }, "$.action_token", /缺少必填/],
    ["managed_workspace_release", "not-an-object", "$", /扁平对象/],
    ["managed_workspace_list", null, "$", /扁平对象/, "strict 原始 null 拒绝：null 不得当作空参数"],
    ["managed_workspace_status", ["workspace_id"], "$", /扁平对象/],
    ["managed_workspace_dispose", { workspace_id: "workspace-a", disposition: "discard", action_token: "token-a", action: "release" }, "$.action", /固定注入/],
  ];
  for (const [toolName, args, keypath, messagePattern] of rejections) {
    const result = await by[toolName].execute("call", args, undefined, undefined, CTX);
    assert.equal(result.isError, true, `${toolName} 必须拒绝 ${JSON.stringify(args)}`);
    assert.equal(result.details.code, "INVALID_WORKSPACE_TOOL_INPUT");
    assert.equal(result.details.keypath, keypath);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text", "错误 shape 与旧 failure() 一致：单 text content");
    assert.ok(result.content[0].text.startsWith("INVALID_WORKSPACE_TOOL_INPUT: "), result.content[0].text);
    assert.match(result.content[0].text, messagePattern);
  }
  assert.deepEqual(calls, [], "安全拒绝不得触达 service，也不得绕 Host 验证继续执行");
});

test("strategy 条件由原 runtime 裁决：schema 不再早拒，INVALID_WORKSPACE_STRATEGY guard 仍在且 disposeOwned 未被调用", async () => {
  const calls = [];
  const by = byName(toolsFor({ service: makeSpyService(calls) }));
  assert.equal(JSON.stringify(by.managed_workspace_dispose.parameters).includes("allOf"), false);
  const result = await by.managed_workspace_dispose.execute(
    "call",
    { workspace_id: "workspace-a", disposition: "discard", strategy: "merge", action_token: "token-a" },
    undefined, undefined, CTX,
  );
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "INVALID_WORKSPACE_STRATEGY", "旧 runtime guard 原样保留");
  assert.equal(result.content[0].text.startsWith("INVALID_WORKSPACE_STRATEGY: "), true);
  assert.equal(calls.some(([name]) => name === "disposeOwned"), false);
});

test("renderer 复用传入引用；缺省时不注入 render 键", () => {
  const renderCall = () => "call-render";
  const renderResult = () => "result-render";
  const withRenderers = toolsFor({ service: makeSpyService(), renderCall, renderResult });
  for (const tool of withRenderers) {
    assert.equal(tool.renderCall, renderCall);
    assert.equal(tool.renderResult, renderResult);
  }
  const withoutRenderers = toolsFor({ service: makeSpyService() });
  for (const tool of withoutRenderers) {
    assert.equal(Object.hasOwn(tool, "renderCall"), false);
    assert.equal(Object.hasOwn(tool, "renderResult"), false);
  }
});

test("真实 service：status token/allowed 权威、owner fail-closed、CAS token 重放、child-owned 拒绝、released 终态与 preserved 独立 release 合法链", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workspace-operation-tools-"));
  const originRoot = join(root, "origin");
  await mkdir(originRoot);
  git(originRoot, "init", "-b", "main");
  git(originRoot, "config", "user.email", "test@example.com");
  git(originRoot, "config", "user.name", "Test");
  await writeFile(join(originRoot, "base.txt"), "base\n");
  git(originRoot, "add", ".");
  git(originRoot, "commit", "-m", "base");
  t.after(() => rm(root, { recursive: true, force: true }));

  const proofB = {
    state: "observed", conflict: false, runId: "run-b", rootSessionId: "root-real",
    asyncDir: join(root, "async-run-b"), processInstance: "process-b", proofId: "b".repeat(64),
  };
  const service = createManagedWorkspaceService({
    stateRoot: join(root, "state"),
    terminalProofProvider: ({ run }) => (run?.runId === "run-b" ? structuredClone(proofB) : undefined),
  });
  const owner = { kind: "standalone-subagent", rootSessionId: "root-real", toolCallId: "tool-real" };
  const allocate = (workspaceId, runId, policy) => {
    const active = service.ensureAllocated(createManagedWorkspaceRequestV2({
      workspaceId, owner, originRoot, requestedCwd: originRoot,
      originRef: "refs/heads/main", baseCommit: git(originRoot, "rev-parse", "HEAD"),
      contractHash: "a".repeat(64), policy,
    }));
    service.bindRun({ workspaceId, run: { runId, asyncDir: join(root, `async-${runId}`) } });
    return active;
  };
  allocate("ws-a", "run-a", { publication: "forbidden", application: "forbidden", writePaths: ["result.txt"] });
  const activeB = allocate("ws-b", "run-b", { publication: "allowed", application: "allowed", writePaths: ["result.txt"] });
  await writeFile(join(activeB.path, "result.txt"), "result\n");
  git(activeB.path, "add", ".");
  git(activeB.path, "commit", "-m", "result");

  const ctx = { sessionManager: { rootSessionId: "root-real" } };
  const by = byName(createWorkspaceOperationTools({ service, resolveRootSessionId: () => "root-real" }));
  const foreignBy = byName(createWorkspaceOperationTools({ service, resolveRootSessionId: () => "root-other" }));

  // list：只读名册，public 投影、无 action_token（非 active+allowed 组合）。
  const listed = await by.managed_workspace_list.execute("call", {}, undefined, undefined, ctx);
  assert.equal(listed.isError, false);
  assert.equal(listed.details.workspaces.map((entry) => entry.workspace_id).sort().join(","), "ws-a,ws-b");
  assert.equal(listed.content[0].text, JSON.stringify(listed.details.workspaces), "content 与 details 同投影");
  for (const entry of listed.details.workspaces) assert.equal(Object.hasOwn(entry, "action_token"), false);

  // owner fail-closed：foreign root session 的 status 在 token 签发前被 service 拒。
  const foreignStatus = await foreignBy.managed_workspace_status.execute("call", { workspace_id: "ws-b" }, undefined, undefined, ctx);
  assert.equal(foreignStatus.isError, true);
  assert.equal(foreignStatus.details.code, "MANAGED_WORKSPACE_OWNER_SCOPE");

  // status（ws-a generic、无 terminal proof）：allowed_dispositions 为 [preserve, release] 权威投影，token 签发。
  const statusA = await by.managed_workspace_status.execute("call", { workspace_id: "ws-a" }, undefined, undefined, ctx);
  assert.equal(statusA.isError, false);
  assert.equal(statusA.details.state, "active");
  assert.equal(statusA.details.workspace_state, "active");
  assert.equal(statusA.details.process_terminal, "pending", "未观察 proof 的实时事实原样投影（旧 workspacePublic 语义）");
  assert.deepEqual(statusA.details.allowed_dispositions, ["preserve", "release"]);
  assert.deepEqual(statusA.details.integrate_blocked_reasons, ["terminal-unobserved"]);
  assert.match(statusA.details.action_token, /^managed-workspace-action\.v1:[a-f0-9]{64}$/);

  // 未观察 terminal proof 时 discard 不被允许（service 权威，非 schema 预判）。
  const blockedDiscard = await by.managed_workspace_dispose.execute(
    "call", { workspace_id: "ws-a", disposition: "discard", action_token: statusA.details.action_token }, undefined, undefined, ctx,
  );
  assert.equal(blockedDiscard.isError, true);
  assert.equal(blockedDiscard.details.code, "MANAGED_WORKSPACE_TERMINAL");

  // preserved 独立分支的 release 合法链（本 fixture 中 preserved 恰由 dispose=preserve 产生，
  // reason 由 runtime 注入；release 本身不依赖 dispose 串联）→ released 终态。
  const preserved = await by.managed_workspace_dispose.execute(
    "call", { workspace_id: "ws-a", disposition: "preserve", action_token: statusA.details.action_token }, undefined, undefined, ctx,
  );
  assert.equal(preserved.isError, false);
  assert.equal(preserved.details.state, "preserved");
  const releasedA = await by.managed_workspace_release.execute("call", { workspace_id: "ws-a" }, undefined, undefined, ctx);
  assert.equal(releasedA.isError, false);
  assert.equal(releasedA.details.state, "released");
  const statusReleased = await by.managed_workspace_status.execute("call", { workspace_id: "ws-a" }, undefined, undefined, ctx);
  assert.equal(statusReleased.isError, true);
  assert.equal(statusReleased.details.code, "MANAGED_WORKSPACE_STATE", "released 终态：status 由 service 权威拒绝");
  assert.equal(statusReleased.details.detail.state, "released");
  assert.deepEqual(statusReleased.details.detail.allowedActions, []);

  // CAS：token 一次性且绑定最新 challenge —— 重签后旧 token 必须被拒。
  const statusB1 = await by.managed_workspace_status.execute("call", { workspace_id: "ws-b" }, undefined, undefined, ctx);
  assert.deepEqual(statusB1.details.allowed_dispositions, ["publish", "discard", "preserve", "release"]);
  const statusB2 = await by.managed_workspace_status.execute("call", { workspace_id: "ws-b" }, undefined, undefined, ctx);
  assert.notEqual(statusB1.details.action_token, statusB2.details.action_token);
  const replay = await by.managed_workspace_dispose.execute(
    "call", { workspace_id: "ws-b", disposition: "preserve", action_token: statusB1.details.action_token }, undefined, undefined, ctx,
  );
  assert.equal(replay.isError, true);
  assert.equal(replay.details.code, "MANAGED_WORKSPACE_ACTION", "旧 token 重放被 service CAS 拒绝");

  // child-owned：publication=allowed 的 coding 工作区 integrate 由 child queue 自主拥有。
  const parentIntegrate = await by.managed_workspace_dispose.execute(
    "call", { workspace_id: "ws-b", disposition: "integrate", action_token: statusB2.details.action_token }, undefined, undefined, ctx,
  );
  assert.equal(parentIntegrate.isError, true);
  assert.equal(parentIntegrate.details.code, "CHILD_OWNS_INTEGRATION", "child-owned 门禁不变，token 未被消费");

  // 合法 discard：以 status 权威 + 新鲜 token 处置到 released。
  const discarded = await by.managed_workspace_dispose.execute(
    "call", { workspace_id: "ws-b", disposition: "discard", action_token: statusB2.details.action_token }, undefined, undefined, ctx,
  );
  assert.equal(discarded.isError, false);
  assert.equal(discarded.details.state, "released");
});

test("真实 service：cleanup-debt 绑定 run 的工作区，模型 release 不得绕过 service token/proof 权威", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workspace-operation-debt-"));
  const originRoot = join(root, "origin");
  await mkdir(originRoot);
  git(originRoot, "init", "-b", "main");
  git(originRoot, "config", "user.email", "test@example.com");
  git(originRoot, "config", "user.name", "Test");
  await writeFile(join(originRoot, "base.txt"), "base\n");
  git(originRoot, "add", ".");
  git(originRoot, "commit", "-m", "base");
  t.after(() => rm(root, { recursive: true, force: true }));

  const service = createManagedWorkspaceService({ stateRoot: join(root, "state") });
  const owner = { kind: "standalone-subagent", rootSessionId: "root-debt", toolCallId: "tool-debt" };
  const active = service.ensureAllocated(createManagedWorkspaceRequestV2({
    workspaceId: "ws-debt", owner, originRoot, requestedCwd: originRoot,
    originRef: "refs/heads/main", baseCommit: git(originRoot, "rev-parse", "HEAD"),
    contractHash: "a".repeat(64),
    policy: { publication: "forbidden", application: "forbidden", writePaths: ["result.txt"] },
  }));
  const asyncDir = join(root, "async-debt");
  await mkdir(asyncDir); // 存在 asyncDir 但无 process-terminal.json：reconcile 标记 terminal-proof debt
  service.bindRun({ workspaceId: "ws-debt", run: { runId: "run-debt", asyncDir } });
  const [settled] = service.reconcile({ originRoot });
  assert.equal(settled.state, "cleanup-debt");

  const ctx = { sessionManager: { rootSessionId: "root-debt" } };
  const by = byName(createWorkspaceOperationTools({ service, resolveRootSessionId: () => "root-debt" }));
  const result = await by.managed_workspace_release.execute("call", { workspace_id: "ws-debt" }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "MANAGED_WORKSPACE_ACTION", "已绑定 run 的 debt release 需要显式 issueRelease token；模型工具不得绕过 service 权威");
});
