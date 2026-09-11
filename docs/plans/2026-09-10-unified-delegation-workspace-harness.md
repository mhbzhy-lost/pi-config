# 统一委派合同与 Workspace Harness 实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定；本计划属于 Goal 改造，在 R13 验收前只允许选择 Subagent-Driven，不得使用 Goal Engine 或 Inline 执行、编排或验收。

**目标：** 将 generic `subagent` 收敛为所有角色共用、prompt 字段全部必传的结构化合同，由 Skill 引导 `executor` 使用在 generic prompt 基座上扩展的 coding contract、`reviewer` 使用 generic contract；将两条输入路径收敛到同一个可信 execution service，并将 managed workspace 改为 policy/capability 驱动的统一资源，补齐 source dirty、workspace dirty、终态证明、publish/apply、处置和恢复的完整 harness 生命周期。

**架构：** 当前只支持 `executor.md` 与 `reviewer.md` 两个 profile：profile 只定义角色行为；generic contract 以必传的 objective、requirements、context、boundaries 和 acceptance 生成通用结构化 prompt；coding contract 复用该基座并增加 task identity、risk、workflow、write scope 和 evidence。只有确实由 runtime/result consumer 使用的字段可以 optional。Public adapter 与 Goal coordinator 将 generic/coding 输入投影到同一个 Host-only execution envelope；统一 workspace service 先发布 durable Git ref，再在 origin 满足门禁时单独 apply。

**技术栈：** Node.js `>=22.19.0`、原生 TypeScript type stripping、TypeBox、Node test runner、Git worktree/plumbing、JSONL ledger、Pi Extension API、`pi-subagents@0.62.0`。

## 全局约束

- 生产代码、配置或 Skill 逻辑/行为变更首次修改前必须加载 `test-driven-development` skill；每个行为切片都先写精确 RED，再写最小 GREEN。
- 文档、Skill 正文和代码注释必须使用中文，仅专业用词可使用英文。
- 不得访问、记录或提交密钥、凭据和证书；Git 管理的信息必须脱敏，但不得对非 Git 内容擅自脱敏。
- R0-R13 全部完成并通过 R13 验收前，禁止使用 Goal Engine 执行、编排或验收本计划；只能由主 agent 按 DAG 使用 Subagent-Driven 执行。
- 历史 event generation、`planned.v1`、`dispatch-ir.v1`、workspace request v1 和既有 lease 必须保持原 replay/mutate/completion/disposition 语义；不得原地升级、混写、桥接到 publish/apply 或重算活跃 hash。
- Goal Root ABI 保持 exact-eight，禁止新增 `goal_observe` 或第九个 Goal 工具。
- `pi-subagents` 固定为 `0.62.0`；深层 upstream import 只能位于 `packages/pi-subagents-enhanced/src/compat/pi-subagents-0.62.ts`。
- 所有 standalone subagent、Goal task、Goal validation workspace 必须使用 `packages/pi-subagents-enhanced/src/workspace/` 的统一 service；不得恢复旧 workspace controller、ledger、Goal workspace 实现或 legacy dispatch facade。
- 不得把 `worktree:true` 透传给 upstream workflow root/leaf；内部 workflow 始终接收已解析的 `cwd` 和 `worktree:false`。
- Workspace 状态必须写入 `PI_CODING_WORKSPACE_DIR`；不得读取、迁移、执行或信任目标仓中的遗留 `.pi-subagents/**`、`.state/subagent-dispatch/**`、`.state/worktree-lifecycle/**`。
- 禁止 raw `git worktree add/remove/prune/move/repair/lock/unlock`；Git 副作用只能通过 managed workspace Git adapter。
- Source dirty 允许 allocation、spawn、terminal settlement 和 publish；只有 apply 到 origin 时才要求 origin clean。Workspace dirty 不得被静默丢弃，必须先 durable publish，或取得独立的显式破坏性授权。
- `writePaths` 裸路径表示精确文件，只有 `/**` 或末尾 `/` 表示目录前缀；rename 的源路径和目标路径都必须通过范围检查。
- Profile 名称、profile frontmatter、prompt、模型和 subagent request 都不能授予 Goal、acceptance、workspace publish/apply 或 Broker capability。
- Public `cwd`、session mode 和 worktree 请求只能收紧 Host grant；exact origin、canonical cwd、isolation 和 allowed profiles 必须由 Host authorization 绑定，caller 不得用 shared mode 或 symlink/越界 cwd 绕过 managed policy。
- 所有生产兼容、防御和 fallback 在实现前必须记录数据来源、首个偏离点和完整生成调用链，并分类为 production、fixture-only 或 unknown；unknown 必须 fail closed。
- TUI 精简只能发生在 renderer；不得改写 agent 收到的原始 tool result、event payload、session 内容或结构化 details。
- 不自动 stash、reset、提交、覆盖或合并 source dirty；不使用 TTL、目录存在性或 clean 状态作为删除 workspace 的授权。
- 本计划不创建 Git commit；如后续需要提交，必须另行获得用户明确授权并加载 `git-commit-convention` skill。

## 目标合同

Generic contract 不包含 `kind` 或 `role`。所有参与 prompt 拼接的字段必须声明为必传；空数组表示调用方已明确确认该维度没有额外内容，不能用 omitted 表示。只有 runtime/result 字段允许 optional：

```ts
interface GenericPromptContract {
  task: string;
  context: readonly string[];
  constraints: readonly string[];
  deliverable: string;
  done: readonly [string, ...string[]];
}

interface GenericSubagentRequest extends GenericPromptContract {
  agent: string;
  title: string;
  model?: string;
  runtime?: {
    cwd?: string;
    timeoutMs?: number;
    session?: "fresh" | "fork";
    worktree?: boolean;
  };
  result?: {
    output?: string | false;
    outputMode?: "inline" | "file-only";
    outputSchema?: Readonly<Record<string, unknown>>;
    progress?: boolean;
    artifacts?: boolean;
  };
}
```

该五段结构来自 OpenAI、Anthropic、Google、Microsoft、LangGraph、SWE-agent 和 OpenHands 官方方法的交集：目标、最小高信号上下文、负空间约束、交付物形状和可观察完成条件。工具列表、effective capabilities、return route 和 stopping condition 由 Host/profile/runtime 注入，不允许 caller 自报。Coding renderer 将现有 `dispatch-ir.v1` 的 objective/context/requirements/boundaries/acceptance 投影到同一内部五段 prompt IR，并补充固定 coding deliverable、task identity、risk、workflow、writePaths 和 evidence；不改变 v1 source contract/hash。现有自由文本 generic 调用只作为 legacy replay adapter；新 Skill 固定引导 `executor` 使用 coding contract，`reviewer` 使用上述 generic contract 与 `worktree:false`。

内部执行边界不是 public codec；只能由未导出的 Host factory 创建 branded envelope：

