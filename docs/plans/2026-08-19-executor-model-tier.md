# Executor Model Tier 实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**目标：** 在不拆分 coding agent 的前提下，让 typed `executor` 支持 `luna` / `terra` 模型层级，并修复现有 Peach dogfooding system prompt 路由漂移。

**架构：** 保持 `agent: "executor"` 作为唯一 coding agent 和安全边界，给 `dispatch-ir.v1` 增加可选 `modelTier`，由 typed runtime 翻译成 child `model` override。模型族 system prompt 继续由 `model-system-prompt` extension 负责，Qwen/Peach 命中 `SYSTEM.qwen.md`，Anthropic idealab 命中 `SYSTEM.anthropic.md`，OpenAI Codex/GPT 族继续使用 Pi 通用 prompt。

**技术栈：** Node.js 22.19+、TypeScript/JavaScript ESM、Pi extension API、`pi-subagents` RPC workflow、Node test runner、TypeBox schema validation。

## 全局约束

- 所有生产代码、配置或 Skill/Agent 行为变更首次修改前必须加载 `test-driven-development` skill，并按 RED/GREEN 执行。
- 所有 coding work 必须通过 `subagent-dispatch` 派发给 `executor`，除非用户明确要求主 agent 直接执行。
- 技术文档默认中文；代码标识符、路径、命令保持原文。
- 不修改、读取或记录任何凭据；`models.json` 只包含非敏感 provider/model metadata。
- 禁止 raw `git worktree add/remove/prune/move/repair/lock/unlock`；需要隔离时只用 typed disposition 或 managed lifecycle CLI。
- 不提交 `pi/settings.json` 的 `enabledModels` 差异；本计划不要求修改 `enabledModels`。
- 不新增 GPT/Codex 族专用 system prompt；除非本计划验收发现稳定失败模式，否则 OpenAI Codex/GPT 族保持 Pi 通用 prompt。
- `modelTier` 是资源路由，不改变 `executor` 的授权范围、writePaths、TDD、acceptance 或 supervisor 协议。

## 文件结构与职责

- `scripts/lib/model-system-prompt.mjs`：模型族到 system prompt 模板的路由表和重建逻辑。
- `test/model-system-prompt.test.mjs`：验证 Qwen/Peach/Anthropic 命中专用 prompt，验证 OpenAI Codex/GPT 不被专用 prompt 接管。
- `scripts/lib/subagent-dispatch/model-tier.ts`：新增纯函数模块，集中定义 `luna` / `terra` tier、默认 tier、tier 到 model 的映射和校验错误。
- `scripts/lib/subagent-dispatch/ir.ts`：扩展 `dispatch-ir.v1` 编译，接收可选 `modelTier` 并默认归一为 `luna`。
- `scripts/lib/subagent-dispatch/prompt.ts`：在 executor 子任务 prompt 中展示已归一的 `modelTier`，让子 agent 明确 tier 不改变职责。
- `scripts/lib/subagent-dispatch/extension.ts`：扩展 typed tool schema；spawn coding child 时把 `modelTier` 映射为 child `model` override。
- `test/subagent-model-tier.test.mjs`：新增纯函数测试，覆盖 tier 归一与模型映射。
- `test/subagent-dispatch-ir.test.mjs`：覆盖 IR 默认 `luna`、显式 `terra`、非法 tier 拒绝和 prompt 展示。
- `test/subagent-dispatch-schema-coercion.test.mjs`：覆盖 typed tool schema 接受可选 `modelTier`，且继续接受旧 contract。
- `test/subagent-dispatch-extension.test.ts`：覆盖 runtime spawn 参数中 child model 随 tier 改变。
- `skill-overrides/subagent-dispatch/SKILL.md`：主 Agent 的 Luna/Terra 路由规则，强调不可用 generic coding 绕过 typed contract。
- `pi/agents/executor.md`：executor 自身职责边界，说明 tier 是资源选择，不是 scope/architecture 权限。

## DAG

```text
T1 (system prompt 路由修复) ───────────────┐
                                           ├──> T6 (最终回归与验收)
T2 (model tier 纯函数与 IR 契约) ──> T3 ──┤
                                  │        │
                                  └──> T4 ─┤
                                           │
T5 (executor 与 Skill 路由文案) ───────────┘
```

## Waves

