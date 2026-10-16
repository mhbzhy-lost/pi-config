# Bug：subagent control `resume` 静默忽略显式 `model` 选择器，续跑沿旧 run 持久化模型启动

- 登记 baseline：2026-10-14（现场实际日期）
- 性质：诊断登记，只记录不修复；未实施任何 production 兼容/修复，未运行真实模型实验
- 用户明确请求登记：『resume不能切换模型？这得记下来，可能是个bug，既然参数允许指定模型，那就理应能切换，不能切换就是bug』

## 1. 用户期望与真实调用事实

用户期望：公共 `subagent` 工具参数允许指定 `model`，那么 resume 续跑理应能切换模型；不能切换即视为 bug。

真实调用时序（同日，父层会话，全部经合法 typed 公共工具入口，正常顺序，非 fixture）：

| 步骤 | 调用 | 结果 |
|---|---|---|
| 1 | 失败原 F1 run `f7ed02c9-4f6d-4c4f-a477-a613b3a32e50`，resume 至 `adf92d4b-866b-452d-bcc7-f9f04a18f60c` | 进入可续跑状态 |
| 2 | `subagent({action:"resume", id:"adf92d4b-866b-452d-bcc7-f9f04a18f60c", model:"qoder-pool/GLM-5.3", message:<非空，继续原合同>})` | 成功返回新 run `9653b78b-5888-4dc3-9c5c-4beb02030bef`，无错误、无警告；随后仍过载 |
| 3 | 新 run status 投影 | step failed `(gpt-6.1-sol · thinking high)` —— 旧模型 ID，非 GLM |
| 4 | 对照：fresh spawn `delegate model:"GLM-5.3"` | run `94534908-8424-4177-88ed-bdee2f9ab45b` status 实证 running (GLM-5.3) |

对照说明：

- `qoder-pool/GLM-5.3` 在 model catalog/profile 中确实存在；步骤 4 证明 spawn 路径的 model 选择器可用且该模型可运行。用户此前已明确授权过载时切换 provider。
- 步骤 3 的 status 行是父层投影的裸模型字符串：`gpt-6.1-sol` 本身已不符显式要求（requested 是 `qoder-pool/GLM-5.3`），但它**不构成 actual-model provider 的完整证据**（unknown，见 §6）。

requested / resolved / actual 三段对照：

| 层 | 值 | 证据强度 |
|---|---|---|
| requested（调用方显式） | `qoder-pool/GLM-5.3` | 调用参数事实 |
| resolved | 无独立的 resolved 回执；resume 成功 receipt 未报 modelSelection，也无 warning | 回执事实：无信号 |
| actual（实际加载模型） | status 投影显示 `gpt-6.1-sol · thinking high`；provider 未证 | 投影级事实；run 工件已被 retention 清理，无法提取 model-only 字段（unknown） |

## 2. 静态调用链与首偏离点

入口 → 参数验证/过滤 → RPC → 上游旧 run 恢复 → 实际模型加载：

1. **公共 schema** `TYPED_SUBAGENT_PARAMETERS`（`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:54-110`）：`model` 是顶层声明属性，`action` 枚举含 `resume`。无任何"resume 分支拒绝/忽略 model"的约束，`additionalProperties:false` 不拦截 → resume+model 组合通过 schema 校验。
2. **工具描述**（同文件 `:111`）：只声明 "resume 必须携带非空新消息，可将 paused/completed/failed 的 run 以新 run（新子会话）方式续跑"，**未声明 model 在 resume 中被忽略** → 契约层与实际行为不一致。
3. **本地路由**（`extension.ts:1616-1618`）：`Object.hasOwn(input, "action")` 即进入 `executeControl(input, ...)`，入参原样传递，无 model 过滤。
4. **executeControl**（`extension.ts:1174-1259`）：仅校验 CONTROL_ACTIONS 与 resume 非空 message（`:1205-1206`），随后 `const { action, ...params } = input` 并 `rpc.resume(params)` → model 原样下发。本地模型选择器（`model-selection.ts` 的 `resolveModelSelection`）只在 spawn（coding/generic）路径调用，**control 分支不 apply selector**。
5. **RPC client**（`src/subagent-dispatch/rpc-client.ts:299-301`）：`resume(params) → call("resume", params)`，透传。
6. **上游 RPC 服务端参数过滤**（`pi-subagents/src/extension/rpc.js:632-633` → `resumeParams`，`rpc.js:423-439`）：仅提取 `message`、target（id/runId/dir）、`output/outputMode` —— **`model` 在此被静默丢弃。此为首偏离点。**
7. **恢复目标解析**（`pi-subagents/src/runs/background/async-resume.js:476-648`）：`resolveAsyncResumeTarget` 从**旧 run 持久化元数据**重导出模型：`stepModel = statusSteps[index]?.model ?? resultSteps[index]?.model ?? result?.model`（`:629-630` 附近）→ `target.model`。
8. **revive 启动**（`pi-subagents/src/runs/foreground/subagent-executor.js:1889`）：`modelOverride: recoveryDescriptor?.model ?? target.model` —— 旧模型。
9. **实际模型加载**（`pi-subagents/src/runs/background/async-execution.js:1600-1608`）：`explicitModel: params.modelOverride` → `resolveSubagentModelOverride(params.modelOverride ?? agentConfig.model, ...)` → 新 run 以旧 run 模型启动。

