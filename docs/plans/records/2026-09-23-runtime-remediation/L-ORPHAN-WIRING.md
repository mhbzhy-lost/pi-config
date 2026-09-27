# L-ORPHAN-WIRING：两个 lifecycle 模块接线归属

## 结论摘要

本报告是只读方案探索；除本文件外没有修改源码、测试、package exports、scripts、ALLOWLIST 或 live state。按限定 production roots 检索，两个目标模块的静态 importer 均为 `0`，相对 `import()`/`require()` 动态 importer 也均为 `0`。因此不能把任一模块报告为已接线。

- `src/subagent-dispatch/durable-run-registry.ts`：owner 应为 lifecycle durable/inventory 接线批次（对应总计划 P2-T4 的 durable inventory 责任），但仓内尚无 runtime composition importer、package public export 或 script entry。建议在继续 allowlist 的前提下另立 coding 任务，通过已存在的 lifecycle runtime composition 接线；在接线前不删除。
- `src/workspace/coordinator-process.ts`：候选 owner 是 workspace lifecycle/宿主集成方。它确实可被 Node 直接执行，并有 `PI_COORDINATOR_ENDPOINT` 条件下的顶层启动逻辑；但仓内没有 production loader 证据。测试中的 `spawn` 只证明测试入口，不证明生产宿主。建议继续 allowlist，先取得仓外宿主 loader 的权威证据；证据不足时 fail closed，不接线、不删除。

## 证据范围与方法

读取并对照：统一 DAG 的 `L-ORPHAN-WIRING` 节点、`L-ORPHAN.md`、`test/package-orphan-export-guard.test.mjs`、`docs/plans/2026-09-20-subagent-lifecycle-overall.md`、`docs/plans/2026-09-21-subagent-lifecycle-residuals.md`，以及两个目标模块、`extensions/subagent-runtime.ts`、package manifests 和 scripts。生产 importer 候选范围沿用 guard：

- package：`packages/pi-subagents-enhanced/src`、`extensions`、`child-extensions`、`scripts`
- 仓库：`src`、`pi/extensions`、`scripts`

检查了相对静态 `from` 和相对动态 `import()`/`require()`；测试、docs、handoff、artifact 不计为 production importer。未读取或输出凭据、token、runId 或 session identity。

### 现场门禁

已运行：

- `node --test test/package-orphan-export-guard.test.mjs`：4/4 通过。该 guard 当前 ALLOWLIST 仍包含两个目标条目，故通过不等于已接线。
- `git diff --check`：通过（最终复核）。
- `git diff --cached --name-only`：无输出，当前无 staged 文件。
- A0 / A-ENV degraded 现场约束：本任务未调用 supervisor，未连接或探测 live host/state；只依据仓内静态证据和既有只读记录。

工作区原有大量 dirty 内容；本任务未清理、stash、reset、提交或覆盖这些现场。

## 模块一：`durable-run-registry.ts`

### owner 判定

**建议 owner：lifecycle durable/inventory 接线 owner（总计划 P2-T4 责任域），而非 workspace coordinator 或测试 harness。** 该模块的 `InventoryV1` 保存 authorization、owner、workspace 的 reference 和 provenance，`DurableRunRegistry` 提供 `recordInventory`、`loadInventory`、`markOrphaned`；这与 P2-T4 的 durable inventory contract 语义一致。它不应成为 Root Broker authority、workspace mutation 或 child stop 的 owner。

### 入口与调用链证据

- 文件自身提供 typed entry：`DurableRunRegistry` class 及 `InventoryV1` type export。
- package `exports` 只有 `./dispatch-ir`、`./generic-prompt`、`./workspace`、`./workspace/admin`；没有 registry export。因此它是可被 package 内部 typed import 的候选，不是当前 public API。
- package scripts 只有测试、setup、typecheck、verify；没有 registry launcher/script entry。
- 限定 production roots 中精确静态 importer：`0`；相对动态 importer：`0`。
- 模块自身只依赖 `durable-contract.ts` 与 `durable-storage.ts`；这证明其实现内部依赖，不证明反向 production 调用链。
- `test/durable-lifecycle.test.mjs` 对它的 jiti 动态载入是测试入口，不能作为 production owner 或接线证据。