- Wave 1：T1、T2、T5（可并行；T1 只影响 prompt 路由，T2 产出 tier 接口，T5 产出 agent/Skill 文案）
- Wave 2：T3、T4（等待 T2 的 `modelTier` 接口；T3 接入 runtime，T4 更新 schema/工具说明）
- Wave 3：T6（等待所有代码、schema 和文案完成）

**关键路径：** T2 → T3 → T6。T1 和 T5 不是关键路径，但必须在 T6 前完成。

---

### Task 1：修复 Peach Dogfooding System Prompt 路由

**Deps：** `none`

**WritePaths：**
- `scripts/lib/model-system-prompt.mjs`
- `test/model-system-prompt.test.mjs`

**Resources：** `none`

**Files：**
- Modify：`test/model-system-prompt.test.mjs:21-121`
- Modify：`scripts/lib/model-system-prompt.mjs:4-10`

**接口契约：**
- Consumes：现有 `createModelSystemPromptExtension(pi)` 和 `before_agent_start` hook。
- Produces：`openai-idealab-dogfooding/Peach-07-17-DogFooding` 命中 `SYSTEM.qwen.md`；`openai-codex/gpt-5.6-terra` 不命中任何专用 system prompt。

**验收标准：**

- `openai-idealab/qwen3.8-max` 继续命中 `SYSTEM.qwen.md`。
- `openai-idealab-dogfooding/Peach-07-17-DogFooding` 命中 `SYSTEM.qwen.md`。
- `anthropic-idealab/claude-opus-4-6` 继续命中 `SYSTEM.anthropic.md`。
- `openai-codex/gpt-5.6-terra` 返回 `undefined`，继续使用 Pi 通用 prompt。

- [ ] **步骤 1：编写失败测试**

在 `test/model-system-prompt.test.mjs` 追加两个行为测试：

```js
test("replaces system prompt for dogfooding Peach compatibility model", async () => {
  const pi = createMockPi();
  createModelSystemPromptExtension(pi);

  const handler = pi.handlers.get("before_agent_start");
  const ctx = {
    model: { provider: "openai-idealab-dogfooding", id: "Peach-07-17-DogFooding" },
  };

  const result = await handler(
    { systemPrompt: "generic prompt", systemPromptOptions: {} },
    ctx,
  );

  assert.ok(result);
  assert.match(result.systemPrompt, /Stop Rules/);
});

test("keeps OpenAI Codex GPT family on the generic Pi system prompt", async () => {
  const pi = createMockPi();
  createModelSystemPromptExtension(pi);

  const handler = pi.handlers.get("before_agent_start");
  const ctx = {
    model: { provider: "openai-codex", id: "gpt-5.6-terra" },
  };

  const result = await handler(
    { systemPrompt: "generic prompt", systemPromptOptions: {} },
    ctx,
  );

  assert.equal(result, undefined);
});
```

- [ ] **步骤 2：运行测试确认 RED**

运行：`node --test test/model-system-prompt.test.mjs`

预期：`replaces system prompt for dogfooding Peach compatibility model` 失败，实际返回 `undefined`；OpenAI Codex 测试通过。

- [ ] **步骤 3：编写最小实现**

在 `scripts/lib/model-system-prompt.mjs` 的 `PROVIDER_PROMPT_MAP` 中增加 provider 键：

```js
  "openai-idealab-dogfooding": {
    pattern: /^Peach-07-17-DogFooding$/i,
    file: "SYSTEM.qwen.md",
  },
```

- [ ] **步骤 4：运行测试确认 GREEN**

运行：`node --test test/model-system-prompt.test.mjs`

预期：全部通过。

- [ ] **步骤 5：运行本任务相关回归**

运行：`node --test test/model-system-prompt.test.mjs test/anthropic-request-rewriter.test.mjs`

预期：全部通过。

---

### Task 2：定义 Model Tier 纯函数并扩展 IR 契约

**Deps：** `none`

**WritePaths：**
- `scripts/lib/subagent-dispatch/model-tier.ts`
- `scripts/lib/subagent-dispatch/ir.ts`
- `scripts/lib/subagent-dispatch/prompt.ts`
- `test/subagent-model-tier.test.mjs`
- `test/subagent-dispatch-ir.test.mjs`

**Resources：** `none`

