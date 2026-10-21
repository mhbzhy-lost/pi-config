# steer 定位合同收紧：`index` 必填（2026-10-17）

类别：**1（生产合同缺陷）**——生产执行期与公开合同（schema/描述）相互矛盾，模型按公开合同发出的最小合法调用必然被拒。
本轮实施：**选项 2（把公开合同同步到已冻结的执行期）+ 选项 3（配套：迁移仓内调用方）**；**不做选项 1**（唯一候选推断）。
所有坐标以本次实施后的工作树为准（`packages/pi-subagents-enhanced/src/subagent-dispatch/**`）。

---

## 1. 结论

1. steer 的 `index` **必填**是已冻结的执行期设计（`docs/plans/2026-10-15-supervisor-gate-recovery.md:35`、`docs/plans/records/2026-10-15-supervisor-gate/contract.md:73`、`supervisor-gate-policy.ts:543-550` 的注释三处一致）：缺 index 一律 fail closed，不推断、不默认 0、不广播「上游旧的无 index 广播行为被明确取消」。
2. 因此**说谎的是本仓自己的 schema/描述**：收紧前 `SUBAGENT_RUN_STEER_PARAMETERS` 的 `required` 只有 `["message"]`（`index` 仅在共享 `TARGET_FIELDS` 里，`operation-tools.ts:38-43`），descriptor 描述写「id/runId/dir/index 为**可选**定位」，legacy union 面（`TYPED_SUBAGENT_PARAMETERS` + `TYPED_SUBAGENT_DESCRIPTION`）一字未提 index 强制。
3. 修法：schema `required` 收紧为 `["message", "index"]`（仅 steer，不影响 status/interrupt/resume/stop），描述与 guideline 同步，错误文案给出可执行下一步；执行期分支、错误码、控制面 fail-closed 一律不变。

---

## 2. 解析语义矩阵（各定位组合 → 分支 → code）

入口：`extension.ts:1482` `if (action === "steer" && supervisorControlPlane && supervisorControlPlane.enabled?.() !== false)`。
**只有该条件为真时才经过 fail-closed 的 steer resolver（第 1-15 行）；控制面未启用或未注入时 steer 与其他 control action 同路直通上游（第 16 行）**：

