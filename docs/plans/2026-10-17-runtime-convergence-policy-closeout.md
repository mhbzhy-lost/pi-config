# Runtime 遗留收口与 Agent Runtime 策略统一实施计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。本计划只定义范围、依赖、证据和验收边界，不自动开始实现、测试编写、真实 Host 操作、危险进程实验、提交或推送。

**目标：** 收口当前 runtime-closeout、Supervisor gate、独立 operation tools、code_mode 工具发现、Agent Runtime 测试政策和遗留验证事项，形成一组可复核的实现、来源分类、阻塞边界与最终验收证据。

**架构：** 计划分成五条互相隔离的工作流：runtime 可达文本与测试政策、code_mode discovery 证据、Supervisor 持久化健壮性、旧工具名 fixture 迁移、遗留事项的来源分类与环境验收。所有探索任务先产出证据；只有证明为本仓生产缺陷的分支才能进入最小修复，来源不明、上游阻塞或用户暂缓项保持 fail-closed 并登记完成边界。

**技术栈：** Node.js `>=22.19.0` 原生 TypeScript type-stripping、TypeScript `tsc --noEmit`、Node `node:test` 既有测试、Pi Host/codemode SDK、`pi-subagents-enhanced` package、官方 npm registry、受控 fresh Host 与本地隔离 fixture。

**计划状态：** Inline 收尾已推进到交付门禁（用户授权持续推进，未提交、未推送）。当前逐项权威状态见 `docs/plans/records/2026-10-17-runtime-convergence/closure-matrix.md`，交付门禁核对见同目录 `acceptance.md`，实际命令与缺口见 `current-validation.md`。已完成：基线与 code_mode 归因、首轮计划 review 与修订、M1 reply guard 对称、H1 opaque intent id、H2 bound release proof 收紧、T29 coordinator errorInfo、T26 public disposition facade、runtime 可达文本测试政策清理（含三个本机 skill）、footer 空行、fixture 迁移（含本轮 model-selection 23/23 与 real-git 4/4）、历史 RPC/Supervisor 与 heartbeat/session-owner 边界归档、S6 清单可还原性核对、真实旧 workspace `preserve` 实际成功。T25A/B/C 已由用户授权新增专项用例并实跑：`test/workspace-disposition-settlement.integration.mjs` 12/12 exit 0，覆盖七个新故障窗口、workspace-only prepare 补建 intent、startup barrier 与分区隔离（`settlement-window-audit.md`）。仍 blocked/deferred：scheduler 上游实现限制（用户已裁决移出本批）、C1/C2/C3 clear/inspect 上游接口、R01/R03 用户暂缓、旧 heartbeat 证据根无合法 public 出口、真实 workspace 物理回收缺 observed terminal proof、`pi -c` 锁为用户停止项。用户已裁决并落地两项 profile 配置：`contact_supervisor` 不再写进 profile `tools`（上游 child runtime 按 supervisor channel metadata 注册，属不可 gate 的 INTERNAL_TOOL），`pi/AGENTS_GLOBAL.md` 与既有 guidance 断言已按该事实更新，`test/operation-guidance-contract.test.mjs` 12/12 exit 0；`qoder-pool/DeepSeek-Flash` 启用，用户已自行删除 `pi/AGENTS_SHARED.md` 的 deepseek 禁令，生产 `providerBlacklist=["deepseek"]` 只匹配 provider 段、不拦该 pool 别名，故保留不变。事实与源码依据见 `agent-profile-drift.md`。复选框共 7 项标为 `[~]`（部分完成/未运行），其余均已勾选：T16 的隔离安装闭包、分组真实 integration、fresh Host 1.0.4 闭包消费与逐组结果登记（未联网安装、孤立 fixture 无法验证）；T25C 的新 fault 窗口验证与 T27 的组合 fixture/授权后运行（新增测试未授权）。`.pi/handoff/context-handoff.md` 已以 **append-only** 方式追加 2026-10-19 当前节，原历史正文逐字保留，T17/T18 对应两项因此已勾选。用户已裁决并落地两项 profile 配置：`contact_supervisor` 不写进 profile `tools`（上游 child runtime 按 supervisor channel metadata 注册，属不可 gate 的 INTERNAL_TOOL），`pi/AGENTS_GLOBAL.md` 与既有 guidance 断言已按该事实更新，`test/operation-guidance-contract.test.mjs` 12/12 exit 0；`qoder-pool/DeepSeek-Flash` 启用，用户已自行删除 `pi/AGENTS_SHARED.md` 的 deepseek 禁令，生产 `providerBlacklist=["deepseek"]` 只匹配 provider 段、不拦该 pool 别名，故保留不变。事实与源码依据见 `agent-profile-drift.md`。本轮另新增 `compat-lane-provenance.md`：`test/pi-subagents-runtime.integration.mjs` 的两个非隔离 live-state lane 失败（上游 `no_active_session`、RPC 60s 超时），按来源未证实/环境受限 fail closed，不重复运行。

## 全局约束

- 仓库和 package 的最低 Node 版本固定为 `>=22.19.0`；新增或迁移 TypeScript 必须由 `tsc --noEmit` 或等价静态检查覆盖。
- npm 只能使用官方源 `https://registry.npmjs.org/`；不得使用第三方 registry。
- `scripts/` 只新增可直接执行的 CLI、初始化脚本或诊断 probe；production 模块不得 import `scripts/**`；复用实现归属 `src/<feature>/` 或 package `src/`。
- Node 原生 production/CLI 代码使用 `.ts`；`.mjs` 只用于测试、fixture、测试辅助模块、第三方入口或尚未迁移的外部兼容文件。
- `scripts/lib/` 不新增文件，不扩大依赖，不接入新调用方。
- `pi/extensions/`、`packages/<name>/extensions/` 和 `packages/<name>/child-extensions/` 只承担 Host 入口、依赖注入和资源注册；可复用实现归属 feature 或 package `src/`。
- 本仓禁止通过 MCP 接入、注册或直接使用任何工具；外部能力只能经已有 skill wrapper 入口使用。
- 未经用户对具体功能点明确授权，agent 不得主动编写**新增测试**、全新测试 fixture 或压力场景；既有测试、既有断言和既有 fixture 的删除或修改可随已授权修复同步进行。
- 本计划中的新增测试、全新测试 fixture 和行为压力场景均为“建议（待用户授权）”；既有测试、断言和既有 fixture 可为匹配生产修复而修改或删除。
- 读取/运行既有测试、`rg` 核对、`git diff --check`、类型检查与测试编写分开处理；可在已授权实现或诊断范围内执行必要的既有检查。带真实 provider、设备、网络安装、SIGKILL 等额外副作用的验证仍按对应资源授权，不能由 skill 文案强制启动。
- `writing-skills`、`writing-plans`、`test-driven-development` 及其它 skill 不得以默认规则强制 TDD、先写测试或强制测试；只有用户明确要求 TDD/测试时，才允许把相应方法作为该范围内的可选执行方式。
- 全局 prompt 的测试政策只表达一条行为约束：未经用户明确授权，agent 严禁主动新增测试；不得再用 skill、agent profile、tool description 或 task template 叠加更强的默认测试义务。
- `pi-subagents-enhanced` 当前 14 个 operation tools 的 `exposure: "model-only"` 是现行安全合同：主 Host 模型可见，codemode callable/discovery 面不可见。除非用户另行改变产品合同，不得为了让 code_mode 发现它们而绕过 Host callable 过滤、增加 `ALL_TOOLS` fallback 或扩张 child capability。
- code_mode 现象必须按真实入口、Host identity、tool exposure、callable names、脚本返回和事件顺序分类；没有同次非敏感证据时只能记为 `blocked-evidence`，不得判 production 缺陷。
- 测试、恢复或实际运行发现异常时，先记录数据来源、首个偏离点、完整生成调用链、权威身份和资源顺序，再决定是 production 缺陷、测试制造的数据还是来源未证实；分类完成前不得增加 production 兼容分支。
- Supervisor clear/inspect 不得把 `pending=[]` 当作 exact absence，不得增加 `force`、bulk clear、root-wide clear、直接删除 request 文件或吞错 fallback。
- 用户已暂缓的 idle notification、纯派发 `triggerTurn` 选择性关闭、`resume(model)` 不在本批实现；本计划只收口其状态、解阻条件和重新立项边界。
- 真实 provider、真实 CLI/TUI、fresh Host、网络安装、SIGKILL/孤儿实验和跨进程竞争实验需要在执行该任务前明确授权；本计划不继承历史危险实验授权。
- 不读取、复制、输出 settings、models、auth、credential、完整 session、authority 或用户状态；不改外部 models 备份，不读取其正文。
- 当前保护现场不得覆盖、stash、reset 或 raw git worktree 操作：`.pi/handoff/context-handoff.md`、`pi/crashes.json`、`pi/models.json.bak-qoder-thinking-20261016161901`。不 push；不自动创建 commit。本会话单独接管 footer worktree 的提交授权仅覆盖该工作区已有交付物；检查已证该工作区干净、HEAD 无增量，因此无提交可创建，不扩展为本批 blanket commit 授权。
- TUI 只在 renderer 层做展示精简；本计划不改 agent 实际收到的消息、tool result、event payload、session 内容或结构化 details。
- 既有历史 handoff、旧验收记录和研究文档只作为证据来源，不为了制造绿色而回写历史事实；当前遗留账本和本计划新增记录才可更新当前状态。

## 当前事实与已有调研输入

- 当前 main 基线为 `92b0302`；`2ca9053` 的 footer metadata 调整已提交。runtime-closeout 和 S0–S6 不因本计划重开；G1/G2/G2-wire 已完成，C1/C2/C3 clear/inspect 仍未实现。
- 2026-10-17 code_mode 归因 delegate 已完成：14 项工具均为 `model-only`；Host callable 过滤是它们无法被 code_mode 发现的已证设计原因。本会话的 `tools.supervisor_request_reply` 调用返回 `TypeError`、`searchTools("managed workspace dispose")` 返回空集合，与该设计相符；不能据此认定 catalog 漏列。报告路径：`.pi/subagents/artifacts/outputs/6802be65-c841-4587-b361-ac6c0c369680/请返回一份结构化中文归因报告，不修改仓库文件`。
- 2026-10-17 runtime 测试政策审计 reviewer 已完成，明确了 SHARED/GLOBAL、writing-skills/writing-plans/TDD/provider skill 和 `CODING_ACCEPTANCE_EVIDENCE` 的命中。T1/T2 应复用并归档这两份报告，只对源码变化做增量核对，不重复派发同一轮审计。
- 本会话 worktree 案例：`a8f3cdf0-fbca-4c19-abb3-f5971dedc750`，child run `29ea828b-dc00-43a2-8cbe-0b6f6a14771f`，supervisor request `e295a31b-bc52-481f-83c2-ed11e2643260`。合法 reply 被拒 `SUPERVISOR_INTENT_INVALID`；pending 可见不证明具体失败原因，不能写成已证“两套投递面不一致”。
- worktree dispose 的调用面将 `strategy` 表示为必填，runtime 在非 integrate 动作上返回 `INVALID_WORKSPACE_STRATEGY`；仓库 factory 源码却声明 `required: false`。T19 定位 schema 从注册到 provider/Host 调用面的首个变化，不预先删 runtime 校验。
- footer child 暂停后 worktree 仍 `active`、`process_terminal=observed`，有 `origin-dirty` 发布阻塞；worktree 自身 clean、HEAD 与基线同为 `92b0302`，没有待提交内容。merge queue 接管提示只证明发出了恢复提示，不能证明队列里一定存在可发布 commit。
- 已有调研归档：`docs/plans/records/2026-10-17-runtime-convergence/codemode-discovery.md`、`runtime-policy-audit.md`。这是规划输入原文，不代表实现、测试编写或真实运行验收完成。
- 新一轮 managed worktree/merge queue 整体审查已完成：reviewer run `bc43766e-88a6-451c-b7c5-21a69cbb61be`，报告 `docs/reviews/2026-10-17-managed-workspace-merge-queue.md`，3 项 High、没有证据充分的 Blocker。主会话已复核 H1 ID 格式、H2 release shortcut 和 H3 public/queue 分离的关键源码；尚未运行真实删除/队列复现。T20/T21 复用该归因，T22–T27落实修复合同、实现与建议验收，不能重新把三项已证问题仅归为待调查。
- footer 视觉小任务已按用户后续明确选择完成：`src/background-activity/layout.ts` 在完整常驻元数据与首个动态内容之间插入一个空行，动态内容之间紧凑；无动态内容不留尾随空行，计入高度预算。仅该源码文件有未提交改动；既有类型检查通过，display 检查 42/51，executor 报告 9 个失败与 HEAD 基线相同。未改测试，实际观感待重载/重启 Host；旧 A/B/C 等待状态已失效。

## 文件结构与职责

- `docs/plans/records/2026-10-17-runtime-convergence/`：本批新增的基线、code_mode 归因、runtime 文本审计、来源分类和最终验收记录；每份记录只保存非敏感证据和明确边界。
- `pi/AGENTS_SHARED.md`、`pi/AGENTS_GLOBAL.md`：全局 prompt 规则和主会话编排规则；只保留用户授权门禁，不再叠加默认 TDD/测试强制语义。
- `pi/agents/*.md`：agent profile 的角色、停止条件和验证文案；不强制 agent 主动编写测试。
- `skill-overrides/writing-skills/**`、`skill-overrides/writing-plans/SKILL.md`、`skill-overrides/test-driven-development/**`：仓库管理的 skill 源；分别承担 skill 编写、计划编写和显式授权后的测试方法说明。
- `.pi/skills/external-llm-review-provider/SKILL.md`：项目级 runtime skill；把强制测试步骤改为授权后的建议验证。
- `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts`：Supervisor reply guard 持久化和清理的唯一 production owner。
- `test/supervisor-gate-wire.test.mjs`：现有公开 wire fixture；既有断言可随修复迁移，新增案例须明确授权。
- `test/fixtures/**` 与指定 `test/*.integration.mjs`：真实 integration 调用者和 provider fixture；只迁移应消费 fresh Host 新工具面的调用，保留明确覆盖 upstream 旧名的兼容 probe。
- `src/task-scheduler/**`：scheduler 只读 observer/adapter 的本仓边界；不把 display observer 当作 store/lock 并发修复。
- `docs/plans/records/2026-10-16-operation-tools/acceptance.md`、`docs/plans/2026-10-15-supervisor-gate-recovery.md`、`docs/architecture/supervisor-gate-recovery.md`：当前 operation tools/Supervisor 计划的证据和架构一致性记录。
- `docs/todos/2026-10-16-runtime-independent-followups.md`、`docs/todos/2026-10-16-subagent-operation-followups.md`、`.pi/handoff/context-handoff.md`：当前账本和会话交接；只更新当前事实，不重写历史验收。

## DAG

以下边与逐任务 `Deps` 一致。T3E 是仓外个人 skill 文本清理节点；T19/T20/T21 分别调查本会话的 schema、reply 和无改动 worktree 生命周期现象。它们不包含未分类的生产修复。

```text
T0 → {T1,T2,T5,T7,T10,T11,T12,T14,T15,T19,T20,T21}
T2 → {T3,T3E,T4}
T5 → T6 → T13
T7 → {T8,T9}
T20 → T24
T21 → T22 → T23 → T25A → T25B
T22 → {T26,T29}
{T25B,T29} → T25C
{T24,T25C,T26} → T27
{T3,T3E,T4,T8,T9,T27} → T16
{T16,T19} → T28
{T1,T10,T11,T12,T13,T14,T15,T28} → T17 → T18
```

