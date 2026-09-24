# B — dispatch 合同 / 模型路由 / 生命周期控制源码级归因

## 1. 摘要

**一句话结论：这组失败并非单纯“agent 不会填参数”，而是一个为兼容多种模型而拍平的单一工具 Schema，将 coding / generic / control 三套字段同时暴露且不声明顶层必填或条件依赖；严格的 `dispatch-ir.v1` 编译器随后才拒绝这些 Schema 可接受的输入，再叠加错误文本缺少修复模板、skill 的目录路径规则与源码相反、模型失败不返回候选、paused 无取消转换，形成高频试错。**

关键证据链：

1. 真正下发给模型的是 `TYPED_SUBAGENT_PARAMETERS` 与 `TYPED_SUBAGENT_DESCRIPTION`：工具注册直接把二者赋给 `parameters` / `description`（`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1278-1283`）；运行入口 `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts` 导入并调用 `installHeadlessTypedSubagentRuntime()`，最终注册这一 project-owned typed runtime。upstream compat 入口只重导出 `pi-subagents` API（`src/compat/pi-subagents-0.62.ts:1-9`），安装包版本由 `packages/pi-subagents-enhanced/node_modules/pi-subagents/package.json:2-3` 证实为 `0.62.0`。
2. Schema 被有意设计成根节点单一 object，不使用顶层 `oneOf/anyOf`；源码注释明确分支互斥“由 runtime 路由与 compiler 裁决”，Schema “只引导字段集与类型”（`extension.ts:44-48`）。结果是根节点没有 `required`，generic 的 `outputMode` 与 coding 字段同时出现（`extension.ts:49-159`）。
3. coding 路由只看 `version`，control 路由优先看 `action`（`extension.ts:1306-1316`）；coding 编译器实际只允许 13 个顶层字段且除 `model` 外全部必填（`src/contracts/dispatch-ir.ts:11-27,212-235`）。
4. 现场最高频 `boundaries` 缺失恰好发生 6 次（原始 session JSONL `:396,457,498,521,535,549`），证明不是理论上的 Schema 漂移，而是实际生产调用摩擦。
5. 另有一处必须升级处理的内部漂移：生产 extension 导入 `src/contracts/dispatch-ir.ts`（`extension.ts:6`），但仓库还保留一份 `src/subagent-dispatch/ir.ts`；前者要求 `writePaths` 至少 1 项（`contracts/dispatch-ir.ts:165-170`），后者允许空数组（`subagent-dispatch/ir.ts:207-216`）。测试甚至把后者的空数组行为写成“显式只读派发”（`test/subagent-dispatch-validation-errors.test.mjs:90-93`），因此该测试没有证明真实 public extension 接受只读空 scope。

### 现场数量校正

任务标题给出的聚合数中有两项与指定原始会话不一致：

- `MODEL_NOT_AVAILABLE`：原始 JSONL 可证 2 条，分别是 reviewer 的裸 `astra`（`:277`）和 executor 的完整但不可用 `qoder-pool/gpt-6-astra`（`:319`），不是 4 条。
- `SUBAGENT_RPC_FAILED`：`errors-only.txt`、`runtime-calls.txt` 和原始 JSONL 均只可证 1 条（原始 JSONL `:680`），不是 2 条。
- `INVALID_PATH`：原始 JSONL 可证 3 条；`runtime-calls.txt:999-1001,1503-1510` 分别为绝对路径、`**/*test.go` 中间 glob、尾随 `/`。

本文仍覆盖题目要求的失败机理，但不把未出现在权威现场中的额外次数写成事实；第二条 RPC 失败和另外两条 model 失败的来源属于“未证实”。

---

## 2. 真正的工具面与路由顺序

### 2.1 模型调用前实际看到什么

- **Schema 生成点**：`TYPED_SUBAGENT_PARAMETERS`（`extension.ts:49-159`）。
- **描述文本生成点**：`TYPED_SUBAGENT_DESCRIPTION`（`extension.ts:161-163`）。
- **注册点**：`createTypedSubagentExtension` 构造 `subagent` 工具，原样使用上述 description / parameters（`extension.ts:1278-1283`），随后 `pi.registerTool(tool)`（`extension.ts:1347`）。
- **路由优先级**：有 `action` → control；否则有 `version` → coding；否则 generic（`extension.ts:1306-1316`）。这不是 Schema 的条件分支，而是 execute-time JavaScript 路由。

### 2.2 为什么 Schema 没有完整表达合同

源码注释给出设计原因：某些严格 OpenAI-compatible provider 遇到根级联合 Schema 会生成空 arguments，所以根保持单 object（`extension.ts:44-48`）。但代价是：

- 顶层没有任何 `required`；
- coding、generic、control 字段被平铺；
- nested coding object 又通过 `runtimeValidated(..., looseObject/string)` 放宽，以便让字符串化 JSON 进入 compiler（`extension.ts:35-39,62-125`）；
- `workflow.reason` 的 mode 条件无法从 Schema 得知；
- 路径字段只是 string array，完整路径文法完全不在 Schema 中（`extension.ts:31-33,79-98`）。

这是兼容约束下的有意实现选择，但它没有被足够强的 description、分支示例或 actionable error 补偿。

---

## 3. 逐错误 A–E 分析

> F（全字段一致性审计）集中在第 4 节。

### 3.1 `INVALID_CONTRACT: $ contains unknown field outputMode`

#### A. 触发点

- coding 路由由 `version` 存在触发：`execute()` → `executeCoding()`（`extension.ts:1311-1314`）。
- `compileCodingDispatchIR()` 在 `src/contracts/dispatch-ir.ts:212-213` 调用 `validateObject()`。
- 顶层 allowlist 不含 `outputMode`（`dispatch-ir.ts:11-25`）；未知字段在 `validateObject()` 的 `:82-90` 被抛为 `INVALID_CONTRACT`，构造点是 `fail()`（`:42-44`）。
- 现场：`errors-only.txt:7-10`。