| # | 定位组合 | 命中分支（坐标） | 结果 code |
|---|---|---|---|
| 1 | `dir` 出现（无论是否同时给 id/runId/index） | `canonicalSteerTarget` → `extension.ts:1398` | `SUPERVISOR_STEER_TARGET_ALIAS` |
| 2 | `id`/`runId` 存在但非 string 或 trim 后为空 | `extension.ts:1402` | `SUPERVISOR_STEER_TARGET_INVALID` |
| 3 | `id` 与 `runId` 同时为 string 且不相等 | `extension.ts:1406` | `SUPERVISOR_STEER_TARGET_CONFLICT` |
| 4 | 既无 `id` 也无 `runId`（含 **index-only**） | `extension.ts:1408`（`target.runId !== "string"` 在 `:1484` 复检） | `SUPERVISOR_STEER_TARGET_UNRESOLVED` |
| 5 | canonical 为绝对路径 / 含分隔符 / 含 `..` | `extension.ts:1409` | `SUPERVISOR_STEER_TARGET_INVALID` |
| 6 | canonical 长度 ∈ [8, 36)（前缀扇描形态） | `extension.ts:1411` | `SUPERVISOR_STEER_TARGET_AMBIGUOUS` |
| 7 | runId 规范成功 + **`index` 缺失** | `extension.ts:1487` | **`SUPERVISOR_STEER_CHILD_AMBIGUOUS`**（文案附可执行提示） |
| 8 | `index` 非安全整数或 < 0 | `extension.ts:1494` | `SUPERVISOR_STEER_TARGET_INVALID` |
| 9 | runId + 合法 index，owner 三态不可用 | `extension.ts:1505-1506`、`:1509` | `SUPERVISOR_OWNER_UNAVAILABLE` / `SUPERVISOR_STALE_OWNER` |
| 10 | 控制面 v2 intent：`childIndex` 缺失（外部构造） | `supervisor-control-plane.ts:300` | `SUPERVISOR_STEER_CHILD_AMBIGUOUS`（从工具面不可达，见 `:1487` 先行） |
| 11 | runtime 非 running / 非 steerable / epoch 不符 | `supervisor-control-plane.ts:301-302` | `SUPERVISOR_STEER_NOT_ALLOWED` |
| 12 | 与 pending request 的 child 不一致 | `supervisor-control-plane.ts:305` | `SUPERVISOR_REQUEST_SCOPE_UNVERIFIED` |
| 13 | 幂等 receipt 命中 | `supervisor-control-plane.ts:309-311`、`extension.ts:1521` | `SUPERVISOR_DELIVERY_IDEMPOTENT` |
| 14 | 存在未 reply 的 pending request | `supervisor-control-plane.ts`（`classifyRequest`） | `SUPERVISOR_REPLY_REQUIRED` 等 |
| 15 | 通过门禁 | `extension.ts:1524` `rpc.steer(params)`（`params.index` 原样透传） | 上游投递；`isError` → `SUPERVISOR_STEER_DELIVERY_FAILED` 补偿（`extension.ts:1525-1530`、`:1535-1538`） |
| 16 | **控制面未启用/未注入**（`enabled() === false`） | `extension.ts:1541` `const reply = await rpc[action](params)` | 直通上游：index 缺省 = 向所有 running child 广播（`pi-subagents/src/runs/foreground/async-steering-action.js:118-119`），single-mode 且仅 1 个 pending step 时上游自默认 0 |

补充事实：
- 第 16 行说明 fail-closed **只覆盖受控（supervisor 控制面启用）路径**；这是既有行为，本次未改，也未新增/删除任何分支。
- `index` 的存在性判断**先于**任何 runtime/owner/目录读取：`extension.ts:1487` 之前没有任何 IO（首次读 runtime 在 `:1495 identityForRun`）。因此 fan-out 1/1、`Mode: single`、单 step 与 64 child **完全同码**，唯一 child 不消歧。
- 控制面无法自行推断：`extension.ts:1512` 把 undefined 的 index 变成 undefined 的 `childIndex`，`:1518` 再以 `...(childIndex === undefined ? {} : { childIndex })` 丢弃该字段；控制面拿到的 runtime 只有 `{runId, ownerGeneration, liveRunEpoch, running, steerable}`（`supervisor-control-plane.ts:170`、`runtime-state.ts:13-25`），**没有 children 目录**。

---

## 3. `extension.ts:1487` 是唯一实际判据

- 全仓仅此一处按 `params.index === undefined` 产出 `SUPERVISOR_STEER_CHILD_AMBIGUOUS` 的工具面判据（`grep -rn "SUPERVISOR_STEER_CHILD_AMBIGUOUS" packages/`：`supervisor-gate-policy.ts:30/181/221/547/558/560/635`、`supervisor-control-plane.ts:300`、`extension.ts:1487`）。
- `supervisor-control-plane.ts:300` 与 `supervisor-gate-policy.ts:635` 同码分支在工具面**不可达**：前者需 v2 intent 缺 `childIndex`（`extension.ts:1487` 已先拦截），后者需 `steerReceiptKey` 收到缺 `childIndex` 的 intent（同样被 `:1487` 先拦截）。
- `:1487` 之前无任何 status/目录读取 → 该判据与 run 的实际 child 数量、模式、目录可读性**完全无关**。

---

## 4. `resolveTargetChild` 死码的三点静态证明

被注释写成「缺 index 时仅当恰好一个可验证可 steer child 则推断」的实现是 `supervisor-gate-policy.ts:551-566`。它**不在任何生产路径上**：