依赖消费说明：T1/T2/T7/T10–T15/T19–T21 使用 T0 的保护基线；T3/T3E/T4 使用 T2 的逐项可达文本清单；T6 使用 T5 的实际 M1 结论；T13 使用 T6 冻结的 gate 文档和既有 D0–D3 接口；T8/T9 使用 T7 的 fresh/legacy 分类。T22–T29 修复链的具体接口依赖见各任务；T16 消费最终修复版本和 fixture 迁移，T28 再消费接口结论与 fresh 验收处理真实现场，T17/T18 依次完成当前账本与整体验收。未画重复传递边。

## Waves

- **Wave 0：** T0。
- **Wave 1：** T1、T2、T5、T7、T10、T11、T12、T14、T15、T19、T20、T21。
- **Wave 2：** T3、T3E、T4、T6、T8、T9、T22、T24。
- **Wave 3：** T13、T23、T26、T29。
- **Wave 4：** T25A。
- **Wave 5：** T25B。
- **Wave 6：** T25C。
- **Wave 7：** T27。
- **Wave 8：** T16。
- **Wave 9：** T28。
- **Wave 10：** T17。
- **Wave 11：** T18。

**优先级和关键路径：** H2（T23）先收紧 bound release 的资源安全，H3 再依次交付 workspace durable prepare/apply（T25A）、queue settlement/receipt（T25B）和 server 恢复接线（T25C）。H1（T24）、错误传输（T29）及 Root facade（T26）独立并行。结构上最长链为 `T0 → T21 → T22 → T23 → T25A → T25B → T25C → T27 → T16 → T28 → T17 → T18`；真实验证资源和测试编写授权是额外门禁，不通过伪造依赖边解决。

Wave 仅表示拓扑层，不是批次屏障。前驱产物已验收即可在空闲槽内派发。并行写冲突使用下表协调，不给整条业务分支增加伪依赖；隔离后由集成队列顺序发布，并验证合入版本同时包含双方语义。managed 工具尚不可用时，改为互不重叠的精确子合同或短时文件互斥，不改用 raw worktree 命令。

| 并行任务 | 共享路径 | 协调方式 |
| --- | --- | --- |
| T4 / T24 | `subagent-dispatch/extension.ts` | evidence 数组与两个 intent 构造点是不同区域，隔离后语义合并 |
| T5 / T24 | `test/supervisor-gate-wire.test.mjs` | 既有测试同步删改时按文件加写锁；私有工作区合入后保留 persistence 与 opaque ID 两类案例 |
| T8 / T9 | deterministic/contact fixture | 按 fresh/legacy 分支精确划区，不能共享 checkout 同时整文件重写 |
| T8 / T14 | heartbeat-parent-host/provider | 将新工具名迁移与正常报告结算分成可审阅 diff；fixture 修改需授权，写入阶段隔离或短锁 |
| T25C / T29 | `workspace/coordinator-server.ts` | T25C 消费 T29 的错误 codec，合入后再接线；这是实际接口依赖 |

T13/T14/T15 不直接写统一账本，由 T17 回填；T21 只前置取证，真实现场处置由 T28 后置执行。

### 共同执行与停止条件

- 每个派发含完整任务内容、精确 WritePaths、验收、资源与本节停止条件；单个 coding 子任务预计 30 分钟以内，T3/T8/T9 超预算时按文档族或业务 fixture 拆成精确变更，不把多次归因/修复/真实运行塞到一个合同。
- 调研先落盘报告，修复派发引用报告原文。T10/T11/T12/T19/T20/T21 查出未知根因时只报告，不在探索任务中顺手修 production。
- 若报告证明新的本仓可修生产缺陷，主会话 inline 补充精确实现节点（路径、方法、验证、Deps），保留原始需求；未经用户新增授权的测试编写仍标建议。新实现及其已授权验收纳入 T17 前驱，不能把 `local-fix-ready` 当作“工程全部完成”。
- 只在证据不足、上游接口缺失、真实资源授权缺失或既有用户暂缓时允许相应分支 blocked/deferred；必须记录具体缺少事实、已完成动作和解阻条件。报告完成与功能完成分别记账。
- scope 外写入、身份/时间/事件顺序不合法、读真实敏感状态、需要放宽 owner/CAS/capability 或无法同时满足验收时停相关分支。`contact_supervisor` 由 child runtime 按 supervisor channel metadata 注册，不靠 profile `tools` 声明；可用时上报，不得假设一定可用，不可用时输出阻塞事实后结束。
- `SUPERVISOR_INTENT_INVALID`、`INVALID_WORKSPACE_STRATEGY` 等同参错误不重复重试，不用 codemode/旧工具/raw git 绕过 gate；workspace 状态与一次性 token 仅取当次 typed 工具。若工具故障导致无法结算，只保留现场与证据，不伪称已 preserve/release。
- runtime 自动集成所需内部提交遵守既有 managed publication 合同；人工提交仅在用户已授权的具体范围内进行。父仓脏文件不自动 stash/reset/stage。计划 review 与成果 review 按授权次数分别处理。

---

## 任务合同

### Task 0：冻结基线、dirty 现场和当前范围

**Deps：** `none`。

**WritePaths：**
- `docs/plans/records/2026-10-17-runtime-convergence/baseline.md`

**Resources：** `none`；只读 git/status、文件系统和已知仓库文档。

**Files：**
- Create：`docs/plans/records/2026-10-17-runtime-convergence/baseline.md`
- Read：`.pi/handoff/context-handoff.md`、`docs/plans/records/2026-10-17-plan-outcome-review.md`、`docs/todos/2026-10-16-runtime-independent-followups.md`、`docs/todos/2026-10-16-subagent-operation-followups.md`、`HANDOFF.md`

**接口契约：**
- Consumes：当前 HEAD、index/status、受保护 dirty 路径、当前 handoff、最新 reviewer report、两份当前遗留账本。
- Produces：`RuntimeConvergenceBaselineV1`，至少包含 `head`、`protectedPaths`、`completedScopes`、`blockedScopes`、`deferredScopes`、`userPostCheckScopes`、`historicalOnlyScopes` 和每个结论的来源路径。

**验收标准：**

- [x] 记录当前 HEAD、index 状态和所有受保护现场；不读取 `pi/models.json.bak-qoder-thinking-20261016161901` 正文。
- [x] 明确当前 closeout 的三项事实：runtime-closeout 按用户裁决完成；S0–S6 在范围内完成；G1/G2/G2-wire 完成而 C1/C2/C3 clear/inspect 仍 blocked。
- [x] 把根目录 `HANDOFF.md` 标为旧升级阶段历史，不用其 B3/T7/T8 状态阻塞当前批。
- [x] 把 runtime policy 与 code_mode 已归档输入写入来源索引，保留 run ID、已检查范围和不确定性；新增 managed worktree review 单独记录，不能与 10-17 旧成果 review 混为同一轮。
- [x] 逐项把 R01–R15/F1–F7 和新增 runtime 案例映射到本计划；报告覆盖与工程完成分开记录。
- [x] M1–M9 显式映射：M1→T5；M2→T6；M3→T6；M4→T6/T13（scope-unverified 阻断张力与 inspect 缺口，保留 fail-closed，不自动放宽）；M5→T10；M6→T11；M7→T16；M8→T17；M9→T6 的证据对账记录。
- [x] 只做文件系统和静态核对；不运行全仓测试、不启动 Host、不修改 production。

**建议验证（无需新增测试；既有测试/断言可随本修复同步调整）：**

- `git status --short --untracked-files=all` 的输出只作为基线记录，不把 dirty 现场当作缺陷。
- `git diff --check -- docs/plans/records/2026-10-17-runtime-convergence/baseline.md`。

---

### Task 1：code_mode discovery 现象取证与合同裁决

**Deps：** `T0`（理由：使用 T0 冻结的 Host/版本/证据边界；不消费用户敏感状态）。

**WritePaths：**
- `docs/plans/records/2026-10-17-runtime-convergence/codemode-discovery.md`

**Resources：** `none`；如需 fresh Host 或实际 code_mode 调用，必须先取得该验证范围的用户授权。

**Files：**
- Create：`docs/plans/records/2026-10-17-runtime-convergence/codemode-discovery.md`
- Read：`node_modules/@earendil-works/pi-coding-agent/docs/codemode.md`、`node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`、`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`、`node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/execute.js`、`node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/tool.js`、`packages/pi-subagents-enhanced/src/subagent-dispatch/operation-tools.ts`、`packages/pi-subagents-enhanced/src/workspace/operation-tools.ts`、`packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-operation-tools.ts`、`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`

**接口契约：**
- Consumes：code_mode 原始脚本（若用户提供）、同次非敏感返回头/错误/details、同次 `{name, exposure}`、active names、callable names、main/child 布尔值、supervisor bind 布尔值、Host/package 版本。
- Produces：`CodeModeDiscoveryDispositionV1`：`expected-model-only-boundary`、`production-callable-discovery-defect` 或 `blocked-evidence` 三选一；附 `firstDivergence`、`sourceClass` 和 `requiredEvidence`。

**实施方法：**

- [x] 归档本会话已返回的 code_mode 只读报告并记录来源 run/artifact，只核对报告之后发生变化的源码；不得再派相同全量调研。
- [x] 核对 `AgentSession._getCallableTools()` 只纳入 `codemode`、`deferred` 和 active `direct`，确认 `model-only` 在进入 codemode 前已被排除。
- [x] 核对 `ALL_TOOLS`、`searchTools()`、`describeTool()` 和 `ctx.executeTool()` 都消费 callable 子集，没有第二条绕过过滤的入口。
- [x] 核对 14 项 operation tools 的 factory 和 main Host 注册均使用 `exposure: "model-only"`；supervisor 三项额外记录 adapter bind/active 条件。
- [x] 记录 child early-return、nested capability boundary 和 synthetic SDK probe 的证据边界。
- [x] 若没有同次脚本/回执/Host 快照，写明当前仍是 `blocked-evidence`，不修改 exposure、不增加 code_mode fallback。
- [x] 只有当非敏感现场证明某个应为 `codemode`/`deferred`/active `direct` 的工具未出现在 callable 集合时，才登记 production 修复输入；否则把“code_mode 不可发现 14 个 model-only 工具”定为预期合同。

**验收标准：**

- [x] 报告能从 Host callable 过滤一路追到 codemode discovery，并给出首个偏离点。
- [x] 报告明确区分“主模型可见”和“codemode 可调用”，不把 SDK `getAllTools()` 元数据视图当成 callable 视图。
- [x] 报告列出不需要修改的生产文件和明确禁止的 fallback 方案。
- [x] 若证据不足，记录最小补证字段，不读取完整 session/config/authority/state。

**建议验证（需要对应 Host/code_mode 运行授权）：**

- 使用一次短脚本分别观察 `ALL_TOOLS`、`searchTools("subagent")`、`describeTool("subagent_start")` 和 `tools.subagent_start(...)` 的非敏感结果。
- 记录同一运行中相关 14 项的 exposure/active/callable 三列投影；不保存 prompt、凭据或完整 session。

---

### Task 2：Agent Runtime 文本可达面与强制测试措辞审计

**Deps：** `T0`（理由：审计只针对当前 runtime 源和可发现 skill，不把历史文档或测试 fixture 的词语误判为注入规则）。

**WritePaths：**
- `docs/plans/records/2026-10-17-runtime-convergence/runtime-policy-audit.md`

**Resources：** `none`；只读搜索和上下文阅读。

**Files：**
- Create：`docs/plans/records/2026-10-17-runtime-convergence/runtime-policy-audit.md`
- Read：`pi/AGENTS_SHARED.md`、`pi/AGENTS_GLOBAL.md`、`AGENTS.md`、`pi/agents/*.md`、`skill-overrides/**`、`.pi/skills/**`、`packages/pi-subagents-enhanced/src/**`、`packages/pi-subagents-enhanced/extensions/**`、`pi/extensions/**`、`src/**`、skill source resolution 和 init 文档；补 Host 的 `dist/core/system-prompt.js`、skill/resource loader 与项目文档加载链。外部引用只读正文和非敏感源码，不扫 config、凭据、日志或完整 session。

**接口契约：**
- Consumes：runtime discovery 路径、system prompt、AGENTS、agent profile、skill正文、child boundary、tool description、extension guidance 和外部 skill symlink 的 realpath/source owner。
- Produces：`RuntimeTextHitV1` 列表，每项包含 `path`、`line`、`runtimeReachability`（A/B/C/D）、`forceLevel`、`sourceOwner`、`policyAction` 和保留/清理理由。

**实施方法：**

- [x] 首先保存已完成 reviewer run `16a20771-4a38-4636-be92-55bd31a4925a` 的报告原文与来源；以下扫描只补已有报告未覆盖的 runtime 加载链和之后的 delta。
- [x] 扫描 `TDD`、`test-driven`、`先写测试`、`编写测试`、`必须测试`、`MUST.*test`、`test first`、`RED/GREEN`、`REQUIRED SUB-SKILL`，并覆盖 `evaluation/evals`、pressure scenario、mandatory checklist 等不含 TDD 字样的同义要求；只扫描 Markdown/prompt 源码，不扫 credentials/config/logs/session。
- [x] 沿 SKILL.md 的正文引用读取 supporting references，包括 writing-skills 的 anthropic-best-practices、testing-skills、examples；区分“评估结果真实性”与“未经授权必须先创建评估”的语义，不能只移除 TDD 词便宣布所有强制测试清理完毕。Host 默认系统 prompt 和 loader 文本若出现同类规则，记录其 owner/版本；未获上游修改授权时不修改 node_modules。
- [x] 逐命中阅读上下文并分为：A 直接 runtime 规则；B skill/agent 被加载后可进入 runtime；C 仅历史、计划、测试、fixture、注释或 probe；D production tool description/runtime guidance。
- [x] 核对 `/Users/leshi.zhy/.agents/skills/<name>` 的 symlink 是否指向本仓 `skill-overrides`；独立外部目录按 T3E 的明确文本 WritePaths 清理，不将“非本仓 Git”机械解释成用户未授权。若目标来自不可写包缓存或第三方源文件，保留源 owner/realpath 证据并停止对应写入，不发布外部变更。
- [x] 对 `pi/AGENTS_SHARED.md`、`pi/AGENTS_GLOBAL.md` 提取所有测试/TDD政策，确定唯一全局约束落点。
- [x] 对 `skill-overrides/writing-skills`、`writing-plans`、`test-driven-development`、`.pi/skills/external-llm-review-provider` 和所有命中 skill 建立逐条清理清单。
- [x] 明确 `scripts/probes/**`、历史 `docs/**`、既有验收记录和测试用例中的描述是否不进入 runtime；不因关键词扫描而批量改写事实。

**验收标准：**

- [x] 每个 A/B/D 命中都有精确路径、行号、短摘录、可达链和处理动作。
- [x] C 类命中有排除理由，不能仅用“看起来像测试文案”排除。
- [x] 审计结果覆盖所有当前 runtime skill 源，而不是只检查 `writing-skills`。
- [x] 报告不读取 settings/models/auth/凭据/完整 session/authority/state，不运行真实 Host。

**建议验证：**

- `rg` 扫描结果保存为审计附录；命中计数仅作辅助，不替代上下文分类。
- `git diff --check` 只在审计记录写入后运行；不添加测试文件。

---

### Task 3：统一全局 prompt、计划和 skill 的测试授权政策

**Deps：** `T2`（理由：只修改 T2 判定为 runtime 可达且由本仓管理的命中；不扩大到历史文档或外部 owner 文件）。

**WritePaths：**
- `pi/AGENTS_SHARED.md`
- `pi/AGENTS_GLOBAL.md`
- `packages/pi-subagents-enhanced/AGENTS.md`
- `skill-overrides/writing-skills/**`
- `skill-overrides/writing-plans/SKILL.md`
- `skill-overrides/test-driven-development/**`
- `.pi/skills/external-llm-review-provider/SKILL.md`