#### B. 校验规则原文转写

coding 顶层只允许：

`version, taskId, title, agent, model, risk, objective, workflow, requirements, context, boundaries, acceptance, execution`。

`outputMode` 不在其中，故对 coding 永远非法；它只在 generic child 参数复制名单中被转发（`extension.ts:390-405`）。coding 的 child output 被 runtime 固定为 `false`（`extension.ts:363-387`）。

#### C. 工具面可见性

- **JSON Schema：误导性可见。** 顶层明确声明 `outputMode: enum[inline,file-only]`（`extension.ts:132-134`），却没有条件说明它只属于 generic。
- **tool description：部分可见。** 文本说 generic 可带“optional generic fields”，但没有列出哪些字段；也没有明确说 coding 禁止 `outputMode`（`extension.ts:161-163`）。
- **SKILL.md：未提供 outputMode 的 coding/generic 归属表。** coding 示例不带它，generic 示例也没展示它。

结论：这是 **generic 合法、coding 非法，但平铺 Schema 无法表达条件约束**；不是 coding contract 应接受 `outputMode`。

#### D. 错误文本可行动性

现有文本只说 unknown field 和 keypath；能让 agent 删除字段，但没有解释“coding output 固定由 runtime 管理”或“仅 generic 可用”。一次改对的概率尚可，但不能建立正确心智模型。

建议英文文案：

> `INVALID_CONTRACT: outputMode is a generic-dispatch field and is forbidden in dispatch-ir.v1. Remove $.outputMode; coding output is runtime-managed (output:false). keypath=$.outputMode`

建议中文文案：

> `INVALID_CONTRACT：outputMode 仅用于 generic 派发，dispatch-ir.v1 禁止该字段。请删除 $.outputMode；coding 输出由 runtime 固定管理。keypath=$.outputMode`

`details` 建议增加：`branch:"coding"`, `allowedTopLevelFields:[...]`, `fix:"remove"`。

#### E. 责任归属

**(2) 使用方输入错误，但工具面诱导（工具面缺陷）。** 证据是同一 public Schema 声明该属性，而 execute-time coding allowlist 拒绝它；agent 不是凭空创造字段。

---

### 3.2 `INVALID_CONTRACT: $ is missing required field boundaries` ×6

#### A. 触发点

- 必填集合由 `TOP_LEVEL_KEYS.filter(key !== "model")` 构造（`dispatch-ir.ts:11-27`）。
- `validateObject()` 遍历 required keys，在缺失时抛错（`:82-90`）。
- public coding 编译入口在 `:212-213`。
- 六个现场点：原始 session JSONL `:396,457,498,521,535,549`。

#### B. 校验规则原文转写

coding 顶层除 `model` 外全部必填，故 `boundaries` 必填。其对象又必须**恰好**包含以下三个字段，均必填且不允许未知字段（`dispatch-ir.ts:165-170`）：

1. `writePaths`: string array；生产 compiler 要求去重后至少 1 项；
2. `excludedWork`: string array，可空；
3. `forbiddenActions`: string array，可空。

每个 array 最多 32 项；每个字符串 trim 后非空、默认最多 4096 UTF-8 bytes（`:94-125`）。

#### C. 工具面可见性

- **顶层必填：Schema 完全不可见。** 根节点没有 `required`。
- **子结构：Schema 可见但不具约束力。** structured branch 写了三子字段 required（`extension.ts:89-98`），但同一 `anyOf` 还接受任意 `looseObject` 或 string（`:35-39,89-98`）。
- **SKILL：示例可见。** coding 示例包含完整三字段（`SKILL.md:134` 起）；正文只笼统要求“完整 typed 合同”（`:60-66`），没有独立必填清单。

核心判定：**“coding 必须有 boundaries”完全没有被 JSON Schema 的顶层 required 表达。**

#### D. 错误文本可行动性

现有 message/details 只有 `$.boundaries`，不告诉三子字段、数组形状、只读任务如何表示。agent 加一个 `{}` 后还会连续遇到三个缺字段错误。

建议英文文案：

> `INVALID_CONTRACT: dispatch-ir.v1 requires $.boundaries = {"writePaths":["repo/relative/file" or "dir/**"],"excludedWork":[],"forbiddenActions":[]}. All three fields are required; writePaths must contain at least one entry in the production compiler. keypath=$.boundaries`

建议中文文案：

> `INVALID_CONTRACT：dispatch-ir.v1 必须提供 $.boundaries，完整形状为 {"writePaths":["仓库相对文件"或"目录/**"],"excludedWork":[],"forbiddenActions":[]}；三个子字段均必填。当前生产 compiler 还要求 writePaths 至少一项。keypath=$.boundaries`

#### E. 责任归属

**(2) 使用方漏字段，但工具面诱导。** Schema 接受缺失顶层字段，错误又不能一次给出完整修复对象。六次现场命中证明这是高频工具面问题，不是测试 fixture 污染。

特别风险：`src/subagent-dispatch/ir.ts:207-216` 与测试声称 `writePaths:[]` 可表示只读，而真正 production import 的 `src/contracts/dispatch-ir.ts:165-170` 要求至少 1 项。这是额外的 **(1) production 实现/测试合同漂移**。

---

### 3.3 `workflow.reason`：tdd 时 forbidden；docs-only 时 required

#### A. 触发点

`normalizeWorkflow()`：

- `workflow` 只允许 `mode,reason`，`mode` 必填（`dispatch-ir.ts:144-146`）；
- mode enum 为 `tdd | existing-tests | docs-only`（`:9-10,146-147`）；
- `tdd` 若**字段存在**即拒绝（即便空字符串也先因存在而拒绝）（`:148-150`）；
- 另外两种 mode 若缺 reason 即拒绝，存在时必须是 trim 后非空字符串（`:151-153,94-99`）。

现场：tdd 带 reason 在原始 JSONL `:398`；docs-only 缺 reason 在 `errors-only.txt:22-25`。