**Files：**
- Create：`scripts/lib/subagent-dispatch/model-tier.ts`
- Create：`test/subagent-model-tier.test.mjs`
- Modify：`scripts/lib/subagent-dispatch/ir.ts:8-24,271-318`
- Modify：`scripts/lib/subagent-dispatch/prompt.ts:14-37`
- Modify：`test/subagent-dispatch-ir.test.mjs:56-113`

**接口契约：**
- Consumes：现有 `compileCodingDispatchIR(input, { cwd })` contract 编译入口。
- Produces：
  - `export const MODEL_TIERS = Object.freeze(["luna", "terra"]);`
  - `export const DEFAULT_MODEL_TIER = "luna";`
  - `export const EXECUTOR_MODEL_BY_TIER = Object.freeze({ luna: "openai-codex/gpt-5.6-luna", terra: "openai-codex/gpt-5.6-terra" });`
  - `export function normalizeModelTier(value, location = "modelTier")`：`undefined` 返回 `"luna"`；非法值抛出 `CodingDispatchContractError`。
  - `export function executorModelForTier(tier)`：返回 `EXECUTOR_MODEL_BY_TIER[tier]`。
  - `compileCodingDispatchIR()` 返回的 `ir.modelTier` 始终是 `"luna"` 或 `"terra"`。

**验收标准：**

- 旧 contract 不传 `modelTier` 时继续编译成功，`ir.modelTier === "luna"`。
- 显式 `modelTier: "terra"` 编译成功并影响 canonical hash。
- 非法 `modelTier` 使用 `INVALID_CONTRACT` 拒绝，`detail` 为 `modelTier`。
- 子任务 prompt 的 `Identity` 区展示 `Model tier: \`luna\`` 或 `Model tier: \`terra\``。

- [ ] **步骤 1：编写失败测试**

新增 `test/subagent-model-tier.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MODEL_TIER,
  EXECUTOR_MODEL_BY_TIER,
  executorModelForTier,
  normalizeModelTier,
} from "../scripts/lib/subagent-dispatch/model-tier.ts";

import { CodingDispatchContractError } from "../scripts/lib/subagent-dispatch/ir.ts";

test("normalizes missing model tier to luna", () => {
  assert.equal(DEFAULT_MODEL_TIER, "luna");
  assert.equal(normalizeModelTier(undefined), "luna");
});

test("maps executor model tiers to concrete Codex models", () => {
  assert.deepEqual(EXECUTOR_MODEL_BY_TIER, {
    luna: "openai-codex/gpt-5.6-luna",
    terra: "openai-codex/gpt-5.6-terra",
  });
  assert.equal(executorModelForTier("luna"), "openai-codex/gpt-5.6-luna");
  assert.equal(executorModelForTier("terra"), "openai-codex/gpt-5.6-terra");
});

test("rejects unsupported model tiers with coding contract errors", () => {
  assert.throws(
    () => normalizeModelTier("sol"),
    (error) => {
      assert.equal(error instanceof CodingDispatchContractError, true);
      assert.equal(error.code, "INVALID_CONTRACT");
      assert.equal(error.detail, "modelTier");
      return true;
    },
  );
});
```

在 `test/subagent-dispatch-ir.test.mjs` 增加：

```js
test("defaults missing modelTier to luna", () => {
  const ir = compileCodingDispatchIR(contract(), { cwd: "/repo" });
  assert.equal(ir.modelTier, "luna");
});

test("accepts explicit terra modelTier and includes it in the child prompt", () => {
  const ir = compileCodingDispatchIR(contract({ modelTier: "terra" }), { cwd: "/repo" });
  assert.equal(ir.modelTier, "terra");
  assert.match(renderCodingDispatchPrompt(ir), /Model tier: `terra`/);
});

test("rejects unsupported modelTier values", () => {
  expectCode("INVALID_CONTRACT", () => compileCodingDispatchIR(contract({ modelTier: "sol" }), { cwd: "/repo" }));
});
```

- [ ] **步骤 2：运行测试确认 RED**

运行：`node --test test/subagent-model-tier.test.mjs test/subagent-dispatch-ir.test.mjs`

预期：新增模块不存在、`ir.modelTier` 不存在或非法 tier 未被拒绝。

- [ ] **步骤 3：编写最小实现**

创建 `scripts/lib/subagent-dispatch/model-tier.ts`：

