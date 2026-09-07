# Subagent 统一模型选择参数实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**目标：** 删除 `modelTier`，让 typed executor 与 generic subagent 统一使用可选 `model` 参数；支持完整 `provider/model-id` 精确匹配和裸 `model-id` 确定性匹配，并对使用全局可用模型目录的匹配返回显式警告。

**架构：** 新建纯函数模型解析器，将“请求值、agent frontmatter 候选、当前可用模型目录”解析为 canonical `provider/model-id`、解析来源和 warnings。Typed coding IR 只负责校验和持久化原始 `model`；extension 在 spawn 前发现 agent metadata、读取 `ctx.modelRegistry.getAvailable()`、调用解析器，再把 canonical model 传给 child。省略 `model` 时保持现有 agent `models` ordered fallback 行为，不产生额外警告。

**技术栈：** TypeScript、Node.js 22.19+、TypeBox JSON Schema、Pi Extension API、pi-subagents 0.62.0 compatibility layer、Node test runner。

## 全局约束

- 删除 public `modelTier` 参数、`MODEL_TIERS`、tier-to-model 映射及所有 `luna|terra` whitelist 语义。
- `model` 是唯一模型选择参数，coding 与 generic 两种 subagent 调用均可使用。
- `model: "provider/model-id"` 必须在当前可用模型目录中按完整 `provider/model-id` 精确匹配；无匹配直接失败。
- `model: "model-id"` 且目标 agent frontmatter 声明 `models` 时，只在该有序列表中按 model ID 精确匹配；同名采用声明顺序第一项，不搜索全局目录，不产生 global-match warning。
- `model: "model-id"` 且目标 agent 未声明 `models` 时，在 `ctx.modelRegistry.getAvailable()` 中按完整 `provider/model-id` 升序后精确匹配 model ID；采用第一项。
- 只有使用全局可用模型目录完成 bare-ID 匹配时，回执文本和 `details.warnings` 才返回 `MODEL_MATCH_USED_GLOBAL_CATALOG` 警告，包含 requested/resolved model 与 agent 名称。
- agent 声明了 `models` 但没有匹配项时直接失败，禁止静默退到全局目录。
- 显式 `model` 匹配失败时直接失败，禁止回退到 agent 默认模型或 ordered fallback。
- 未提供 `model` 时保持现有行为：executor 使用 agent frontmatter `models` ordered fallback；generic agent 使用自身 metadata/default model。
- model resolution 必须发生在 workspace allocation 和 RPC spawn 之前；解析失败不得创建 workspace、workflow 或 child run。
- coding dispatch hash 与 generic workspace contract hash 必须包含原始 `model`，防止不同模型请求共享同一 durable identity。
- 实际 child model 与解析结果仍由运行时 actual-model metadata 校验；不得用回执中的 requested model 冒充实际模型。
- agent discovery 只能经 `src/compat/pi-subagents-0.62.ts` 导出的兼容入口消费，禁止新增其他 pi-subagents 深层 import。
- warnings 是稳定结构化数据，不只拼入人类文本；没有 warning 时 `details.warnings` 为缺省而不是空噪声字段。
- 不改 agent Markdown 中现有 `models` 候选顺序，不修改 `pi/settings.json` 或 `pi/models.json`。
- 所有逻辑变更遵循 TDD；测试验证解析结果、spawn 参数和回执，不对文档或源代码字面值建立镜像断言。
- 当前未提交的“放宽 modelTier”实验不是实现基线；执行本计划前恢复到仓库 HEAD，再从 RED 开始。
- 不创建 commit 或 push，除非用户另行明确授权。

## 解析规则

| 请求 | Agent 有 `models` | 解析结果 | Warning |
|---|---|---|---|
| 未传 `model` | 任意 | 不覆盖 child model，沿用现有 metadata/default | 无 |
| `codex-pool/gpt-5.6-sol` | 任意 | 在 available catalog 中完整精确匹配 | 无 |
| `gpt-5.6-sol` | 是 | 在 agent `models` 中按声明顺序匹配 `.id` | 无 |
| `gpt-5.6-sol` | 否 | available catalog 按 full ID 升序后匹配 `.id` | `MODEL_MATCH_USED_GLOBAL_CATALOG` |
| 裸 ID 在 agent 候选中不存在 | 是 | 失败 | 不启动 child |
| 任意请求无匹配 | 任意 | 失败 | 不启动 child |