```ts
interface DispatchExecutionRequest {
  source: {
    type: "generic" | "standalone-coding-v1" | "goal-coding-v1";
    contractHash: string;
    taskId?: string;
  };
  spawn: NormalizedWorkflowSpawn;
  workspace?: ManagedWorkspaceRequestV2;
}

interface ManagedWorkspacePolicy {
  publication: "forbidden" | "allowed";
  application: "forbidden" | "allowed";
  writePaths: readonly string[];
}
```

`createAuthorizedDispatch(input, hostGrant)` 是未导出的可信 factory，返回 `{ request, authorization }` branded envelope。Host grant 精确绑定 root session、allowed profile、canonical origin/cwd、isolation、Goal ticket 和 capability；profile 工具集只能从 grant 扣减。Public adapter 对 caller-supplied authorization、Goal ticket、capability 和 workspace policy 字段一律 fail closed。Workspace policy 不能反向授予 Broker 或 Goal capability。

## Harness 不变量

1. Generic public schema 中，optional 字段必须有独立 runtime/result consumer 和行为测试；所有 prompt 字段必须位于必传 `GenericPromptContract`，自由文本 `task` 只存在于 legacy replay adapter。
2. Allocation 只固定 primary origin、attached ref、`baseCommit` 和 dirty snapshot；source dirty 不阻塞创建。
3. 子进程只收到 Host confinement 后的 `dispatchCwd`，upstream `worktree` 固定为 false；caller 请求 shared mode、越界/symlink cwd 或 managed state root 时 fail closed。
4. Workspace 与 root session、canonical tool call、run ID、async directory 和 process instance 持久绑定，跨 owner 操作在任何 Git inspection 前拒绝。
5. Completion、status 文本、日志和进程退出码都不是 destructive authorization；terminal proof 固定为 `not-started | pending | observed | conflict | unknown`，只有身份完全匹配的 `observed` 可进入破坏性动作，unknown field 和 identity mismatch fail closed。
6. `publish` 将 `baseCommit -> publishedTree` 的完整结果固化为 durable ref/artifact，不修改 origin；clean workspace 复用当前 tree，dirty workspace 使用临时 index 生成 snapshot tree/commit，不修改 workspace index。
7. Published artifact 固定记录 `artifactId/workspaceId/baseCommit/publishedTree/sourceHead/refName/policyHash/changedFiles/proofId`；ref 更新使用 `update-ref <new> <expected-old>` CAS。
8. `apply` 只消费已发布 artifact 的 `baseCommit -> publishedTree` 完整差异；在 repository-wide operation lock 内检查 origin HEAD/index/worktree CAS、无 sequencer、路径范围和历史关系。失败时只回滚本操作拥有且 CAS 仍匹配的状态；发现外部漂移立即停止并记录 recovery debt，禁止 reset 覆盖。
9. Publish/apply 禁用仓库 hooks；检测到外部 clean/smudge filter、dirty submodule/gitlink 或不受支持的 symlink/path 状态时 fail closed。普通 ignored 文件和 harness runtime 路径不进入 published tree，非 ignored untracked 文件进入 snapshot。
10. `release` 只释放已被 durable publication 覆盖或已明确放弃的物理 workspace；普通 dirty workspace 不再因非强制 remove 进入无解 `cleanup-debt`。
11. `discardChanges` 是独立高风险动作，必须有 fresh inspection、terminal proof、一次性 token、非空原因和可信用户授权；普通 subagent 字段不能授权它。
12. Action token 的消费与 disposition intent 在同一 ledger lock/原子写中完成；双进程同 token 只有一个成功。所有 service 操作先持久化 intent，再执行 Git 副作用，最后持久化 receipt；任一步中断都可由 reconcile 幂等恢复。
13. Goal settlement、Goal receipt append 和 workspace publish/apply receipt 分别持久化；重试只补缺失 receipt，不重复已完成 Git 副作用。Executor/run criteria 可以进入 child prompt，coordinator-only terminal/workspace predicates 永不进入 child acceptance。
14. 活跃 v1 lease 始终调用冻结的 v1 disposition；publish/apply 只服务新 v2 lease，任何 v2 sidecar 都不得修改 v1 bytes、hash、mutation 或 completion。

## 文件职责

- `docs/research/2026-09-10-generic-subagent-prompt-contract.md`：官方方法调研、字段取舍和来源链接。
- `packages/pi-subagents-enhanced/src/contracts/generic-prompt.ts`：唯一 generic 五段 prompt codec、规范化、hash 和 renderer。
- `packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts`：保留 `dispatch-ir.v1` 历史 codec，并新增只供 Goal compiler 消费的内部转换接口。
- `packages/pi-subagents-enhanced/src/subagent-dispatch/execution.ts`：共享 dispatch execution service，不注册工具、不解析 Goal projection。
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`：公共 `subagent` legacy/v2 adapter、模型解析和 Host API 绑定。
- `packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts`：可信 authorization 规范化、capability 交集和 fail-closed 校验。
- `packages/pi-subagents-enhanced/src/workspace/contract.ts`：workspace request v1 reader、v2 policy/receipt/action codec。
- `packages/pi-subagents-enhanced/src/workspace/ledger.ts`：v1/v2 durable record、intent、receipt 和 replay。
- `packages/pi-subagents-enhanced/src/workspace/git-worktree.ts`：唯一 Git 副作用层，负责 snapshot ref、apply、abort/rollback 和安全释放。
- `packages/pi-subagents-enhanced/src/workspace/service.ts`：allocation、binding、proof、publish/apply/discard/preserve/release/reconcile 状态机。
- `packages/pi-subagents-enhanced/src/workspace/tool.ts`：当前 root session 的 standalone workspace 控制面。
- `src/goal-engine/dispatch.ts`：Goal task 到内部 execution request 的 compiler。
- `src/goal-engine/managed-workspace.ts`：Goal 对 workspace v1/v2 public receipt 的唯一 adapter。
- `src/goal-engine/extension.ts`：Goal exact-eight 工具绑定和 coordinator orchestration，不承载 workspace/Git 实现。
- `packages/pi-subagents-enhanced/src/tui/compact-rendering.ts`、`packages/pi-subagents-enhanced/extensions/custom-footer.ts`、`src/goal-engine/tool-renderer.ts`：只读消费原始 details 的展示层。
- `packages/pi-subagents-enhanced/src/workspace/administration.ts`、`scripts/worktree-lifecycle.ts`：inventory、dry-run recovery plan 和显式授权 apply。
- `skill-overrides/subagent-dispatch/SKILL.md`、`skill-overrides/using-goal-engine/SKILL.md`：唯一公开调用顺序和安全边界。

## DAG

```text
T1 调研决策、provenance 与 RED
├──> T2 generic prompt codec ──> T4 shared execution service ──> T10 public tool/TUI/Skill
├──> T3 authorization 边界 ────> T4
└──> T5 workspace v2 policy ──> T6 publish Git primitive ──> T7 workspace service
                                  │                           ├──> T9 admin/recovery
                                  │                           └──> T10
                                  └────────────────────────────────> T11 standalone harness E2E