1. **无生产调用方**：`grep -rn "resolveTargetChild" packages/ src/ test/ --include=*.ts --include=*.mjs` 的全部命中为定义（`supervisor-gate-policy.ts:503` 注释、`:551` export）与 `test/supervisor-gate-policy.test.mjs`（27-28 import、150-271 用例）。`supervisor-control-plane.ts` 与 `extension.ts` 均不 import、不调用。
2. **前置条件在生产中恒不成立**：`:558` 要求 `readable.complete === true` 才会进入「唯一候选推断」；而 `:164-166` 明确「当前没有任何 public 来源可证明完整性（durable correlation 只是稀疏请求历史，asyncSnapshot/fleet 是带 omitted 的有界投影），因此生产调用方必须传 `complete: false`」。`complete` 由 `:538` 从 `raw.complete === true` 求得，生产侧没有能提供该字段的目录来源。
3. **控制面没有目录输入**：即使调用，`resolveTargetChild(directory, index?)` 需要 `SupervisorTargetDirectory`（children + complete），而控制面可读的 runtime 身份类型只有 `{runId, ownerGeneration, liveRunEpoch, running, steerable}`（`supervisor-control-plane.ts:170`、`runtime-state.ts:13-25`），无 children 字段，构造不出可用目录。

处置：**保持现状，不删除、不激活、不新增生产调用方**，也不放宽 `complete === true` 前置。删除属独立清理决策，本轮只报告。

---

## 5. 合同不一致坐标（收紧前 → 收紧后）

| 位置 | 收紧前 | 收紧后 |
|---|---|---|
| `operation-tools.ts:122-131` `SUBAGENT_RUN_STEER_PARAMETERS.required` | `["message"]`（`index` 只在共享 `TARGET_FIELDS`，`operation-tools.ts:38-43`） | `["message", "index"]`（附注释说明与执行期一致）；`TARGET_FIELDS` 未改，status/interrupt/resume/stop 的 `required` 均未声明，字段形状不变 |
| `operation-tools.ts:247`（`subagent_run_steer` description） | 「id/runId/dir/index 为可选定位（dir 在 steer 上会被目标解析器拒绝，优先 id/runId）」 | 「message 与 index 均必填」，逐条写明 `SUPERVISOR_STEER_CHILD_AMBIGUOUS` / `SUPERVISOR_STEER_TARGET_INVALID` / `SUPERVISOR_STEER_TARGET_CONFLICT` / `SUPERVISOR_STEER_TARGET_AMBIGUOUS` / `SUPERVISOR_STEER_TARGET_ALIAS` 与「status/interrupt/stop 的 dir 不受影响」 |
| `operation-tools.ts` steer `promptSnippet` / `promptGuidelines` | 只提 message 必填 | 同时提 index 必填与「不推断、不默认 0、不广播」 |
| `extension.ts:127`（legacy `TYPED_SUBAGENT_PARAMETERS.index`） | 无注释，看起来对全部 control action 等价 | 注释声明「status/interrupt/resume/stop 的 index 可选；steer 的 index 必填」，并说明扁平 union 不能写条件必填（不引入 if/then） |
| `extension.ts:132` `TYPED_SUBAGENT_DESCRIPTION` | control action 段落只在 resume 提必填消息，steer 未提 index | 「steer 必须同时携带 id 或 runId 与必填的非负整数 index（单 child 也必须写 index: 0）」+ 缺 index 的 code + 不推断/不默认 0/不广播 |
| `extension.ts:1416-1423` `controlFailure` | 只接受 `(code, receipt)`，文案固定 | 新增可选第三参 `hint`（仅追加到 text）；`details` 形状与 `code` 不变，未传 hint 的调用点文案逐字不变 |
| `extension.ts:1487-1493` 缺 index 分支 | `controlFailure("SUPERVISOR_STEER_CHILD_AMBIGUOUS")` | 同 code + 可执行提示（「重发并带上目标 child 的 0 基下标；单 child 也要 index:0；不推断任何值」），**无任何新增推断/默认/广播分支** |
| `extension.ts:1404-1405`（陈旧注释） | 「上游优先级为 id ?? runId」 | 「上游 steer 实际为 runId ?? id」（`pi-subagents/src/runs/foreground/subagent-executor.js:6528`）；因 `:1406` 已对二者不等直接冲突拒绝，无行为差异 |

