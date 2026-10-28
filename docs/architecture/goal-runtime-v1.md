# Goal Runtime v1：契约、执行与会话恢复

**范围：** §1–§8 保留 v1 契约层的历史设计与验证记录；§9 说明 Host 门禁、continuity、用户控制与恢复边界；§10 记录 v2 多仓库扩展。
**职责：** contract 模块不读业务状态、不调度、不执行检查、不写 session、不注册工具。运行进度权威是 Pi session custom entry，检查执行与证据归 verification，package 运行事实由 `pi-subagents-enhanced/execution` 提供。
**状态：** §7–§8 的“测试待授权”仅为 T1 历史记录；当前受控联合回归与真实 smoke 的边界见 §10。

> 注意：本文 §5 中的契约区块是**示例**，用于说明格式与校验语义；不要对本文调用 `plan_execute`。示例中的任务与检查对应本计划的 `contract.ts`（T1）、`policy.ts`（T4）与 `index.ts`（T6）交付物。

---

## 1. 唯一需求载体

- 一份计划 Markdown 只允许**一个**契约区块，块内是**一个**标准 JSON fence。
- 契约块中的 `objective`、`constraints`、`tasks`、`checks`、`terminalCheckIds` 是**机器执行权威**；正文只供人阅读。
- 解码器只处理该块，不扫描正文推断任务、条件或修复归属；正文与契约不一致时由计划编写自检与人工审阅指出差异，代码**不选择较宽松的一边**，也不从模型输出补全缺失字段。
- 关键要求必须完整进入契约；「尚未授权的新检查」「需要模型自评的自然语言标准」都不进入可执行契约（自然语言终态必须转化为命令检查，否则报告不支持）。

## 2. 契约区块格式与拒绝规则

区块形如：一行 `goal-runtime-contract:start` 的 HTML 注释（两侧为 `<!--` 与 `-->`），随后是单个 `json` fence，最后是同样形式的 `end` 注释。读取时：

| 情形 | 结果 |
| --- | --- |
| 缺少开始或结束标记 | `MISSING_CONTRACT_BLOCK` |
| 任一标记出现两次以上 | `DUPLICATE_CONTRACT_BLOCK` |
| 结束标记在开始标记之前 | `INVALID_CONTRACT_BLOCK` |
| 块内不是以 `json` fence 开始 / 以 fence 结束 | `INVALID_CONTRACT_BLOCK` |
| 块内出现第二个 fence 或夹带正文 | `INVALID_CONTRACT_BLOCK` |
| JSON 语法错误 | `INVALID_JSON` |
| 文件超过 4 MiB | `PLAN_TOO_LARGE` |
| 文件不可读 | `UNREADABLE_PLAN` |

区块外的 Markdown 排版、checkbox 状态、空白与缩进都不参与校验和 hash。

## 3. 严格解码与跨引用校验

`decodePlanContract(value: unknown): PlanContract` 对**已解析的 JSON 值**做纯结构校验，任一不成立即在返回前抛 `PlanContractError`（带稳定 `code` 与 `keypath`）。所有字段集合都是精确匹配：未知字段直接拒绝，不做宽容忽略。