T4 ────────────────────────────────────────────────────────────────> T11
T9 ────────────────────────────────────────────────────────────────> T11
T10 ───────────────────────────────────────────────────────────────> T11
T11 ──> T12 pre-cutover 全量验收与迁移说明
T14 stream_read_error 安全重试 ────────────────────────────────────> T12
T15 测试副作用 tmp 隔离 ───────────────────────────────────────────> T12

Deferred（本地不启用 Goal，移出主线）：
T8 Goal bridge、T13 fresh Host Goal smoke —— 保持 Goal exact-eight/v1 replay 不变量，不在本计划实现。
```

## Waves

- Wave 1：T1。
- Wave 2：T2、T3、T5（消费 T1 的分类和 RED，可并行）。
- Wave 3：T4、T6（分别消费合同/授权与 workspace policy，可并行）。
- Wave 4：T7（消费 T5、T6）。
- Wave 5：T9、T10（消费稳定 execution/workspace ABI，可并行，按 WritePaths 隔离）。
- Wave 6：T11（standalone harness E2E，逐个前驱完成即补，不等待同 Wave 的无关工作）。
- Wave 7：T12。
- T14、T15 可与 T2-T11 并行，但其结果必须在 T12 前纳入总验收。
- Deferred：T8、T13 移出主线；本地不启用 Goal，其 Goal publish/apply bridge 与 fresh Host Goal smoke 不在本计划实现。若将来本地启用 Goal，另立计划并先满足 `docs/superpowers/plans/2026-08-13-goal-obligation-runtime.md` 的 R13 验收。

**关键路径：** T1 → T5 → T6 → T7 → T11 → T12。T14 是独立安全路径，必须在 T12 汇合；T2 → T4 与 T3 → T4 是并行次关键路径。Goal 任务（T8/T13）已移出主线，不计入本计划完成度。

---

### Task 1：固化 prompt 调研、问题来源和架构 RED

**Deps：** `none`

**WritePaths：**
- `docs/research/2026-09-10-generic-subagent-prompt-contract.md`
- `docs/bugs/2026-09-10-subagent-contract-role-coupling.md`
- `docs/bugs/2026-09-10-managed-workspace-dirty-lifecycle-gap.md`
- `docs/bugs/2026-09-10-workspace-publish-apply-recovery-gap.md`
- `test/subagent-generic-prompt-contract.test.mjs`
- `test/managed-workspace-lifecycle-contract.test.mjs`

**Resources：** `none`

**Files：**
- Create：官方方法调研、上述三个中文问题记录和两个 contract test。
- Test：`test/subagent-generic-prompt-contract.test.mjs`、`test/managed-workspace-lifecycle-contract.test.mjs`。

**接口契约：**
- Consumes：OpenAI、Anthropic、Google、Microsoft、LangGraph、SWE-agent、OpenHands 官方资料；现有 `dispatch-ir.v1`、generic schema、workspace v1 request、terminal proof adapter 和 bug records。
- Produces：`GenericPromptContract { task, context, constraints, deliverable, done }` 的字段决策与来源；production/fixture-only/unknown 分类表；`ManagedWorkspacePolicy` 测试期望；source dirty、workspace dirty、publish/apply 的可观察状态矩阵。

**验收标准：** 调研逐项说明字段为何属于必传 prompt 或 optional runtime，并明确不采用 caller-supplied tools/capabilities/return route；每个问题记录包含实际入口、权威身份、事件/资源顺序、首个偏离点和 production 事实差异；RED 只断言行为，不镜像文档字面值。

- [x] **步骤 1：写入官方方法调研与五段 prompt 决策**

  记录官方 URL、共同模式、反模式、字段取舍和本仓库 `executor/reviewer` 映射。

- [x] **步骤 2：编写 contract 分叉 RED**

  断言 generic 的五个 prompt 字段全部 required，contract 不存在 `kind/role` 或 optional prompt 字段；只允许 `executor/reviewer` profile；所有影响 prompt/spawn 的字段进入各自 canonical hash。

- [x] **步骤 3：运行 contract RED**

  运行：`node --test test/subagent-generic-prompt-contract.test.mjs`

  预期：FAIL，原因为 generic 五段 codec 尚不存在，现有自由文本 generic hash 未覆盖完整结构化 prompt。

- [x] **步骤 4：编写并运行 dirty 生命周期 RED**

  覆盖 source dirty 可 allocate/publish 但不可 apply；workspace dirty 可 durable publish 后 release；未 publish 的 dirty workspace 不得 release；apply 失败必须 rollback。

  运行：`node --test test/managed-workspace-lifecycle-contract.test.mjs`

  预期：FAIL，原因为现有 service 只有原子 `integrate/discard/preserve`，dirty preserve 后 release 会进入 `cleanup-debt`。

- [x] **步骤 5：核对既有回归基线**

  运行：`node --test test/subagent-dispatch-ir.test.mjs test/goal-subagent-dispatch-parity.test.mjs test/managed-workspace-service.integration.mjs`

  预期：记录当前通过项、既有失败和超时；不得把既有 resolver identity 断言失败归因到本任务。

### Task 2：实现 generic 五段 prompt codec 和 coding 投影

**Deps：** `T1`（理由：消费 T1 产出的公共合同 RED 和行为字段清单）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/contracts/generic-prompt.ts`
- `packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts`
- `packages/pi-subagents-enhanced/package.json`
- `packages/pi-subagents-enhanced/scripts/verify-package.ts`
- `test/subagent-generic-prompt-contract.test.mjs`
- `test/subagent-generic-prompt-contract-security.test.mjs`
- `test/pi-subagents-enhanced-package.test.mjs`

**Resources：** `none`

**Files：**
- Create：`packages/pi-subagents-enhanced/src/contracts/generic-prompt.ts`、security test。
- Modify：coding renderer 投影、package exports/verifier allowlist、T1 contract test 和 tarball required-file assertion。

**接口契约：**
- Consumes：T1 的 `GenericPromptContract` 字段决策和既有 `dispatch-ir.v1`。
- Produces：`compileGenericPrompt(input): CompiledGenericPrompt`、`GenericPromptContractError`、`projectCodingPrompt(ir): StructuredPromptIR`；generic canonical hash 覆盖五段 prompt，coding source contract/hash 保持字节语义不变。

**验收标准：** 五个 prompt 字段全部 required；`task/deliverable/done` 非空；`context/constraints` 必须显式给数组且可为空；不存在 optional prompt 字段；unknown key fail-closed；输出 deep-freeze；coding 投影不改变 `dispatch-ir.v1` hash；profile identity 不影响 capability。