#### B. 可读规则

| mode | reason |
|---|---|
| `tdd` | **禁止出现** |
| `existing-tests` | **必填、非空** |
| `docs-only` | **必填、非空** |

这不是“reason 一般可选”，而是互斥条件依赖。

#### C. 工具面可见性

- **Schema：条件完全不可见。** `reason` 只是 optional string（`extension.ts:63-71`），没有 `if/then/else`、`oneOf` 或文字说明。
- **tool description：不可见。** 没提 mode/reason。
- **SKILL：明确可见。** `SKILL.md:66` 原文说明 tdd 禁止 reason，另外两种必须 reason。

因此可发现性取决于 agent 是否正确加载并记住 skill；单看工具 Schema 会被误导。这种“有时必填、有时禁止”对 LLM 极不稳健，现场先后反向犯错正是证据。

#### D. 错误文本可行动性

单次错误本身能指出当前动作（删或加），但没有给完整三态表；同会话发生相反错误说明局部提示没建立规则。

建议英文文案：

> `INVALID_CONTRACT: workflow.reason rule: omit it for mode="tdd"; provide a non-empty reason for mode="existing-tests" or "docs-only". Received mode="tdd" with reason. keypath=workflow.reason`

或：

> `... Received mode="docs-only" without reason. Add workflow.reason or change mode. keypath=workflow.reason`

建议中文文案：

> `INVALID_CONTRACT：workflow.reason 的完整规则是：mode=tdd 时禁止；mode=existing-tests/docs-only 时必须为非空字符串。当前 mode=tdd 但提供了 reason，请删除。keypath=workflow.reason`

#### E. 责任归属

**(2) 使用方输入错误但 Schema 未表达；skill 已明确。** 这不是 validator 逻辑 bug，测试也锁定了该意图（`test/subagent-dispatch-ir.test.mjs:217-226`）；agent 对 skill 负有直接责任，工具 Schema/description 对可发现性负有产品责任。

---

### 3.4 `INVALID_PATH`：绝对路径与 unsupported pattern

#### A. 触发点

- path item 进入 `normalizeRepoRelativePath()`（`dispatch-ir.ts:128-142`）；`boundaries.writePaths` 调用点在 `:165-170`。
- 绝对路径、反斜杠、NUL → `must be a repo-relative POSIX path`（`:130-133`）。
- 不支持的 glob 或尾随 slash → `contains an unsupported path pattern`（`:134-136`）。
- 空 / `.` / `..` / 双斜杠 segment → `unsafe path segment`（`:137-140`）。
- 现场绝对路径：`errors-only.txt:43-46`；中间 glob 与尾随 slash：`runtime-calls.txt:1503-1510`。

#### B. 完整规则

见第 5 节完整 grammar。最重要的源码事实是：**唯一支持的范围表达式是末尾 `/**`；裸路径按精确路径处理；尾随 `/` 实际被拒绝。**

#### C. 工具面可见性

- **Schema：完全不可见。** item 只有非空 string / 长度限制，没有 path pattern（`extension.ts:31-33,94`）。
- **SKILL：部分可见但有错误。** 它说 repo-relative POSIX path，且说目录范围可以 `/**` **或 `/`**（`SKILL.md:66,107`）。源码却在 base 以 `/` 结尾时明确拒绝（`dispatch-ir.ts:134-136`）。
- 中间 glob、`?`、`[]`、unsafe segments 等规则，skill 没有完整列出。

#### D. 错误文本可行动性

- 绝对路径提示了“repo-relative POSIX”，但没说相对哪个 cwd，也没给改写例子。
- `unsupported path pattern` 完全没列允许的唯一 glob 与禁止字符；对尾随 `/` 更糟，因为它与 skill 正面冲突。

建议英文文案：

> `INVALID_PATH: boundaries.writePaths[0] must be relative to execution.cwd, use '/' separators, and be either an exact path (e.g. "src/a.ts") or a recursive directory scope ending in '/**' (e.g. "src/**"). Absolute paths, trailing '/', backslashes, '*', '?', '[' and ']' elsewhere, empty/'.'/'..' segments are forbidden. keypath=...`

建议中文文案：

> `INVALID_PATH：该路径必须相对 execution.cwd、使用 POSIX '/'；只支持精确路径（如 src/a.ts）或以 '/**' 结尾的递归目录（如 src/**）。禁止绝对路径、尾随 '/'、反斜杠、其他位置的 * ? [ ]，以及空/. /.. 段。keypath=...`

#### E. 责任归属

- 绝对路径：**(2) agent 输入错误；skill 已说明相对路径，但错误文本仍欠示例。**
- `**/*test.go` 等中间 glob：**(2) agent 输入错误，Schema/skill 未完整公开文法。**
- 尾随 `/`：**(1) production 工具面缺陷。** skill 明确宣称合法，而 canonical compiler 明确拒绝；这是合同文档与实现的真实矛盾。

---

### 3.5 `MODEL_NOT_AVAILABLE: ... astra; agent=reviewer`

#### A. 触发点

- `executeCoding/executeGeneric` 都调用 `resolveSpawnModel()`（coding：`extension.ts:746-747`；generic：`:924-925`），它读取 profile 与 available registry 后调用 `resolveModelSelection()`。
- `ModelSelectionError` 构造 code/message 在 `src/subagent-dispatch/model-selection.ts:27-33`。
- 匹配算法在 `:54-101`。
- reviewer 候选在 `pi/agents/reviewer.md:4-9`。
- 现场裸 `astra`：原始 JSONL `:277`。

#### B. 匹配算法规格

1. 请求省略/trim 后空：保留 default/profile fallback（`model-selection.ts:61-64`）。
2. 含 `/` 的 qualified ID：对过滤黑名单后的 available catalog 做**完整字符串精确匹配**（`:66-70`），不按 profile 候选做别名解析。
3. 裸 ID 且 profile 声明 `models`：按 profile 声明顺序，取 `provider/` 后的**完整 id 段等于 requested**且该 full ID 当前 available 的第一个候选（`:40-47,72-80`）；miss 后不查全局。
4. 裸 ID 且 profile 没声明 `models`：全局 available catalog 按 full ID 升序，找 `model.id === requested`，并产生 warning（`:82-101`）。
5. provider blacklist 先过滤，比较区分大小写（`:50-64`）。