**Resources：** `none`；纯文案和规则边界修改。

**Files：**
- Modify：`pi/AGENTS_SHARED.md` 的“测试与逻辑变更”段
- Modify：`pi/AGENTS_GLOBAL.md` 的派发格式、计划执行和 skill 注入段
- Modify：`packages/pi-subagents-enhanced/AGENTS.md:27` 的强制先跑命令句，保留验收 CLI 与 production coordinator 的职责边界
- Modify：`skill-overrides/writing-skills/SKILL.md`
- Modify：`skill-overrides/writing-skills/testing-skills-with-subagents.md`
- Modify：`skill-overrides/writing-skills/persuasion-principles.md`、`skill-overrides/writing-skills/anthropic-best-practices.md`、`skill-overrides/writing-skills/examples/CLAUDE_MD_TESTING.md`、`skill-overrides/writing-skills/graphviz-conventions.dot` 中被 T2 证明可再次注入执行规则的表述；只是历史例子的内容保留
- Modify：`skill-overrides/writing-plans/SKILL.md`
- Modify：`skill-overrides/test-driven-development/SKILL.md`、`skill-overrides/test-driven-development/writing-good-tests.md`
- Modify：`.pi/skills/external-llm-review-provider/SKILL.md`

**接口契约：**
- Consumes：T2 的 `RuntimeTextHitV1` 清理清单。
- Produces：统一的 `TestAuthorizationPolicyV1`：未授权时禁止 agent 主动新增测试；允许随已授权修复删改既有测试；计划任务只写“建议验证”；用户明确授权后才能把具体步骤改为“已授权”并执行。

**实施方法：**

- [x] `pi/AGENTS_SHARED.md` 中测试政策只保留“未经用户明确授权，agent 严禁主动新增测试”这一条行为约束；GLOBAL 删除 TDD 禁读/默认测试粒度/默认测试 acceptance 示例等重复语义。计划里“建议→已授权”的具体模板只放在 writing-plans/writing-skills，不往其它全局段落复制新的门禁。
- [x] GLOBAL 的示例 acceptance 改成可观察功能行为；任务预算只说明包含合同中实际存在的工作，不把测试预设为每次派发步骤。
- [x] package AGENTS 的“合同验证先运行”改成针对验收 CLI 的验证建议；保留 provenance、真实 child 和现场保护要求。根 AGENTS 的异常来源分类没有要求写测试，保持原规则，不为了关键词命中扩大修改。
- [x] 重写 `writing-plans` 的任务模板：新增测试任务使用“建议（待用户授权）”，授权后明确回填“已授权（范围）”；既有检查、类型检查与新测试编写分开列，不设固定 RED/GREEN 必做步骤。
- [x] 重写 `writing-skills`：删除“Skill 写作就是 TDD”、`REQUIRED BACKGROUND`、`REQUIRED SUB-SKILL`、`NO SKILL WITHOUT A FAILING TEST FIRST` 和无条件 RED/GREEN 流程；改成可选的“行为验证建议”，仅在用户授权后执行压力场景或测试编写。
- [x] 重写 `testing-skills-with-subagents.md` 和 `writing-good-tests.md` 中的强制流程，使其成为用户明确授权测试/TDD时的参考材料；不保留绕过用户授权、把测试编写设为交付前提的句子。仅参考资料读取不等于授权新增或执行压力测试。
- [x] 修改 `test-driven-development/SKILL.md` frontmatter 触发条件：只有用户明确要求 TDD/补测试时适用；正文保留的方法步骤全部带授权前提，不再作为所有代码变更的默认规则。
- [x] 将 `.pi/skills/external-llm-review-provider/SKILL.md` 中“先写两个测试”“测试必须覆盖”“RED/GREEN”等强制句改为授权后的建议验证，并保留 provider 安全和非敏感配置边界。
- [x] 不为历史计划、旧 review、旧 acceptance 记录做措辞清洗；这些文件不进入当前 agent runtime，且需要保留历史事实。

**验收标准：**

- [x] 全局规则只剩一条测试写作授权门禁，没有“任何情况下必须 TDD”或“每个实现必须先写测试”的更高强制规则。
- [x] `writing-plans` 的测试任务可作为建议出现在计划中，但没有用户授权标记时不得成为执行步骤。
- [x] `writing-skills` 不再要求读取 TDD skill、运行 RED baseline 或完成 RED/GREEN/REFACTOR 才能交付 skill。
- [x] 用户若明确授权某项 TDD/测试工作，仍能从相应 skill 获得方法参考，但授权范围之外不会扩散。
- [x] 本仓 managed skill symlink 仍指向同一 override；T3E 单独处理独立全局 skill，不能只改本仓三份文件便宣称全部 runtime 文本完成。

**建议验证（新增测试须取得对应授权；既有测试可同步删改）：**

- `rg -n` 扫描 runtime-owned paths，确认强制性命中只剩授权条件句。
- 使用已有 skill discovery/loader 的静态检查确认 `~/.agents/skills/writing-skills`、`writing-plans`、`test-driven-development` 指向仓库 override；不读取凭据。

---

### Task 3E：清理独立全局 skill 中的 TDD/测试强制句

**Deps：** `T2`（理由：使用 reviewer 已发现的三个独立目录及 runtime 可达链，不用本仓 symlink 修改冒充外部 skill 已清理）。

**Dispatch Cwd：** `/Users/leshi.zhy/.agents`。本节点使用单独的 `worktree:false` 合同；WritePaths 按该目录相对路径填写，不能把仓外绝对路径塞到本仓 typed WritePaths。

**WritePaths：**
- `skills/managing-megability-ability-idl/SKILL.md`
- `skills/managing-taobao-ios-whale-modules/SKILL.md`
- `skills/mtl-taobao-ios-dependency-debugging/SKILL.md`

**Resources：** 本机个人 skill 文本；不改其 config、脚本、credentials、tests 或第三方包缓存。

**Files：**
- Modify：`/Users/leshi.zhy/.agents/skills/managing-megability-ability-idl/SKILL.md:12`
- Modify：`/Users/leshi.zhy/.agents/skills/managing-taobao-ios-whale-modules/SKILL.md:26`
- Modify：`/Users/leshi.zhy/.agents/skills/mtl-taobao-ios-dependency-debugging/SKILL.md:99`

**接口契约：**
- Consumes：T2 的外部 owner/realpath、前置 TDD 和真实 device test 硬要求短摘录。
- Produces：三个本机可发现 skill 的功能指导保留，强制加载 TDD、RED/GREEN 和未经授权 device test 门禁改为建议；若用户明确请求真实测试，则原测试结果判定仍真实，零执行/skip 不冒充通过。

**步骤与验收：**

- [x] 只读确认三条路径为可编辑的本机个人文本及各自 Git/包 owner；先比对 dirty，不能覆盖用户已有改动。
- [x] 删除强制 `REQUIRED SUB-SKILL: test-driven-development` 前置条件和“改动必先 RED”句；保持 IDL 输入、Whale 版本和依赖选择的业务规则。
- [x] 将依赖排查自动启动 device test 的要求改为“建议（待用户授权）”；不得修改测试结果真实性标准，不把零执行写成通过。
- [x] 对这三个 skill 做定向文本核对；不发布、不同步到外部仓库、不扩大到其他产品配置。
- [x] 若 T2 增量审计在其他独立正文发现相同命中，主会话先将其精确路径回填本节点再派发，不能把所有 `~/.agents/**` 授予任意改写。

**授权与验证：** 用户已授权所有 runtime 可达文本的强制测试清理；本节点不编写测试。若目录不支持本次 harness 的精确 coding 合同，报告该实际限制，不把读取权限当写入权限，也不绕到未声明路径。

---

### Task 4：清理 coding runtime 验收证据中的默认测试暗示

**Deps：** `T2`（理由：审计 D1 已证明 coding workflow 固定携带 `tests-added`，但未证明它硬拒无测试任务；只修固定文本期待，不扩大为新的技术门禁）。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `docs/plans/records/2026-10-17-runtime-convergence/runtime-evidence-policy.md`

**Resources：** `none`；同文件其它修复使用隔离 worktree/串行集成，不覆盖彼此 diff。

**Files：**
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:591` 的 `CODING_ACCEPTANCE_EVIDENCE`
- Create：`docs/plans/records/2026-10-17-runtime-convergence/runtime-evidence-policy.md`
- Read：`workflow-spawn.ts`、`child-extensions/acceptance-evidence.ts` 和已有 operation-tool descriptors/agent profiles

**接口契约：**
- Consumes：T2 D1 的证据；现有 acceptance evidence 是描述数组，child 工具仍接收 `outcome/criteria/commandsRun/changedFiles`。
- Produces：默认 coding evidence 列表移除 `tests-added`，保留 changed-files、commands-run、validation-output、residual-risks、no-staged-files；不新增 tests-not-added、测试授权字段或通用 runtime 阻断器。

**实施方法：**

- [x] 逐调用方确认该 evidence 数组用于注入指导，移除唯一的 `tests-added` 默认标签；不要将测试是否编写变成 typed 输入必填项。
- [x] 保留 `acceptance.criteria`、`writePaths`、模型准入、owner/CAS、exposure、child tool schema、raw details 和公共返回值。
- [x] 记录 `pi/agents/delegate.md` 的“聚焦验证”、bash_async 的长时任务例子、tool schema 中通用 acceptance 均不是强制写测试，不无故改色或扩宽源码 WritePaths。
- [x] 若已有精确测试断言依赖默认 `tests-added` 列表，记录差异并将断言修订列为建议，用户授权后再修改，不能放回标签或忽略失败冒充通过。

**验收标准：**

- [x] 未授权 coding dispatch 的默认提示不暗示必须新增测试；不创建新技术执行门禁。
- [x] task criteria、所有 tool schema/exposure/权限和 receipt/raw details 保持现行合同。
- [x] 所有未改源文件及其保留理由落在新 evidence-policy 记录中。

**验证：** 静态核对数组调用链，运行 root/package 既有类型检查和已审计的纯合同检查；本任务不自动编写测试。

---

### Task 5：修复 Supervisor reply guard v2 持久化与清理前缀不对称

**Deps：** `T0`（理由：当前源码证据已足够定位，不依赖 clear/inspect upstream 能力）。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts`
- `test/supervisor-gate-wire.test.mjs`（既有测试可同步删改；新增测试须明确授权）

**Resources：** `none`；只使用临时 persistence root，不读取用户 state。

**Files：**
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts:217-251`
- Existing Test Modify：`test/supervisor-gate-wire.test.mjs:59-78` 附近的 fresh persistence/reload fixture

**接口契约：**
- Consumes：现有 `replyPayloadGuardKey()` 生成的 `supervisor-reply-guard.v2:<root>:<run>:<ownerGeneration>:<childIndex>:<payloadDigest>`，以及旧 `${root}:...` v1 key。
- Produces：`saveRoot(root)` 和 `transaction(root, ...)` 在锁内重载前对 v1/v2 guard 使用相同 root 归属判断；fresh plane 保留 v2 guard，事务不会沿用上一快照的本 root 内存 guard。

**实施方法：**

- [x] 将 `saveRoot()` 的 `replyPayloads` 过滤条件从仅 `payload.startsWith(`${root}:`)` 改为同时接受旧 v1 root 前缀和 `supervisor-reply-guard.v2:${root}:` 前缀。
- [x] 同步 `transaction(root, ...)` 锁内重载前的本 root 内存失效判断，使 v2 guard 和 v1 一样先从旧内存快照剔除，再由 `loadRoot()` 读取权威值；这不是关闭 root 时删除 durable guard，不增设生命周期清理语义。
- [x] 保持 `parseStoredState()` 已有的 v1/v2 严格 schema、digest 和 root 校验，不放宽未知 key。
- [x] 复用现有 `supervisor-gate-wire` 的 public register/commit 流程；不直接拼内存 Map，不增加 fallback。

**验收标准：**

- [x] 含 correlation/childIndex 的 `reply` 提交后，持久化 JSON 的 `replyPayloads` 包含 v2 guard key。
- [x] 新建 fresh plane 后 v2 guard 仍存在；重复正文 steer 仍拒绝为 `STEER_DUPLICATES_REPLY`，同一 reply 重交仍按现有 receipt 合同返回幂等，不强改其错误码。receipt 已有第一道防线，不能仅凭该场景仍拒绝证明 guard 已持久化。
- [x] 旧 v1 key 仍可读取；不同 root、run、ownerGeneration、childIndex 的 guard 不互相命中。
- [x] 新事务先清除本 root 的旧内存 guard，再重载文件，其他 root 不动；不删除权威存储里的历史去重事实。
- [x] 无 clear/inspect、无 owner scope 放宽、无跨 root 读取。

**建议验证（新增 reload 测试必须用户明确授权）：**

- 既有：`node --test test/supervisor-gate-wire.test.mjs test/supervisor-consumption.test.mjs`。
- 建议新增一个 `persistenceRoot` fixture：`commitDelivery({ intent: reply, consumed: true })` → 读取文件 → fresh plane → 重复 `resolveSupervisorControl()`，断言 duplicate code 和 guard key。
- `npm_config_registry=https://registry.npmjs.org/ npm_config_offline=true npm run typecheck` 与 `git diff --check`。

---

### Task 6：Operation tools 与 Supervisor gate 文档证据收口

**Deps：** `T5`（理由：文档必须反映 M1 的最终实现状态，并保留 C1/C2/C3 blocked）。

**WritePaths：**
- `docs/plans/records/2026-10-16-operation-tools/acceptance.md`
- `docs/plans/2026-10-15-supervisor-gate-recovery.md`
- `docs/architecture/supervisor-gate-recovery.md`
- `docs/plans/records/2026-10-17-runtime-convergence/evidence-reconciliation.md`

**Resources：** `none`；只读既有命令/日志证据，不重跑长时任务。

**Files：**
- Modify：`docs/plans/records/2026-10-16-operation-tools/acceptance.md`
- Modify：`docs/plans/2026-10-15-supervisor-gate-recovery.md` 的 B/G0/G1/G2/V/Z 状态说明
- Create：`docs/architecture/supervisor-gate-recovery.md`
- Create：`docs/plans/records/2026-10-17-runtime-convergence/evidence-reconciliation.md`，记录 M1–M9 的处理、H1-key 和历史精确命令的已知/缺失，不篡改原 closeout 结果
**接口契约：**
- Consumes：S6 的实际 24 个文件、492/492 结果、typecheck/offline verify/synthetic probe 记录；Supervisor G0/G1/G2/G2-wire evidence；T5 的 M1 结果。
- Produces：文档能区分 `gate-fixed`、`clear-verified`、`blocked-upstream`、`synthetic-only` 和 `not-run`，不把文档补齐写成 clear 完成。

**实施方法：**

- [x] 从既有最终命令或记录核对 S6 的 24 个准确测试文件，补入 acceptance；不修改历史 492/492 数字，不用重新组合运行去猜原文件清单。若原命令已无法取得，保留历史报告值并显式写明精确清单缺失。
- [x] 为 reviewer M9 的 H1-key `111/111` 追加证据追踪说明，引用 `110cc0e` 和现有状态表；精确命令未找到就标缺失，不篡改 closeout 历史，也不强制重跑伪补历史命令。
- [x] 让 Supervisor 计划复选框与实际 B/G0/G1/G2/G2-wire 证据一致；C1/C2/C3 保持未完成和 blocked-upstream。
- [x] 新建架构说明，固定 child identity、queued 与 consumed 分离、v1/v2 migration、reply guard namespace、clear/inspect 的 absence 边界、fresh Host 要求和禁止 fallback。
- [x] 在架构/对账记录显式保留 M4：缺可信 child correlation 时 scope-unverified 可能扩大同 run steer 阻断；inspect 仍不可用，现行 fail-closed 不变。将正常 child 级 gate 已修与该未知 scope 边界分开，不新增“忽略旧 pending”的门禁放宽。
- [x] 在文档中引用 M1 的 v2 persistence guard，而不复制实现代码。