**当前实际调用链：** 无已证实 production caller → `DurableRunRegistry`。已证实的仅是 test → jiti → registry，以及 registry → durable contract/storage。不能将测试消费升级成 runtime lifecycle 调用链。

### 建议动作

**接线（推荐），暂不删除。** 另立 coding 任务，把它接到明确的 lifecycle runtime composition/恢复 inventory 路径；接线必须使用既定 durable contract，保持 reference-only，不授予 authority，不直接调用 workspace ledger mutate、broker authority 或 child RPC。接线完成并有 production importer 后，才评估移除 ALLOWLIST；若产品决策放弃 inventory 设计，才另立删除任务，先证明所有消费者和契约均不存在。

### 后续 coding 小任务（精确拆解）

- **WritePaths（仅这些）：**
  - `packages/pi-subagents-enhanced/src/subagent-dispatch/durable-run-registry.ts`（仅在确需最小适配时修改）
  - 一个新的、已由任务授权的 lifecycle composition 文件（应先由计划明确具体路径；不得借用 `extensions/subagent-runtime.ts` 作为未经授权的扩展 WritePath）
  - `test/durable-lifecycle.test.mjs`
  - 一个专门验证 production composition 的既有测试文件（路径需在 coding 任务派发时冻结；不能把本只读任务的报告当作授权）
  - 不得修改 `test/package-orphan-export-guard.test.mjs`、ALLOWLIST 或 package exports 作为绕过。
- **RED（断言级）：** 先新增一个真实 composition 测试，装配最小 runtime dependency，断言 lifecycle runtime 在合法 run identity 下调用 registry 的 `recordInventory`，且写入值只含 authorization/owner/workspace reference、provenance，不含 owner token、stop/disposition/settlement。另断言目标文件由 production composition 可达；运行时应因尚无该 importer/接线而以具体 assertion failure 失败，不接受 `ERR_MODULE_NOT_FOUND` 作为 RED。
- **GREEN（最小实现）：** 只新增最小 typed composition importer/adapter；将 registry 注入已存在的 lifecycle durable 路径，维持 opaque references、revision/CAS 和 fail-closed 错误语义；不新增 public export，不借 registry 推导 authority，不接 workspace 私有 ledger，不改 allowlist。
- **聚焦回归：** `node --test test/durable-lifecycle.test.mjs test/subagent-delivery-recovery.test.mjs test/recovery-resume-contract.test.mjs`，随后 `npm run typecheck:subagents-enhanced` 与 `node --test test/package-orphan-export-guard.test.mjs`。
- **hunk/dirty 现场门禁：** 变更前记录 `git status --short`；变更后只允许上述 WritePaths，审查 `git diff -- <WritePaths>`，运行 `git diff --check`，确认 `git diff --cached --name-only` 为空；不得 stash/reset/clean/提交。若出现非 WritePath hunk，停止并保留现场。

## 模块二：`coordinator-process.ts`

### owner 判定

**候选 owner：workspace lifecycle/宿主集成方；当前 owner 未被仓内证据证实。** 该文件属于 workspace coordinator process 边界，不应由 durable registry 或 subagent runtime extension 直接冒领 owner。现有 `extensions/subagent-runtime.ts` 中直接调用的是 `createCoordinatorServer`（同一 workspace 子系统内的 library path），不是 `coordinator-process.ts` 的 importer。

### 入口与调用链证据

