# dispatch 分支可发现性方案探索

## 1. 问题陈述与量化

当前工具面是一个根级单 object，字段并集由 schema 引导，运行时按 `action` → control、`version` → coding、否则 → generic。这样避开 provider 对根级 union 的兼容问题，但模型需要从一张 30 个字段左右的矩阵自行发现分支边界。历史调查统计了 312 次 `INVALID_CONTRACT` 与 327 次 `INVALID_PATH`；这些数字是历史拒绝计数，不是本探针重新统计的样本，也不能据此伪造精确削减率。

本节点不修改 production code。A-ENV 已判定 `degraded`；本任务没有 live/supervisor 依赖，未调用 `contact_supervisor`。

## 2. 硬约束：根级 union 的 provider 兼容性

### 2.1 原始证据

原始证据是 `docs/bugs/2026-09-14-glm-empty-tool-args-from-root-union-schema.md`：对 `zai-coding-cn/glm-5.3` 直接进行的工具流实验中，根节点 `anyOf`、`oneOf`、`allOf` 都只返回字面量 `{}`；简单根 object 与字段级 `anyOf` 能返回完整参数。该记录还包含故障会话的 8/8 空参数及本次会话 1/1 空参数、SSE arguments 分片和 provider 对照。涉及 GLM；记录称其他 provider（包括 gpt-5.6-sol、deepseek）未出现同一现象，但这不等于它们提供了根级联合的兼容保证。

当前 `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts` 的注释仍明确写出：严格 OpenAI-compatible provider 对根级 `anyOf/oneOf/allOf` 可能生成空 arguments；实际 schema 仍是 `type: object`、`additionalProperties: false`、字段并集，无根级组合子。故原始兼容约束**仍成立为已证实风险**，而不是已被 provider 升级证伪。按禁止事项，本探针没有读取或输出 `enabledModels`、模型配置或任何凭据；因此“当前 enabledModels 是否仍含受影响模型”无法从本任务环境验证，不能推测。

### 2.2 当前结论

根级 union 不是当前可推荐方案。若未来取得不含凭据的 provider 兼容性回归证据，也只能作为条件方案重新评审，而不能仅凭模型升级版本号放开。

## 3. T2 之后的字段面快照

快照依据当前实际 `extension.ts` 与 canonical `dispatch-ir.ts`；没有使用旧 `workflow` 字段。`required` 指 JSON Schema 顶层 required（当前没有顶层 required）。

| 字段 | Schema | required | coding 必填/合法 | generic 合法 | control 合法 | 条件约束 |
|---|---|---|---|---|---|---|
| `version` | 是 | 否 | 必填且为 `dispatch-ir.v1` | 否（出现即走 coding） | 否（但 action 优先） | 路由标志 |
| `taskId` | 是 | 否 | 必填 | 否（coding 特征） | 可作为 RPC 参数 | 两分支语义不同 |
| `title` | 是 | 否 | 必填 | 必填 | 否 | generic 必须非空 |
| `agent` | 是 | 否 | 必填 | 必填 | 否 | profile 校验 |
| `model` | 是 | 否 | 可选 | 可选 | 否 | 路由后模型选择 |
| `risk` | 是 | 否 | 必填且枚举 | 不应出现（现状未由 generic 路由拒绝） | 否 | coding-exclusive |
| `objective` | 是 | 否 | 必填 | 否 | 否 | coding 特征 |
| `requirements` | 是 | 否 | 必填且至少一项 | 否 | 否 | coding contract |
| `context` | 是 | 否 | 必填对象 | 否 | 否 | coding contract |
| `boundaries` | 是 | 否 | 必填对象 | 不应出现 | 否 | coding contract |
| `acceptance` | 是 | 否 | 必填对象 | 否 | 否 | coding contract |
| `execution` | 是 | 否 | 必填对象 | 否 | 否 | coding contract |
| `task` | 是 | 否 | 否 | 必填 | 否 | generic 路由 |
| `cwd` | 是 | 否 | 否 | 可选 | 否 | generic |
| `output` | 是 | 否 | 否 | 可选 | 否 | generic |
| `outputMode` | 是 | 否 | 否 | 可选 | 否 | generic |
| `outputSchema` | 是 | 否 | 否 | 可选 | 否 | generic |
| `artifacts` | 是 | 否 | 否 | 可选 | 否 | generic |
| `progress` | 是 | 否 | 否 | 可选 | 否 | generic |
| `worktree` | 是 | 否 | 否 | 可选 | 否 | generic |
| `skill` | 是 | 否 | 否 | 可选 | 否 | generic |
| `reads` | 是 | 否 | 否 | 可选 | 否 | generic |
| `action` | 是 | 否 | 否 | 否 | 必须是支持动作 | 最高优先级 |
| `id` | 是 | 否 | 否 | 否 | 可选 RPC 标识 | control |
| `runId` | 是 | 否 | 否 | 否 | 可选 RPC 标识 | control |
| `dir` | 是 | 否 | 否 | 否 | 可选 RPC 参数 | control |
| `index` | 是 | 否 | 否 | 否 | 可选非负整数 | control |
| `message` | 是 | 否 | 否 | 否 | resume 时必填 | control |