**验收标准：**

- [x] S6 acceptance 可由 reviewer 仅凭文件清单和既有证据复核。
- [x] 计划复选框、架构说明、acceptance 和当前遗留账本对 G1/G2 一致。
- [x] 所有 clear/inspect 缺口仍明确为未实现，未出现空壳工具或“清理已完成”措辞。
- [x] 文档没有重写历史用户 incident，也没有读取完整用户状态。

**建议验证：**

- `git diff --check -- docs/plans/records/2026-10-16-operation-tools/acceptance.md docs/plans/2026-10-15-supervisor-gate-recovery.md docs/architecture/supervisor-gate-recovery.md`。
- 使用现有 acceptance 的命令行逐项对照，不新增测试。

---

### Task 7：真实 integration fixture 旧工具名 inventory 与分类

**Deps：** `T0`（理由：沿用当前 fresh Host/compat probe 证据边界；先分类再修改调用者）。

**WritePaths：**
- `docs/plans/records/2026-10-17-runtime-convergence/fixture-inventory.md`

**Resources：** `none`；只读 `rg` 和 fixture 上下文。

**Files：**
- Create：`docs/plans/records/2026-10-17-runtime-convergence/fixture-inventory.md`
- Read：
  - `test/fixtures/deterministic-provider-state.mjs`
  - `test/fixtures/heartbeat-parent-host.ts`
  - `test/fixtures/heartbeat-provider.ts`
  - `test/fixtures/joint-upgrade/contact-provider.mjs`
  - `test/fixtures/recovery-resume/scripted-model-server.mjs`
  - `test/fixtures/repository-merge-queue-acceptance/root-provider.mjs`
  - `test/heartbeat-parent-death.integration.mjs`
  - `test/joint-upgrade-contact-supervisor.integration.mjs`
  - `test/pi-runtime.integration.mjs`
  - `test/pi-subagents-project-workflow.integration.mjs`
  - `test/pi-subagents-runtime.integration.mjs`
  - `test/subagent-completion-notification.integration.mjs`
  - `test/subagent-steer-text-insertion.integration.mjs`
  - `test/subagent-managed-worktree.integration.mjs`
  - `test/subagent-acceptance-evidence.integration.mjs`
- Scan：所有现有 `test/*.integration.mjs`、`test/*.e2e.mjs` 及其 provider/helper，用工具名和 `tools[n]` 定位；上述清单是已知命中起点，新增命中须由本任务逐条记录。
**接口契约：**
- Consumes：旧 `subagent`、`subagent_worktree`、`subagent_supervisor` 名称、`setActiveTools()`、tool array position 和旧 action union 参数的所有命中。
- Produces：`FixtureToolMigrationInventoryV1`，每项标记 `fresh-host-caller`、`upstream-compat-probe`、`historical-only`、`position-coupled`，并给出新工具映射和是否保留旧名。

**实施方法：**

- [x] 区分 fresh Host 应消费的新工具：`subagent_start`、`subagent_run_*`、`managed_workspace_*`、`supervisor_request_*`。
- [x] 找出 provider 根据 `toolName` 或 tool array position 推进状态的逻辑，记录状态机前置条件和终止条件。
- [x] 识别明确测试 upstream compatibility 的旧名注册/观察，例如手动注册 `subagent_supervisor` 的 synthetic fixture；这类命中不直接迁移。
- [x] 对每个文件写出最小修改范围、对应 integration 命令和不应修改的历史/兼容断言。

**验收标准：**

- [x] 所有当前 `rg` 命中都有归类，没有“剩余命中但未知用途”。
- [x] inventory 能直接作为 T8/T9 的输入，不要求执行者重新猜测工具映射。
- [x] 不修改 fixture、生产代码或历史记录。

**建议验证：**

- `rg -n -i 'subagent_supervisor|subagent_worktree|toolName.*subagent|setActiveTools'` 只用于建立 inventory，不把命中数当作迁移完成证明。

---

### Task 8：迁移 active fixture 的新 operation tool 调用

**Deps：** `T7`（理由：只消费 inventory 标为 fresh-host-caller 的文件）。

**WritePaths：**
- `test/fixtures/deterministic-provider-state.mjs`
- `test/fixtures/heartbeat-parent-host.ts`
- `test/fixtures/heartbeat-provider.ts`
- `test/fixtures/joint-upgrade/contact-provider.mjs`
- `test/fixtures/recovery-resume/scripted-model-server.mjs`
- `test/fixtures/repository-merge-queue-acceptance/root-provider.mjs`
- `test/pi-subagents-project-workflow.integration.mjs`
- `test/subagent-completion-notification.integration.mjs`
- `test/subagent-steer-text-insertion.integration.mjs`
- `test/subagent-managed-worktree.integration.mjs`
- `test/subagent-acceptance-evidence.integration.mjs`

**授权状态：** 本节点是“建议（待用户授权）”的测试/fixture 行为迁移；不得因选择执行本计划自动回填“已授权”。

**Resources：** `none`；不运行 SIGKILL，不连接真实 provider。

**Files：**
- Modify：T7 明确列为 `fresh-host-caller` 的 fixture 和 caller 文件
- Test：同文件既有 integration 入口；不新建测试文件

**接口契约：**
- Consumes：T7 的 tool mapping 和 state transition inventory。
- Produces：active fixture 通过当前 14 项 operation tool names/argument shapes 驱动，不依赖旧 union action 字段或固定 `tools[n]` 位置。

**实施方法：**

- [x] 按独立调用链分组派发，每组只携带 T7 冻结的精确文件及本组验收：① deterministic/contact supervisor；② heartbeat 正常路径；③ recovery/merge-queue provider 与 project caller；④ managed-worktree/acceptance-evidence 位置依赖；⑤ completion/steer caller。各组有自己的记录和既有验证命令，不将全部文件打包成一次大派发。T8 完成表示所有获授权组均有结果，未授权组保留 blocked-authorization，不冒称迁移通过。
- [x] 将 dispatch 调用映射到 `subagent_start`，并保留完整 typed dispatch 合同字段。
- [x] 将 run control 映射到对应 `subagent_run_status`、`subagent_run_steer`、`subagent_run_interrupt`、`subagent_run_resume`、`subagent_run_stop`，每个工具只传固定 schema，不传旧 `action`。
- [x] 将 workspace 操作映射到 `managed_workspace_list/status/dispose/release`，由回执中的 `allowed_dispositions` 和一次性 token 驱动，不猜 owner/root。
- [x] 将 supervisor pending/status/reply 映射到 `supervisor_request_pending/status/reply`，保留 `replyTo`/`message` required contract 和 queued/consumed distinction。
- [x] 同时消除 `test/subagent-managed-worktree.integration.mjs` 的 workspace `tools[1]` 和 `test/subagent-acceptance-evidence.integration.mjs` 的 start `pi.tools[0]` 依赖；按名称取当前独立工具，保留服务级 owner、token、child-owned 和 released 断言。
- [x] 用工具名查找替代其它 `tools[n]` 位置依赖；若 fixture 仍需覆盖 upstream 旧名，转入 T9，不在本任务混用。

**验收标准：**

- [x] fresh Host fixture 不再使用旧 union action 调用。
- [x] fixture 的状态推进、失败重试、终局判断和 raw result 投影保持原语义。
- [x] 未新增 production compatibility branch，未改变 tool schema/exposure。
- [x] 任何无法映射的旧调用被记录为 T9 的兼容 probe，而不是静默删除。

**建议验证（修改 fixture/test 文件必须用户明确授权）：**

- `node --test test/pi-subagents-project-workflow.integration.mjs test/subagent-completion-notification.integration.mjs test/subagent-steer-text-insertion.integration.mjs`，只在副作用审计后按对应组执行。
- 位置依赖组：`node --test test/subagent-managed-worktree.integration.mjs test/subagent-acceptance-evidence.integration.mjs`；不在真实 managed evidence roots 运行。
- heartbeat fixture 只跑不含 parent SIGKILL 的正常路径；危险实验另走 T14 授权门。

---

### Task 9：收口 upstream compatibility probe 与旧工具名兼容边界

**Deps：** `T7`（理由：只消费 inventory 标为 `upstream-compat-probe` 或 `historical-only` 的命中）。

**WritePaths：**
- `test/fixtures/deterministic-provider-state.mjs`
- `test/fixtures/joint-upgrade/contact-provider.mjs`
- `test/joint-upgrade-contact-supervisor.integration.mjs`
- `test/pi-runtime.integration.mjs`
- `test/pi-subagents-runtime.integration.mjs`
- `docs/plans/records/2026-10-17-runtime-convergence/fixture-inventory.md`

**Resources：** `none`；不运行网络或 provider。

**Files：**
- Modify：T7 标为兼容 probe 的精确 fixture/caller
- Test：同一组既有 integration 文件，仅在授权后修改断言或工具调用

**接口契约：**
- Consumes：T7 的 compatibility classification、fresh Host 14-tool contract、upstream old-name membrane contract。
- Produces：兼容 probe 明确写出它在测试 upstream/legacy boundary，fresh Host assertions 不再把旧名当作当前模型工具面。

**实施方法：**

- [x] 保留只为验证 upstream `subagent_supervisor` capture/membrane 的旧名 fixture，但在 fixture 注释和 acceptance 中标明 test-manufactured 数据来源。
- [x] 更新 `pi-runtime.integration.mjs`、`pi-subagents-runtime.integration.mjs` 中关于 fresh Host active tools 的断言，使其与当前 14 项 model-only contract 一致；若某断言实际验证上游 compatibility，则保留并明确对象。
- [x] 删除不再代表当前 production 的 `setActiveTools(["subagent", ...])` 仅为位置驱动的调用；保留必要的 legacy adapter probe。
- [x] 检查旧名、旧 schema 和新独立工具是否在同一个 fixture 状态机中互相污染；必要时将 fixture 分成 fresh/legacy 两个明确分支。

**验收标准：**

- [x] fresh Host 断言与 `operation-tools` 14 项列表一致。
- [x] legacy probe 的旧名只出现在明确的 upstream compatibility 语境，并有 source classification。
- [x] 不把旧 fixture 的绿色结果宣称为真实用户 Host/provider 兼容。
- [x] `tools[n]` 位置依赖在 active fresh path 清零，残留位置依赖有清单和理由。

**建议验证（修改 fixture/test 文件必须用户明确授权）：**

- `node --test test/pi-runtime.integration.mjs test/pi-subagents-runtime.integration.mjs test/joint-upgrade-contact-supervisor.integration.mjs`。
- 对每个失败先记录入口、identity、event/tool 顺序，再决定只修 fixture 还是生产代码。

---

### Task 10：resource-isolation 既有失败来源分类

**Deps：** `T0`（理由：使用基线和当前 production description 事实，避免因单项红测直接改资源隔离逻辑）。

**WritePaths：**
- `docs/plans/records/2026-10-17-runtime-convergence/resource-isolation-provenance.md`
- `test/subagent-runtime-resource-isolation.test.mjs`（仅在用户授权修订陈旧测试合同后写入）

**Resources：** `none`；只读复现与 source comparison，禁止扩大资源隔离能力。

**Files：**
- Create：`docs/plans/records/2026-10-17-runtime-convergence/resource-isolation-provenance.md`
- Read：`test/subagent-runtime-resource-isolation.test.mjs`、当前 `TYPED_SUBAGENT_DESCRIPTION` 定义和 HEAD 对照证据
- Suggested Modify：`test/subagent-runtime-resource-isolation.test.mjs`

**接口契约：**
- Consumes：失败断言的实际 expected text、当前 production description、测试入口和 identity/顺序。
- Produces：`ProvenanceClassification` 为 `test-manufactured` 或 `production`，并给出最小处置。

**实施方法：**

- [x] 精确定位失败断言是否仍匹配旧英文 description，确认 production 当前描述是否已按现行中文合同改变。
- [x] 核对失败是否由合法 public Host/tool 入口产生，还是 fixture 直接构造了旧 description/缺字段对象。
- [x] 若为陈旧测试合同，只在用户授权后更新 expected 到当前公开 description，并记录不改 production。
- [x] 若 provenance 不能证明，保留失败现场，不增加 fallback，不放宽 resource isolation。

**验收标准：**

- [x] 报告含首个偏离点、调用链、身份、资源顺序和与 production 的差异。
- [x] 不把 HEAD 对照副本同样失败直接当作 production 根因证明。
- [x] 生产资源隔离逻辑没有因本任务变更。

**建议验证（测试修改需授权）：**

- 现有定向测试命令：`node --test test/subagent-runtime-resource-isolation.test.mjs`。
- 若只改断言，记录测试合同修订而非新增行为保证。

---

### Task 11：ceiling-runtime 三项失败来源分类

**Deps：** `T0`（理由：失败属于既有基线，先独立分类，不与 operation tools 迁移混合）。

**WritePaths：**
- `docs/plans/records/2026-10-17-runtime-convergence/ceiling-runtime-provenance.md`

**Resources：** `none`；静态入口和既有 fixture 对照。

**Files：**
- Create：`docs/plans/records/2026-10-17-runtime-convergence/ceiling-runtime-provenance.md`
- Read：`test/joint-upgrade-ceiling-runtime.test.mjs`、`packages/pi-subagents-enhanced/src/subagent-dispatch/child-tool-policy.ts`、`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`、相关 fixture/acceptance 记录

**接口契约：**
- Consumes：三项失败的 exact assertion、child ceiling 注册/startup/drain 入口、HEAD 对照副本结果。
- Produces：每一项的 `production`、`test-manufactured` 或 `unconfirmed` 分类和下一步 owner。

**实施方法：**

- [x] 对 ceiling 未注册、startup 未失败、drain 观察三项分别追踪到真实 public entry、child identity、event/resource order。
- [x] 区分 child early-return、configured capability ceiling、fresh Host physical dependency 和 fixture startup timing。
- [x] 禁止在本任务修改 capability ceiling、child permission 或 startup rollback；只有分类结果明确为本仓 production bug 时，另开最小修复任务。
- [x] 将 HEAD 对照失败仅作为线索，不作为单独证明。

**验收标准：**

- [x] 三项失败分别有首个偏离点和来源分类。
- [x] 报告明确哪些项可由合法 production 入口产生，哪些只能由 fixture 制造。
- [x] 没有新增兼容分支或放宽 child capability。

**建议验证：**

- 先审计既有定向命令副作用；已授权诊断范围内的纯既有检查和静态检查可执行，不为它们笼统新增审批门。测试编写与额外真实 Host/provider/危险进程实验分别按对应授权。
- 若需要真实 child Host/启动顺序，单独申请 fresh Host 资源，不在本任务隐式执行。

---

### Task 12：scheduler store/lock 并发问题来源分类与最小修复决策

**Deps：** `T0`（理由：scheduler observer 已通过不等于共享 store/lock 正确，必须独立追踪 public mutation 和跨 Host 事实）。

**WritePaths：**
- `docs/plans/records/2026-10-17-runtime-convergence/scheduler-provenance.md`

**Resources：** 静态阶段 `none`；真实共享 store/lock 竞争验证需单独资源窗口。