## DAG

```text
T1（纯解析器） ──> T2（Schema 与 Coding IR） ──> T3（Extension spawn 与回执）
      │                         │                         │
      └─────────────────────────┴────────────────────────> T4（文档与 Skill）
                                                        │
                                                        v
                                                T5（完整回归与 reload 验证）
```

## Waves

- Wave 1：T1
- Wave 2：T2
- Wave 3：T3
- Wave 4：T4
- Wave 5：T5

**关键路径：** T1 → T2 → T3 → T4 → T5。

---

### Task 1：实现纯模型解析器

**Deps：** `none`

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/model-selection.ts`
- `test/subagent-model-selection.test.mjs`

**Resources：** `none`

**Files：**
- Create：`model-selection.ts`
- Create：`subagent-model-selection.test.mjs`

**接口契约：**
- Consumes：`requestedModel?: string`、`agentName: string`、`agentModels?: string[]`、`availableModels: Array<{provider:string,id:string}>`。
- Produces：`{ model?: string, source: "default"|"qualified"|"agent-candidates"|"global-catalog", warnings?: ModelSelectionWarning[] }`。

**验收标准：** 六种解析规则均确定性通过；所有失败均在 spawn 前产生稳定错误；不依赖 Pi runtime 或文件系统。

- [ ] **步骤 1：编写 qualified exact RED 测试**

测试完整 `provider/model-id` 只接受 available catalog 的完整精确匹配，错误 provider 和错误 model ID 均失败。

- [ ] **步骤 2：编写 agent-candidate bare-ID RED 测试**

fixture 中两个 provider 均声明同一 model ID，断言采用 frontmatter 声明顺序第一项；不存在时失败且不访问 global catalog。

- [ ] **步骤 3：编写 global-catalog bare-ID RED 测试**

agent 无 `models`，available catalog 以逆序输入两个同 ID provider；断言按 canonical full ID 升序选第一项，并返回：

```ts
{
  code: "MODEL_MATCH_USED_GLOBAL_CATALOG",
  agent: "delegate",
  requestedModel: "gpt-5.6-sol",
  resolvedModel: "codex-pool/gpt-5.6-sol"
}
```

- [ ] **步骤 4：运行测试确认 RED**

运行：`node --test test/subagent-model-selection.test.mjs`

预期：FAIL，原因是 `model-selection.ts` 尚不存在。

- [ ] **步骤 5：实现最小纯函数**

实现输入归一化、完整 ID 精确匹配、agent candidate 顺序匹配、global catalog 排序匹配和 warning 构造；仅 trim 输入，不做模糊、前缀、日期或分隔符等价匹配。

- [ ] **步骤 6：运行 GREEN 与 mutation check**

运行：`node --test test/subagent-model-selection.test.mjs`

预期：PASS。手工验证交换 candidate 顺序、删除排序、把 agent miss 改为 global fallback 时至少一个测试失败。

---

### Task 2：统一工具 Schema 与 Coding IR

**Deps：** `T1`（理由：IR 的 `model` 语义由 T1 解析器合同定义）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/ir.ts`
- `packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts`
- `test/subagent-dispatch-ir.test.mjs`
- `test/subagent-dispatch-schema-coercion.test.mjs`
- `test/subagent-dispatch-schema-security.test.mjs`

**Resources：** `none`

**Files：** Modify：tool schema、内部 IR、公开 contract codec 及对应测试。

**接口契约：**
- Consumes：T1 的 requested model 字符串合同。
- Produces：coding/generic schema 均支持可选 `model`；所有 schema/IR 均拒绝 `modelTier`。

**验收标准：** executor typed contract 与 generic contract 都接受 `model`；`modelTier` 作为未知字段被拒绝；coding hash 对 model 变化敏感；model 缺省保持历史 hash/行为的兼容解释。

- [ ] **步骤 1：修改测试形成 RED**