| 校验类别 | 规则 | 失败 code |
| --- | --- | --- |
| 版本 | `schema` 必须精确等于 `goal-runtime.plan.v1` | `UNKNOWN_SCHEMA` |
| 字段集合 | 每层对象不接受未声明字段，必需字段不得缺失 | `UNKNOWN_FIELD` / `INVALID_CONTRACT` |
| ID | `[A-Za-z0-9]` 开头，仅 `A-Za-z0-9._:-`，≤128 字节；资源、检查、任务 ID 各自唯一 | `INVALID_VALUE` / `DUPLICATE_ID` |
| 任务列表 | `tasks` 不得为空；`acceptance.criteria` 至少 1 条；`task` 正文 ≤32 KiB（与 dispatch-ir.v2 的 `MAX_TASK_BYTES` 一致） | `INVALID_CONTRACT` |
| 引用闭合 | `deps`、`checkIds`、`resources`、`repairTaskIds`、`terminalCheckIds` 必须指向契约内已声明的目标 | `UNKNOWN_TASK_REF` / `UNKNOWN_CHECK_REF` / `UNKNOWN_RESOURCE_REF` |
| 重复引用 | 同一引用列表内不得重复同一 ID | `DUPLICATE_REFERENCE` |
| DAG | 任务不得依赖自身；依赖图必须无环（错误信息给出完整环路径） | `SELF_DEPENDENCY` / `DEPENDENCY_CYCLE` |
| 终态 | `terminalCheckIds` 不得为空：每个必要条件都必须有实际 check | `EMPTY_TERMINAL_CHECKS` |
| 修复归属 | 每个 check 的 `repairTaskIds` 不得为空，且必须包含引用它的任务自身——不能只靠「等下游 accepted」后修复 | `EMPTY_REPAIR_OWNERS` / `MISSING_REPAIR_OWNER` |
| 死检查 | 未被任何任务或终态引用的 check 永远不会执行，视为契约自相矛盾 | `ORPHAN_CHECK` |
| 写路径 | 与 dispatch-ir.v2 同文法：仓库相对 POSIX 路径或末尾单个 `/**`；非空、无 glob、非绝对路径、无 `\\`、无 `.`/`..` 段、不得为 `/**`；任务内不得重复 | `INVALID_PATH` / `DUPLICATE_PATH` |
| 资源容量 | `capacity` 必须是 0..1e6 的整数；不得为负或非整数 | `INVALID_CAPACITY` |
| 命令 | `executable` 非空且不含控制字符；`args` 保留原样（不 trim）、不得含控制字符；`timeoutSeconds` 必须是 1..86400 的整数 | `INVALID_COMMAND` / `INVALID_VALUE` |

补充约定：

- 字符串型人类文本（`objective`、`constraints`、`statement`、`task`、`criteria`）解码时去除首尾空白并要求非空；命令参数不做任何改写。
- 数组顺序参与语义，解码器不排序、不去重、不补默认值。
- 解码结果递归 `Object.freeze`，下游不能就地改动冻结契约。

## 4. 语义 hash

`hashPlanContract(contract)` 与 `readPlanContract(filePath)` 的 `contractHash` 语义一致：

1. 入参先经 `decodePlanContract` 归一化（因此非法契约会抛错，而不是被宽松 hash）；
2. 对归一化结果做 canonical JSON（对象键递归升序）后取 SHA-256，十六进制小写。

因此：契约内容相同、正文排版/checkbox/空白不同 ⇒ hash 相同；契约任一语义字段变化 ⇒ hash 变化。Hash 变化在执行期即视为契约漂移，v1 不支持原地 amendment（暂停 → 用户处置 live run → `/plan cancel` → 重新授权）。

## 5. 示例契约（可直接 JSON.parse，且已通过本模块解码）

```text
任务关系：t-contract 与 t-policy 相互独立；t-entry 依赖两者。
资源：repo-writer 容量 2 —— 两个独立任务可在容量内并行，t-entry 在依赖 accepted 后启动。
终态：c-contract-types、c-typecheck-root。
```