**Files：**
- Create：`docs/plans/records/2026-10-17-runtime-convergence/scheduler-provenance.md`
- Read：`src/task-scheduler/adapter.ts`、`src/task-scheduler/index.ts`、`src/task-scheduler/activity-source.ts`、既有 scheduler bug/acceptance 记录
- 本探索不写 production/test；证明为本仓缺陷后先产报告，由主会话增加独立修复节点，不能在同一派发中边归因边放宽行为。

**接口契约：**
- Consumes：真实 public task ID、store revision、lock owner、Host identity、mutation/read 顺序和 adapter observer projection。
- Produces：`SchedulerConcurrencyDispositionV1`：`local-production-defect`、`upstream-defect`、`fixture-defect` 或 `blocked-evidence`。

**实施方法：**

- [x] 先证明正常 public create/update/delete/runNow 的权威 task ID 和共享 store 路径。
- [x] 分离 observer 的只读 snapshot、TUI freshness 和跨 Host store/lock 互斥，不用 footer 绿色销账。
- [x] 记录首个 revision/lock 偏离点；若上游负责，保留 fail-closed 结果并写清上游接口缺口。
- [x] 若本仓 adapter 只负责 projection，则不改 production；若本仓确实丢失 revision/lock 事实，输出精确 owner 和最小修复建议，另派修复，不新增调度状态机。

**验收标准：**

- [x] 不把单 Host observer 通过写成跨 Host concurrency 通过。
- [x] 生产/fixture/upstream 分类证据完整，未证实时保持 blocked。
- [x] 任何修复都只改变首个偏离点，不扩大 scheduler adapter 权限。

**建议验证（真实并发需授权）：**

- 既有 scheduler unit/adapter 命令。
- 受控双 Host concurrency probe：同一 task ID、独立 Host identity、共享 store、记录 lock/revision 事件；不启动常驻 daemon。

---

### Task 13：历史 RPC/Supervisor 个案取证与 clear blocked 收口

**Deps：** `T6`（理由：使用已实现 D0–D3/G1/G2 的安全投影和最新文档；不把 gate 修复冒充历史 incident 已归因）。

**WritePaths：**
- `docs/plans/records/2026-10-17-runtime-convergence/historical-provenance.md`

**Resources：** 仅已有非敏感 diagnostics；不读取完整 session/authority/state。

**Files：**
- Create：`docs/plans/records/2026-10-17-runtime-convergence/historical-provenance.md`
- Read：两份当前遗留账本，状态更新集中到 T17，避免并行写同一账本
- Read：`docs/bugs/2026-10-10-rpc-session-capability-negotiation.md`、`docs/bugs/2026-10-10-supervisor-reply-required-state-views.md`、`docs/plans/records/2026-10-15-runtime-closeout/rpc-diagnostics.md`、`supervisor-diagnostics.md`、Supervisor contract/acceptance

**接口契约：**
- Consumes：RPC 的 `code/stage/missingCapabilities/cwd/worktree/version` 非敏感投影；Supervisor 的 `runId/requestId/index/ownerGeneration/registration/reply/steer/consumption` 时序；C1/C2/C3 absence/owner 合同。
- Produces：每个历史个案的 `production`、`test-manufactured` 或 `unconfirmed` 分类；clear/inspect 状态保持 `blocked-upstream`，并记录解阻条件。

**实施方法：**

- [x] 只通过已有诊断入口取得字段级证据；字段缺失记录为未知，不用 pending 空数组、reply 成功或 attention 通知猜消费事实。
- [x] 画出每个个案的发送前、登记、回执、消费和失败顺序，标出第一个缺失或矛盾事实。
- [x] 显式记录 M4 的 scope-unverified steer 阻断范围和 inspect 缺失张力：本轮保留 fail-closed，不把历史个案取证结果当作放宽所有 child gate 的理由。
- [x] 对 clear/inspect 继续保留：没有 exact absence/root ownership 时不签 challenge、不删除 request、不加 force/bulk fallback。
- [x] 在本任务报告中给出当前账本的状态更新材料和解阻条件，由 T17 统一回填；不重写旧 bug 记录，不把 G1/G2 变成 C1/C2/C3 完成。

**验收标准：**

- [x] RPC/Supervisor 历史个案有最小非敏感证据链或明确 `blocked-evidence`。
- [x] clear/inspect 的 blocked 原因能被 reviewer 从 contract、source 和 acceptance 交叉复核。
- [x] 当前账本没有把“待取证”与“未实现生产修复”混写。

**建议验证：**

- 只运行已有诊断命令；不得访问完整真实 session、authority、state 或凭据。
- 若上游提供新的 typed absence/root 字段，先更新 contract，再另开 C1/C2/C3 实现任务。

---

### Task 14：heartbeat 覆盖、正常 fixture 结算和旧 evidence root 边界

**Deps：** `T0`（理由：历史 H2 只证明 managed coding + worktree:true，不能外推其它拓扑，也不能继承旧 SIGKILL 授权）。

**WritePaths：**
- `docs/plans/records/2026-10-17-runtime-convergence/heartbeat-session-owner-boundary.md`
- `test/fixtures/heartbeat-provider.ts`（仅在用户授权修订 fixture 后）
- `test/fixtures/heartbeat-parent-host.ts`（仅在用户授权修订 fixture 后）

**Resources：** heartbeat lease/fixture；SIGKILL、真实 child、旧 workspace 处置均需单独用户授权。

**Files：**
- Create：`docs/plans/records/2026-10-17-runtime-convergence/heartbeat-session-owner-boundary.md`
- Read：`docs/plans/records/2026-10-13-heartbeat-acceptance.md`、`docs/plans/records/2026-10-13-heartbeat-experiment.md`、`test/fixtures/heartbeat-parent-host.ts`、`test/fixtures/heartbeat-provider.ts`、现有 H2 证据
- Suggested Modify：`test/fixtures/heartbeat-provider.ts` 中 `commandsRun: []` 的正常 child 报告，仅作为 fixture-only 修订

**接口契约：**
- Consumes：managed coding + worktree:true 的已证 lease/heartbeat 顺序、generic/binding-failed/detached/bash descendant/multi-child 的未证边界、四个 active evidence root 和一个 released evidence root 的当前状态。
- Produces：`HeartbeatCoverageDispositionV1`，分别记录 `verified`、`coverage-unverified`、`blocked-recovery`、`fixture-followup`。

**实施方法：**

- [x] 固定已证范围：父死后 managed coding + worktree:true child 在 lease 到期附近自退出；不外推 generic、binding-failed、detached、bash 后代、多 child 或更长续租。
- [x] 对正常 fixture 的 `commandsRun: []` 追踪实际报告生成入口；若是 fixture 缺失字段，只改 fixture，不补 production 伪证据。
- [x] 对旧 active evidence root 只通过合法 public owner/workspace 处置出口探测；找不到当前 owner/token 时保持现场，不 raw 删除 workspace、branch、socket 或台账。
- [x] 将旧 SIGKILL 结果标为历史证据，不继承给新拓扑实验。

**验收标准：**

- [x] 每种拓扑有单独状态，不出现“heartbeat 全覆盖”概括。
- [x] fixture 报告中的命令证据可追到合法执行入口；不能证明时保留 blocked。
- [x] 旧 evidence root 没有未经 public API 的删除或猜 token 操作。

**建议验证（fixture 修改或危险实验需授权）：**

- 正常 heartbeat fixture 的既有类型/身份检查可在已授权诊断范围内按副作用审计后运行；既有 fixture 可同步修改，新增测试才需要明确授权。
- generic/binding-failed/detached/multi-child/parent SIGKILL 实验必须单独列出资源、超时、清理和停止条件；不得用后台 sleep 或常驻 daemon 等待。

---

### Task 15：session-owner 剩余验证边界

**Deps：** `T0`（理由：当前 P2/P3/非 PTY 已有证据，剩余项只补真实 open failure 和跨进程竞争，不扩大独占承诺）。

**WritePaths：**
- `docs/plans/records/2026-10-17-runtime-convergence/session-owner-boundary.md`
- `test/session-owner-runtime.integration.mjs`（仅在用户授权真实 Host/CLI/PTY 后）
- `test/session-owner-extension.integration.mjs`（仅在用户授权真实 Host/CLI/PTY 后）

**Resources：** fresh Host、visible CLI/PTY、跨进程同目标竞争窗口；需单独授权，最多一个独占窗口。

**Files：**
- Create：`docs/plans/records/2026-10-17-runtime-convergence/session-owner-boundary.md`
- Read：`docs/plans/records/2026-10-13-session-owner-acceptance.md`、`docs/plans/records/2026-10-15-runtime-closeout/owner-cli.md`、`owner-esrch.md`、`owner-harness.md`
- Existing Test Modify：两个 session-owner integration 文件，仅在授权后补真实 open failure/跨进程竞争证据

**接口契约：**
- Consumes：现有 CLI 5/5、P3 reap/ESRCH、非 PTY 8/8 证据；剩余真实 `SessionManager.open` failure 和跨进程同 target 竞争入口。
- Produces：`SessionOwnerCoverageDispositionV1`，不扩展到受控 launcher 之外的全量 CLI/SDK/RPC 独占保证。

**实施方法：**

- [x] 明确现有通过证据和未覆盖边界，避免重复验证已关闭项。
- [x] 先静态确认真实 open failure 的合法触发入口和可观测字段，再决定是否需要 fresh Host 实验。
- [x] 若授权真实实验，分别记录 process identity、owner record、claim/release 顺序和失败首点；不得把同 PID 串行 claim 当跨进程竞争。
- [x] 外部 import 目标无 header 的路径继续 `blocked-upstream/fail-closed`，不加隐式支持。

**验收标准：**

- [x] 真实 open failure 与跨进程竞争分别有证据或明确 blocked，不用既有同 PID 结果替代。
- [x] session-owner 结论不外推为所有 CLI/SDK/RPC 场景的独占保证。
- [x] 没有为不确定来源增加生产 fallback。

**建议验证（测试/真实 Host 需授权）：**

- 现有 session-owner focused 命令只作为 baseline；新增 experiment 需要独立日志和清理证明。

---

### Task 16：fresh Host 依赖闭包与真实 integration 验收

**Deps：** `T3`、`T3E`、`T4`、`T8`、`T9`、`T27`（理由：fresh Host 最终验收必须消费修复后的 production 版本和迁移后的调用者。环境预热可提前，验收不能拿修复前的 artifact 证明新版本）。

**WritePaths：**
- `docs/plans/records/2026-10-17-runtime-convergence/fresh-host-integration.md`

**Resources：** 官方 npm registry、隔离 agent dir/state、fresh Host 安装根；真实 provider/CLI/integration 需用户明确授权。

**Files：**
- Create：`docs/plans/records/2026-10-17-runtime-convergence/fresh-host-integration.md`
- Read：root/enhanced package manifest、lock/override、`scripts/setup-subagent-runtime-deps.ts`、`scripts/doctor.ts`、T8/T9 migration inventory
- Environment only：隔离 fresh Host 的 `node_modules`/agent dir/state；不得热替换当前运行 Host

**接口契约：**
- Consumes：`@earendil-works/pi-codemode@1.0.4` 的 manifest/lock 约束、14-tool operation contract、迁移后的 fixture 命令。
- Produces：`FreshHostIntegrationDispositionV1`，分别记录 install closure、package verify、tool exposure、fixture compatibility、provider compatibility 和未验证项。

**实施方法：**

- [x] 使用官方 registry 在隔离目录安装 manifest/lock 要求的 codemode 版本；不修改当前物理 Host，不读取 credentials。（隔离临时目录 `npm ci --ignore-scripts` exit 0，`npm ls` 确认 `pi-codemode@1.0.4 overridden`）
- [x] 记录物理 package version、enhanced package peer resolution、fresh Host extension registration 和 14 个 model-only tool exposure。
- [x] 先运行静态 package verify/typecheck，再按 T8/T9 分组运行真实 integration；每组记录入口、tool names、raw result/status 和退出码。（typecheck 0、verify 离线/联网各 0、N1 8/8；分组结果见 `current-validation.md`；单进程 28 文件连跑的超时已分类为资源竞争并保留原始失败记录）
- [x] 将真实 provider 未覆盖、旧 Host 未重装、TUI 用户观感和 blocked upstream 明确分开，不用 synthetic probe 扩大结论。
- [x] 任意 integration 失败先回到来源分类：fixture、Host/package、upstream、production；不在验证过程中增加 fallback。

**验收标准：**

- [x] fresh Host 实际消费 lock/override 的 1.0.4 闭包，当前旧物理 Host 未被热替换。（`PI_TEST_CODING_AGENT_ROOT` 指向隔离安装的 1.0.4，注册面用例 1/1 exit 0；本仓 `node_modules` 未改）
- [x] fresh Host 的 14 项工具面和旧三名不 active 事实与合同一致。
- [x] T8/T9 所有获授权 integration 的每组结果都有命令、退出码、工具名和边界说明。（三组各自 exit 0；五-child 真实验收 probe 需真实 provider，未获授权、未执行，按未验证记录）
- [x] 未运行或未授权的 provider/CLI/TUI 项保持明确未验证，不写成通过。

**建议验证（真实 Host/provider/integration 需授权）：**

- `npm_config_registry=https://registry.npmjs.org/ npm_config_offline=true npm run typecheck`。
- `npm run verify:subagents-enhanced`、受控 package verify 和 T8/T9 分组 integration。
- 不运行全仓 `npm test` 或自动打开所有 integration glob；如需广域回归，另设资源和安全门。

---

### Task 17：deferred、blocked、user post-check 与保护现场统一收口

**Deps：** `T1`、`T10`、`T11`、`T12`、`T13`、`T14`、`T15`、`T28`（理由：T28 消费 T16/T19，T16 已覆盖 T20–T27 修复链；不重复加传递边）。

**WritePaths：**
- `docs/todos/2026-10-16-runtime-independent-followups.md`
- `docs/todos/2026-10-16-subagent-operation-followups.md`
- `.pi/handoff/context-handoff.md`
- `docs/plans/records/2026-10-17-runtime-convergence/closure-matrix.md`

**Resources：** `none`；不触碰保护备份和 crashes 文件。

**Files：**
- Create：`docs/plans/records/2026-10-17-runtime-convergence/closure-matrix.md`
- Modify：两份当前遗留账本和当前 session handoff

**接口契约：**
- Consumes：所有前置任务的 disposition、证据路径、用户授权状态、blocked 解阻条件。
- Produces：`RuntimeClosureMatrixV1`，每项只有一个当前状态：`completed`、`local-fix-ready`、`blocked-evidence`、`blocked-upstream`、`deferred-user`、`user-post-check`、`protected-local-artifact` 或 `historical-only`。

**实施方法：**