## 4. 离线探针实测结果（8 类样本）

探针命令：`node scripts/probes/dispatch-branch-probe.ts`。Node 26.8.1 原生 TypeScript type stripping 执行成功；脚本只 import canonical 纯编译函数，不注册工具、不启动 host、不读写文件、不联网。以下为该命令的 stdout 原文（JSON 每行一类）：

```text
{"sample":"完整合法 coding","inputKeys":["version","taskId","title","agent","model","risk","objective","requirements","context","boundaries","acceptance","execution"],"branch":"coding","result":"OK"}
{"sample":"缺 version 但含 taskId","inputKeys":["taskId","title","agent","model","risk","objective","requirements","context","boundaries","acceptance","execution"],"branch":"generic","result":"INVALID_CODING_ROUTER"}
{"sample":"缺 version 但含 boundaries","inputKeys":["boundaries","agent","title","taskId"],"branch":"generic","result":"INVALID_CODING_ROUTER"}
{"sample":"缺 version 且只有 agent/title/task 的合法 generic","inputKeys":["agent","title","task"],"branch":"generic","result":"OK"}
{"sample":"generic 混入 coding-exclusive 字段","inputKeys":["agent","title","task","risk"],"branch":"generic","result":"OK"}
{"sample":"coding 混入 generic 字段","inputKeys":["version","taskId","title","agent","model","risk","objective","requirements","context","boundaries","acceptance","execution","outputMode"],"branch":"coding","result":"INVALID_CONTRACT","detail":"$ contains unknown field outputMode; 完整 shape 提示：{ version, taskId, title, agent, model, risk, objective, requirements, context, boundaries, acceptance, execution }; keypath=$.outputMode"}
{"sample":"带 action 的 control","inputKeys":["action","id"],"branch":"control","result":"CONTROL_ROUTE"}
{"sample":"action 与 version 同时存在","inputKeys":["action","version"],"branch":"control","result":"CONTROL_ROUTE"}
```

第 5 类实测显示 generic 当前会接受 `risk` 并继续 generic 路由；这是“非法接受”风险，不应静态包装成拒绝。第 8 类实测确认 `action` 优先于 `version`。

运行前后执行 `git status --short`；脚本只向 stdout 输出。受保护门禁原始输出为 ` M pi/agents/reviewer.md`、` M pi/settings.json`，与任务前现场一致；二者是预存修改，脚本未触碰。`pi/models.json` 与 `var/workspaces/` 无输出。未运行 live tool schema，因此 provider 真实 Host schema 兼容性不可由本探针验证。

## 5. 候选方案

### 5.1 方案 A：单 object + branch-specific description 动态生成

**契约：** 保持 `TYPED_SUBAGENT_PARAMETERS` 为 `type: object`、`additionalProperties:false`、无根级组合子、所有候选字段在 `properties`；新增一个纯函数 `describeDispatchBranches({ providerFamily? })`，返回包含三段的 description：`action` 存在即 control；否则 `version` 等于 `dispatch-ir.v1` 即 coding；否则必须有 `agent/title/task` 即 generic。工具注册时使用该返回文本，不能按 live workspace 或凭据生成。运行时仍以 `execute` 路由和 canonical contracts 为权威。

**错误契约：** 保持现有 `details.code`；generic 混入 coding-exclusive 字段应返回 `INVALID_GENERIC_DISPATCH` 的字段级诊断（这是后续裁决，不在本任务实现）。

### 5.2 方案 B：description 中嵌入 coding/generic/control 字段矩阵