<!-- goal-runtime-contract:start -->
```json
{
  "schema": "goal-runtime.plan.v1",
  "objective": "为 Goal Runtime v1 落地契约层、调度决策纯函数与公开入口，并用类型检查证明其可执行。",
  "constraints": [
    "仓库内 TypeScript 生产代码使用 .ts 并纳入 tsc --noEmit。",
    "只经 Pi 公开入口与 package exports 消费能力，不深引 package 内部源码。",
    "未获用户授权的检查不得进入契约。"
  ],
  "resources": [
    { "id": "repo-writer", "capacity": 2 }
  ],
  "checks": [
    {
      "id": "c-contract-types",
      "statement": "契约模块在 TypeScript 7 下单独静态检查通过。",
      "command": {
        "executable": "node",
        "args": [
          "node_modules/typescript/bin/tsc",
          "--ignoreConfig",
          "--noEmit",
          "--target",
          "ES2024",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--allowImportingTsExtensions",
          "--skipLibCheck",
          "--types",
          "node",
          "src/goal-runtime/contract.ts"
        ],
        "timeoutSeconds": 300
      },
      "repairTaskIds": ["t-contract"]
    },
    {
      "id": "c-policy-types",
      "statement": "调度纯函数模块在 TypeScript 7 下单独静态检查通过。",
      "command": {
        "executable": "node",
        "args": [
          "node_modules/typescript/bin/tsc",
          "--ignoreConfig",
          "--noEmit",
          "--target",
          "ES2024",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--allowImportingTsExtensions",
          "--skipLibCheck",
          "--types",
          "node",
          "src/goal-runtime/policy.ts"
        ],
        "timeoutSeconds": 300
      },
      "repairTaskIds": ["t-policy"]
    },
    {
      "id": "c-typecheck-root",
      "statement": "根工程类型检查通过（契约模块、调度模块与入口均已纳入 include）。",
      "command": {
        "executable": "npm",
        "args": ["run", "typecheck"],
        "timeoutSeconds": 900
      },
      "repairTaskIds": ["t-entry", "t-contract", "t-policy"]
    }
  ],
  "tasks": [
    {
      "id": "t-contract",
      "agent": "executor",
      "task": "实现 src/goal-runtime/contract.ts：冻结 §4.1 类型，实现严格解码、唯一契约块读取与 canonical JSON + SHA-256 语义 hash。输入来源：docs/plans/2026-10-26-goal-runtime-v1.md §4.1 与 dispatch-ir.v2 的 writePaths 文法。产物：contract.ts。停止条件：单文件 tsc 通过；发现合同内部矛盾或与上游类型冲突时停止并上报，不擅自修改冻结语义。",
      "deps": [],
      "writePaths": ["src/goal-runtime/contract.ts"],
      "resources": ["repo-writer"],
      "acceptance": {
        "criteria": [
          "contract.ts 导出 §4.1 全部类型与三个函数。",
          "未知字段、坏 DAG、重复/丢失引用、空终态、非法写路径与容量均被精确拒绝。"
        ]
      },
      "checkIds": ["c-contract-types"]
    },
    {
      "id": "t-policy",
      "agent": "executor",
      "task": "实现 src/goal-runtime/policy.ts：readyTasks 与资源容量计数、decideNextAction 的最小决策集（advance/retry/verify/wait/blocked/done）。输入来源：T1 的 PlanContract/TaskState 类型与计划 §5.4 的决策语义。产物：policy.ts。停止条件：单文件 tsc 通过；只做纯函数，不引入第二套资源账本。",
      "deps": [],
      "writePaths": ["src/goal-runtime/policy.ts"],
      "resources": ["repo-writer"],
      "acceptance": {
        "criteria": [
          "ready 任务在声明容量内返回，且不把整 Wave 当屏障。",
          "决策结果携带具体 task/check/reason。"
        ]
      },
      "checkIds": ["c-policy-types"]
    },
    {
      "id": "t-entry",
      "agent": "executor",
      "task": "实现 src/goal-runtime/index.ts 公开入口并纳入根 tsconfig include，安装 plan_* 工具与执行入口。输入来源：T1 的 contract.ts 与 T4 的 policy.ts 产物，以及 T3 的 package 执行服务。产物：index.ts 与 tsconfig 变更。停止条件：根 npm run typecheck 通过；工具默认关闭时不得注册任何 plan_* 能力。",
      "deps": ["t-contract", "t-policy"],
      "writePaths": ["src/goal-runtime/index.ts", "tsconfig.json"],
      "resources": ["repo-writer"],
      "acceptance": {
        "criteria": [
          "入口只经 Pi 公开 API 注册工具与生命周期。",
          "契约漂移时暂停而非降级执行。"
        ]
      },
      "checkIds": ["c-typecheck-root"]
    }
  ],
  "terminalCheckIds": ["c-contract-types", "c-typecheck-root"]
}
```
<!-- goal-runtime-contract:end -->

### 5.1 命令检查映射

| 检查 | 关联任务 | 实际命令 | 通过判据 |
| --- | --- | --- | --- |
| `c-contract-types` | `t-contract` | `node node_modules/typescript/bin/tsc --ignoreConfig --noEmit … src/goal-runtime/contract.ts` | 退出码 0 且结果非错误 |
| `c-policy-types` | `t-policy` | 同上，目标换成 `src/goal-runtime/policy.ts` | 退出码 0 且结果非错误 |
| `c-typecheck-root` | `t-entry` | `npm run typecheck` | 退出码 0 且结果非错误 |