未影响 interrupt/resume/stop 的证明：
- 三者不共享 steer resolver：`extension.ts:1541` 为它们的唯一出口（`const reply = await rpc[action](params)`），仅 `resume` 在 `:1478` 有自身 message 检查、`interrupt/stop/status` 无前置检查。
- 共享结构只有 `TARGET_FIELDS`（字段**形状**），本次未改；`required` 是各 schema 独立声明，`SUBAGENT_RUN_STATUS/INTERRUPT/STOP_PARAMETERS` 没有 `required`，`RESUME` 仍为 `["message"]`。
- 单测 `test/subagent-operation-tools.test.mjs` 逐工具断言合法/非法输入集合，三者行为未变且全绿（见 §10）。

---

## 6. upstream 广播语义与无法在本仓修复的提示冲突（登记为已知缺陷）

- upstream 的 index 语义（`packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/foreground/async-steering-action.js:118-119`）：
  `effectiveTargetIndex = input.index ?? (status.mode === "single" && runningIndexes.length === 0 && steps[0]?.status === "pending" ? 0 : undefined)`；
  `targetIndexes = effectiveTargetIndex !== undefined ? [effectiveTargetIndex] : runningIndexes`。
  → **index 缺省 = 向所有 running child 广播**（这也正是本仓在 2026-10-15 明确取消的行为）。
- 但 upstream 的状态回执仍给出 index-less 提示（raw 文本，本仓不得改写）：
  - `.../src/runs/background/run-status.js:348`：`Steer: subagent({ action: "steer", id: "<runId>", message: "..." })`
  - `.../src/runs/background/run-status.js:746`：`Steer running child: subagent({ action: "steer", id: "<runId>", message: "..." })`
  - 与之相邻的 `:712`、`:733` 是带 `index` 的正确形态，说明 upstream 自身两种提示并存。
- 冲突性质：该文本与 upstream 自己的广播语义自洽，但与**本仓收紧后的合同相反**。仓库根 `AGENTS.md` 的 TUI 精简边界要求 raw payload 不得为展示而改写，且 `node_modules/**` 不在本仓可修范围 → **本次未修改 node_modules 任何字节**，此冲突登记为已知缺陷。
- 残留影响：模型若照 upstream 提示只发 `{id, message}`，会得到 `SUPERVISOR_STEER_CHILD_AMBIGUOUS` + 本轮新增的可执行提示（告知补 index），可自愈重试；但「首次即错」的往返无法在本仓消除。修复面在 upstream（要么让回执统一带 index，要么让广播语义与本仓一致）。

---

## 7. 类别 1 判定要件