```ts
import { CodingDispatchContractError } from "./ir.ts";

export const MODEL_TIERS = Object.freeze(["luna", "terra"] as const);
export type ModelTier = typeof MODEL_TIERS[number];
export const DEFAULT_MODEL_TIER: ModelTier = "luna";

export const EXECUTOR_MODEL_BY_TIER = Object.freeze({
  luna: "openai-codex/gpt-5.6-luna",
  terra: "openai-codex/gpt-5.6-terra",
} satisfies Record<ModelTier, string>);

export function normalizeModelTier(value: unknown, location = "modelTier"): ModelTier {
  const raw = value === undefined ? DEFAULT_MODEL_TIER : value;
  if (typeof raw !== "string") {
    throw new CodingDispatchContractError("INVALID_CONTRACT", `${location} must be a string; keypath=${location}`, location, location);
  }
  const normalized = raw.trim();
  if ((MODEL_TIERS as readonly string[]).includes(normalized)) return normalized as ModelTier;
  throw new CodingDispatchContractError("INVALID_CONTRACT", `${location} is not supported: ${normalized}; keypath=${location}`, location, location);
}

export function executorModelForTier(tier: ModelTier): string {
  return EXECUTOR_MODEL_BY_TIER[tier];
}
```

修改 `scripts/lib/subagent-dispatch/ir.ts`：

```ts
import { normalizeModelTier } from "./model-tier.ts";

const TOP_LEVEL_KEYS = [
  "version",
  "taskId",
  "title",
  "agent",
  "modelTier",
  "risk",
  "objective",
  "workflow",
  "requirements",
  "context",
  "boundaries",
  "acceptance",
  "execution",
];

const REQUIRED_TOP_LEVEL_KEYS = TOP_LEVEL_KEYS.filter((key) => key !== "modelTier");
```

并将根对象校验改为：

```ts
const source = validateObject(coercedInput, "$", TOP_LEVEL_KEYS, REQUIRED_TOP_LEVEL_KEYS);
```

在 canonical 对象中加入：

```ts
    modelTier: normalizeModelTier(source.modelTier, "modelTier"),
```

修改 `scripts/lib/subagent-dispatch/prompt.ts` 的 Identity 区，加入：

```js
    `- Model tier: \`${ir.modelTier}\``,
```

- [ ] **步骤 4：运行测试确认 GREEN**

运行：`node --test test/subagent-model-tier.test.mjs test/subagent-dispatch-ir.test.mjs`

预期：全部通过。

- [ ] **步骤 5：运行本任务相关回归**

运行：`node --test test/subagent-dispatch-ir.test.mjs test/subagent-dispatch-ir-coercion.test.mjs test/subagent-dispatch-validation-errors.test.mjs`

预期：全部通过。

---

### Task 3：将 Model Tier 接入 Typed Runtime Spawn

**Deps：** `T2`（理由：消费 T2 产出的 `executorModelForTier(tier)` 与 `ir.modelTier`）

**WritePaths：**
- `scripts/lib/subagent-dispatch/extension.ts`
- `test/subagent-dispatch-extension.test.ts`

**Resources：** `none`

**Files：**
- Modify：`scripts/lib/subagent-dispatch/extension.ts:7-12,269-281,354-407`
- Modify：`test/subagent-dispatch-extension.test.ts:1-126`

**接口契约：**
- Consumes：T2 的 `ir.modelTier` 和 `executorModelForTier()`。
- Produces：coding spawn workflow 的 leaf child 控制中包含 `model: "openai-codex/gpt-5.6-luna"` 或 `model: "openai-codex/gpt-5.6-terra"`。

**验收标准：**

- 未传 `modelTier` 的旧 contract spawn 时 child `model` 为 `openai-codex/gpt-5.6-luna`。
- `modelTier: "terra"` spawn 时 child `model` 为 `openai-codex/gpt-5.6-terra`。
- `agent` 仍为 `executor`；spawn params 不暴露 `spawnKey`；durable identity 逻辑保持原样。

- [ ] **步骤 1：编写失败测试**

在 `test/subagent-dispatch-extension.test.ts` 增加 helper：

```ts
function workflowLeaf(params: any) {
  const match = String(params.workflowScript).match(/runs\.run\("[^"]+", (.*)\);/);
  assert.ok(match?.[1]);
  return JSON.parse(match[1]);
}
```

增加测试：

```ts
test("coding spawn defaults executor child model to Luna", async () => {
  const { pi, rpc, calls, tools } = setup();
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {} });
  await tools[0].execute("tier-luna", contract, undefined, undefined, { cwd: "/repo" });
  assert.equal(workflowLeaf(calls[0]?.params).agent, "executor");
  assert.equal(workflowLeaf(calls[0]?.params).model, "openai-codex/gpt-5.6-luna");
});