- [x] R01 idle notification：保持 `deferred-user`，记录登记/epoch/逐 ID status 合同和重新授权条件，不实现 osascript。
- [x] R02 triggerTurn：保持 `blocked-upstream`，记录发送前稳定 receipt/run 关联缺口，不全局关闭唤醒。
- [x] R03 resume(model)：保持 `deferred-user`/独立立项，记录 revive/sessionFile/lease/model contract，不用 fresh spawn 冒充修复。
- [x] R04 scheduler：引用 T12 的分类，不因 observer 通过销账。
- [x] R05/R06/R07：引用 T13，保留历史个案和 clear/inspect blocked 边界。
- [x] R08/R09/R10/R11：分别引用 T14/T15，不把一项 heartbeat 或 owner 证据外推到其它拓扑。
- [x] R12 fixture migration：只在 T8/T9 完成并有分组结果后标记；synthetic probe 不替代真实 integration。
- [x] R13 ceiling→T11；R14 resource-isolation→T10，不能按编号顺序机械反填。分别决定 fixture-only、production follow-up 或 blocked。
- [x] 将 T0 的 M1–M9 显式表逐项回填：M4 在 T6/T13 保留语义张力和解阻条件，不能只记 clear blocked 而漏掉范围未知的 steer 行为。
- [x] R15：记录 Supervisor V/Z 文档一致性完成状态，clear 仍 blocked。
- [x] code_mode：引用 T1，model-only 不可 callable 与实际用户 incident 分开记账，不因“未发现”就改 exposure。
- [x] 本会话新增 runtime 三项：T19 记录策略字段投影；T20/T24 记录 invalid reply 的代码归因与修复；T21/T22–T27 记录 workspace/queue 合同与修复，T28 负责真实现场结算。合法本仓修复未实施前不能以诊断完成销账。
- [x] 全部 runtime 文本引用 T3/T3E/T4，分别记录本仓源、独立个人 skill 和 coding evidence；footer 空行单列已实现、未提交、用户已重启 Host，实际观感不外推为整体验收。
- [x] 既有测试和既有 fixture 如与已证生产合同冲突，可同步修正并记录变更原因；只有新增测试、全新 fixture 或压力场景仍保留“建议（待用户授权）”。
- [x] F6 TUI L3 保持 `user-post-check`；F7 外部 models backup 保持 `protected-local-artifact`，不读、不提交、不删除。
- [x] 当前 handoff 删除“reviewer 报告尚未落盘”的过期事实，保留当前 HEAD、no push 和保护现场说明。

**验收标准：**

- [x] 15 个工程/功能事项和 7 个专项事项逐项有状态、证据入口、owner 边界和下一解阻动作。
- [x] 没有把 deferred、blocked、未授权、未验证混写成完成。
- [x] `.pi/handoff/context-handoff.md` 的修改只更新当前交接，不覆盖其它 dirty 现场。（2026-10-19 以 **append-only** 方式追加当前节，原有历史正文逐字保留；未触碰 crashes/backup）
- [x] 不读取或修改外部 backup/crashes 文件。

**建议验证：**

- 对 closure matrix 与两份账本做 ID 交叉检查，确保没有漏项或重复状态。
- `git diff --check -- docs/todos .pi/handoff/context-handoff.md docs/plans/records/2026-10-17-runtime-convergence/closure-matrix.md`。

---

### Task 18：最终证据、策略扫描和交付门禁

**Deps：** `T17`（理由：T17 已消费 T16 和全部分支；最终验收不替代各分支结果，也不重复增加传递边）。

**WritePaths：**
- `docs/plans/records/2026-10-17-runtime-convergence/acceptance.md`

**Resources：** `none`；默认只读检查，广域测试需另行授权。

**Files：**
- Create：`docs/plans/records/2026-10-17-runtime-convergence/acceptance.md`
- Read：全部本批记录、最新代码 diff、当前账本、package manifests/lock 和 protected status

**接口契约：**
- Consumes：本计划全部节点的 records、source classification、命令证据、授权记录和 closure matrix；包括 T3E 与本会话 T19–T21，不按数值区间漏计。
- Produces：`RuntimeConvergenceAcceptanceV1`，包含 implementation status、evidence index、blocked/deferred matrix、test authorization log、environment limits 和 no-push/no-commit state。

**实施方法：**

- [x] 核对每个任务的 WritePaths 与实际 diff，不允许 scope 外写入或 dirty 现场被覆盖。
- [x] 运行 runtime-owned 文本扫描，确认默认注入面没有无授权的强制 TDD/测试语句；保留明确的“用户授权后可选方法”条件句。
- [x] 核对 M1 source/parser/cleanup namespace 对称性、S6 24 文件清单、Supervisor G1/G2 文档、fixture migration inventory 和 fresh Host record。
- [x] 核对所有测试/fixture 修改都具有用户授权记录；没有授权的任务只能保留建议，不得把计划复选框改成已执行。
- [x] 汇总未跑的全仓 npm test、真实 provider、TUI L3、dangerous heartbeat/session-owner、upstream clear/inspect 和外部 owner skill，不把它们写成通过。
- [x] 保留 no push、无自动 commit、protected artifact 未触碰的交付边界。

**验收标准：**

- [x] 每个 DAG 终点都有对应证据或明确 blocked/deferred 结论。
- [x] 计划、review、acceptance、当前 handoff 和遗留账本之间没有相互矛盾的当前事实。（handoff 以 append-only 追加当前节并显式标注上文哪些表述已被取代）
- [x] `git diff --check` 通过；root/enhanced typecheck/verify 结果与记录一致。
- [x] 所有 production 修复都能指出来源分类、首个偏离点和最小影响范围。
- [x] 未授权的测试编写、真实 Host、危险进程、provider、网络和 push 均未被计划执行过程隐式发生。

**建议验证（广域回归需用户另行授权）：**

- 当前 package 的 root/enhanced typecheck、offline verify 和已授权的聚焦回归。
- `git diff --check`、runtime policy `rg` 扫描、WritePaths/staged 状态审计。
- 全仓 `npm test`、`test:all-integration` 和真实 provider 只在用户明确选择广域验收并给出资源窗口后执行。

---

### Task 19：定位 managed dispose 的可选字段在调用面变为必填

**Deps：** `T0`（理由：复用本会话同次工具错误和 worktree 基线，不再次执行失败 dispose）。

**WritePaths：**
- `docs/plans/records/2026-10-17-runtime-convergence/workspace-schema-provenance.md`

**Resources：** `none`；只读注册 schema、Host/provider 正规化源码与本会话已出现的回执，不读凭据或真实 state。

**Files：**
- Create：`docs/plans/records/2026-10-17-runtime-convergence/workspace-schema-provenance.md`
- Read：`packages/pi-subagents-enhanced/src/workspace/operation-tools.ts`、`packages/pi-subagents-enhanced/src/workspace/tool.ts`、`service.ts`、`administration.ts` 和 Host 注册/模型 schema 转换链

**接口契约：**
- Consumes：源 factory `strategy.required=false`；模型侧 schema 将 `strategy` 列为必填的本会话工具定义；`preserve/discard + strategy:cherry-pick → INVALID_WORKSPACE_STRATEGY`；最新 allowed/state 的非敏感摘要。
- Produces：注册原 schema → Host 工具 loadout → provider strict schema → 模型实际可填写参数 → runtime validator 的逐层对照，每层记录来源文件/版本/字段差异和首个偏离点。

**步骤与验收：**

- [x] 同时核对 `strategy` 和其它操作的可选字段，判断是单工具构造错误还是统一 schema 投影改变；不得仅凭模型工具定义把 factory 归罪为 required。
- [x] 保留 runtime 对非 integrate strategy 的严格拒绝；不能以忽略字段或放宽生产 validator 解决下游投影故障。
- [x] 记录非 integrate 省略策略、provider 需要 nullable 表达、Host strict converter 是否支持等技术选项及已有合同；只选证据支持的最小 owner，不预判加 null 或 split tools。
- [x] 判断该故障来自合法生产注册链、synthetic schema 或来源未证实；报告附实际错误，而不重复调用同参 dispose。
- [x] 若证明为本仓可修缺陷，主会话依据报告补一个精确实现节点；实现前固定省略/显式值语义和 provider 支持范围。若 owner 在上游，记录所需变更与授权，不加隐藏 adapter 绕过。
- [x] 该活跃 worktree 只能在合法 typed 接口恢复后按当次 status token 处置；本诊断不执行 dispose，也不调用 raw git worktree 清理。

**验证：** 先静态核对已有 factory/validator 测试。建议新增 provider schema round-trip 对照，但本计划未授权编写该测试；不安装/热替换当前 Host。

---

### Task 20：归档 Responses tool-call ID 的已证不兼容与本次 incident 边界

**Deps：** `T0`（理由：使用新现场完整 request/run/index 锚点，和历史 R06 分开归因）。

**WritePaths：**
- `docs/plans/records/2026-10-17-runtime-convergence/supervisor-intent-provenance.md`

**Resources：** `none`；只读源码、本会话已经送达的 pending/reply 回执。

**Files：**
- Create：`docs/plans/records/2026-10-17-runtime-convergence/supervisor-intent-provenance.md`
- Read：`packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-operation-tools.ts`、`extension.ts:1566`、`supervisor-control-plane.ts:83`、`supervisor-adapter.ts` 及既有 wire/diagnostics 合同

**接口契约：**
- Consumes：request `e295a31b-bc52-481f-83c2-ed11e2643260` 的已送达非敏感定位；`supervisor_request_reply` 同 request/message 返回 `SUPERVISOR_INTENT_INVALID`；pending 仍列该 request。
- Produces：从 operation factory 固定 action、controlled adapter 取 request、构建 v2 intent、strict parser、owner/gate/native sender 的调用链；精确到首个失败字段/步骤，而非笼统说“intercom 不一致”。

**步骤与验收：**

- [x] 直接复用已归档 reviewer H1，并静态核对 Responses producer 的 `call_id|item_id`、Host 的原样传递以及两个 `intentId: toolCallId` 消费点；本仓生产合同不兼容已证，不重复派发同一归因。
- [x] 核对其它 root/run/request/generation 的合法来源，另记本次历史回执是否确为 Responses 的最小证据缺口；不知道本次历史 ID 不妨碍 T24 修复已证不兼容。
- [x] 核对省略 `to`、空 `to`、显式 `to` 在受控路径中是否被消费；schema 已说 `replyTo` 是权威，不能把改 `to` 当作已证修复。
- [x] 将 controlled parser 的 `SUPERVISOR_INTENT_INVALID` 与 request registration/native sender 错误分开；pending 可见不证明 sender plane/registration 完整。
- [x] 如现场不足，只登记哪些字段尚无证据；不读完整 session/authority/state，不伪造 intentId 或直接调用 native sender 来绕过 gate。
- [x] 将修复交给 T24：稳定地从 Host opaque call identity 生成内部 intent identity，保持请求/owner 绑定及幂等；本报告不直接改 production，也不建议放宽所有 ID 字符。

**验收标准：** 报告有实际入口、合法身份生成链、时序、首偏离字段和来源分类；未证明之处明确标未知。新的同次失败与历史 R06 不互相替代。

**验证：** 可运行已审计的既有纯 wire/intent 检查；建议在授权后补与真实 toolCallId 格式一致的公开入口回归。当前 pending 不再重复 reply、steer 或自动 resume。

---

### Task 21：无改动 worktree 的前置事实与已知缺陷归档

**Deps：** `T0`（理由：当前工作区 clean/基线相同已证，但 queue/proof 内部状态不能由普通 Git 检查推断）。

**WritePaths：**
- `docs/plans/records/2026-10-17-runtime-convergence/empty-workspace-lifecycle.md`

**Resources：** 只读 public workspace/status 与代码；本任务不做真实处置，不等待修复或部署。

**Files：**
- Create：`docs/plans/records/2026-10-17-runtime-convergence/empty-workspace-lifecycle.md`
- Read：`packages/pi-subagents-enhanced/src/workspace/child-integration-lifecycle.ts`、`integration-queue.ts`、`completion-reminder.ts`、`subagent-dispatch/recovery-resume-contract.ts`、`root-broker-server.ts` 和 main Host 入口接线

**接口契约：**
- Consumes：workspace `a8f3cdf0-fbca-4c19-abb3-f5971dedc750` 的 status；`git status`/diff/untracked 为空、HEAD `92b0302` 与启动基线相同；child paused/terminal 通知和 integration-handoff 文本。
- Produces：`EmptyWorkspaceDispositionV1`，分别给出 filesystem、commit delta、runtime process terminal、queue、proof、workspace 处置事实；不可观测字段写 unknown。

**步骤与验收：**

- [x] 沿官方 terminal/proof → queue/recovery intent → `subagent-integration-handoff` 调用链核对提示触发条件，确认无改动/无提交时合同如何结算。
- [x] 对齐 `active + process_terminal=observed` 与 `allowed_dispositions` 的动作语义；不能因为列表出现 release 就跳过 public release 的 state 前提，也不能因 integrate blocked 猜测可以 raw publish。
- [x] 判断接管提示是合法恢复提醒还是错误声称“有待提交内容”；只报告能证明的问题，不把每次通知自动认定为 queue 缺陷。
- [x] 如存在可发布 payload，遵守 child-owned queue 与已授权提交边界；若没有 payload，不创建空提交。父工作区 dirty 文件不转移进 child 工作区。
- [x] 只记录本次状态、diff/commit delta 和 public 工具错误；不能在该前置任务重试处置或等待后置部署。
- [x] 复用 reviewer H2/H3：public preserve→release 的已证 proof 漏洞指向 T23，queue 残留指向 T25A/T25B/T25C 与 T26；本任务只补当前 worktree 的已知/未知状态，不再把两个代码缺陷列为来源未证。
- [x] 将现场处置明确移交 T28：依赖 T19 接口结论和已修复版本的 fresh Host 验收；只有合法同 owner 身份和当次 typed token 才执行。该移交不影响 T21 前置取证完成。

**验收标准：** 基线、已知/未知字段、H2/H3 生产调用链与 T22 合同输入归档即完成；不以真实工作区最终回收作为前置完成条件。“无可提交 diff”不等于“queue 已完成”。实际回收和 blocked-recovery 的后置落点是 T28；后续单独完成的 footer 空行代码不改变旧 managed worktree 无 payload 的事实。

**建议验证：** 授权后可用临时 public dispatch 产生 no-change/paused/failed 三类终态，观察不同提示和处置；不手工 append 台账或制造非法时间，不新增真实任务只为等待。

---

### Task 22：冻结 H2/H3 的持久化、错误传输与空交付合同

**Deps：** `T21`（理由：消费前置事实和整体成果 review，前置统一 service/ledger、queue、transport、Host 接口；本节点不依赖后置现场回收）。

**WritePaths：**
- `docs/plans/records/2026-10-17-runtime-convergence/workspace-disposition-contract.md`

**Resources：** `none`；文档合同，不写 production 或测试。

**Files：**
- Create：上述合同
- Read：`workspace/service.ts`、`ledger.ts`、`git-worktree.ts`、`coordinator-client.ts`、`coordinator-protocol.ts`、`coordinator-server.ts`、`integration-queue.ts`、`coordinator-ledger.ts`、`registry.ts`、`tool.ts`、`extensions/subagent-runtime.ts`

**接口契约：**