因此：

- `astra` 与候选 id 段 `gpt-6-astra` 不相等，**必然失败**。
- `gpt-6-astra` 对 reviewer 是算法上正确的裸 id；只有当 `codex-pool/gpt-6-astra` 或 `openai-codex/gpt-6-astra` 至少一个当前在 allowed available catalog 中时才成功，不能仅凭 profile 声明保证现场可用。
- `model-tiers.yaml` 实际写的是 `gpt-6-astra`（`:7-18`），不是 `astra`。落差来自用户自然语言“使用 Astra”被 agent 擅自缩成产品昵称，而 skill 明确要求使用裸 **model-id**（`SKILL.md:46-50`）。

#### C. 工具面可见性

- **Schema：只见 non-empty string，不见候选。**（`extension.ts:58`）
- **tool description：算法充分可见。** qualified / bare / profile candidates / global fallback 都有说明（`:161-163`）。
- **SKILL：算法和 tier 名充分可见。**（`SKILL.md:44-79`；`model-tiers.yaml:7-18`）
- **profile：模型本身在 profile 文件可读，但调用工具前 Schema 没动态 enum。**

#### D. 错误文本可行动性

现有 message 只有 requested 与 agent；`details` 只有 code，实测没有 available/profile candidates、最近匹配或“应使用 gpt-6-astra”。不足以一次改对。

建议英文文案：

> `MODEL_NOT_AVAILABLE: bare model id "astra" does not exactly match any currently available model declared by agent "reviewer". Available declared IDs: ["gpt-6-astra", "gpt-5.6-sol", "glm-5.3"]. Did you mean "gpt-6-astra"? Bare IDs match the full id segment after provider/. No global fallback is used for profiles with models.`

建议中文文案：

> `MODEL_NOT_AVAILABLE：裸 model-id "astra" 未精确匹配 reviewer 当前可用的声明候选。可用声明 ID：[...]；是否应为 "gpt-6-astra"？裸名必须匹配 provider/ 后的完整 id；profile 已声明 models 时不会搜索全局目录。`

`details` 建议返回经过权限/黑名单过滤后的 `declaredCandidates`, `availableCandidates`, `requestedKind`, `suggestions`。

#### E. 责任归属

**(2) agent 输入错误，工具面错误回执不可行动。** skill/tier/profile 都足以证明正确字符串是 `gpt-6-astra`；router 没有把 `astra` 当 alias 是明确且经测试锁定的精确匹配语义（`test/subagent-model-selection.test.mjs:53-96`），不是路由 bug。但缺候选清单放大了恢复成本。

---

### 3.6 paused run 调用 stop：`invalid_state`

#### A. 触发点

- wrapper control 只验证 action 与 resume message，然后直接 `rpc[action]`（`extension.ts:1016-1024`）。
- typed client 对 stop 只做单次 `call("stop")`（`rpc-client.ts:157-180`）。
- 真正状态检查位于 pinned `pi-subagents@0.62.0`：`packages/pi-subagents-enhanced/node_modules/pi-subagents/src/extension/rpc.ts:668-680`，`status.state !== "running"` 即抛 `invalid_state`。
- stop capability 虽被声明为 true（同文件 `:440-458`），但 capability 不代表每个状态都合法。
- 现场：原始 JSONL `:709`。

#### B. 状态机与 paused 合法动作

源码可证：

```text
running --interrupt--> paused
running --stop-------> stopping -> stopped
paused  --resume-----> 启动 continuation/revived run（需 persisted session/recovery 资料）
stopped --resume----> 禁止
```

- runner 的 `interruptRunner()` 直接把 running 状态与 running steps 改为 `paused`（`packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/subagent-runner.ts:3798-3815`）；最终状态投影也令 `interrupted ? "paused"`（同文件 `:5334`）。
- resume resolver 只显式拒绝 `stopped`（`async-resume.ts:467-476`），随后要求可确定 child、session file 等（`:539-560`）。
- paused 下稳定合法的是 `status`；`resume` 是**有条件合法**（当前 session ownership、session file/recovery metadata 等均需通过）。
- `stop` 对 paused 非法；不存在 paused → stopped 的状态转换。
- “先 resume 再 stop”只能停止**新启动的 resumed/replacement run**；它不会把原历史 run 从 paused 改成 stopped。因此这不是严格意义上的原 run 唯一出路。若目标只是不要继续执行，paused 已没有 live running turn；若目标是把它标记为 canceled/stopped 或释放 retained 状态，当前没有 public action。

#### C. 工具面可见性

- **Schema：仅列 action enum，不给状态矩阵**（`extension.ts:151-157`）。
- **tool description：部分可见。** 明说 interrupt 后用带消息的 resume；stopped 不可 resume（`:161-163`），但没明确 paused 不能 stop，也没说明 resume 创建 continuation 而非原地改态。
- **skill：本次核对的 dispatch skill 没有 control 状态矩阵。**

#### D. 错误文本可行动性

文本只说 stop 仅支持 running，不告诉用户 paused 已无 live process、可尝试 resume、resume 的前提、或没有 paused→stopped 转换。

建议英文文案：

> `INVALID_STATE: run <id> is paused and has no live turn to stop. Allowed actions: status; resume with a non-empty message if recovery metadata is available. There is currently no paused→stopped transition; resuming and then stopping affects the replacement run, not this paused record.`

建议中文文案：

> `INVALID_STATE：run <id> 已 paused，没有可 stop 的活动 turn。可用动作：status；若恢复资料完整，可用非空 message 调用 resume。当前不支持 paused→stopped；resume 后再 stop 只作用于新 continuation，不会改写原 paused 记录。`