- [x] **步骤 1：补齐 codec 安全 RED**
- [x] **步骤 2：运行 RED**：`node --test test/subagent-generic-prompt-contract.test.mjs test/subagent-generic-prompt-contract-security.test.mjs`，预期因 generic prompt codec 缺失而 FAIL。
- [x] **步骤 3：实现最小 TypeBox codec、规范化、hash、renderer 和 coding 投影**。
- [x] **步骤 4：运行 GREEN**：重复步骤 2 命令，预期 PASS。
- [x] **步骤 5：运行合同、package 回归**：`node --test test/subagent-dispatch-ir.test.mjs test/subagent-dispatch-schema-security.test.mjs test/subagent-dispatch-validation-errors.test.mjs test/pi-subagents-enhanced-package.test.mjs`，预期 PASS。

### Task 3：分离请求边界与可信 RunAuthorization

**Deps：** `T1`（理由：消费 provenance 分类和禁止 profile/request 提权的不变量）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/execution-contract.ts`
- `test/subagent-run-authorization.test.mjs`
- `test/subagent-execution-contract.test.mjs`

**Resources：** `none`

**Files：**
- Create：`execution-contract.ts`、execution contract test。
- Modify：authorization matrix test 和实现。

**接口契约：**
- Consumes：现有 standalone/Goal capability matrix、Goal ticket authority。
- Produces：非导出 `createAuthorizedDispatch(untrustedInput, hostGrant): AuthorizedDispatch`；branded `AuthorizedDispatch`；capability intersection；明确拒绝 caller-supplied authority/capability/workspace policy。

**验收标准：** Host grant 绑定 root session、allowed profile、canonical origin/cwd 和 isolation；caller 只能收紧 grant；agent/profile/model/prompt/request 字段变化不增加 capability；shared-mode、symlink/越界 cwd、managed state root 和伪造 Goal 字段 fail closed；Goal ticket exact binding 保持；historical `dispatch-ir.v1` authorization 可重放。

- [x] **步骤 1：编写 request/profile 提权 RED**。
- [x] **步骤 2：运行 RED**：`node --test test/subagent-run-authorization.test.mjs test/subagent-execution-contract.test.mjs`，预期因统一 execution contract 尚不存在而 FAIL。
- [x] **步骤 3：实现最小 execution envelope 和 capability intersection**。
- [x] **步骤 4：运行 GREEN**：重复步骤 2 命令，预期 PASS。
- [x] **步骤 5：运行 Broker 回归**：`node --test test/root-subagent-broker.test.mjs test/subagent-runtime-membrane.test.mjs`，预期 PASS。

### Task 4：提取共享 subagent execution service 和兼容 adapter

**Deps：** `T2`（理由：消费 compiled generic/coding prompt）、`T3`（理由：消费可信 branded execution envelope）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/execution.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/execution-contract.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/ir.ts`
- `packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts`
- `test/subagent-dispatch-extension.test.ts`
- `test/subagent-dispatch-shared-execution.integration.mjs`
- `test/goal-subagent-dispatch-parity.test.mjs`

**Resources：** `none`

**Files：**
- Create：shared execution service、shared execution integration test。
- Modify：public tool adapter、legacy IR adapter、workflow spawn 和 parity owner test。

**接口契约：**
- Consumes：`CompiledGenericPrompt`、coding prompt projection、`AuthorizedDispatch`、现有 model selector、workflow spawn、workspace allocator interface。
- Produces：`dispatchExecution(request, dependencies): Promise<DispatchReceipt>`；legacy generic 和 `dispatch-ir.v1` 只做输入适配；`subagent-dispatch/ir.ts` 不再持有第二份 compiler。

**验收标准：** public request 不含 role kind；executor coding/reviewer generic 的选择只由 Skill 指导，不由 agent name 授权；Goal capability 不由 public adapter构造；legacy session 可恢复；resolved model、Host-confined cwd、prompt、hash 和 run binding 均由同一 execution service 处理；inner worktree 永远 false。

- [x] **步骤 1：编写两种 adapter 汇合到单一 service 的 RED**。
- [x] **步骤 2：运行 RED**：`node --test test/subagent-dispatch-shared-execution.integration.mjs test/goal-subagent-dispatch-parity.test.mjs`，预期因 shared service 缺失而 FAIL。
- [x] **步骤 3：提取 `dispatchExecution`，保留现有 v1/generic 可观察结果**。
- [x] **步骤 4：将 structured generic/coding adapter 接入 shared service，删除重复 IR compiler 实现**。
- [x] **步骤 5：运行 GREEN 和回归**：`node --test test/subagent-dispatch-shared-execution.integration.mjs test/subagent-dispatch-extension.test.ts test/goal-subagent-dispatch-parity.test.mjs test/subagent-dispatch-ir.test.mjs`，预期 PASS。

### Task 5：引入 workspace request v2 policy 和 ledger 兼容读取

**Deps：** `T1`（理由：消费 workspace mode 耦合与 dirty 状态矩阵）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/contract.ts`
- `packages/pi-subagents-enhanced/src/workspace/ledger.ts`
- `test/managed-workspace-contract.test.mjs`
- `test/managed-workspace-ledger.test.mjs`
- `test/managed-workspace-v1-replay.test.mjs`

**Resources：** `none`

**Files：**
- Create：v1 replay test。
- Modify：workspace codec、ledger 和现有 contract tests。

**接口契约：**
- Consumes：workspace request v1 records、deterministic Goal workspace ID、existing receipt projection。
- Produces：`ManagedWorkspaceRequestV2`、`ManagedWorkspacePolicy`、version-discriminated ledger reader；新 allocation 只写 v2，v1 record 只路由到冻结的 v1 service/disposition，不转换为 publish/apply。

**验收标准：** 新 request 不含 coding/generic/validation mode；owner 与 policy 独立校验；policy 真值表固定为 `application:allowed => publication:allowed && writePaths非空`，其余非法组合在 allocation 前拒绝；validation/standalone policy 由可信 adapter 产生；v1 golden fixtures 的 bytes、hash、mutation、completion 和 disposition 不变。

- [x] **步骤 1：编写 v1 全语义 golden replay 和 policy 真值表 RED**。
- [x] **步骤 2：运行 RED**：`node --test test/managed-workspace-contract.test.mjs test/managed-workspace-ledger.test.mjs test/managed-workspace-v1-replay.test.mjs`，预期因 v2 codec 缺失而 FAIL。
- [x] **步骤 3：实现 v2 request、versioned ledger codec 和冻结 v1 路由**。
- [x] **步骤 4：运行 GREEN**：重复步骤 2 命令，预期 PASS。
- [x] **步骤 5：运行 identity 回归**：`node --test test/goal-engine-managed-workspace.test.mjs test/subagent-managed-worktree.integration.mjs`，预期 PASS。

### Task 6：实现 durable publish snapshot 和独立 apply Git primitive

**Deps：** `T5`（理由：消费 workspace v2 policy、published artifact identity 和 ledger schema）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/git-worktree.ts`
- `packages/pi-subagents-enhanced/src/workspace/published-artifact.ts`
- `test/managed-workspace-git-publish.integration.mjs`
- `test/managed-workspace-git-apply.integration.mjs`