- 文件导出 typed function `startCoordinatorProcess(environment)`。
- 它读取 `PI_COORDINATOR_ENDPOINT`、repository/instance/state/capability 等环境配置，创建 `createCoordinatorServer(...)`，监听并注册 SIGTERM/SIGINT 关闭处理。
- 文件末尾有 `if (process.env.PI_COORDINATOR_ENDPOINT) await startCoordinatorProcess()`；因此它**可被 Node 直接执行为 standalone process entry**。
- 但 standalone entry 能力不等于生产 loader：限定 production roots 的静态 importer 为 `0`，动态 `import()`/`require()` importer 也为 `0`。
- package exports 与 scripts 均没有 `coordinator-process` 条目；没有仓内 package public entry 或 launcher script。
- `test/managed-workspace-coordinator.integration.mjs` 通过 child process spawn 直接启动该 TS 文件。这是测试入口，只证明 Node spawn 场景可达，不证明 production external loader。
- 没有发现仓内生产代码通过 `extensions/subagent-runtime.ts`、`scripts` 或其他 launcher 动态加载该文件；`extensions/subagent-runtime.ts` 的 `createCoordinatorServer` 调用不可转移为该文件的 importer 证据。

**当前实际调用链：** 测试 → Node child-process spawn → `coordinator-process.ts` 自启动 → `createCoordinatorServer`；生产 roots → `coordinator-process.ts` 尚无已证实链路。特别区分：`coordinator-process.ts` 可独立 Node 执行，不能据此声称存在生产外部 loader。

### fail-closed 阻塞与取得权威证据的方法

当前 allowlist 理由“由宿主外部动态装载”只是待验证假设，不是调用证据。关闭该阻塞前，必须取得以下至少一条可审计且与发布版本匹配的权威证据，并保留脱敏引用：

1. 宿主仓库/部署 manifest 中明确的 Node argv/module path，证明实际加载此文件；
2. workspace coordinator 的官方 launcher/package entry 或容器/服务启动配置，明确指向该文件并说明 owner、cwd、state-root 与生命周期关闭责任；
3. 受控宿主运行记录中可复核的 module-resolution/argv 证据（仅保留模块名、版本和结果，不记录凭据、完整敏感路径或 raw payload）。

应对证据做版本、环境和 path canonicalization 校验，并证明它不是测试 harness、README、handoff 或 artifact transcript。若仓外宿主无法提供上述证据，保持 `blocked-unknown`：继续 ALLOWLIST，禁止臆造 loader、禁止为了消除孤儿而新增 importer、禁止删除模块前假定它无用。

### 建议动作

**继续保留并保持 allowlist，先取外部宿主证据；不接线、不删除。** 若证实宿主 loader 存在，另立 coding 任务补充最小、明确的 production launcher/adapter（是否需要 package export 由宿主契约决定）；若证实不存在宿主 owner，再另立删除任务，先验证测试和 workspace runtime 是否改用 `createCoordinatorServer` library path，并同步移除失效 allowlist 条目。当前两种动作都不在本报告授权内。

### 后续 coding 小任务（精确拆解）

- **WritePaths（证据确认后才可冻结）：**
  - `packages/pi-subagents-enhanced/src/workspace/coordinator-process.ts`（仅必要适配）
  - 宿主已确认的唯一 launcher/manifest 文件（须在任务派发时以确切仓内路径列出；当前没有可合法指定的仓内生产 importer）
  - `test/managed-workspace-coordinator.integration.mjs`（仅当生产入口契约需新增断言）
  - 不得修改 `test/package-orphan-export-guard.test.mjs` 或 ALLOWLIST 以掩盖未证实 loader。