**契约：** 与方案 A 相同的单 object schema；description 固定包含机器可读风格的字段矩阵，逐项列出 branch、required、互斥字段、最小合法示例和优先级。矩阵由源码常量生成，禁止手工与 schema 分叉。运行时错误 details 增加 `branchHints: { coding: { required:[...] }, generic:{ required:[...] }, control:{ required:[...] } }`（新增字段需兼容旧消费者）。

### 5.3 方案 C：INVALID_CONTRACT 回执侧返回分支模板/必填清单

**契约：** 首次拒绝仍 fail closed；所有 `INVALID_CONTRACT`、`INVALID_CODING_ROUTER`、`INVALID_GENERIC_DISPATCH` 的 `details` 可选携带 `branchHints`，形状为 `{ selectedBranch?: "coding"|"generic"|"control", templates: { coding: object, generic: object, control: object }, missing?: string[], unexpected?: string[] }`。模板只含字段名与占位符，不泄露凭据、live 路径或 child 内容。错误文本继续保留现有 code/keypath，减少下游破坏。

### 5.4 方案 A'（条件方案）：根级 union 判别式

仅在每个受支持 provider/model 有原始工具流回归证据证明根级 `anyOf/oneOf/allOf` 不再产生 `{}` 时评估。契约为 `oneOf` 三个带 `required` 判别字段的 object 分支，并保留 runtime 校验。当前证据未满足前置条件，禁止实施。

## 6. 对比矩阵

| 方案 | 模型可见性提升 | provider 兼容风险 | 误判率变化（合法拒绝/非法接受） | 错误码变化面 | 文件级改动面 | 测试成本 | 对 312 次 INVALID_CONTRACT 预期削减 | 对 327 次 INVALID_PATH 预期削减 | 可与 T1/T3 错误文案叠加 |
|---|---|---|---|---|---|---|---|---|---|
| A | 中高：按当前意图给出分支规则 | 低，schema 不变 | 合法拒绝预计下降；非法接受基本不变，需运行时补洞 | 小，主要是 description/可选 hints | `extension.ts`，可能新增 schema 描述测试 | 中 | 方向性下降；无法从历史计数推导精确数值 | 直接削减不可量化，路径错误本身不由分支发现解决 | 是 |
| B | 高：字段矩阵最完整 | 低，固定文本 | 合法拒绝预计下降；矩阵若过长可能引入模型选择错误，非法接受仍需 runtime | 中，若增加 hints | `extension.ts`、schema/description 测试、文档 | 中高 | 预计比 A 更能减少字段遗漏，但不可量化 | 仅间接帮助选对 coding 分支，不应承诺削减 | 是 |
| C | 低至中：错误发生后才可见 | 最低 | 合法拒绝不变；后续重试的合法修复率可能提高，非法接受不变 | 中，错误 details 新增兼容字段 | `extension.ts`、错误测试、消费方断言 | 中 | 预期只减少重复拒绝/重试，不减少首次拒绝；不可量化 | 几乎不影响 INVALID_PATH 首次量；可能帮助后续修正 | 是 |
| A' | 高（理论） | **高且已有 GLM 反证** | 判别式错误会合法拒绝，provider 空参数会扩大拒绝；非法接受取决于 provider | 大，schema 与路由错误面均变 | `extension.ts`、provider fixtures、全套测试 | 高 | 不可承诺，当前不应实施 | 不相关 | 否，除非重新验证 |

推导依据只有当前 8 类探针、历史错误计数及 GLM 原始实验；没有生产重放样本的分母，故所有“削减”均为方向性判断或不可量化，不是精确百分比。

## 7. 推荐方案与理由

推荐 **方案 A 为基础，吸收方案 B 的精简字段矩阵，并在高频拒绝回执中采用方案 C 的兼容 hints**。先改善模型在调用前的可见性，保持已验证的单 object provider 兼容形态；再把实际错误的可行动信息返回给模型。不要实施 A'。方案 A/B 需要特别补上 generic 混入 coding-exclusive 字段的 fail-closed 规则，否则探针已经证明非法字段会被接受。

待用户裁决：是否接受新增 `branchHints` details 字段；是否把矩阵固定写入 description（文本变长会增加模型上下文成本）；generic 混入 coding-exclusive 字段是直接拒绝还是仅 warning。上述裁决不影响本任务的探针与文档交付。