#### E. 责任归属

**(1) production 生命周期能力/可发现性缺口。** 状态机按设计工作，不是随机故障；但 public API 同时暴露 interrupt/stop，却没有“取消 paused retained run”的转换或清理语义，错误也没说明出路。需注意这不是“无法杀死一个仍在跑的进程”——paused 已是 terminal-like retained 状态；缺口是无法终止语义化/改态/回收。

---

### 3.7 `SUBAGENT_RPC_FAILED`

#### A. 触发点

现场唯一可证样本并非远端 RPC 传输失败：

1. `executeCoding()` 已完成 `rpc.ping()`，构建 `codingRequest`（`extension.ts:803-810`）。
2. 随后在真正 `dispatchExecution(...spawnWorkflowLeaf...)` 前调用 `hostAuthorizedDispatch()`（`:811-815`）。
3. `createAuthorizedDispatch()` 发现 cwd 位于 `PI_CODING_WORKSPACE_DIR` 内，在 `execution-contract.ts:154-163` 本地抛出无 `code` 的普通 Error。
4. extension catch 对无 code 的异常默认赋 `SUBAGENT_RPC_FAILED`（`extension.ts:1319-1331`），并因 trace stage 已是 `workflow-spawn`，把 `rpcOperation` 推断成 `spawn`；但此时 `rpc.spawn()` 尚未执行。
5. 现场 `causeCode:"unknown"` 正是普通 Error 无 code 的结果（`errors.ts:47-55`；原始 JSONL `:680`）。

#### B. 触发条件与重试语义

`SUBAGENT_RPC_FAILED` 当前是一个过宽兜底：

- 真 RPC 错误：client disposed、request id 冲突、reply version/id 协议错误、server reply error、5 秒 timeout（`rpc-client.ts:70-154`）。
- 假 RPC 错误：任何没有 `error.code` 的本地异常也会被 catch 默认归类（`extension.ts:1319-1327`），本次即是 execution authorization preflight。

**自动重试：没有。** 每个 `call()` 只注册一次 listener、emit 一次 request、等待一次 reply/timeout（`rpc-client.ts:87-154`）；`spawn()` 只是单次转发（`:161-166`）。`renew()` 只重建 client，不是操作级 retry（`:29-56`）。

对于本次 deterministic policy rejection，重试相同参数必然再次失败；应把 cwd 改回合法 origin，并由 managed workspace API/既有 run continuation 管理 workspace。对于 timeout/transport 类错误，盲目重试还存在“服务端已 spawn、reply 丢失”的重复派发风险，除非有稳定 requestId/idempotency proof。

#### C. 工具面可见性

- managed state root 禁止作为 public dispatch cwd 的规则在 Schema、tool description、SKILL 中均不可见。
- `details` 有 taskId/toolCallId/stage/rpcOperation/causeCode/causeMessage（`errors.ts:23-55`），诊断相关性较好，但本次 stage/operation 标签是误导的。

#### D. 错误文本可行动性

`causeMessage` 暴露了直接原因，但顶层 code 错，且没说明怎样继续已有 managed workspace；`causeCode:"unknown"` 也阻碍自动分类。

建议英文文案（本地 policy）：

> `INVALID_EXECUTION_CWD: execution.cwd is inside PI_CODING_WORKSPACE_DIR and cannot be used as a public dispatch origin. Do not spawn a nested standalone dispatch from a managed workspace path; resume the owning run or dispatch from the repository origin with execution.worktree:true. keypath=execution.cwd`

真 RPC 失败则建议：

> `SUBAGENT_RPC_FAILED: operation=<op>, stage=<stage>, cause=<code>. No automatic retry was performed. Before retrying spawn after timeout, query status by the stable request/run identity to avoid duplicates.`

#### E. 责任归属

- cwd 输入：**(2) 使用方输入违反隐含 policy，工具面未公开规则。**
- 把本地 preflight 错标为 RPC/spawn、causeCode unknown：**(1) production 错误分类缺陷。**
- 题目所称第 2 条 RPC 失败：指定三份现场都找不到，判为 **(3) 来源未证实**。

---

### 3.8 缺 `version` 的 `INVALID_GENERIC_DISPATCH` / `INVALID_CODING_ROUTER`

#### A. 触发点

无 `version` 会落到 generic。若 `agent/title/task` 不完整，runtime 检查输入是否含 `taskId`、`objective` 或 `workflow`：命中则返回 `INVALID_CODING_ROUTER`；否则返回 `INVALID_GENERIC_DISPATCH`（`extension.ts:909-920`）。测试覆盖在 `test/subagent-dispatch-validation-errors.test.mjs:96-113`。

#### B. 规则

- coding 唯一路由标记：`version` 属性存在（`extension.ts:1311-1314`）；值错误会进入 coding 后得到 `UNSUPPORTED_VERSION`。
- 缺 version + 三个 coding 特征字段之一 + generic 三必填不完整 → 自诊断。
- 缺 version 但恰好满足 generic `agent/title/task` → 会按 generic 合法派发，即便还混有其他 coding-like 字段；自诊断不是全面 branch discriminator。

#### C. 工具面可见性

SKILL 对该路由规则和自诊断路径写得很清楚（`SKILL.md:60-66`）；Schema 本身因根级平铺不要求 version。

#### D. 错误文本可行动性

`INVALID_CODING_ROUTER` 文案直接给出 `version:"dispatch-ir.v1"`，可行动性良好。`INVALID_GENERIC_DISPATCH` 也给三必填字段，但对未被三个 heuristic 字段识别的畸形 coding 输入仍可能误导。

建议把检测扩到任一 coding-exclusive 字段（`risk/objective/workflow/requirements/boundaries/execution/taskId`），并在 generic 输入混入这些字段时 fail closed，而不是只有 generic 三字段缺失时检查。

#### E. 责任归属与现场命中