- **RED（断言级）：** 先基于已取得的权威宿主入口写断言：从受控 launcher 启动后，验证 coordinator process protocol 首行/监听行为来自目标模块，且缺失必需环境变量时 fail closed；同时断言 production launcher 的 module path 精确指向目标文件。若 loader 证据仍缺失，coding 任务不得开始，保持 blocked，而不是伪造 RED。
- **GREEN（最小实现）：** 只实现已证实宿主契约要求的 launcher/adapter 接线，复用 `startCoordinatorProcess`，不改变 coordinator protocol、state ownership 或测试 spawn 语义；若权威结论为无宿主，则最小 GREEN 是删除模块及其测试专用路径的独立删除任务，但必须先有明确决策和完整 consumer 证明。
- **聚焦回归：** `node --test test/managed-workspace-coordinator.integration.mjs test/managed-workspace-service.integration.test.mjs`（以仓内实际存在的 coordinator/service 测试路径为准），`npm run typecheck:subagents-enhanced`，以及 `node --test test/package-orphan-export-guard.test.mjs`。真实宿主 lane 只在获得授权且使用隔离 state root 后运行。
- **仓外 loader provenance 获取门禁：** 由 workspace lifecycle/部署 owner 提供与待审发布版本匹配的宿主仓库 launcher/部署 manifest（脱敏副本或稳定行号引用），核对 Node argv 中的 canonical module path、版本/环境、cwd、state-root、生命周期关闭责任；或提供受控运行时 module-resolution/argv 记录，仅保留模块名、版本及加载成功结果。不得采集、转述或落盘凭据、token、环境变量值或 raw payload。独立复核其非测试 harness、README、handoff、artifact transcript；缺证据继续 `blocked-unknown`。
- **hunk/dirty 现场门禁：** 变更前后执行 `git status --short`；限定 diff 到已批准 WritePaths；`git diff --check` 通过；`git diff --cached --name-only` 为空；禁止清理或提交。任何宿主证据缺失、路径漂移、非目标 hunk 或 live coordinator 绑定均立即 fail closed。

## TDD 与纯文档豁免

本节点只写本指定 Markdown 报告，没有 production、配置、测试或 Skill 行为变更，适用 `test-driven-development` 的“纯文档变更”显式豁免；因此本节点不创建或运行 RED/GREEN coding 测试。为满足后续执行门禁，上文分别给出了后续 coding 的断言级 RED、最小 GREEN、聚焦回归和现场门禁。已运行的 guard 是只读现场验证，不是本节点生产变更的 TDD GREEN。

## Residual risks / manual notes

- 两个 `0 importer` 结论受限于指定 production roots 和静态文本规则，不能证明仓外宿主、发布系统或部署平台不存在调用。
- `coordinator-process.ts` 的 Node 直接执行能力是真实入口形态，但不能替代生产 loader provenance；外部 loader 未证实，D-CLEANUP-RECHECK 对该项应保持 blocked。
- durable registry 有 typed API 和测试消费，但没有 production composition importer；allowlist 只能是暂时豁免，不是 owner 接线完成证明。
- 当前 guard 通过是 allowlist/算法门通过，不是两个 lifecycle 模块均已接线的证明。
- **D-CLEANUP 阻塞判定：阻塞。** `coordinator-process.ts` 仓外宿主 loader provenance/audit 未知，且 registry 仍无 production importer；L-ORPHAN-WIRING 只完成 owner/方案识别，不能替代 D-CLEANUP-RECHECK 要求的 provenance、接口及 transport 证据。至少在 coordinator 外部 loader 证据审计关闭前，D-CLEANUP 必须保持 blocked；若 provenance/audit 任一仍未知不得解除。
- **手工核对记录（manual-notes）：** 对照 guard production roots 与测试入口；逐项核对 package exports/scripts、两个源码的导出/调用、自启动分支及 `extensions/subagent-runtime.ts` 的 coordinator library 调用。结论均未将测试 `jiti`/`spawn`、allowlist 文字、自身 `PI_COORDINATOR_ENDPOINT` 分支视为 production importer。仓外证据只能按上文向宿主 owner 索取脱敏权威引用，不请求或输出凭据。
- 计划审阅证据以现存 L-ORPHAN-WIRING 节点及 lifecycle 总计划 P2-T4 durable inventory 职责为准；A0 guard 文件名在仓内未找到独立文件，guard 证据来自 `test/package-orphan-export-guard.test.mjs`；A-ENV 状态参照 C-ACC 现场记录。