调用方传入的 `model` 从未越过步骤 6；步骤 7-9 的旧模型回填与观测到的 status 投影（新 run 用旧模型 ID）一致。

## 3. 交叉证据（文档与守卫）

- 上游工具参考 `pi-subagents/docs/tool-reference.md:178`："`resume` and `agent` are mutually exclusive. **The revived child keeps its stored agent, model, and tool contract.**" —— "resume 沿用 stored model" 是上游**明文设计**。
- 同文档 `:350`/`:355`：resume "starting a new child from its stored session file"；"Revive starts a new child session from the old session context; it does not resume the live session" —— 是"以旧 session 上下文新建子会话"，不是 pi 核心意义上的原地 session 恢复。
- 上游 CHANGELOG（`pi-subagents/CHANGELOG.md:1332`）：retained workflow child "resume ... **without changing its stored agent, model, or tool contract**"。
- 上游**直连守卫**（`subagent-executor.js:1553-1560`）：非 RPC 的 management resume 路径对 `params.model !== undefined` 显式报错 "action='resume' reuses the persisted child model and does not accept a model override." —— 直连路径会给出明确拒绝信号。
- pi 核心会话语义（`@earendil-works/pi-coding-agent/docs/models.md`）："A session records model and thinking-level changes. Resuming the session restores them." —— pi 核心层 session 恢复同样还原已记录模型。

## 4. 缺陷分类（门禁）

production 可达：数据由真实 public/typed 入口产生（合法 typed 工具 + 有效 model `qoder-pool/GLM-5.3` + 有效 failed run + 非空 resume message，正常顺序，非 fixture）。属第 1 类：**预期 production 输入（显式 model 选择器）未被正确处理**。

但需精确界定缺陷形态：

- "续跑沿用旧模型"本身是上游**文档化设计**（tool-reference:178），不是数据损坏或意外回退；
- 真正的缺陷是**契约不一致**：公共 schema/工具描述接受 `model` 并让调用方形成"可切换"预期，本地层透传，上游 RPC 层却静默丢弃而非像直连路径那样显式拒绝（"does not accept a model override"）——调用方拿到成功 receipt，无任何 error/warning，实际却以旧模型启动。

## 5. 根因与责任归属（先完整生成链后判定）

- **首偏离点**：上游 `pi-subagents/src/extension/rpc.js` 的 `resumeParams()`（`:423-439`）静默丢弃 `model`。
- **主因（上游）**：`resumeParams` 过滤行为使显式 model 无信号丢失；与上游自身直连守卫（显式拒绝）行为不一致。
- **共因（本仓公共层）**：`TYPED_SUBAGENT_PARAMETERS` 未对 resume 分支声明 model 约束、工具描述未说明"resume 忽略 model"、`executeControl` 盲透传且成功 receipt 无 modelSelection/警告回执。
- **被排除的假设**："上游旧 session 恢复执行路径覆盖模型"这一更深假设**不成立也不需要**——model 在参数过滤层已被丢弃，从未到达恢复执行层（步骤 7-9 只消费旧 run 持久化元数据）。pi 核心 session 恢复还原模型（models.md）与本链无关：revive 是新子会话，不走核心 `--resume` 加载。

未实施修复，未加 fallback（根因已定位到静态链，修复方向见 §7，但不在本任务内执行）。

## 6. 明确 unknown

1. **actual-model provider 未证**：status 行裸 `gpt-6.1-sol` 只是投影字符串；本地 `/tmp/pi-subagents-uid-501/async-subagent-runs` 已被 retention 清理，4 个相关 run 工件不在，无法按合同只读提取 manifest/model 字段。按合同记录：父层 status 投影为足够事实，provider 未证。
2. 旧 run `adf92d4b` 原始 spawn 时的 modelSelection（requested/resolved/source）元数据未能读取（工件已清理），三段对照以父层投影为界。
3. 上游是否有意让 RPC resume 路径静默吞掉 model（而非对齐直连守卫的显式拒绝）无进一步 changelog 级证据（仅定位到 CHANGELOG:1332 佐证 stored-model 设计意图）。

## 7. 建议最小后续修复范围（仅为建议，未写计划、未实施）

最小闭环是对齐契约信号，二选一或组合：

- **本仓层（最小）**：在公共层对 `action:"resume" && model !== undefined` 给出显式信号——要么 schema/入参校验层拒绝（复用上游直连语义："resume 沿用持久化子模型，不接受 model 覆盖"），要么在 `executeControl` 透传前过滤 model 并在成功回执 `details.warnings` 注入说明。同时补工具描述一句话。
- **上游层（如可动）**：让 RPC `resumeParams` 对 `model` 显式报 `invalid_params`，与直连守卫一致，消除"直连报错 / RPC 静默"分歧。
- 不建议：让 resume 支持换模型（与上游 stored-model 设计冲突，且会牵动 launch contract digest / capability ceiling / recovery descriptor 链，超出最小修复）。

若确需过载换 provider，当下可用替代路径：对 failed run fresh spawn 并显式 `model`（步骤 4 已验证可用），或在授权后由父层承担上下文搬运。