1. **数据来源**：Host 真实运行（`test/subagent-steer-text-insertion.integration.mjs` lane）的 `tool_execution_end` 记录；失败 run 的 `status.steering` 全 0（requested/scheduled/pending/delivered/failed），`details.code = SUPERVISOR_STEER_CHILD_AMBIGUOUS`，回执文本 `SUPERVISOR_STEER_CHILD_AMBIGUOUS: Supervisor control request blocked.`（见 `integration-gate-baseline.md:218`）。父会话另有一次独立复现：fan-out 1/1 的 run 只给 `runId` 被拒，补 `index: 0` 后投递成功（同文件 `:220`）。
2. **首个偏离点**：`extension.ts:1487`（缺 index 直接 fail closed）。`subagent_start` 已 `isError:false`，偏离点前移到 steer 投递，不在派发侧。
3. **完整调用链**：模型按公开合同调 `subagent_run_steer{runId,message}` → `operation-tools.ts` factory 白名单/必填检查（收紧前 `required` 无 index → 放行）→ 注入回调 `executeControl` → legacy typed tool 的 `Object.hasOwn(input,"action")` 控制分支 → `executeControl` → `:1482` steer 分支 → `:1483 canonicalSteerTarget` → `:1487` 缺 index → `controlFailure("SUPERVISOR_STEER_CHILD_AMBIGUOUS")`；**从未**到达 `:1495 identityForRun`、`:1513 resolveSupervisorControl`、`supervisor-control-plane.ts:300`、`:1524 rpc.steer`。
4. **与 production 事实无差异**：该链不经 fixture 特化代码、不依赖测试专属 schema；同样的 schema/描述/执行期分支对真实模型调用完全一致（production 与 lane 同码）。因此「模型按公开合同只给 runId 必被拒」是可从合法 typed 入口产生的生产事实，不是测试制造的非法组合。

---

## 8. 本次实施（选项 2 + 选项 3）与明确不做的选项 1

**选项 2（已实施）**：把公开合同同步到已冻结的执行期——schema `required` 增加 `index`；描述/guideline 与 legacy union 描述同步；`:1487` 文案可执行化（不新增分支）。
**选项 3（已实施，配套合法化）**：迁移仓内调用方，使其满足收紧后的合同（否则它们会从「合法调用」变成「非法调用」）：

| 调用点 | 形态 | 处置 |
|---|---|---|
| `test/subagent-steer-text-insertion.integration.mjs:87`（收紧前为 `:85`） | 真实工具调用 `{ runId, message }`（单 child / single mode） | 补 `index: 0`；同文件 `:14-16` 头注释同步 |
| `test/subagent-operation-tools.test.mjs:82` | schema 合法样例 `{ message }` | 补 `index: 0`；并在非法集合新增 `{ message }`（缺 index）、`{ message, index: -1 }`、`{ message, index: 1.5 }`、`{ id, index }`（缺 message） |
| `test/subagent-operation-tools.test.mjs:218-220` | factory 透传样例 `{ id, message }` | 补 `index: 0`（断言同步），使样例满足公开 schema |
| `test/subagent-compact-rendering.test.mjs:239` | 纯渲染投影输入（legacy args 形态，不经 dispatch） | 不改（无 dispatch 语义，改它会动到 `tui/**` 的渲染合同） |
| `test/subagent-runtime-membrane.test.mjs`（1866/1877/1901/1922/2165/2185/2510/2517/2526/2533/2540/2547/2554/2565/2573）、`test/supervisor-gate-wire.test.mjs:95` | 已全部携带 `index: 0` | 无需迁移 |
| `test/subagent-dispatch-extension.test.ts:155` | 注释已写「缺 index 一律拒绝而不猜 0/不广播」 | 无需迁移（与新合同一致） |
| `pi/AGENTS_GLOBAL.md:53/:78/:82`、`pi/agents/*.md` | 只提工具名，无 steer 参数示例、无「index 可选」陈述 | 无需修改（本次未改 `pi/AGENTS_*.md`） |
| `scripts/**` | 只有 RPC method 名单与 diagnostic 探针的 action enum | 无需修改 |

**明确不做的选项 1（唯一候选推断）**：把 `resolveTargetChild` 的推断分支接上生产，使缺 index 时从 run 目录推断唯一 child。阻塞原因：推断的正确性前提是「该 run 的 child 集合完整可证」，而 `supervisor-gate-policy.ts:164-166` 已论证当前**没有任何 public 来源可证明完整性**（durable correlation 是稀疏请求历史；asyncSnapshot/fleet 是有界投影），因此 `complete` 恒为 `false`；在此之上放宽唯一候选推断等于**降低 fail-closed 标准**，且会把「找不到/看不全」误当成「只有一个」。同时控制面拿不到 children（`supervisor-control-plane.ts:170`、`runtime-state.ts:13-25`），要做就得新增目录读取面（新 IO、新竞态、新权限），超出「同步合同」范围。