要点：

- 三个任务都是 coding，`writePaths` 非空且同文法；`task` 正文含输入来源、产物与停止条件，不是任务编号。
- 任务级 check 的 `repairTaskIds` 必含该任务自身：`c-contract-types`→`t-contract`，`c-policy-types`→`t-policy`，`c-typecheck-root`→含 `t-entry`（同时列出 `t-contract`、`t-policy`，因为该失败也可能由前两者引入）。
- 终态检查 `c-contract-types` 与 `c-typecheck-root` 都落到真实命令；`terminalCheckIds` 非空，故不存在「无必要终态」。
- `repo-writer` 容量 2 与 DAG 组合表达 F2：两个独立任务可并行，`t-entry` 依赖二者 accepted。

## 6. 与后续任务的接口边界

| 消费方 | 使用的冻结接口 | 边界 |
| --- | --- | --- |
| T2 状态存储 | `PlanContract`、`PlanBinding`、`GoalState`、`TaskState`、`Checkpoint`、`GoalSessionDiskReader`、`EvidenceWriter` | 状态写入只走 Pi 公开 `appendEntry`/`getBranch`；本模块不持有 session |
| T4 调度/修复 | `PlanContract`、`TaskState`、`CheckReceipt`、`VerifyChecks`、`CaptureSubject` | 决策是纯函数，资源容量只按契约计数，不新建账本 |
| T5 验证/证据 | `GoalCheck`、`GoalSubject`、`CheckReceipt`、`GoalCheckEvidence`、`EvidenceWriter` | `VerifyChecks` 注入 `writeEvidence`，T5 不依赖 T2 实现即可编译 |
| T3 package 适配 | 无（package 自有 `PlanRunRef`/`PlanRunFacts`） | package 不反向 import 根模块；根只做结构兼容 |
| T6 工具入口 | 上述全部 + `readPlanContract`/`hashPlanContract`/`PlanContractError` | 工具不接受 caller 传入的 `command`/`passed`/`evidence`；解码失败前不产生副作用 |

`VerifyChecks` 使用 Pi 1.4 的真实 `ExtensionToolContext`：命令只能经 `ctx.executeTool("bash", …)` 走原 hooks，`PlanContractError` 的 `code`/`keypath` 供工具层生成精确拒绝文案。

## 7. 遗留限制（v1 明确不承诺）

- **正文一致性不由代码保证。** 解码器不解析自然语言，正文与契约冲突由 `writing-plans` 自检与人工审阅指出；这是 §4.1 的既定边界。
- **JSON 重复键按平台语义。** 区块 JSON 由 `JSON.parse` 解码，重复键取最后一次出现的值；契约作者不得依赖重复键表达语义。
- **不做跨版本兼容。** 未知 `schema` 直接拒绝，不迁移旧 obligation runtime 的契约格式。
- **不校验语义正确性。** 解码只保证结构、引用闭合、DAG、终态与修复归属成立；命令是否能验证目标仍需计划审阅判断。
- **未新增测试。** 计划 §3 的三份建议测试仍待用户授权；本任务只做静态检查与一次性手工解码核对。

## 8. 验证记录（T1）

```bash
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit \
  --target ES2024 --module NodeNext --moduleResolution NodeNext \
  --allowImportingTsExtensions --skipLibCheck --types node \
  src/goal-runtime/contract.ts
```

TypeScript 7 在仓库存在 `tsconfig.json` 时显式指定文件必须带 `--ignoreConfig`（否则 TS5112）；全工程检查仍用 `npm run typecheck`。T6 把 `src/goal-runtime/**` 纳入 `tsconfig.json` include 之前，上述单文件检查是覆盖新模块的唯一静态证据。

## 9. Host 门禁与会话恢复（T7）

### 9.1 启用边界