现有主路径判为健康；但 heuristic 不完整是 medium 风险。指定原始 session 中 `INVALID_CODING_ROUTER` 与 `INVALID_GENERIC_DISPATCH` 工具结果均为 **0 次**；skill 文本中出现这些词不算现场错误。未命中本次会话。

---

## 4. F — 顶层字段一致性审计

### 4.1 canonical `dispatch-ir.v1` 字段

> “Schema 必填”均为否，因为根 schema 没有 `required`。🔴 表示 public Schema 与 production coding compiler 有缺口。

| 顶层字段 | JSON Schema 声明 | Schema 声明为必填 | coding 实际必填 | 条件/子结构约束 |
|---|---:|---:|---:|---|
| 🔴 `version` | 是，const `dispatch-ir.v1` | **否** | **是** | 缺失改走 generic；错误值 `UNSUPPORTED_VERSION` |
| 🔴 `taskId` | 是，regex | **否** | **是** | `^[A-Za-z0-9._-]{1,160}$`，且 UTF-8 ≤160 bytes |
| 🔴 `title` | 是 | **否** | **是** | trim 非空，compiler ≤4096 bytes；Schema 是字符 maxLength |
| 🔴 `agent` | 是 | **否** | **是** | trim 非空、无 C0/C1、≤256 bytes |
| `model` | 是 | 否 | 否 | 非空；路由另受 profile/catalog/blacklist 限制 |
| 🔴 `risk` | 是，enum | **否** | **是** | `low|normal|high` |
| 🔴 `objective` | 是 | **否** | **是** | trim 非空，≤4096 bytes |
| 🔴 `workflow` | 是 | **否** | **是** | `mode` 必填；`tdd` 禁 reason，另两种必填 reason；Schema 未表达条件 |
| 🔴 `requirements` | 是 | **否** | **是** | array 1..32，元素非空；fallback 使 Schema 不强制 nested shape |
| 🔴 `context` | 是 | **否** | **是** | 恰好 `knownFacts/decisions/relevantFiles` 三字段，均必填；Schema 有 loose fallback |
| 🔴 `boundaries` | 是 | **否** | **是** | 恰好三子字段均必填；生产 `writePaths` ≥1；Schema 顶层不 required 且 loose fallback |
| 🔴 `acceptance` | 是 | **否** | **是** | 仅 `criteria`，必填且 ≥1；Schema 有 object/array/string fallback |
| 🔴 `execution` | 是 | **否** | **是** | public caller不得传 timeoutMs，Host 注入；`cwd/worktree` 可选。Schema 不显示注入后的必填 timeout |

生产 compiler 的权威依据：`contracts/dispatch-ir.ts:11-27,212-235`。Schema 依据：`extension.ts:49-126`。

### 4.2 同一平铺 Schema 中的非 IR 字段

| 顶层字段 | JSON Schema 声明 | Schema 声明为必填 | coding 分支实际 | 条件约束/缺口 |
|---|---:|---:|---|---|
| `thinkingLevel` | 是 | 否 | 可选执行选择器；进入 compiler 前剥离 | 不进入 contract/hash（`extension.ts:715-721`） |
| 🔴 `task` | 是 | 否 | `version` 存在时 unknown/reject | generic 必填；Schema 无 branch 条件 |
| 🔴 `cwd` | 是 | 否 | coding 顶层 unknown/reject | generic 字段；coding 应用 `execution.cwd` |
| 🔴 `output` | 是 | 否 | coding unknown/reject | generic-only |
| 🔴 `outputMode` | 是 | 否 | coding unknown/reject | generic-only；本次真实命中 |
| 🔴 `outputSchema` | 是 | 否 | coding unknown/reject | generic-only |
| 🔴 `artifacts` | 是 | 否 | coding unknown/reject | generic-only |
| 🔴 `progress` | 是 | 否 | coding unknown/reject | generic-only |
| 🔴 `worktree` | 是 | 否 | coding unknown/reject | generic 用顶层；coding 用 `execution.worktree` |
| 🔴 `skill` | 是 | 否 | coding unknown/reject | generic-only |
| 🔴 `reads` | 是 | 否 | coding unknown/reject | generic-only |
| `action` | 是 | 否 | **优先改路由为 control** | enum status/steer/interrupt/resume/stop |
| `id` | 是 | 否 | action 路由参数 | target；Schema 不按 action 声明 required |
| `runId` | 是 | 否 | action 路由参数 | target |
| `dir` | 是 | 否 | action 路由参数 | target |
| `index` | 是 | 否 | action 路由参数 | child index |
| `message` | 是 | 否 | action 路由参数 | resume 必须非空；Schema 不表达 action 条件 |

这张表说明 `outputMode` 不是孤立遗漏，而是平铺多分支 Schema 的系统性结果。

---

## 5. `writePaths` 合法文法完整规格

### 5.1 源码等价 grammar

根据 `contracts/dispatch-ir.ts:128-142`：

```text
PATH      := trim(INPUT)
PATH      := EXACT | RECURSIVE
RECURSIVE := EXACT "/**"
EXACT     := SEGMENT ("/" SEGMENT)*
SEGMENT   := 非空，且不等于 "." 或 ".."
```

全局限制：