test("coding spawn maps terra modelTier to Terra child model", async () => {
  const { pi, rpc, calls, tools } = setup();
  createTypedSubagentExtension(pi, { rpc, cleanupStore: {} });
  await tools[0].execute("tier-terra", { ...contract, modelTier: "terra" }, undefined, undefined, { cwd: "/repo" });
  assert.equal(workflowLeaf(calls[0]?.params).agent, "executor");
  assert.equal(workflowLeaf(calls[0]?.params).model, "openai-codex/gpt-5.6-terra");
});
```

- [ ] **步骤 2：运行测试确认 RED**

运行：`node --test test/subagent-dispatch-extension.test.ts`

预期：新增测试失败，workflow leaf 没有 `model` 字段。

- [ ] **步骤 3：编写最小实现**

在 `scripts/lib/subagent-dispatch/extension.ts` 引入：

```ts
import { executorModelForTier } from "./model-tier.ts";
```

修改 `codingWorkflowSpawnParams()`：

```ts
function codingWorkflowSpawnParams(ir, prompt, workflowKey) {
  return buildWorkflowSpawn({
    workflowKey,
    agent: ir.agent,
    task: prompt,
    cwd: ir.execution.cwd,
    context: "fresh",
    timeoutMs: ir.execution.timeoutMs,
    child: { output: false, model: executorModelForTier(ir.modelTier) },
    acceptance: {
      criteria: ir.acceptance.criteria,
      evidence: CODING_ACCEPTANCE_EVIDENCE,
    },
  });
}
```

- [ ] **步骤 4：运行测试确认 GREEN**

运行：`node --test test/subagent-dispatch-extension.test.ts`

预期：全部通过。

- [ ] **步骤 5：运行本任务相关回归**

运行：`node --test test/subagent-dispatch-extension.test.ts test/subagent-workflow-spawn.test.mjs test/subagent-dispatch-rpc.test.mjs`

预期：全部通过。

---

### Task 4：更新 Typed Tool Schema 与 Tool Description

**Deps：** `T2`（理由：消费 T2 产出的 `modelTier` 枚举和默认语义）

**WritePaths：**
- `scripts/lib/subagent-dispatch/extension.ts`
- `test/subagent-dispatch-schema-coercion.test.mjs`

**Resources：** `none`

**Files：**
- Modify：`scripts/lib/subagent-dispatch/extension.ts:36-109,180-184`
- Modify：`test/subagent-dispatch-schema-coercion.test.mjs:18-126`

**接口契约：**
- Consumes：T2 的 `modelTier` 字段语义。
- Produces：`TYPED_SUBAGENT_PARAMETERS` 接受可选 `modelTier: "luna" | "terra"`，拒绝其他值；tool description 告诉主 Agent `modelTier` 是 coding contract 的一部分。

**验收标准：**

- 旧 coding contract 仍通过 schema。
- `modelTier: "luna"` 和 `modelTier: "terra"` 通过 schema。
- `modelTier: "sol"` 被 schema 拒绝。
- tool description 包含“executor supports optional modelTier”语义，且不鼓励 generic coding dispatch。

- [ ] **步骤 1：编写失败测试**

在 `test/subagent-dispatch-schema-coercion.test.mjs` 增加：

```js
test("schema accepts optional coding modelTier values", () => {
  for (const modelTier of ["luna", "terra"]) {
    const input = validCodingContract();
    input.modelTier = modelTier;
    assert.equal(validator.Check(input), true, `${modelTier} modelTier should pass schema validation`);
  }
});

test("schema rejects unsupported coding modelTier values", () => {
  const input = validCodingContract();
  input.modelTier = "sol";
  assert.equal(validator.Check(input), false, "unsupported modelTier should fail schema validation");
});
```

- [ ] **步骤 2：运行测试确认 RED**

运行：`node --test test/subagent-dispatch-schema-coercion.test.mjs`

预期：`modelTier` 因 additional properties 被拒绝，合法 tier 测试失败。

- [ ] **步骤 3：编写最小实现**

在 `CODING_SCHEMA.properties` 增加：

```ts
    modelTier: { enum: ["luna", "terra"] },