`pi/extensions/goal-runtime.ts` 在 child 中直接退出。主 Host 必须同时满足可信 `PI_CODING_AGENT_DIR`、全局 `settings.json` 的 `goalEngine.enabled === true` 和 `goal-runtime.json` 的 `enabled:true`；两个配置默认均关闭。缺失、不可读、非法设置均 fail closed，不修改设置文件。

Pi 1.4 的 extension loader 在 factory 阶段把 `getSettings` 绑定为 `notInitialized`。因此 factory 仅读取可信 agentDir 下的 `settings.json` 快照并调用 `resolveGoalEngineGate`：关闭时完全不注册工具、命令或 hook。开启后每次 `session_start` 用真实 `pi.getSettings()` 再核验有效设置；此时若关闭，不初始化 Goal session，已加载入口的 Goal 行为为 no-op。reload 重跑 factory；不在工具、context、通知或 tree 事件中读取开关，不承诺会话中途切换。T8 需覆盖两个阶段的 false、缺失、非法值及 true。

### 9.2 持久化与恢复链路

状态与证据只追加到当前 Pi session。`plan_checkpoint` 原样保存 `decisions/source_refs/next_action/task_id`；任务和检查变化由 store 立即保存。continuity 不生成另一份 handoff 文件，也不截断合同。

`session_start` 建立新的 generation/store，先 await `store.restore()` 核验当前分支对应的磁盘条目。然后绑定 execution service，立即订阅，再 reconcile 已知 run，覆盖订阅前的完成通知窗口。若 package 尚未绑定服务，在后续请求/工具入口解析原服务，绝不创建替代派发器。通知只刷新事实并请求一次明确的 plan 工具续跑；同代 pending 标记和有效事实指纹去重。

同一 Manager 内存中的 Goal entry 若没有文件证明，恢复保持 blocked，`plan_status` 与 `/plan status` 仍可读诊断。重新创建 store 不能将内存可见当成已落盘；恢复成功也不承诺 fsync 或断电事务保证。

每次 `context` 请求生成独立投影：完整 `GoalState`（含原合同、全局约束、任务合同、run 引用、回执、来源、决策与 next action）、未接受任务和仍需当前证明的终态检查。旧 passed 不自动代表当前候选通过。投影不 append、不改历史 transcript/tool result，也不替换 Pi 默认摘要；契约来源发生漂移或不可读时暂停自动执行。

### 9.3 compact、导航和退出

| Pi 1.4 hook | Goal 行为与真实返回合同 |
| --- | --- |
| `session_before_compact` | 保存当前 checkpoint；manual、threshold、overflow 均适用，保存失败返回 `{cancel:true}`；成功不返回 `compaction`，保留默认摘要 |
| `session_compact` | 与 reason/willRetry 配对，清除临时标记并要求下次请求恢复；通知 hook 无返回动作 |
| `session_compact_failed` | 仅清除本次临时标记，不制造恢复锁，不清除真实存储/业务阻塞；willRetry 不授权额外续跑 |
| `session_before_switch` | 仍属于旧 session 时保存；失败返回 `{cancel:true}`；不转移 Goal，不停止 child |
| `session_before_fork`、`session_before_tree` | 非终态或任何 run 未闭合时返回 `{cancel:true}`；说明先 pause 诊断、完成或 cancel 并核实资源闭合 |
| `session_tree` | 导航获准后重建当前分支的 store 并核验；不重新读取 gate |
| `session_shutdown` | 幂等撤销订阅、清空当前绑定并使 generation 失效；不把退出作为 terminal proof |

返回值按已安装 Pi 1.4 的 `dist/core/extensions/types.d.ts` 中 `SessionBefore*Result` 核对。每个保存/控制异步路径与 store 的 readBranch/appendEntry 闭包均重核 session ID、Manager 实例与 generation；旧回调不能写入新 session。cancelled 替换期间先排空旧核对，通知仅标记失效，之后再核对新实例。

### 9.4 暂停、取消与新计划

`/plan pause` 暂停新调度，`/plan resume` 在原合同与持久化仍有效时恢复，`/plan status` 只读。来自 interactive/RPC 的新消息或 steer 暂停自动续跑，不猜测其自然语言授权；既有 child 仍由通用 runtime 管理。