**Resources：** `Git integration test repositories；同一临时 origin 的测试不得并发`

**Files：**
- Create：published artifact codec、publish/apply integration tests。
- Modify：Git adapter。

**接口契约：**
- Consumes：`ManagedWorkspacePolicy`、workspace inspection、write path matcher。
- Produces：`publishWorkspaceSnapshot(input): PublishedArtifactReceipt`；`applyPublishedArtifact(input): ApplyReceipt`；`abortFailedApply(input): RollbackReceipt`。

**验收标准：** clean workspace 发布完整 tree；dirty workspace 使用独立临时 index 执行 `read-tree`、`add -A`、`write-tree`、`commit-tree` 并以 CAS 更新 `refs/pi/workspaces/<workspaceId>/published`，不得修改 source/workspace index；publish 不要求 origin clean；apply 在 repository lock 内消费 `baseCommit -> publishedTree` 完整差异并要求 origin clean；apply 失败时只在 CAS 仍匹配时恢复本操作拥有的状态，外部漂移保留现场和 recovery debt；published ref 的创建、重复发布、冲突、apply 后保留和显式删除均有 CAS 测试。

- [x] **步骤 1：编写 source dirty publish、workspace dirty snapshot、完整 `baseCommit -> publishedTree`、ref 创建/重放/冲突/保留/删除 CAS 和 artifact identity RED**。
- [x] **步骤 2：编写 repository lock、origin HEAD/index/worktree CAS、apply conflict、并发 origin advance、rename scope、hook/filter、symlink、ignored/untracked 和 dirty submodule RED**。
- [x] **步骤 3：运行 RED**：`node --test test/managed-workspace-git-publish.integration.mjs test/managed-workspace-git-apply.integration.mjs`，预期因 primitives 缺失而 FAIL。
- [x] **步骤 4：实现 publish snapshot、durable ref CAS 和包含 `baseCommit/publishedTree/sourceHead/refName/policyHash/changedFiles/proofId` 的 receipt hash**。
- [x] **步骤 5：实现 repository-wide lock、完整 tree diff apply、Host-owned hooks-disabled Git 环境和 CAS rollback**；外部漂移时记录 recovery debt，禁止 reset 覆盖；重复步骤 3 命令，预期 PASS。

### Task 7：升级 workspace service 状态机和 dirty disposition

**Deps：** `T5`（理由：消费 v2 ledger）、`T6`（理由：消费 publish/apply Git primitives）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/contract.ts`
- `packages/pi-subagents-enhanced/src/workspace/ledger.ts`
- `packages/pi-subagents-enhanced/src/workspace/service.ts`
- `packages/pi-subagents-enhanced/src/workspace/completion-reminder.ts`
- `test/managed-workspace-service.integration.mjs`
- `test/managed-workspace-publish-apply.integration.mjs`
- `test/managed-workspace-terminal-proof.test.mjs`
- `test/managed-workspace-action-token.concurrent.mjs`
- `test/subagent-workspace-completion-reminder.test.mjs`

**Resources：** `Git integration test repositories；同一临时 origin 的测试不得并发`

**Files：**
- Create：publish/apply service E2E、terminal proof test、双进程 token test。
- Modify：v2 action codec/ledger、service、completion reminder 和现有 service tests。

**接口契约：**
- Consumes：published artifact Git receipts、pinned official terminal proof provider、v2 ledger intents。
- Produces：strict `TerminalProofV2`（`not-started|pending|observed|conflict|unknown` + run/rootSession/asyncDir/processInstance/proofId）；`issueAction()`、`publishOwned()`、`applyOwned()`、`discardOwned()`、`preserveOwned()`、`releaseOwned()`；action token 绑定 owner、proof、inspection 和 action-specific snapshot，并与 intent 在同一 ledger transaction 消费。

**验收标准：** run completion 不自动处置；unknown field、not-started、pending、unknown、conflict 和 identity mismatch 均 fail closed；source dirty 只阻塞 apply；workspace dirty 可 publish 后安全 release；未发布 dirty workspace 的 release 返回 blocked result 而非制造 cleanup-debt；显式 discardChanges 缺少可信授权时 fail closed；双进程 token 只有一个消费成功；effect 已完成但 receipt 未落盘时只补 receipt；并行 workspace 顺序 apply 每次重做 origin preflight。

- [x] **步骤 1：编写 exact proof variant/identity、action matrix、dirty 闭环和 crash-point RED**。
- [x] **步骤 2：运行 RED**：`node --test test/managed-workspace-publish-apply.integration.mjs test/managed-workspace-service.integration.mjs`，预期因新 service methods 缺失而 FAIL。
- [x] **步骤 3：实现 strict proof adapter，以及 action-specific token 消费与 intent 的原子 ledger transitions**。
- [x] **步骤 4：实现 publish 后 release、blocked dirty release 和显式 discardChanges authority gate**。
- [x] **步骤 5：运行 GREEN 与 reminder 回归**：`node --test test/managed-workspace-publish-apply.integration.mjs test/managed-workspace-service.integration.mjs test/subagent-workspace-completion-reminder.test.mjs`，预期 PASS。

### Task 8（DEFERRED）：将 Goal coordinator 接到内部 IR 和 publish/apply bridge

**状态：** 本地不启用 Goal，本任务移出主线，不在本计划实现。Goal 保持 exact-eight 工具、历史 generation、`planned.v1` 与 `dispatch-ir.v1` replay 不变量；现有 Goal workspace 集成继续使用 v1 冻结 disposition。若将来本地启用 Goal，另立计划并先满足 `docs/superpowers/plans/2026-08-13-goal-obligation-runtime.md` 的 R13 验收，再按以下原设计实现。

**Deps：** `T4`（理由：消费 shared execution service）、`T7`（理由：消费稳定 publish/apply service ABI）

**WritePaths：**
- `src/goal-engine/dispatch.ts`
- `src/goal-engine/run-binding.ts`
- `src/goal-engine/managed-workspace.ts`
- `src/goal-engine/events.ts`
- `src/goal-engine/store.ts`
- `src/goal-engine/extension.ts`
- `test/goal-engine-dispatch.integration.mjs`
- `test/goal-engine-workspace.integration.mjs`
- `test/goal-engine-extension.integration.mjs`
- `test/goal-engine-v1-replay.test.mjs`

**Resources：** `Goal integration fixture store；同一 fixture 目录不得并发`

**Files：**
- Create：Goal v1 replay test。
- Modify：Goal compiler、binding、workspace adapter、events/store/coordinator 和 integration tests。

**接口契约：**
- Consumes：`dispatchExecution`、Goal ticket、`ManagedWorkspaceRequestV2`、publish/apply receipts。
- Produces：source discriminator 为 `goal-coding-v1` 且带独立 Goal binding hash 的 internal execution request；独立 `workspace_publish_requested/completed` 与 `workspace_apply_requested/completed` event；exact receipt recovery。

**验收标准：** Goal coordinator 将 coding contract 和 ticket 交给 subagent-owned internal coding adapter，再进入 shared execution service；不得直接 spawn workflow，也不得通过 caller-visible generic shape 自报 Goal authority；shared service 不解析 Goal projection；executor/run criteria 可进入 coding prompt，coordinator-only terminal/workspace predicates 只能留在 Goal authorization/settlement；exact-eight 工具不变；历史 generation 和 `dispatch-ir.v1` replay 不变；append 失败重试不重复 Git 副作用。

- [ ] **步骤 1：编写 Goal internal IR、publish/apply receipt 和 replay RED**。
- [ ] **步骤 2：运行 RED**：`node --test test/goal-engine-dispatch.integration.mjs test/goal-engine-workspace.integration.mjs test/goal-engine-v1-replay.test.mjs`，预期因新 bridge/events 缺失而 FAIL。
- [ ] **步骤 3：实现 Goal compiler 和 authorization/ticket exact binding**。
- [ ] **步骤 4：实现 publish/apply intents、receipts、projection 和 missing-receipt recovery**。
- [ ] **步骤 5：运行 GREEN 与 coordinator 回归**：`node --test test/goal-engine-dispatch.integration.mjs test/goal-engine-workspace.integration.mjs test/goal-engine-extension.integration.mjs test/goal-engine-v1-replay.test.mjs`，预期 PASS。

### Task 9：升级 administration 和 reconcile

**Deps：** `T7`（理由：消费新 action/state/receipt 语义）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/administration.ts`
- `packages/pi-subagents-enhanced/src/workspace/ledger.ts`
- `scripts/worktree-lifecycle.ts`
- `test/worktree-lifecycle-cli.test.mjs`
- `test/managed-workspace-administration.test.mjs`