```

保持 `CODING_SCHEMA.required` 不包含 `modelTier`。

将 `TYPED_SUBAGENT_DESCRIPTION` 的 executor 句子改为：

```ts
For executor, provide the complete dispatch-ir.v1 contract; free-form task dispatch is rejected. Coding contracts may include modelTier:"luna" or modelTier:"terra"; omit modelTier for the default Luna execution tier. Do not use generic dispatch for coding work just to choose a model.
```

- [ ] **步骤 4：运行测试确认 GREEN**

运行：`node --test test/subagent-dispatch-schema-coercion.test.mjs`

预期：全部通过。

- [ ] **步骤 5：运行本任务相关回归**

运行：`node --test test/subagent-dispatch-schema-coercion.test.mjs test/subagent-dispatch-validation-errors.test.mjs test/subagent-dispatch-extension.test.ts`

预期：全部通过。

---

### Task 5：更新 Subagent Dispatch Skill 与 Executor 职责边界

**Deps：** `none`

**WritePaths：**
- `skill-overrides/subagent-dispatch/SKILL.md`
- `pi/agents/executor.md`

**Resources：** `none`

**Files：**
- Modify：`skill-overrides/subagent-dispatch/SKILL.md:8-30`
- Modify：`pi/agents/executor.md:3-12`

**接口契约：**
- Consumes：现有 `dispatch-ir.v1`、T2 的 `modelTier` 语义。
- Produces：最小化的 typed-contract API 语义与 executor 边界：`modelTier` 选择请求的主 Luna/Terra 偏好；配置的 fallbackModels 可在可重试 provider/auth/quota/rate-limit/network 失败时尝试；run/status/artifact 的 actual model 为准；父级需求或架构不清时回 supervisor。

**验收标准：**

- `subagent-dispatch` skill 明确要求 coding work 仍走 `dispatch-ir.v1`，不得用 generic dispatch 选择模型。
- Skill 以最小文字明确 requested-primary、configured fallback 与 actual-model authority；保留“五项基线控制均正确路由”的历史证据，不新增完整 Luna/Terra 路由教程。
- `executor.md` 说明 model tier 是资源选择，不扩大 write scope、不改变父级架构决策、不替代 supervisor。
- `executor.md` 的模型 frontmatter 保持当前值，不因引入 tier 删除 fallback。

- [ ] **步骤 1：编写失败检查**

运行以下只读检查，记录当前缺失项：

```bash
python3 - <<'PY'
from pathlib import Path
skill = Path('skill-overrides/subagent-dispatch/SKILL.md').read_text()
agent = Path('pi/agents/executor.md').read_text()
assert 'modelTier' in skill
assert 'Luna' in skill and 'Terra' in skill
assert 'generic dispatch' in skill
assert 'model tier' in agent
PY
```

预期：脚本因缺少 `modelTier` 或 `model tier` 断言失败。

- [ ] **步骤 2：更新 Skill 路由规则**

在 `skill-overrides/subagent-dispatch/SKILL.md` 的 `## Coding` 段落中最小更新 API 语义：`modelTier` 是请求的主 Luna/Terra 偏好，configured fallbackModels 可在可重试 provider/auth/quota/rate-limit/network 失败时尝试，run/status/artifact actual-model metadata 为准；仍不得用 generic dispatch 绕过 typed coding contract。

保留示例中的：

```js
modelTier: "luna",
```

历史证据：五项无 Skill 控制均已正确路由，因此不新增完整 Luna/Terra 路由教程。

- [ ] **步骤 3：更新 Executor Agent 描述**

将 `pi/agents/executor.md` frontmatter description 改为：

```yaml
description: Deterministic coding executor for typed dispatch contracts with parent-selected Luna/Terra model tiers
```

在正文开头加入：

```markdown
Model tier is a routing/resource choice selected by the parent. It does not change your authority: execute the typed dispatch contract, preserve declared write scope, and do not revise parent-level architecture or task boundaries.

If required implementation strategy, public API shape, or task boundary is undecided, use `contact_supervisor` with `reason: "need_decision"` instead of silently deciding. Terra tier may diagnose harder implementation problems, but it is still an executor tier, not a planner role.
```

- [ ] **步骤 4：运行检查确认 GREEN**