1. 继续使用已有 `RepositoryCoordinatorClient.disposeOwned/releaseOwned` 和 `binding.register` 的 `dispose/release` operation。模型字段不增加 owner、proof、queue generation；不另建 sender、raw integrate 工具或 child capability。
2. bound release 在任何 Git 删除前必须取得且校验匹配 run/root/asyncDir 的 observed proof；`challenge.used`、Git clean、paused 均不构成替代。unbound orphan 有独立合法释放流程。
3. 保留 `managed-workspace-ledger.v2` 的既有顶层键集合，在现有 `pendingAction` 槽定义严格、可区分的新子格式 `workspace-disposition-prepare.v1`；不在顶层偷塞字段，不放宽 exact-key 校验。其精确字段是 `schemaVersion, settlementId, operation, reason, binding, authorizedRevision, snapshotHash, proofHash, executorHead, phase, workspaceReceiptRef, queueReceiptRef`。`operation` 仅 preserve/discard/release；`phase` 为 prepared/effect-committed/settled；两个 receiptRef 初始 null。`binding` 精确含 workspaceId/leaseId/rootSessionId/runId/asyncDir/queueItemId/queueLeaseId/queueRevision/admissionGeneration，未绑定 run 或无 queue 时对应字段显式 null。prepare 以一次 ledger CAS 原子消费已核实授权、写入此绑定/操作/HEAD、设置 disposing，并把接受的 observed proof 写入已有 `terminalProof` 槽。
4. 存量 `pendingAction=null` 和合法旧六字段形态继续严格读取。旧六字段不被自动伪造 settlementId/proof；只有能从权威 owner、现有 challenge/旧 durable intent、绑定和匹配 proof 证明原授权时，才允许明确的一次 CAS 转为新格式。其余记录保留原状并报告 blocked-recovery。不支持旧 Host 与新 Host 并行写新子格式；这不是对畸形测试数据的兼容。
5. coordinator 侧 `WorkspaceQueueSettlementIntentV1` 保存与 workspace prepare 相同的 settlementId/binding/授权 revision/操作/HEAD/proofHash，并保存 authorized/workspace-committed/queue-committed/settled/blocked 阶段及 receipt refs。放在既有 repository integration-queue ledger，不存 raw token。首个崩溃窗口是 workspace prepare 已提交而 coordinator intent 尚未写：恢复必须通过 service 的 `listPreparedDispositions()` 发现这类权威准备记录、核实当前绑定并补建同一 intent，不重新要 token、不手工拼台账。
6. 首批自动 no-payload 必须同时满足：可信 terminal proof且无冲突；精确 workspace/run/lease/queue 绑定；worktree clean；`inspection.headCommit === record.request.baseCommit`；`inspection.descendant === true`；`inspection.aheadCount === 0`；无进行中的 Git sequencer、无 integrationIntent/integrationReceipt。删除前再次检查同一 executorHead。严禁拿可变 `authorizedWorkspaceHead` 或 `!hasCommits` 替代。净 diff 为零但存在提交、HEAD 已变基、integration intent 已存在均保留现场或走已有明确授权处置，不自动删除。
7. 错误 wire 保留既有 `error:string`，新增可选严格 `errorInfo`，仅允许 code/detail/keypath。detail 支持现有字符串或精确 `{state,allowedActions,nextAction}`；未知 Error/cause/stack/owner/token 不透传。无 errorInfo 的现有字符串失败仍可读取。Host/coordinator 需联合受控更新，不把新 server/旧严格 client 混跑声称兼容；不更改请求权限和 operation。

**service 方法合同（均为内部权威方法，模型不可直接填 context）：**

- `prepareOwnedDisposition(input, settlementContext): PreparedWorkspaceDispositionV1`：input 为现有 owner-scoped workspace/action/proof/token；context 为 coordinator 从 queue 推导的 settlementId 与 queue binding。先验权，再一次 CAS 保存授权与 proof，尚不删除目录。
- `applyPreparedDisposition({workspaceId,ownerScope,settlementId}): WorkspaceReceipt`：严格匹配 durable prepare、当前 lease/run 和 executorHead，幂等执行副作用，保留 pendingAction 到 effect-committed；不能依赖 raw token 重放。
- `listPreparedDispositions(): readonly PreparedWorkspaceDispositionV1[]`：coordinator 启动内部读取本 repository 中尚未 settled 的权威记录；不向模型暴露跨 root 私有数据。
- `markDispositionSettled({workspaceId,ownerScope,settlementId,queueReceiptRef}): WorkspaceReceipt`：匹配 binding 后标 settled；新动作只有在前一准备完成后才可替换该槽，历史 receipt 保留在 coordinator ledger。

**步骤与验收：**

- [x] 将每个 nullable 字段、receiptRef 生成规则、lease/revision CAS 以及四个方法的具体参数/返回字段完整写入合同，T25A/B/C 不自行另创第二套格式。
- [x] 固定 publish→completed、保留→preserved、已证 no-payload/合法 discard→cancelled 的区别；已有 terminal queue 不重开，不伪造 integration receipt。
- [x] 固定服务验权/prepare→coordinator intent→workspace effect→queue终结→receipt/handoff关闭的阶段；各窗口失败/重放规则可观察，不声称跨 ledger 单写原子。
- [x] 冻结新 fault 调用点及 startup readiness：workspace-only prepare 后、coordinator intent 后、Git 后 ledger commit 前、queue commit 后 receipt 前；listen 正常成功与 EADDRINUSE 后重听共用恢复入口，相关 mutation 等待恢复屏障。
- [x] 主会话 inline 校对合同后派发 T23、T26、T29；该合同任务不算 High 已修复。

---

### Task 23：H2——收紧 bound workspace release 的终态证明

**Deps：** `T22`（理由：消费统一 bound/unbound 规则、public release 无模型 token 的内部授权流程和回执合同）。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/service.ts`
- `test/workspace-operation-tools.test.mjs`（既有文件可同步删改；新增案例待授权）
- `test/managed-workspace-service.integration.mjs`（既有文件可同步删改；新增案例待授权）
- `docs/plans/records/2026-10-17-runtime-convergence/release-proof-fix.md`

**Resources：** 临时受控 repo/ledger；不处置本次真实 workspace，不运行 kill。

**Files：**
- Modify：`service.ts` 的 `issueReleaseForLease/releaseForLease/releaseOwned`、既有 `resolveProof` 和 durable released proof 记录
- Create：`docs/plans/records/2026-10-17-runtime-convergence/release-proof-fix.md`
- Existing Test Modify：上述两个既有文件可同步修改；新增案例仍待授权

**接口契约：**
- 消费 T22；public release 仍不接受模型提供 owner/proof/token。
- 对 bound run，进入任何 Git 删除前统一 `resolveProof(record, supplied)`，验证 proof 与 run/root/asyncDir 一致；不能用 clean Git、paused、模型 turn settled、challenge.used 或进程 status 字符串替代。
- 有可信 proof 的 public release 可由服务内部签发并消费新的一次性 release challenge；显式 token 路径仍校验 action/proof/owner。unbound orphan 可用服务内部一次性授权，不能向 bound 放大。

**步骤与验收：**

- [x] 移除 `suppliedToken===undefined && challenge.used===true` 对 bound workspace 的 shortcut，保留 unbound orphan 的明确定义路径。
- [x] `issueReleaseForLease` 与实际 release 使用同一 proof resolution 和身份校验，防止 issue 只看 observed 字面状态、release 再漏检身份。
- [x] 在 proof pending/unavailable/错 run/root/asyncDir 时，Git 副作用、branch 删除、released state 写入都不得发生；保持 `MANAGED_WORKSPACE_TERMINAL` 等现有错误类别。
- [x] 匹配的 observed proof 与合法授权才执行 release；把接受的 proof 随 ledger durable 保存，清理之后审计不依赖已删除目录。
- [x] 检查 cleanup-debt 重试仍走相同证明边界；不能为了恢复删除增加 force 或 proof 空值 fallback。
- [x] 运行已有静态/类型检查并记录未覆盖行为；只有用户授权测试编写后才补下面的案例。

**建议测试（待用户授权，授权后回填“已授权”）：**

- public allocate/bind → proof pending → status/preserve → release，断言固定拒绝且目录/branch/ledger 仍存在；真实调用链不用直接拼内部 Map/append ledger。
- 同链 observed proof 成功释放；错身份拒绝；unbound allocation orphan 仍能 preserve/release；cleanup-debt 和已用 challenge 不能绕过 bound proof。
- 相关既有命令：`node --test test/workspace-operation-tools.test.mjs test/managed-workspace-service.integration.mjs`，先审计只在临时 repo 运行。

---

### Task 24：H1——稳定转换 Host opaque tool-call ID 为内部 intent ID

**Deps：** `T20`（理由：消费已证 Responses producer→Host→adapter→parser 归因，不需要 H2/H3 或 schema 投影问题先解决）。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-intent-id.ts`
- `test/supervisor-gate-wire.test.mjs`（既有文件可同步删改；新增案例待授权）
- `docs/plans/records/2026-10-17-runtime-convergence/supervisor-intent-id-fix.md`

**Resources：** 纯 adapter/fixture；不回复真实 pending、不换模型、不读 session。

**Files：**
- Create：`supervisor-intent-id.ts`、本任务记录
- Modify：`extension.ts` 中 reply 与 steer 的两个 intent 构造点
- Existing Test Modify：`test/supervisor-gate-wire.test.mjs`

**接口契约：**

```ts
createSupervisorIntentId(input: {
  hostToolCallId: string;
  kind: "reply" | "steer";
  rootSessionId: string;
  runId: string;
}): string
```

该内部函数对非空 Host opaque ID 与 scope 作带版本域的 SHA-256，返回 `svi1-` 加 64 位小写 hex（69 字符）。精确 hash 输入为 `JSON.stringify(["supervisor-intent-id.v1", kind, rootSessionId, runId, hostToolCallId])`；相同输入稳定，保留作用域和操作区别。空/非字符串 Host ID 仍拒绝，不随机补一个 ID。仅构造内部 intentId，不改变 requestId、消息/correlation/tool result 的原始 Host ID。

**步骤与验收：**

- [x] 在本 feature 内新增上述 helper，reply/steer 两处都使用；沿原参数将原始 Host toolCallId 继续交给 native adapter/RPC，不改 session/event/raw details。
- [x] 保持 parser 的 root/run/request 安全 ID、generation、payloadDigest 和 child scope校验；不把 `|` 加进所有身份字段正则。
- [x] 幂等仍沿现有 receipt key 和请求绑定判断；重复相同 Host 调用不导致第二次 native 投递，不拿 intentId 取代 request ownership。
- [x] package/root 类型检查与已有纯 wire 检查通过；没有真实 provider call 不声称所有 provider 已验。

**测试处理：既有测试可同步删改；新增案例建议待用户授权。**

- 从公开 operation tool 的 execute 传入 Responses 同形 `call_x|fc_y`，reply 和 steer 均能进入正确 sender/gate，不再 parser invalid。
- 重复同一调用仍是 receipt 幂等；不同 child、root、run 的绑定拒绝/隔离保持，错 owner 不因 ID hash 被放行。
- 使用既有 `test/supervisor-gate-wire.test.mjs` 测行为，不单独写一个只镜像 hash 公式的测试。

---

### Task 25A：workspace 严格 schema 与 durable prepare/apply

**Deps：** `T23`（理由：消费已收紧的 proof/release 权威和 T22 子格式合同，单独交付可恢复的 workspace 阶段）。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/ledger.ts`
- `packages/pi-subagents-enhanced/src/workspace/service.ts`
- `packages/pi-subagents-enhanced/src/workspace/git-worktree.ts`
- `packages/pi-subagents-enhanced/src/workspace/disposition-contract.ts`
- `docs/plans/records/2026-10-17-runtime-convergence/workspace-prepare-apply.md`
- `test/managed-workspace-service.integration.mjs`（既有文件可同步删改；新增案例待授权）
- `test/managed-workspace-ledger.integration.mjs`（既有文件可同步删改；新增案例待授权）

**Resources：** 临时 ledger/repo；不改真实现场，不 kill。

**Files：**
- Modify：`ledger.ts` 的 `validatePendingAction/validateRecordEnvelope` 与新子格式字段的交叉身份校验；`service.ts` 的 prepare/apply/list/mark；`git-worktree.ts` 的 no-payload 事实检查
- Create：`disposition-contract.ts`（本 feature 的类型/精确 codec）和本任务记录

**接口契约：** 消费 T22，产出严格 `PreparedWorkspaceDispositionV1` 及四个 service 方法；T25B 只接受由 public prepare 或其合法重放产生的准备记录，不接受手拼未验权对象。

**步骤与验收：**

- [x] 明确扩展 `pendingAction` strict union：合法旧六字段与带 `workspace-disposition-prepare.v1` 的新 exact-key 形态；顶层键不变，release 只在新形态合法。未知字段/畸形 binding 继续 `MANAGED_WORKSPACE_SCHEMA`，不接受空默认对象。
- [x] prepare 在同一次 CAS 中保存授权 revision、binding、settlementId/operation/执行 HEAD，消费原已验证 challenge，并在 bound destructive 动作中保存完整已接受 proof；不能只存 proofHash 让 crash 后无法核实身份。
- [x] apply 验证相同 pending identity 后执行副作用并持久化 effect-committed；最终 receipt 写入前保留可发现记录。与上一轮不同的 token/owner/lease/run/HEAD 不可借此重放。
- [x] 使用 request.baseCommit、HEAD、descendant/aheadCount 和已有 sequencer 检查计算 T22 的严格 no-payload；不能使用 `hasCommits` 布尔值，也不修改 admission 的其它功能语义。
- [x] 增加真实 fault 调用点 `settlement/after-workspace-prepare`、`settlement/after-workspace-git-before-commit`、`settlement/after-workspace-effect`，复用现有 fault callback，不在生产路径自动注入故障。
- [x] 列举旧六字段记录的可读、可合法升级、缺证 blocked 三种结果；无完整 proof 时不把原 preserve challenge 当 destructive 授权。

**测试处理：既有测试可同步删改；新增案例建议待用户授权。** public prepare 后仅 workspace 有记录就模拟重启，list 能发现同一 identity；含 release 的新记录可严格读回；未知字段拒绝；apply 重复幂等。正例 HEAD=base、零增量；反例净 diff=0 但有提交、HEAD 已变基、integration intent 存在、sequencer 活跃均不能自动 no-payload 删除。

---

### Task 25B：queue settlement、receipt 与 handoff 关闭

**Deps：** `T25A`（理由：消费其实际准备记录 codec 与 service 方法，交付跨 ledger 的幂等结算器，不负责 server socket 接线）。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/integration-queue.ts`
- `packages/pi-subagents-enhanced/src/workspace/disposition-settlement.ts`
- `docs/plans/records/2026-10-17-runtime-convergence/queue-settlement.md`
- `test/managed-workspace-integration-queue.integration.mjs`（既有文件可同步删改；新增案例待授权）

**Resources：** 单 coordinator 的临时 queue/workspace ledger；不启动用户 Host。

**Files：**
- Modify：`integration-queue.ts` 的受权绑定精确终结与 active handoff 关闭
- Create：`disposition-settlement.ts` 和本任务记录

**接口契约：**

`createWorkspaceDispositionSettlement({workspaceService,integrationQueue,ledger,fault})` 产出 `settlePrepared(prepared)`、`replay()`。输入/返回类型消费 T25A/T22；持久化 intent/receipt 位于既有 integration-queue ledger。`replay()` 合并 coordinator intents 与 service.listPreparedDispositions() 的 workspace-only 记录，按身份校验补建缺失 intent，不能只重放 coordinator 文件列表。

**步骤与验收：**

- [x] 按 T22 的阶段推进，prepare 前不碰 queue；各阶段用完整 binding、revision/generation 和 expectedHead 核对。清理失败记录 debt，不凭错误跳过队首。
- [x] 新增仅 coordinator 可用的 queued no-payload/cancelled 结算分支；不放宽现有通用 `cancelItem/transition`。preserve 对应 preserved，已 terminal queue 保持其终态，不伪造 completed/integration receipt。
- [x] 同一 ledger 锁内关联 queue 终态与匹配 handoff intent，分别记录持久化边界；未写完时用 settlement replay 收敛，不以“持锁”声称多文件原子。
- [x] 持久化 queue/workspace receipt refs 后调用 service.markDispositionSettled；只关闭本 queue item 的 active handoff，再由原 FIFO pump 推进后继。
- [x] 新增明确 fault 点 `settlement/after-coordinator-intent`、`settlement/after-queue-settlement`、`settlement/before-settlement-receipt`、`settlement/after-settlement-receipt`，故障后的状态差异和重放动作均落入记录。
- [x] 回执严格匹配 proof/lease/run/settlement；cancelled/preserved 只表示明确结算，不等于代码发布成功。

**测试处理：既有测试可同步删改；新增案例建议待用户授权。** workspace-only prepare → replay 补建 intent；queue commit 后 receipt 前重放不二次删除/不关另一 root item；旧 queue lease/generation 拒绝；第一个空交付队首合法终结后第二个 root 可 admission；部分 handoff/receipt 写入可收敛。