---

## 9. 遗留产品问题（未裁决，保持现状）

`interrupt` / `stop` / `resume` 目前**完全没有 child 作用域**：它们不经 steer resolver，从 `extension.ts:1541` 直通 `rpc[action](params)`，接受 `dir`、不产生任何 `SUPERVISOR_*` 码，多 child run 上的语义由 upstream 决定（`index` 对 resume/stop 是否改变投递目标仍未证，见 `docs/plans/records/2026-10-16-operation-tools/contract.md:113`）。「它们是否也必须 child-scoped」属产品语义决策，本次**未裁决、未改动**；本次仅保证 steer 的收紧没有波及它们。

---

## 10. 验证（本轮实际执行）

| 命令 | 结果 | 日志 |
|---|---|---|
| `npx tsc --noEmit` | 0 错误（退出码 0） | `/tmp/steer-contract-logs/tsc-root-final.log` |
| `npm run typecheck:subagents-enhanced` | 0 错误（退出码 0） | `/tmp/steer-contract-logs/tsc-enhanced-final.log` |
| `node --test test/subagent-operation-tools.test.mjs test/operation-guidance-contract.test.mjs test/supervisor-gate-wire.test.mjs test/supervisor-gate-policy.test.mjs` | TAP：tests 73 / pass 73 / fail 0 / skipped 0 | `/tmp/steer-contract-logs/unit-1-final.tap` |
| `node --test test/subagent-runtime-membrane.test.mjs test/subagent-runtime-resource-isolation.test.mjs test/subagent-compact-rendering.test.mjs test/subagent-dispatch-extension.test.ts` | TAP：tests 183 / pass 183 / fail 0 / skipped 0 | `/tmp/steer-contract-logs/unit-final-2.tap` |
| `node --test test/subagent-runtime-membrane.test.mjs test/subagent-runtime-resource-isolation.test.mjs test/subagent-compact-rendering.test.mjs test/subagent-dispatch-extension.test.ts test/custom-footer-subagents.test.mjs test/pi-subagents-compat.test.mjs test/joint-upgrade-model-only.test.mjs test/subagent-dispatch-rpc.test.mjs test/subagent-runtime-state.test.mjs` | TAP：tests 278 / pass 278 / fail 0 / skipped 0 | `/tmp/steer-contract-logs/unit-final-rest.tap` |

未执行：任何真实 Host / node --test 的 integration lane（Host 槽位被占，steer lane 复跑由主会话另行安排）；未联网；未提交 commit；未改 `node_modules/**`。

**主会话复跑建议命令**（Host 槽位释放后）：
`node --test test/subagent-steer-text-insertion.integration.mjs`
期望变化：`steerResult.isError !== true`、`status.steering.delivered >= 1`、child 会话 jsonl 出现 `STEER_INSERT_INJECTED_TEXT` 且无 `STEER_CHILD_FALLBACK`。

---

## 11. 未在本次写入的过期陈述（超出本轮 writePaths，仅登记）

- `docs/plans/records/2026-10-16-operation-tools/contract.md:45`：把 `subagent_run_steer` 的 `index` 列在**可选**清单、`required` 只列 `message`。这是 S0 冻结表的历史记录（本次未获写权限），已被本记录取代；如需在源头更正经父层裁决。
- `docs/research/**` 中的上游参数表（例如 `2026-10-15-upstream-subagent-tool-exposure.md:74`）描述的是 **upstream** 的字段可选性，与本仓收紧后的合同不冲突，无需修改。
- `docs/plans/records/2026-10-17-runtime-convergence/integration-gate-baseline.md:218` 记录的「schema 把 index 声明为可选」是该次 lane 观测时刻的事实，已在原处加一行指向本记录的取代说明。