运行：

```bash
python3 - <<'PY'
from pathlib import Path
skill = Path('skill-overrides/subagent-dispatch/SKILL.md').read_text()
agent = Path('pi/agents/executor.md').read_text()
for needle in ['modelTier', 'Luna', 'Terra', 'generic dispatch', 'parent/supervisor']:
    assert needle in skill, needle
for needle in ['Model tier', 'typed dispatch contract', 'contact_supervisor', 'not a planner role']:
    assert needle in agent, needle
PY
```

预期：命令退出码为 0。

- [ ] **步骤 5：运行本任务相关回归**

运行：`node scripts/doctor.mjs`

预期：Doctor 通过；如果只因当前机器未暴露 `codex-pool` 报告既有 provider 可用性问题，记录该输出但不修改凭据或 `enabledModels`。

---

### Task 6：最终回归与真实配置验收

**Deps：** `T1`（理由：验证 prompt 路由修复）、`T3`（理由：验证 runtime spawn model override）、`T4`（理由：验证 schema）、`T5`（理由：验证文案与 agent profile）

**WritePaths：**
- `docs/plans/2026-08-19-executor-model-tier.md`

**Resources：** `none`

**Files：**
- Modify：`docs/plans/2026-08-19-executor-model-tier.md`（勾选任务状态和记录验收结果）

**接口契约：**
- Consumes：T1-T5 的全部交付物。
- Produces：一份可审查的验收记录，证明 prompt 路由、IR、schema、runtime spawn 和文案均一致。

**验收标准：**

- 所有聚焦单测通过。
- Resource loader 仍发现 `pi/extensions/model-system-prompt.ts` 和 `pi/extensions/subagent-runtime.ts`。
- 当前模型 registry 至少可列出 `openai-codex/gpt-5.6-luna` 和 `openai-codex/gpt-5.6-terra`；如本机 registry 隐藏 provider，记录实际 `pi --list-models` 输出。
- 不产生 `pi/settings.json` 的 `enabledModels` diff。

- [ ] **步骤 1：运行完整聚焦回归**

运行：

```bash
node --test \
  test/model-system-prompt.test.mjs \
  test/subagent-model-tier.test.mjs \
  test/subagent-dispatch-ir.test.mjs \
  test/subagent-dispatch-ir-coercion.test.mjs \
  test/subagent-dispatch-schema-coercion.test.mjs \
  test/subagent-dispatch-validation-errors.test.mjs \
  test/subagent-dispatch-extension.test.ts \
  test/subagent-workflow-spawn.test.mjs \
  test/subagent-dispatch-rpc.test.mjs
```

预期：全部通过。

- [ ] **步骤 2：运行 Doctor**

运行：`node scripts/doctor.mjs`

预期：通过；如输出环境相关问题，保留原始摘要并停止自动修复凭据或 per-machine 设置。

- [ ] **步骤 3：确认 extension 发现**

运行：

```bash
node --input-type=module <<'NODE'
import { join, resolve } from 'node:path';
import { loadPiTestRuntime } from './test/helpers/pi-runtime.mjs';
const repoRoot = resolve('.');
const { codingAgent } = await loadPiTestRuntime(import.meta.url);
const { DefaultResourceLoader } = codingAgent;
const loader = new DefaultResourceLoader({
  cwd: repoRoot,
  agentDir: join(repoRoot, 'pi'),
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: false,
});
await loader.reload();
const paths = loader.getExtensions().extensions.map((entry) => entry.path);
for (const required of [
  '/pi/extensions/model-system-prompt.ts',
  '/pi/extensions/subagent-runtime.ts',
]) {
  if (!paths.some((path) => String(path).endsWith(required))) throw new Error(`missing ${required}`);
}
console.log('required extensions discovered');
NODE
```

预期：输出 `required extensions discovered`。

- [ ] **步骤 4：确认 Luna/Terra registry 可见性**

运行：

```bash
pi --list-models 'gpt-5.6-luna|gpt-5.6-terra'
```

预期：输出包含 `openai-codex  gpt-5.6-luna` 和 `openai-codex  gpt-5.6-terra`。如果当前 shell wrapper 不支持正则过滤，分别运行 `pi --list-models luna` 与 `pi --list-models terra`。

- [ ] **步骤 5：确认 Git diff 不含 per-machine enabledModels**

运行：