把现有 `modelTier` 测试替换为 `model`，新增 executor/generic 接受 `model`、拒绝 `modelTier`、空 model 拒绝、不同 model 产生不同 coding hash 的行为断言。

- [ ] **步骤 2：运行测试确认 RED**

运行：

```bash
node --test test/subagent-dispatch-ir.test.mjs
node --test test/subagent-dispatch-schema-coercion.test.mjs test/subagent-dispatch-schema-security.test.mjs
```

预期：FAIL，原因是 schema/IR 仍暴露 `modelTier`，coding contract 尚不接受 `model`。

- [ ] **步骤 3：修改内部与公开 IR**

将 TOP_LEVEL_KEYS 中的 `modelTier` 替换为 `model`；使用既有非空字符串归一化；canonical hash 保留 normalized `model`；删除 `normalizeModelTier`、`model-tier.ts` 及 tier 映射调用。

- [ ] **步骤 4：修改工具 union schema**

`CODING_SCHEMA.properties` 和 `GENERIC_SCHEMA.properties` 均声明同形的可选 `model`；不保留 compatibility alias `modelTier`。

- [ ] **步骤 5：运行 GREEN**

重复步骤 2 命令，预期全部 PASS。

---

### Task 3：Agent metadata 解析、spawn 应用和 warning 回执

**Deps：** `T1`（解析器）；`T2`（统一 `model` schema/IR）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/compat/pi-subagents-0.62.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `test/subagent-dispatch-extension.test.ts`
- `test/subagent-model-selection.integration.mjs`

**Resources：** 测试内 fake model registry 与 agent discovery；不访问网络。

**Files：**
- Modify：compat export、extension execution/spawn/receipt。
- Create：model selection integration test。

**接口契约：**
- Consumes：`discoverAgents(cwd,"both",preferredProvider)` 返回的 `AgentConfig.models`；`ctx.modelRegistry.getAvailable()`；T1 resolver。
- Produces：spawn child canonical model；coding/generic receipts 的 `modelSelection` 和可选 `warnings`。

**验收标准：** 所有 agent 均可用 `model`；executor 候选内 bare match 无 warning；delegate 无候选时 global match 有显式 warning；解析失败不分配 workspace、不 ping RPC、不启动 workflow。

- [ ] **步骤 1：在 compat 层暴露 agent discovery**

只从 `src/compat/pi-subagents-0.62.ts` 导出 `discoverAgents` 和 `AgentConfig` 类型；其他文件不得直接 import `pi-subagents/src/agents/agents.ts`。

- [ ] **步骤 2：编写 spawn RED 测试**

覆盖：

1. executor `model:"gpt-5.6-sol"` 在 agent `models` 中选择声明顺序第一项。
2. delegate `model:"gpt-5.6-sol"` 从 fake available catalog 字典序匹配。
3. qualified model 完整精确匹配。
4. agent candidate miss、qualified miss 均在 workspace/RPC 前失败。
5. 未传 model 不写 child.model。

- [ ] **步骤 3：运行测试确认 RED**

运行：`node --test test/subagent-dispatch-extension.test.ts test/subagent-model-selection.integration.mjs`

预期：FAIL，原因是 extension 尚未解析 agent metadata/catalog，也没有 warning receipt。

- [ ] **步骤 4：在 executeCoding/executeGeneric 前统一解析 model**

发现目标 agent 的 effective metadata；将 registry models 规范化为 `{provider,id}`；调用 T1 resolver。解析完成后再进入 Goal/workspace/RPC 流程。

- [ ] **步骤 5：把 canonical model 传给 child**

coding 与 generic 的 workflow child 都设置 `model: resolved.model`；未传 model 时不覆盖 agent metadata。

- [ ] **步骤 6：扩展稳定回执**

成功回执 details 增加：

```ts
modelSelection: {
  requestedModel: "gpt-5.6-sol",
  resolvedModel: "codex-pool/gpt-5.6-sol",
  source: "global-catalog"
},
warnings: [{ code: "MODEL_MATCH_USED_GLOBAL_CATALOG", ... }]
```

同时在 content 首句后追加 `Warning: ...`；agent-candidates/qualified/default 不返回 warnings。

- [ ] **步骤 7：generic workspace hash 纳入 model**