## 8. 推荐方案的精确接口契约

### 8.1 schema 结构

保持当前根结构：`{ type: "object", additionalProperties: false, properties: FIELD_UNION }`，不添加根级 `anyOf/oneOf/allOf`，不添加 workflow。字段级联合可保留。顶层不依赖 required，由 runtime 分支裁决。

### 8.2 description 文本生成方式

新增纯函数（后续实现）返回固定版本化文本：

```ts
type DispatchBranchDescription = {
  version: "dispatch-branch-description.v1";
  text: string;
  branches: {
    coding: { selector: "version=dispatch-ir.v1"; required: string[]; exclusive: string[] };
    generic: { selector: "no action and no version"; required: ["agent", "title", "task"]; optional: string[] };
    control: { selector: "action exists"; required: ["action"]; optional: string[] };
  };
};
```

`text` 固定写入优先级、每分支最小 JSON 示例、coding/generic/control 字段矩阵；不得读取 workspace、模型 catalog 或凭据。

### 8.3 错误 details 形状

保留 `{ code, keypath?, detail? }` 和既有错误码。可选扩展：

```ts
type BranchHints = {
  selectedBranch?: "coding" | "generic" | "control";
  missing?: string[];
  unexpected?: string[];
  templates: {
    coding: { required: string[]; example: Record<string, unknown> };
    generic: { required: ["agent", "title", "task"]; example: Record<string, unknown> };
    control: { required: ["action"]; example: Record<string, unknown> };
  };
};
```

模板不含真实 id、路径、token 或 run 数据。

## 9. TDD 纪律是否应机械强制、在哪一层强制

推荐在**child 产出侧**机械校验 Required Report 的 `RED/GREEN` 或明确豁免证据，并在**事后核查**验证 child 确实读取 skill；不推荐在派发合同层强制“非空 writePaths ⇒ requirements 必须包含 TDD 路径”。合同层字符串匹配既会增加合法只读/文档任务拒绝率，也能被无意义文本满足，不能证明执行过 TDD。

- 派发合同层：只传递 `requirements` 和既有 acceptance，不新增字符串门禁；保留对 write scope 的结构校验。
- child 产出侧：Required Report 必须包含 `redGreenEvidence` 或 `tddExemption`（纯文档、单行、已有测试覆盖等理由与证据），缺失则报告不完整；这是最接近实际产出的机械层。
- 事后核查：在可审计事件/工具 trace 中核对读取 skill 文件；核查失败标为风险，不伪造 RED/GREEN。它是证据增强而非唯一门禁，因为环境可能无法提供完整 trace。

本任务新增 probe/文档为纯诊断与决策产物，适用 TDD skill 的“纯文档变更”豁免；脚本是无副作用探针，不改变 production 行为，因此没有 production RED-GREEN 代码循环。豁免理由与证据：允许写入路径仅为本脚本和本决策文档，脚本执行结果已原样记录且 git status 无脚本之外副作用。

## 10. 预期效果与验证方式

先用本探针 8 类样本建立基线，再对候选实现运行同一命令做路由/错误码 diff；增加 generic-exclusive 字段样本与最小 control 参数样本。随后在临时 provider fixture（不使用 live workspace 或凭据）验证 schema 序列化没有根级组合子。若获用户批准，可在受控 provider 会话统计调用数、合法拒绝数、非法接受数和 `INVALID_CONTRACT`/`INVALID_PATH` 计数，按同一时间窗对照；在证据不足前不得把历史 312/327 转成预测百分比。

## 11. 未解决的问题

1. A-ENV degraded，无法进行真实 Host tool schema/provider 回归；本报告明确不推测其结果。
2. 当前 enabledModels 是否仍包含 GLM 受影响型号未验证，因为本任务禁止读取/输出模型配置。
3. generic 接受 `risk` 的非法字段边界是否应立即 fail closed，需要用户裁决并单独 TDD。
4. `branchHints` 是否进入公开 details 契约、以及 description 矩阵的最大长度预算待裁决。
5. 没有足够历史分母把 312/327 的预期削减量量化；任何精确数字都属于伪造。

本节点结论不是“继续调研”：在当前约束下采用单 object + branch-specific description（吸收精简矩阵，错误回执可选 hints），拒绝根级 union；以上 5 项是明确需要用户裁决的接口/边界事项。