- 不能以 `/` 开头；不能匹配 Windows drive absolute `^[A-Za-z]:[\\/]`；不能以 UNC `\\` 开头；
- 不能含任何 `\` 或 NUL；
- 去掉唯一允许的末尾 `/**` 后，base 不能为空、不能以 `/` 结尾；
- base 任何位置不能含 `* ? [ ]`；因此 `/**` 只能出现一次且必须在最末尾；
- `/` 分割后不能有空 segment、`.`、`..`；
- 输入前后 whitespace 会 trim；重复规范化路径在数组层去重；
- 数组最多 32 项；真实 production compiler 当前要求至少 1 项（`dispatch-ir.ts:113-125,165-170`）。

**目录范围的真实写法只有 `dir/**`。** skill 所说 `dir/` 合法与实现冲突；`dir/` 会在 `base.endsWith("/")` 分支被拒绝。

### 5.2 可复制正例

| 输入 | 结果/语义 |
|---|---|
| `README.md` | 合法，精确文件 |
| `src/index.ts` | 合法，精确文件 |
| `.github/workflows/ci.yml` | 合法，精确文件；dot-prefix segment 允许 |
| `src/**` | 合法，`src` 递归范围 |
| `packages/a/src/**` | 合法，多层递归范围 |
| ` src/index.ts ` | 合法，规范化为 `src/index.ts` |
| `src` | 语法合法，但按裸精确路径处理；**不代表目录范围** |

### 5.3 可复制反例

| 输入 | 错误原因 |
|---|---|
| `/Users/me/repo/src/a.ts` | 绝对路径 |
| `C:/repo/a.ts` / `C:\repo\a.ts` | Windows absolute / 反斜杠 |
| `\\server\share\a.ts` | UNC / 反斜杠 |
| `src/` | 尾随 `/`，源码拒绝；与 skill 冲突 |
| `src/*` | `*` 只允许作为末尾 `/**` 的组成部分 |
| `src/**/*.ts` | `/**` 后还有内容，base 中残留 glob |
| `src/**/a.ts` | 中间 glob |
| `src/file?.ts` | `?` 禁止 |
| `src/[ab].ts` | `[` / `]` 禁止 |
| `./src/a.ts` | `.` segment |
| `src/../a.ts` | `..` segment |
| `src//a.ts` | 空 segment |
| `.` / `..` | unsafe segment |
| `/**` | 去掉 `/**` 后 base 为空 |
| `src/\0a.ts`（实际 NUL） | NUL 禁止 |

Schema 没有表达上述 grammar；现有测试只覆盖部分 escape/glob（`test/subagent-dispatch-ir.test.mjs:237-258`），没有锁定 skill 宣称的尾随 `/`。

---

## 6. 模型路由规格与裸 id 失败机理

### 6.1 规范

| requested model | profile 有 models | 匹配方式 | miss 行为 |
|---|---|---|---|
| 省略 | 任意 | 不覆盖 profile/default | 使用 profile fallback |
| `provider/id` | 任意 | allowed available catalog 精确 full-ID | `MODEL_NOT_AVAILABLE` |
| 裸 `id` | 是 | 按 profile 顺序，候选 id 段精确相等且 full-ID 当前 available | 失败，不搜全局 |
| 裸 `id` | 否 | global catalog 按 full-ID 排序，精确 `model.id` | 失败或返回 global warning |

证据：`model-selection.ts:36-101`。

### 6.2 `astra` 为什么必失败

reviewer 声明的是：

- `codex-pool/gpt-6-astra`
- `openai-codex/gpt-6-astra`
- 以及其他 fallback（`pi/agents/reviewer.md:4-9`）。

候选 id 段是 `gpt-6-astra`，不是 `astra`；算法没有 alias、substring、suffix 或营销昵称匹配。因此 `astra` 必失败。`gpt-6-astra` 只有在至少一个声明 full-ID 当前 available 且 provider 未被 blacklist 时成功。

### 6.3 文档落差

`model-tiers.yaml:7-18` 已写完整逻辑 id `gpt-6-astra`；`SKILL.md:49-50` 要求裸 model-id 且 miss 后停止。此次错误不是 tier 文档把名称缩写成 astra，而是 agent 把用户自然语言“Astra”误当 API id。工具错误若返回候选即可显著降低恢复成本。

---

## 7. 可直接采用的错误文本改写汇总

| Code | 建议英文核心文本 | 建议中文核心文本 |
|---|---|---|
| `INVALID_CONTRACT/outputMode` | `outputMode is generic-only; remove it from dispatch-ir.v1. Coding output is runtime-managed.` | `outputMode 仅用于 generic；请从 dispatch-ir.v1 删除，coding 输出由 runtime 管理。` |
| `INVALID_CONTRACT/boundaries` | `Provide {writePaths:["file" or "dir/**"], excludedWork:[], forbiddenActions:[]}; all three are required.` | `请提供完整 boundaries 三字段对象；三个字段均必填。` |
| `INVALID_CONTRACT/workflow.reason` | `Omit for tdd; require non-empty for existing-tests/docs-only.` | `tdd 禁止 reason；existing-tests/docs-only 必须提供非空 reason。` |
| `INVALID_PATH` | `Use a repo-relative exact path or a recursive scope ending '/**'; trailing '/' and all other globs are unsupported.` | `仅支持仓库相对精确路径或末尾 '/**'；尾随 '/' 与其他 glob 均不支持。` |
| `MODEL_NOT_AVAILABLE` | `No exact ID match. Available declared IDs: [...]. Did you mean ...?` | `没有精确 ID 命中；当前可用声明 ID：[...]；是否应为 ...？` |
| `invalid_state/paused stop` | `Paused has no live turn to stop; status/resume are available. No paused→stopped transition exists.` | `paused 没有活动 turn 可 stop；可 status/有条件 resume；当前无 paused→stopped。` |
| local cwd policy | `INVALID_EXECUTION_CWD ... do not label as RPC failure.` | `INVALID_EXECUTION_CWD：cwd 位于 managed state root；不要标成 RPC 失败。` |
| true `SUBAGENT_RPC_FAILED` | `No automatic retry occurred; inspect operation/cause and status before retrying spawn.` | `未自动重试；重试 spawn 前先按稳定身份查状态，避免重复派发。` |

建议所有错误 `details` 统一包含：`branch`, `keypath`, `expectedShape/allowedValues`, `received`, `examples`, `retryable`, `nextActions`；模型错误另含过滤后的 candidates；RPC 错误另含真实 `stage/operation`，本地 preflight 不得冒充 RPC。

---

## 8. Runtime 缺口清单

### Blocker