`genericContractHash()` 加入 normalized requested model，验证同任务不同 model 生成不同 hash。

- [ ] **步骤 8：运行 GREEN**

重复步骤 3 命令，预期全部 PASS。

---

### Task 4：更新工具描述与 subagent-dispatch Skill

**Deps：** `T2`（公共 schema）；`T3`（回执与 warning 行为）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `skill-overrides/subagent-dispatch/SKILL.md`
- `test/subagent-dispatch-extension.test.ts`
- `test/subagent-dispatch-skill.test.mjs`

**Resources：** fresh-context delegate pressure test；不执行 coding。

**Files：** Modify：tool description、skill override、行为测试。

**接口契约：**
- Consumes：T2/T3 最终 public behavior。
- Produces：未来 agent 能正确选择 qualified/bare model，并在 global catalog warning 后向用户明确报告实际选择。

**验收标准：** 工具说明不再出现 `modelTier`；Skill 能指导 qualified、agent-candidate bare、global bare 三种路径；不会把 requested model 当作 actual model；global warning 不被隐藏。

- [ ] **步骤 1：运行无新指导的 fresh-context RED 场景**

给 delegate 一个“使用裸 model ID 派发并解释选择来源”的任务，记录它是否遗漏 global warning 或误称 actual model。

- [ ] **步骤 2：更新 tool description**

用正向合同描述唯一 `model` 参数、匹配顺序、global warning 和 actual-model 权威性；不保留旧 `modelTier` 说明。

- [ ] **步骤 3：更新 Skill**

只增加一段紧凑模型选择规则；保留“coding 必须使用 executor typed contract”的授权边界，因为模型参数泛化不改变 agent 权限。

- [ ] **步骤 4：运行相同 fresh-context GREEN 场景**

验证 agent 使用 `model`，能区分 requested/resolved/actual，并主动转述 global catalog warning。

- [ ] **步骤 5：运行文档消费行为测试**

运行：`node --test test/subagent-dispatch-skill.test.mjs test/subagent-dispatch-extension.test.ts`

预期：PASS。

---

### Task 5：完整回归、package 验证与 reload 验收

**Deps：** `T3`（runtime）；`T4`（public guidance）

**WritePaths：**
- `docs/reviews/2026-09-05-subagent-unified-model-selector-verification.md`

**Resources：** Pi RPC integration；不修改业务仓库。

**Files：** Create：中文验证记录。

**接口契约：**
- Consumes：完整实现。
- Produces：类型、package、unit/integration、reload 后工具 schema 与真实 spawn 的验收证据。

**验收标准：** 所有测试通过；`modelTier` 不存在于 production source/public skill；executor 和 delegate 均能按 `model` 工作；global bare match 回执含 warning；无部署、无 commit。

- [ ] **步骤 1：运行静态与 package 验证**

```bash
npm run typecheck
npm --prefix packages/pi-subagents-enhanced run verify:package
```

- [ ] **步骤 2：运行 focused tests**

```bash
node --test test/subagent-model-selection.test.mjs \
  test/subagent-dispatch-ir.test.mjs \
  test/subagent-dispatch-schema-coercion.test.mjs \
  test/subagent-dispatch-schema-security.test.mjs \
  test/subagent-dispatch-extension.test.ts \
  test/subagent-model-selection.integration.mjs
```

- [ ] **步骤 3：运行完整仓库测试**

运行：`npm test`

预期：PASS。

- [ ] **步骤 4：reload 后检查工具 schema**

执行 `/reload` 后检查 `subagent` tool：coding/generic 分支均有 `model`，均无 `modelTier`。

- [ ] **步骤 5：真实只读 spawn 验收**

1. 对有候选的 executor 传裸 model ID，验证 resolved model 来自 frontmatter、无 warning。
2. 对无候选的 delegate 传裸 model ID，验证回执含 `MODEL_MATCH_USED_GLOBAL_CATALOG`。
3. 用 status actual-model 元数据确认真实 child model；若与 resolved 不同则验收失败。

- [ ] **步骤 6：生成验证记录并停止**

记录命令、结果、requested/resolved/actual 模型和 warning 回执；不 commit、不 push、不继续修改 Sub2API。