---

### Task 25C：server 普通/recovery/proof 路由与启动恢复屏障

**Deps：** `T25B`、`T29`（理由：消费结算器及保留错误结构的 transport，再接所有真实入口；不能留下本地旁路）。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`
- `docs/plans/records/2026-10-17-runtime-convergence/settlement-server-wiring.md`
- `test/managed-workspace-coordinator.integration.mjs`（既有文件可同步删改；新增案例待授权）
- `test/managed-workspace-integration-queue.integration.mjs`（既有文件可同步删改；新增案例待授权）

**Resources：** 隔离 coordinator socket/临时 Git；不实际 SIGKILL。

**Files：** Modify server 的 binding.register dispose/release、recovery.discard/release、deliverTerminalProof、listen 和 EADDRINUSE 重听；Create 本任务记录。

**接口契约：** `binding.register` operation/角色权限不变；普通与 recovery 处置都经同一个 service prepare→settlePrepared。startup 统一执行 settlement replay→terminal proof replay→handoff pump，`ready` 屏障关闭前不允许修改相关 workspace/queue 的新请求进入。

**步骤与验收：**

- [x] 接入普通/recovery dispose/release，不能仅修其中一个入口；出错保留 T29 的 code/detail/keypath，不退回 local mutation。
- [x] 可信 terminal proof 经精确 binding 与 T25A 不可变条件判断 no-payload；需要保留的有效提交、零净 diff 提交和未知状态不进入自动删除。
- [x] proof outbox 只凭完整、同绑定的结算 receipt 接受 cancelled/preserved 结果；正常 queue completed 的已发表路径保持原证明链。
- [x] 抽成同一 `finishStartupRecovery()`，正常 listen 与 stale socket 的 EADDRINUSE 后重听都 await 它；alive coordinator 不被替换，socket权限检查保持原规则。
- [x] broker 注册/必要只读诊断可处理，但 dispose/release/admission/publish 及影响绑定的 mutation 必须等待 readiness。恢复失败按权威记录记 debt/阻塞，不 catch 成功后放入新 mutation；无关 binding 能否放行只按明确定义的恢复结果，不猜 absence。
- [x] 使用前两节点新增的 fault callback 点验证各 crash 窗口，不把旧 publication hook 当成新 settlement hook 已存在；新增启动恢复就绪故障点只供受控 fixture。（`test/workspace-disposition-settlement.integration.mjs` 12/12）

**测试处理：既有测试可同步删改；新增案例建议待用户授权。** 正常启动与 EADDRINUSE dead inode 重听均调用同一 replay；恢复屏障打开前相关 mutation 不执行；workspace-only 准备记录被发现；普通/recovery/proof 各入口最终 queue/workspace/receipt 一致，且后继 root 可推进。

---

### Task 26：Root Host 将 public 处置接入 coordinator 权威

**Deps：** `T22`（理由：仅消费冻结 transport/service facade 接口；可与 T23、T25A/B/C、T29 的后端实现并行）。

**WritePaths：**
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- `packages/pi-subagents-enhanced/src/workspace/registry.ts`
- `packages/pi-subagents-enhanced/src/workspace/tool.ts`
- `packages/pi-subagents-enhanced/src/workspace/disposition-facade.ts`
- `test/subagent-runtime-membrane.test.mjs`（既有文件可同步删改；新增案例待授权）
- `test/subagent-workspace-tool.test.mjs`（既有文件可同步删改；新增案例待授权）
- `docs/plans/records/2026-10-17-runtime-convergence/root-disposition-wiring.md`

**Resources：** 纯 Host DI 与已有 coordinator client；不启动当前用户 Host。

**Files：**
- Create：`workspace/disposition-facade.ts`、本任务记录
- Modify：main runtime 的服务 registry 绑定/解绑；public tool 对异步 dispose/release 的 await

**接口契约：**

`createCoordinatorDispositionFacade({ localService, coordinatorClient, resolveTerminalProof })` 返回实现现有 `ManagedWorkspaceService` 的 facade。reserve/ensureAllocated/bindRun/list/status/issueDisposition 保持原 owner 与权威调用；public `disposeOwned/releaseOwned` 用已有 coordinatorClient 方法。proof 从可信 callback 或已记录 proof 获取；owner 仍由 main tool 的 session resolver 注入，client/server 不信任模型覆盖。

**步骤与验收：**

- [x] facade 实现在 package `src/workspace`，入口只做 DI；不得为复用从 src 反向 import extensions。
- [x] main 启动时绑定 facade，关闭时以同一对象解绑；child early-return 和工具白名单不变。
- [x] public workspace tool 的写操作等待 coordinator Promise 后再构造 `workspacePublic`。错误结构由 T29 在 transport 中保留，facade/tool 不洗成成功；读取路径不静默成为错误的 Promise对象。不得仅做 await 就声称错误合同已闭环。
- [x] 已配置 coordinator 时若断连/未就绪，应返回真实失败；不能退回本地 dispose/release 造成 queue 再次脱钩。不受 coordinator 管理的 unbound allocation orphan 按 T22 的独立权威路径处理，不能凭读取错误猜 unbound。
- [x] 保留 `CHILD_OWNS_INTEGRATION`、`origin-dirty`、一次性 token 和 owner scope拒绝；不扩 model-only/codemode callable 边界。
- [x] 逐项核对受 async disposal 影响的本仓调用者并列精确清单；既有断言可按真实合同迁移，不借迁移新增未经授权的测试。

**测试处理：既有测试可同步删改；新增案例建议待用户授权。** 通过真实 operation tool callback 验证 dispose/release 只进入 coordinator，断连不会调用 local mutation；owner/root模型越权参数拒绝；await 完整 receipt 才输出 public result。只运行既有纯 DI 检查不等于授权新增这些断言。

---

### Task 27：H1/H2/H3 的跨层建议验收与记录

**Deps：** `T24`、`T25C`、`T26`（理由：T25C 已消费 T23/T25A/T25B 和 T29，验收最终 ID、proof-safe service、结算器、错误 transport 与 Host 接线）。

**WritePaths：**
- `docs/plans/records/2026-10-17-runtime-convergence/managed-runtime-acceptance.md`
- `test/managed-workspace-disposition-runtime.integration.mjs`（新增组合验证建议，待用户授权）

**Resources：** 明确隔离的两个 synthetic Root、真实临时 Git/coordinator socket；不使用用户 session/provider，不实际 SIGKILL，不访问旧 heartbeat roots。

**Files：**
- Create：本验收记录
- Suggested Test Create：上述组合 integration，仅用户授权并回填“已授权”后创建
- Read/Run existing：T23/T24/T25A/B/C/T26/T29 已有纯合同与临时 fixture 检查，先审计副作用

**接口契约：** 下列跨层行为是验收目标；相关新测试仍属于建议，未授权不得编写。

- H1：合法 Responses 同形 toolCallId→operation tool→controlled intent→native callback；不同 request/owner/child 的拒绝和重复 callback 次数可观察。
- H2：bound child proof pending 时 preserve 能留现场，release 不能删除；trusted observed 后才可回收，unbound orphan 不被误锁死。
- H3：Root A 无 payload 队首被合法结算后，Root B 可 admission；检查 queue item、workspace、pendingAction/settlement、proof outbox、handoff/receipt 的最终一致性；本机原 dirty checkout 不参与 fixture。
- 恢复：使用 T25A/B 明确新增的 `after-workspace-prepare`、`after-workspace-git-before-commit`、`after-workspace-effect`、`after-coordinator-intent`、`after-queue-settlement`、`before-settlement-receipt`、`after-settlement-receipt` 调用点模拟故障，由 T25C 的正常及 EADDRINUSE 后重听启动路径 replay；不能仅声称已有 hook 已覆盖新增窗口。无新 token、无手工写台账、无空提交/force/raw merge。
- 无交付反例：HEAD等于已刷新的 authorizedWorkspaceHead 但不同于 request.baseCommit、存在零净 diff 提交或进行中的 integration intent 时，不自动 cancelled/released。

**步骤与验收：**

- [x] 先记录精确源码版本和已有检查结果；新增测试未授权时保留建议范围，既有测试可执行与迁移，如实记录未覆盖行为，不宣称 High 全部闭环。
- [x] 用户授权后只创建这一个有跨层意义的组合 fixture，复用当前 public入口，不照抄函数实现制造纯文本断言。（已授权并新增 `test/workspace-disposition-settlement.integration.mjs`，经 coordinator client/listen 公开路径驱动）
- [x] 运行已授权组合和相关既有 focused 检查，记录文件、命令、exit、各分支覆盖、资源清理证明，失败按来源分类处理。（12/12 exit 0；三轮迭代中的失败均为本用例自身断言错误（socket 名过长、preserve 保留受管分支、effect-committed 阶段状态），按类别 2 只修测试，未改生产）
- [x] 记录三项 code-fixed/behavior-verified 的区别、strategy provider 投影仍未证实的边界，以及本次真实 worktree 是否具备合法同 owner 处置出口。

**验收标准：** H2/H3 不以单一 workspace released 或 queue completed 代替跨状态机证明；H1 不以安全 ASCII fixture 代替 opaque ID 兼容；原保护边界均保留。未授权的建议验证不阻止完成已授权代码工作，但必须降低相应验收结论。

---

### Task 28：后置检查并依法结算本次真实 workspace

**Deps：** `T16`、`T19`（理由：消费修复后版本验收与调用接口结论；不让前置 T21 等待自身的修复链）。

**执行者：** 主会话使用 typed workspace 工具；Subagent-Driven 模式下也不让 child 伪造 root 身份或经 codemode 调用 model-only 工具。

**WritePaths：**
- `docs/plans/records/2026-10-17-runtime-convergence/current-workspace-settlement.md`

**Resources：** 当前 workspace `a8f3cdf0-fbca-4c19-abb3-f5971dedc750` 的合法 owner 会话；受控 fresh Host 消费修复版本的维护窗口需按既有授权核实，不热替换运行 Host 或重用旧 token。

**Files：**
- Create：本任务记录
- Read：T19/T21/T16 的证据与当次 typed status/list；不直接读真实 ledger/authority/session 正文

**接口契约：**
- Consumes：已修生产版本、Host/provider schema 可正确表达动作的结论、同 owner 权威身份、实际 process proof、无 payload 的当前 Git事实和当次 action token。
- Produces：`released`/`preserved`/`cleanup-debt` 等真实 public 结算及 queue receipt，或精确的 `blocked-recovery/blocked-interface`；不能把“试过了”当作已回收。

**步骤与验收：**

- [x] 先核对操作的是已修版本和合法同 owner 会话；若 fresh Host 无合法恢复该 owner 的 public 路径，停为 blocked-recovery，不换 owner/伪造 rootSessionId、不读取完整旧 session。
- [x] 若 T19 仍不能解释或正确表达非 integrate 参数，停为 blocked-interface；不重复相同失败参数、不绕到旧工具/raw git，也不假定源码 optional 已等于 provider 接口可用。
- [x] 当前 typed list/status 与无敏感正文的 Git status/diff/HEAD 再次核对，特别防止此前 clean 之后又出现 payload。取得新 token 只执行当次状态实际允许的动作，遵守 proof、child-owned publication 和 queue settlement。
- [x] 对已证无交付工作区，按合法处置回执核对 workspace/queue/receipt 是否共同收敛；有内容则保留，不空提交、不自动合入父 dirty 内容。
- [x] 仅有 code-fixed 或 synthetic 验收而无实际同 owner 出口时，完整记录剩余现场和解阻条件，交 T17 保持明确未完成，不要求为销账删除台账或恢复已结束 child。

**验收标准：** T21 的前置归档不依赖本任务；本任务有唯一后置 owner 和明确结果。footer 空行已由独立任务在共享工作区完成，提交/Host 重载与旧空 managed worktree 结算分别记账，不把一方状态当另一方完成证据。

---

### Task 29：coordinator 结构化错误投影与恢复

**Deps：** `T22`（理由：消费固定 errorInfo wire 合同，可与 workspace/queue 实现及 Root facade 并行；T25C 再接入完整 server）。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/coordinator-protocol.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-errors.ts`
- `docs/plans/records/2026-10-17-runtime-convergence/coordinator-error-contract.md`
- `test/managed-workspace-coordinator.integration.mjs`（既有文件可同步删改；新增案例待授权）

**Resources：** 纯 codec/临时 socket fixture；不访问真实 coordinator 状态。

**Files：**
- Modify：Reply 严格 schema、server catch 编码、client failure 重建
- Create：`coordinator-errors.ts` 和本任务记录

**接口契约：**

- 保留 `error:string` 字段及现有无 errorInfo 失败回执的读取；新增 optional `errorInfo`，exact-key 仅 code/detail/keypath。code 与 keypath 为字符串；detail 仅字符串或现有公开状态对象 `{state:string,allowedActions:string[],nextAction:string}`。不传 Error 原对象、cause、stack 或私有授权字段。
- `toCoordinatorErrorInfo(error)` 输出该精确投影或 undefined；`fromCoordinatorFailure(message,info)` 构造 Error 并恢复合法 code/detail/keypath。错误 message 沿现有公开合同保留，不从文本正则猜 code。
- 请求协议、角色权限和 `binding.register dispose/release` 不变；新 Host/coordinator 受控联合启用，不承诺旧严格 client 可消费新增字段。

**步骤与验收：**

- [x] protocol Reply 纳入精确 optional errorInfo；拒绝 unknown/畸形投影，不用 Type.Unknown 接受整个 Error。
- [x] server catch 同时写既有 error 字符串和合法 errorInfo；client failure 重建时恢复原 code/detail/keypath。
- [x] `CHILD_OWNS_INTEGRATION`、`MANAGED_WORKSPACE_TERMINAL`、`MANAGED_WORKSPACE_STATE` 的 state/allowedActions/nextAction 和 keypath 经 RPC 后仍可被 public tool 按原合同显示；无元数据的普通错误保持普通错误，不编造安全放行。
- [x] 更新 T26 facade 的错误消费约定，不在 tool 层追加吞错/fallback；T25C 合入后再次检查 server 同时包含 codec 和恢复接线。

**测试处理：既有测试可同步删改；新增案例建议待用户授权。** 既有字符串错误可读；各关键拒绝码及状态详情 round-trip；unknown字段拒绝；真实 public callback 不退化为统一 MANAGED_WORKSPACE_ERROR。新增断言归本节点，T25C 对同测试文件若并行写入须隔离后语义合并。

---

## 执行交接与授权记录

- 本计划获用户明确授权编写；“所有 runtime 文本强制测试清理”和单独的 footer child 接管已有具体授权，继续保留各自范围，不重复索要。整批实施方式仍待用户选择；编写计划不自动授权测试编写、额外真实实验或远端发布。
- 用户选择执行方式后，按 DAG 派发：探索任务先完成并产生记录；实现任务只消费对应记录，不让执行者自行扩大范围。
- 写测试/改变测试逻辑、测试专用 fixture 行为前，在对应计划任务明确回填 `已授权` 与用户原话/范围；不另造必须精确四字段才算授权的流程。既有检查读取、类型检查和运行不自动取得写测试授权。
- 需要真实 Host/provider/网络/SIGKILL/跨进程竞争时，在任务记录中单独登记资源、入口、identity、超时、清理动作和停止条件；历史授权不自动继承。
- 计划执行期间不使用 Goal Engine 编排本批改造；按本计划 DAG 使用 Subagent-Driven 或 Inline。
- 计划完成后的成果 review 需要用户另行明确授权；首轮计划 review 按仓库执行规范自动派发，不视为成果 review 授权。