**Resources：** `none`

**Files：**
- Create：administration focused test。
- Modify：admin service、v2 ledger recovery challenge API、CLI 和 CLI tests。

**接口契约：**
- Consumes：v1/v2 ledger、publish/apply/discard/release intents 和 receipts。
- Produces：只读 inventory；ledger-issued recovery challenge；per-lease authorization apply；published ref 和 orphan intent reconciliation。Challenge 使用 ledger generation、plan hash、随机 nonce hash、expiry 和 consumed-at，在 ledger lock 内一次性消费，不引入长期签名密钥。

**验收标准：** audit 不产生副作用；reconcile 不按 TTL/clean/目录存在性删除；中断 publish/apply 可幂等确认或按 CAS rollback；recovery challenge 不可跨 generation、过期或重放；dirty destructive cleanup 必须有显式 lease authorization；输出不泄露 Git 管理的敏感信息。

- [x] **步骤 1：编写 interrupted publish/apply 和 dirty cleanup authorization RED**。
- [x] **步骤 2：运行 RED**：`node --test test/worktree-lifecycle-cli.test.mjs test/managed-workspace-administration.test.mjs`，预期因 v2 recovery plan 缺失而 FAIL。
- [x] **步骤 3：实现 inventory/plan/apply v2 和 v1兼容读取**。
- [x] **步骤 4：运行 GREEN**：重复步骤 2 命令，预期 PASS。
- [x] **步骤 5：运行 dry-run CLI fixture，确认未发生 Git mutation**。

### Task 10：收敛 public tool、TUI renderer 和 Skills

**Deps：** `T4`（理由：消费统一 public delegation adapter）、`T7`（理由：消费新 workspace actions 和 details）

**WritePaths：**
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- `packages/pi-subagents-enhanced/extensions/custom-footer.ts`
- `packages/pi-subagents-enhanced/src/workspace/tool.ts`
- `packages/pi-subagents-enhanced/src/tui/compact-rendering.ts`
- `src/goal-engine/tool-renderer.ts`
- `skill-overrides/subagent-dispatch/SKILL.md`
- `skill-overrides/using-goal-engine/SKILL.md`
- `test/subagent-workspace-tool.test.mjs`
- `test/subagent-compact-rendering.test.mjs`
- `test/custom-footer-subagents.test.mjs`
- `test/goal-engine-tool-renderer.test.mjs`
- `test/subagent-dispatch-skill.test.mjs`

**Resources：** `none`

**Files：**
- Modify：runtime tool registration、workspace control tool、renderers、Skills 和 focused tests。

**接口契约：**
- Consumes：generic 五段 prompt schema、coding contract、workspace `status/publish/apply/discard/preserve/release` details、completion reminder。
- Produces：唯一 public tool ABI；model-visible action token、allowed actions、blocked reasons 和 artifact receipt；TUI-only compact rendering。

**验收标准：** public contract 不出现 kind；generic 的五个 prompt 字段全部必传，optional 字段均有 runtime/result consumer test；Skill 引导 executor 使用 coding contract、reviewer 使用 generic + `worktree:false`，但 runtime 不按 agent name 授权；自由文本 generic 和 `dispatch-ir.v1` replay adapter 不改变历史记录；删除失效 `subagent({action:"workspace_status"})` 文案；renderer 不改写 details；completion reminder 指向 `subagent_worktree status`。

- [x] **步骤 1：编写 public schema、model-visible details 和 stale Skill ABI RED**。
- [x] **步骤 2：运行 RED**：`node --test test/subagent-workspace-tool.test.mjs test/subagent-compact-rendering.test.mjs test/subagent-dispatch-skill.test.mjs`，预期因旧 action/schema 文案而 FAIL。
- [x] **步骤 3：接入 structured generic/coding public adapter 和 workspace actions，保留 legacy replay decode**。
- [x] **步骤 4：更新 renderer 与两份 Skill，保持原始 payload 不变**。
- [x] **步骤 5：运行 GREEN**：`node --test test/subagent-workspace-tool.test.mjs test/subagent-compact-rendering.test.mjs test/custom-footer-subagents.test.mjs test/goal-engine-tool-renderer.test.mjs test/subagent-dispatch-skill.test.mjs`，预期 PASS。

### Task 11：建立 standalone harness 端到端矩阵

**Deps：** `T4`（理由：需要 shared execution service）、`T6`（理由：需要 publish/apply Git primitive）、`T9`（理由：需要 recovery plane）、`T10`（理由：需要 public tool ABI）

**WritePaths：**
- `test/subagent-delegation-workspace.e2e.mjs`
- `test/fixtures/managed-workspace-v1/**`
- `test/fixtures/managed-workspace-v2/**`
- `package.json`

**Resources：** `真实临时 Git repositories；该任务测试串行运行`

**Files：**
- Create：standalone E2E、v1/v2 fixtures。
- Modify：根测试脚本，增加 focused harness 命令。

**接口契约：**
- Consumes：standalone 前驱公开 ABI 和 durable records。
- Produces：`npm run test:delegation-workspace-harness`；该 script 显式枚举 generic prompt security、authorization confinement、v1 golden replay、Git publish/apply、terminal proof、双进程 token、crash injection 和 standalone E2E，不依赖宽泛 glob 隐式纳入；跨入口、跨进程、跨 session 的完整证明矩阵。Goal E2E 不在本任务范围（T8 deferred）。