1. **现象**：coding Schema 接受缺失所有顶层必填、generic 字段混入 coding；`boundaries` 现场失败 6 次。  
   **根因**：根级单 object 平铺三分支，缺少可被模型消费的 discriminator contract；compat fallback 又放宽 nested object。  
   **缺口类型**：Schema/description 合同可发现性。  
   **建议方向**：在不使用 provider 不兼容根 union 的前提下，生成 branch-specific description/示例；至少给根 `required` 的替代文字元数据，并在模型调用前提供 coding/generic/control 字段矩阵；runtime error 一次返回完整对象模板。

2. **现象**：测试声称 `writePaths:[]` 是合法只读，但真实 public extension 的 compiler 要求 ≥1。  
   **根因**：`src/contracts/dispatch-ir.ts` 与 `src/subagent-dispatch/ir.ts` 双实现漂移；extension 导入前者，相关测试直接测后者。  
   **缺口类型**：生产合同双源 / 测试假绿。  
   **建议方向**：收敛为单一 canonical codec；让 schema、public extension、Goal、测试都 import 同一入口；明确只读 coding 的官方表达。

### High

3. **现象**：skill 明示目录可以尾随 `/`，真实 validator 拒绝。  
   **根因**：文档与 regex/分支不同步。  
   **缺口类型**：生产文档合同错误。  
   **建议方向**：先裁决 canonical grammar；若保持源码，只文档化 `/**`；若支持 `/`，需统一 codec、workspace scope matcher 与测试，不能只放宽 parser。

4. **现象**：paused run 无法 stop，也没有 paused→stopped/cancel/release 动作。  
   **根因**：upstream stop 硬限制 `state===running`；resume 生成 continuation，而非原地改态。  
   **缺口类型**：生命周期能力与状态矩阵文档缺口。  
   **建议方向**：增加明确 `cancel-paused` / archive/release 语义，或正式定义 paused 已终止并提供独立清理动作；description/error 暴露合法动作矩阵。

5. **现象**：本地 cwd authorization rejection 被报告为 `SUBAGENT_RPC_FAILED`, `rpcOperation=spawn`, `causeCode=unknown`。  
   **根因**：catch 对无 code Error 一律归入 RPC；trace stage 在真正 spawn 前已设为 workflow-spawn。  
   **缺口类型**：错误 taxonomy / attribution。  
   **建议方向**：execution contract 抛 typed code/keypath；stage 在真正 RPC 调用前后细分；只有 `TypedSubagentRpcError` 才归 RPC。

### Medium

6. **现象**：workflow.reason 同一会话发生相反错误。  
   **根因**：条件只在 compiler/skill，Schema 与 description 不可见。  
   **缺口类型**：条件合同可发现性。  
   **建议方向**：description 嵌入三态表；错误始终回显完整三态规则。

7. **现象**：model miss 无候选，用户昵称容易被当作 id。  
   **根因**：精确匹配合理，但 `ModelSelectionError` 只保存 requested/agent。  
   **缺口类型**：错误可行动性。  
   **建议方向**：返回过滤后的 declared+available candidates 与安全 suggestion，不引入模糊自动 alias。

8. **现象**：路径错误只说 unsupported，无法区分尾随 slash、中间 glob、unsafe segment。  
   **根因**：多个 grammar 条件共用泛化 message。  
   **缺口类型**：错误可行动性。  
   **建议方向**：返回 grammar、bad token、正例，并统一 `repo-path.ts` 与两个 IR 实现。

9. **现象**：RPC 操作没有自动 retry，timeout 后也无明确去重指引。  
   **根因**：client 单次 emit/wait；standalone spawn 默认随机 identity。  
   **缺口类型**：传输恢复语义。  
   **建议方向**：不要对 spawn 盲重试；先提供稳定 request identity/status lookup，再仅对幂等 ping/status 做 bounded retry，并把 `retryable` 写进 details。

10. **现象**：缺 version 自诊断只看 `taskId/objective/workflow` 且只在 generic 三必填不足时执行。  
    **根因**：启发式而非完整 branch collision 检查。  
    **缺口类型**：路由诊断覆盖。  
    **建议方向**：任何 coding-exclusive 字段与 generic shape 混用都 fail closed；保持现有 `INVALID_CODING_ROUTER` 文案。

---

## 9. 验证与测试盲区

本次只读运行聚焦合同测试：

```text
node --test test/subagent-dispatch-validation-errors.test.mjs test/subagent-model-selection.test.mjs test/subagent-dispatch-ir.test.mjs
```

结果：33 tests，33 pass，0 fail，约 259 ms。

该 GREEN 证明当前实现意图（严格 workflow 条件、路径 escape 拒绝、精确模型匹配、version 自诊断）稳定；它**不否定**本文归因，反而暴露以下盲区：

- 没有测试 coding input 带 Schema-declared generic `outputMode` 时的 Schema/contract 一致性；
- 没有测试顶层 coding required 与 Schema required 的一致性；
- 没有测试 skill 的 `dir/` 声明与 runtime；
- empty `writePaths` 测试只调用 duplicate `subagent-dispatch/ir.ts`，没有穿过 production extension import；
- model test只断言 error code，不断言候选清单/actionability；
- paused-stop 状态矩阵属于 pinned upstream，project tests 主要覆盖展示，没有覆盖可取消性。

## 10. 最终责任结论

- **纯 agent 错误但工具面已足够清楚**：`astra` 而非 `gpt-6-astra`、绝对 writePath；不过错误回执仍欠行动信息。
- **agent 输入错误且工具面明显诱导**：coding `outputMode`、遗漏 `boundaries`、workflow.reason 双向条件、中间 glob、managed state root cwd。
- **明确 production 缺陷/缺口**：skill 尾随 `/` 与源码冲突；双 IR 实现导致 read-only scope 测试假绿；本地 preflight 错标 RPC；paused 无 cancel/改态；Schema 与严格 contract 系统性漂移。
- **来源未证实**：任务声称但指定原始现场未出现的第 2 条 `SUBAGENT_RPC_FAILED`、另外两条 `MODEL_NOT_AVAILABLE`。