`/plan cancel` 记录取消并保留全部 run/workspace 引用，不停止 child、不释放 workspace，也不算完成。同 session 的后续 `plan_execute` 通过 `scheduler.replaceCancelled` 对所有已知 run 重新 inspect。只有官方 succeeded/failed terminal proof、completed integration receipt 或权威 not-applicable、workspace released、recovery none、blocker null 全部成立时才可替换；未绑定的 dispatch intent/workspace、unknown、pending、manual takeover 均拒绝。没有派发过任务的 cancelled 实例可直接替换。

`store.replaceCancelled(expectedRevision,newState)` 在同一写队列校验取消状态、revision、新 planId 与 Host session binding，再经 `appendVerified` 追加全新状态。新计划从 pending/attempt 0、空 receipts 与 checkpoint 开始；旧快照、证据和 binding 保持历史原样，不做 amendment。新状态发布后清空旧 facts，不继承旧通过结论。

### 9.5 需要明确处置的恢复阻塞

- **契约漂移：** 保留原合同和证据并暂停；用户先处理 live run，取消旧执行，再对新版本授权 `plan_execute`。只改 checkbox 不改 contractHash，但仍改变候选 contentHash，需要重新验证。
- **unknown spawn/run：** 有 intent、workspace 却无精确 run，或 adapter 无法证明身份/终局时，不重派、不推断未启动；通过 `subagent_run_status`、`managed_workspace_status` 取得当前权威事实。超时、Host 退出、status 文案都不是 proof。
- **manual integration takeover：** 保留 `subagent-integration-handoff` 与原 typed 处置流程，由原资源 owner 完成处置。Goal 不代父层 integrate，也不以 fresh start 绕过人工接管。
- **存储失败：** 保存失败 latch 阻止派发、修复和完成；只读诊断继续可用。只有重新初始化并从实际 session 文件核验才能恢复可写。

`context_usage` 独立提供 known/unknown 观测，不再发送手工 handoff 提醒或提供 handoff 路径。历史 session 与 handoff 文件不删除、不改写。

T7 只使用既有检查和类型检查，不新增测试/fixture、不启动真实 Host/provider。compact/reload/restart、真实异步通知及四形态门禁的 Host 行为取证仍属于 T8；静态检查和 context_usage 回归不能替代 F5/F10 实测。

## 10. 多仓库超级工作区（Goal Runtime v2）

多仓库模式只支持一个非 Git 超级根下的一层普通、独立 Git 仓库。每个参与仓库的物理根必须是超级根的直接 canonical 子目录；其 Git 顶层、origin root 和 `.git` common dir 都必须与该目录一致。linked worktree、同 common-dir 的重复候选、路径别名、嵌套仓库、超级根自身作为任务仓库和动态仓库拓扑均拒绝。单仓库模式仍沿用 v1 的 `PlanBinding` 与 subject 形状。

超级根任务只有一套路径文法：每条 `writePaths` 以同一 `<repoId>/` 首段开始，并且一项任务的所有路径必须属于同一个参与仓库；绝对路径、`..`、空剥除路径、跨仓库路径和未知前缀在绑定时拒绝。归属与路径投影统一经 `resolveTaskRepository` 从原合同及 binding 派生，输出任务的 `repoId`、仓库根、原始路径与剥除首段后的仓库相对路径。绑定、状态展示和每次派发可重新从原合同调用该纯函数；一次派发只剥除一次首段，prompt、dispatch request 与 workspace policy 消费同一投影，request cwd 指向仓库根，child cwd 仍由 Host 的 workspace 决定。任何下游不得对已投影路径再次剥除前缀。

多仓库 binding 只持久化计划实际参与的仓库及其既有 `repositoryId`、`storageRepositoryId`；不保存超级根的目录库存、任务到仓库的索引或 run 到仓库的索引。绑定重入只核验这些固定记录，不重新扫描超级根。任务 repoId、仓库相对路径和 checkpoint 展示位置都由原合同与固定 binding 派生，因此新增无关兄弟仓库不会改变旧计划。派发标题仍由 plan/task 身份与原任务正文生成，不保存仓库映射。状态里的 `TaskState`、run 引用和 `GoalCheckpoint` 不增加 repo 字段；`plan_status` 原样返回 `state`，并在顶层 `tasks[taskId].repoId` 和 `checkpoint.repoId` 提供只读派生位置。单仓库及未指定 taskId 的 checkpoint 不附加 repoId。