**验收标准：** 覆盖 reviewer structured generic 与 executor coding contract；Skill 选择正确且 profile 不提权；dirty source allocation/publish；dirty workspace snapshot/release/restore；origin clean apply；并行同 base 顺序 apply；repository lock/CAS 外部漂移；hook/filter/symlink/gitlink 门禁；foreign owner 拒绝；terminal proof 全 variant 与 identity mismatch；双进程 token stale/replay；effect-complete/receipt-missing；进程重启 reconcile；v1 bytes/hash/mutation/completion/disposition golden replay。Goal receipt append failure 不在本任务范围（T8 deferred）。

- [x] **步骤 1：编写 standalone 全链路 E2E RED**。
- [x] **步骤 2：运行 RED**：`node --test test/subagent-delegation-workspace.e2e.mjs`，确认每个失败对应缺失链路而非 fixture 非法数据。
- [x] **步骤 3：只修复 E2E 暴露的 production 可达缺口；fixture-only 异常只修 fixture/harness**。
- [x] **步骤 4：将全部新增 security/replay/crash tests 显式写入 script 并运行 GREEN**：`npm run test:delegation-workspace-harness`，预期 PASS，输出逐个列出被执行文件。

### Task 12：pre-cutover 全量验收和迁移说明

**Deps：** `T11`（理由：消费完整 E2E 证据）

**WritePaths：**
- `docs/plans/2026-09-10-unified-delegation-workspace-harness.md`
- `docs/summaries/2026-09-10-unified-delegation-workspace-harness-verification.md`

**Resources：** `none；禁止启动 Goal runtime`

**Files：**
- Create：中文验证总结。
- Modify：本计划复选框和最终证据链接。

**接口契约：**
- Consumes：T1-T11（standalone）测试证据、migration/replay records、known baseline failures。
- Produces：可审计的 standalone pre-cutover 验收报告、legacy adapter 退役条件；Goal cutover 不在本计划范围。

**验收标准：** focused、workspace、standalone harness、typecheck 和 package verification 全部通过；没有把 baseline failure 隐藏为本改造成功；不启动 Goal runtime；报告明确写出 Goal cutover（T8/T13）已 deferred，不能宣称 Goal production cutover 完成。

- [x] **步骤 1：运行合同与 workspace focused tests**

  运行：`node --test test/subagent-generic-prompt-contract.test.mjs test/subagent-generic-prompt-contract-security.test.mjs test/subagent-execution-contract.test.mjs && npm run test:subagent-workspace`

  预期：PASS。

- [x] **步骤 2：运行 standalone harness tests**

  运行：`npm run test:delegation-workspace-harness`

  预期：PASS。

- [ ] **步骤 3：运行静态与 package 验证**

  运行：`npm run typecheck && npm run verify:subagents-enhanced`

  预期：PASS。

- [x] **步骤 4：核对工作树和迁移证据**

  记录变更文件、v1/v2 fixture、published refs、reconcile receipt 和所有已知 baseline failure；不得修改或清理用户原有 dirty。

- [ ] **步骤 5：请求执行后 reviewer 授权并审阅**

  先向用户取得针对本次执行后审阅的明确批准，再 inline 完成执行后审阅（不派发 subagent，因 provider 不稳定）；review findings 修复后重复步骤 1-3。计划编写阶段的 reviewer 批准不得复用于执行后审阅。

### Task 13（DEFERRED）：R13 后 fresh Host smoke 与 production cutover

**状态：** 本地不启用 Goal，本任务移出主线，不在本计划实现。Goal fresh Host smoke 与 production cutover 依赖 Goal runtime，须待本地启用 Goal 并满足 `docs/superpowers/plans/2026-08-13-goal-obligation-runtime.md` 的 R13 验收后另立计划。以下为原设计保留。

**Deps：** `T12`（理由：消费 pre-R13 全量验收报告）、`E1`（理由：消费 `docs/superpowers/plans/2026-08-13-goal-obligation-runtime.md` 的权威 R13 已通过状态）

**WritePaths：**
- `docs/summaries/2026-09-10-unified-delegation-workspace-harness-verification.md`

**Resources：** `fresh Pi Host；最多 1 个验证进程`

**Files：**
- Modify：验证总结中的 fresh Host smoke、cutover 和 residual risk 记录。
- Test：fresh Host 的 tool inventory、executor/reviewer dispatch 和 workspace lifecycle smoke。

**接口契约：**
- Consumes：T12 报告和 E1 权威验收状态。
- Produces：production cutover receipt；exact-eight Goal ABI、structured generic reviewer、coding executor 和 managed workspace publish/apply 的 fresh Host 证据。

**验收标准：** E1 不满足时任务不可调度；fresh Host 不加载历史 extension instance；Goal ABI exact-eight；reviewer/executor Skill 路由正确；source dirty publish 与延迟 apply smoke 通过；失败时保留现场并回退配置，不改写历史 ledger。

- [ ] **步骤 1：验证 E1 权威状态并记录版本/Host identity**。
- [ ] **步骤 2：启动 fresh Host，检查 exact-eight Goal ABI 与 public subagent schema**。
- [ ] **步骤 3：运行 reviewer generic 和 executor coding 最小 smoke，不使用 Goal Engine 编排本任务自身**。
- [ ] **步骤 4：运行 source dirty publish、origin clean apply 和 receipt recovery smoke**。
- [ ] **步骤 5：写入 production cutover receipt、失败现场或残余风险**。

### Task 14：为 stream_read_error 增加安全的 provider stream recovery

**Deps：** `none`（理由：只依赖 pinned runner 的现状归因，不依赖 workspace/Goal 改造；T12 消费其验证结果）