```bash
git diff -- pi/settings.json
```

预期：无输出，或输出不包含 `enabledModels`。如果出现 `enabledModels` diff，停止并请用户确认是否丢弃该 hunk。

- [ ] **步骤 6：记录验收结果**

在本计划对应任务复选框旁记录实际命令结果摘要；不创建 commit。

---

## T7 最终审查失效与恢复记录（2026-08-19）

- T6 的原“最终验收”记录已被最终审查**失效**：当时 `Goal` 的 `dispatch-ir.mjs` 未归一化并哈希 `modelTier`，而 typed `ir.ts` 会将省略值归一为 `luna`。因此 Goal 生成的 transport/hash 与 executor 实际校验形状不同。
- 修复前已保留 RED 证据：`node --test test/goal-engine-executor-binding.integration.mjs` 为 11/19 通过、8/19 失败，失败均为 `EXECUTOR_CONTRACT_MISMATCH`。详见 `docs/bugs/2026-08-19-goal-executor-model-tier-hash-mismatch.md`。
- T7 新增普通单测 `test/goal-subagent-dispatch-parity.test.mjs`。它以 criteria-only acceptance 分别编译省略 tier（归一为 Luna）和显式 Terra 的同一合同，断言 Goal/typed transport 及 SHA-256 完全一致；修复前该测试为 0/2，修复后为 2/2。
- T7 实现：Goal IR 导入共享 `normalizeModelTier()`，接收可选顶层 `modelTier`，将归一化 tier 纳入 canonical hash、transport 和 prompt；`compileTaskContract()` 明确为已由 planner 界定的 Goal 工作写入 `modelTier: "luna"`，未向 Goal task-definition 新增字段。历史内部 `acceptance.commands` 仍可由 Goal IR 处理，但 Goal-to-typed transport 继续仅发送 criteria。
- 恢复验证：`node --test test/goal-engine-dispatch.integration.mjs` 25/25 通过；`node --test test/goal-engine-executor-binding.integration.mjs` **19/19 通过**；聚焦 tier suite（`test/subagent-model-tier.test.mjs`、`test/subagent-dispatch-ir.test.mjs`、`test/goal-subagent-dispatch-parity.test.mjs`）22/22 通过；`npm test` 633/633 通过并包含该普通 parity test。
- 由于 Goal binding 已恢复为 19/19 green，T7 后的最终验收恢复；未创建 commit。

---

## T8 实际证据（2026-08-19）

- T6：原完整计划的 session JSONL 快照已从指定会话第 7 条记录恢复（同内容亦在第 9 条）；恢复前的十行 T7 恢复记录完整保留在本计划中。
- T7：Goal IR 的 `modelTier` 归一化、canonical hash、transport 与 prompt 修复仍在；本次 binding 回归为 **19/19** green。
- T8 RED：先将 typed 与 Goal prompt 行为断言改为 `Requested model tier`，再运行 `node --test test/subagent-dispatch-ir.test.mjs test/goal-engine-dispatch.integration.mjs`；结果 **40/42**，两项 renderer 断言因生产提示仍为 `Model tier` 失败。
- T8 实现：typed 和 Goal renderer 均改为 `Requested model tier`，不修改 canonical `modelTier` 或 hash。tool description、Skill 与 executor 统一为“请求的主偏好；配置 fallbackModels 可在可重试 provider/auth/quota/rate-limit/network 失败时尝试；run/status/artifact actual-model metadata 为准”。executor 明确 fallback 或 actual model 不改变 authority、write scope 或 parent decisions。Skill 仅作最小 API 语义更新；五项无 Skill 控制均正确路由的历史结论保留，未新增完整路由教程。
- T8 GREEN：`node --test test/subagent-dispatch-ir.test.mjs test/goal-engine-dispatch.integration.mjs test/goal-subagent-dispatch-parity.test.mjs` 为 **44/44**；`node --test test/goal-engine-executor-binding.integration.mjs` 为 **19/19**；`npm test` 为 **633/633**。
- T8 Goal 全套：`npm run test:goal-engine` 为 **856/902**，**46 failed**，故不标记最终验收。失败来自既有未纳入本任务写入范围的 Goal/runtime/worktree 变更：legacy event generation replay-only、Goal host `execute` 未注册，以及 worktree registry 多出 `reanchorAllocation`；本任务相关 focused、parity 与 binding suites 均 green。