持久形状只有以下两种：

| 对象 | 单仓库 v1 | 多仓库 v2 |
|---|---|---|
| binding | 原有 `planPath`、`contractHash`、`repositoryRoot`、`sessionId`、`sessionFile`；`repositoryRoot` 为 Git 根 | 原字段加 `repositories[]`，每项为固定 `repoId`、`root`、`repositoryId`、`storageRepositoryId`；`repositoryRoot` 为非 Git 超级根锚点 |
| subject | `repositoryRoot`、`head`、`contentHash` | `kind: "multi-repository"` 加按 `repoId` 排序的成员；每个成员复用上述三个字段 |

多仓库 subject 仍逐仓库调用单仓库 `captureSubject(string)` 原语，候选覆盖每个完整参与仓库，不按任务 writePaths 缩小范围。receipt、scheduler 完成判定和检查证据共用同一个复合比较实现；超级根不执行 Git，也不伪造超级根 HEAD。固定参与集合的成员缺失、身份漂移或 subject 形状不符均 fail closed。check 命令仍只经 Host 的 bash 工具及 hooks 执行：单仓库在 repositoryRoot，多仓库在超级根，不增加 check cwd 字段。五工具名称、参数与 goalEngine 两阶段门保持不变。

parent 只保留一份 Goal 状态、scheduler、execution broker 和 Host 生命周期。首次 dispatch 从已验证 request origin 选择仓库上下文；已有 run、inspect、resume、proof、settlement 和 close 沿同一个 Host 选择结果路由到对应 canonical identity/storage 分区。各仓库可以拥有既有 coordinator/workspace 连接上下文，但不复制业务状态机，也不轮询 `listOwned` 来发现归属。package Host 对每个选定仓库负责 receipt、coordinator、proof 和 sidecar 的权威校验；Goal continuity 只恢复固定 binding，随后消费 `execution.inspect` 返回的统一事实，不读取 sidecar、不重建 broker 权限、不实现第二套证明校验。

compact、reload 或新 Host 的恢复顺序保持 v1：session store 先从当前分支和同一 session 文件核验合同、binding、run 引用和证据；package Host 在同代恢复回调中完成 proof replay，再完成 settlement replay，最后进入 resume pump。Goal continuity 只订阅同代 execution service 并经 scheduler 的 `refreshRuns → execution.inspect` reconcile 已知 run；导航闭合门消费该轮已核对的 facts，不另行读取证明。package 的服务晚到时，通过同代 availability 回调恢复；shutdown 撤销订阅并使旧 generation 失效。它不扫描目录，不迁移旧记录，不补写 repo 字段，也不由摘要推断终局。恢复后新增兄弟仓库、旧单仓库 binding 和旧单仓库 subject 均保持兼容。

兼容矩阵如下：

| 输入/记录 | 处理 |
|---|---|
| v1 单仓库 binding、TaskState、run、checkpoint、subject | 原样恢复，保持原字段与原 subject 比较 |
| v2 多仓库 binding 与复合 subject | 只恢复固定参与集合，按 binding 派生任务路由和 subject 成员 |
| 持久 binding/subject 缺成员或形状错误 | store 精确解码拒绝；不动态重扫或迁移 |
| 固定参与路径不可读、身份变化 | 重入核验拒绝；检查候选捕获失败拒绝完成；运行终局仍以 Host inspect 为准 |
| 新增无关一层兄弟仓库 | 不影响既有计划；重入不查看该目录 |
| linked worktree、别名、嵌套仓库、同 common-dir 候选、跨仓库单任务 | 不支持，绑定阶段拒绝 |

该章节描述的是 v1 状态、存储与恢复边界的多仓库路由扩展，不引入第二套 Goal 状态机、proof 账本或恢复协议。真实 provider smoke、双仓库并行与新 PID 的生产证据仍属于后续 T5；本节的受控测试不替代真实 smoke。