**WritePaths：**
- `docs/bugs/2026-09-10-subagent-stream-read-error-retry-gap.md`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/ordered-models-runtime-patch.ts`
- `test/subagent-stream-read-error-retry.test.mjs`
- `test/subagent-ordered-models-runtime.test.mjs`

**Resources：** `none`

**Files：**
- Create：中文 production provenance bug 记录、stream recovery regression test。
- Modify：已存在的 ordered-models runtime patch 入口及其测试。

**接口契约：**
- Consumes：pinned `pi-subagents@0.62.0` runner 的 provider failure 分类、`modelAttempts` loop、abortable wait 和 ordered model candidates。
- Produces：仅对精确 `stream_read_error` 的 `recoverProviderStream` 行为；每个 recovery episode 最多 3 次 provider attempt（初次 + 2 次同模型 retry），使用 250ms/750ms 可中止退避；不改变既有 5xx/rate-limit model fallback。

**验收标准：** 首 token 前、无 assistant 可见输出、usage、tool call、mutation evidence、supervisor wait、stop、interrupt、timeout 时才允许同模型重试；任一不满足即一次 terminal failure；三次失败只发送一次最终 completion；第三次成功只产生一次 logical completion/final result；stream recovery 不切换模型、不重派 detached task；保留现有 server/rate-limit fallback；无法确认错误来源的其他 stream error fail closed。

- [x] **步骤 1：记录 provenance 和分类**

  记录 `model-fallback.ts` classifier 未包含 `stream_read_error` 的首个偏离点、runner 到 result-watcher/notifier 的调用链，并明确 provider stream reader 的产生位置当前为 unknown，不据此扩大兼容。

- [x] **步骤 2：编写 RED**

  在 `test/subagent-stream-read-error-retry.test.mjs` 覆盖首 token 前三次尝试、第三次成功、三次失败、tool/output/usage/mutation/abort/stop/timeout 禁止重试、模型不切换、单次通知和 server/rate-limit 原有 fallback。

- [x] **步骤 3：运行 RED**

  运行：`node --test test/subagent-stream-read-error-retry.test.mjs`

  预期：FAIL，原因是 pinned runner 当前将 `stream_read_error` 作为不可重试 terminal failure；不能以 dispatch wrapper 重跑整个任务替代该 RED。

- [x] **步骤 4：实现最小 provider stream recovery**

  在项目已有 `ordered-models-runtime-patch.ts` 注入入口实现同模型 stream recovery；沿用 abort/stop/timeout signal；retry 次数、退避和 evidence gate 必须是 runner 层逻辑，不能通过重复 workspace allocation 或 RPC detached spawn 实现。

- [x] **步骤 5：运行 GREEN 与回归**

  运行：`node --test test/subagent-stream-read-error-retry.test.mjs test/subagent-ordered-models-runtime.test.mjs test/subagent-runtime-membrane.test.mjs`

  预期：PASS；既有 ordered model candidate 顺序、runtime membrane 和 completion notifier 语义不变。

### Task 15：将全部测试运行时副作用隔离到 tmp

**Deps：** `none`（理由：测试 harness 修复与 contract/workspace 生产实现独立；T12 消费其验证结果）

**WritePaths：**
- `docs/bugs/2026-09-10-test-session-side-effects-leak-into-repository.md`
- `test/**`

**Resources：** `真实临时目录；涉及进程级环境变量的测试串行运行`

**Files：**
- Create：中文 fixture-only 问题记录、仓库副作用回归测试。
- Modify：泄漏 session/lease/registry/workspace/Goal state 或临时仓库的 integration tests 与共享 test helpers。

**接口契约：**
- Consumes：Node `tmpdir()/mkdtemp()`、`t.after()`/`finally`、现有 child-process env builders。
- Produces：统一 test runtime root helper；每个测试显式设置 `PI_CODING_AGENT_SESSION_DIR`、`PI_SESSION_OWNER_REGISTRY`、`PI_CODING_WORKSPACE_DIR`、`PI_CODING_GOAL_DIR` 等适用目录；进程退出后递归清理。

**验收标准：** 测试运行前后仓库 `pi/sessions`、`var/sessions`、`.state` 和其他 runtime state 路径的文件集合完全不变；所有测试副作用位于 `os.tmpdir()` 下的唯一测试根目录；并发测试不共享目录；失败/超时/abort 路径也执行清理；不得通过新增 production fallback 或仅添加 `.gitignore` 掩盖泄漏。

- [x] **步骤 1：记录 fixture-only provenance 并建立 RED**

  记录泄漏入口、缺失的 `PI_CODING_AGENT_SESSION_DIR`/cleanup、目录命名证据和完整 test spawn 调用链；RED 在隔离临时 clone/fixture 中运行相关测试，并断言仓库 runtime 路径出现新增文件。

- [x] **步骤 2：盘点所有测试副作用目录**

  搜索 `SessionManager.create`、Pi child spawn、session-dir、workspace/Goal/registry env 和仓库相对 state path；形成测试到 tmp root 的映射，不读取 session 内容。

- [x] **步骤 3：最小修改 test harness**

  每个测试使用 `mkdtemp(join(tmpdir(), "pi-...-"))`，将所有 runtime env/CLI 参数指向其子目录，并在 `t.after` 或 `finally` 清理；共享行为抽到 test helper，不修改 production launcher 默认路径。

- [x] **步骤 4：运行 GREEN**

  运行泄漏相关 focused integration tests；预期 PASS，且仓库 runtime 路径前后快照无变化。

- [x] **步骤 5：运行全测试副作用审计**

  在测试前后比较 `git status --short --untracked-files=all -- pi/sessions var/sessions .state` 和 inode/path 快照；预期没有新增项。现有历史残留不在测试中删除，待用户单独授权清理。

## 迁移与退役条件

1. Structured generic contract 作为新 canonical public ABI；自由文本 generic 只用于历史 replay，不再扩展 optional prompt 字段。
2. Goal generation 保持现状：历史 generation 继续读取原 `dispatch-ir.v1` 和原 hash，exact-eight 工具与 v1 replay 不变。Goal internal execution request（`goal-coding-v1`）属 T8 deferred，本地不启用 Goal 时不实现。
3. Workspace request v1 只读兼容且继续走冻结 v1 disposition；新 allocation 只写 v2 policy。活跃 v1 lease 完成前不得删除 adapter，也不得映射为 publish/apply。
4. Publish/apply 只服务 v2 lease；origin dirty 时 publish 成功并返回 apply blocked reason，published artifact 不回滚。
5. Policy 固定 `application:allowed => publication:allowed && writePaths非空`；generic reviewer 默认 publication/application 均 forbidden，coding executor 是否允许由 Host grant 决定而非 agent name。
6. 只有 inventory 证明不存在活跃 v1 lease、历史 replay suite 通过，才可另立计划删除 legacy adapters；Goal fresh Host 验证（T13）已 deferred，不作为 standalone legacy adapter 退役的前置。
7. Published ref 的保留和删除必须有 receipt、ref CAS 和显式动作；不得由 workspace release、TTL 或 branch cleanup 隐式删除。

## 计划自检

- 规格覆盖：统一 contract、profile 角色边界、Goal internal IR、authorization、workspace policy、dirty、publish/apply、terminal proof、处置、恢复、TUI/Skill 和 E2E 均映射到具体任务。
- 类型一致性：`GenericPromptContract`、branded `AuthorizedDispatch`、`ManagedWorkspacePolicy`、`PublishedArtifactReceipt` 在生产者与消费者之间只有一个 owner。
- DAG 一致性：T2/T3/T5 可并行；共享热点 `extension.ts`、`service.ts`、`extension.ts` Goal bridge 分属串行前后任务；E2E 只在 ABI 稳定后汇合。
- 数据分类：所有新增 fallback 前置 T1 provenance；E2E 中 fixture-only 数据不得推动 production 兼容。
- 安全边界：没有 profile/request 提权、raw Git、自动 source dirty 处理、未经 proof/token 的 destructive action 或 Goal 第九工具。
