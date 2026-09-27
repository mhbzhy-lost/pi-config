# Pi 0.86.0 兼容性升级实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**目标：** 在与计划一独立的 candidate 中验证 Pi 核心 `0.86.0`，不消费计划一的新接口；以证据决定接受、回滚或阻断。

**架构：** 只在 `/tmp` 或受管 worktree 的 candidate 隔离目录读取/安装依赖；真实根 manifest/lock 不作为 candidate WritePaths。source dirty 不自动 integrate，失败只丢弃 candidate 并清理 allowlist 内的 `node_modules`、cache、temp，随后验证 registry、manifest、lock、`npm ls` 和 `git diff`。

**技术栈：** Node.js `>=22.19.0`、npm lockfile、TypeScript、Node `node:test`、Pi Extension API、`pi-subagents@0.62.0`。

## 全局约束

- 本计划与 `2026-09-20-subagent-orphan-recovery.md` 独立，不消费其新接口或实现状态。
- 当前 baseline 为四个 Pi 核心包 `0.85.1`；四包 candidate 必须统一 `0.86.0`。
- 公网可用、内网未同步、A-B 差异均为待 candidate 任务重新验证的假设；必须保存命令和证据，不把历史描述当事实。
- candidate 只能在 `/tmp` 或受管 worktree；真实根 manifest/lock 不得列入 candidate WritePaths，不自动 integrate dirty source。
- registry 只用显式 `--registry=https://registry.npmjs.org`；不改正式 registry、`pi/settings.json` 或 `enabledModels`。
- `pi-subagents` 固定 `0.62.0`；TypeBox 直接依赖保持 baseline，不强制 dedupe。
- 本计划与孤儿恢复计划独立；不消费其 ExecutionLease、rebind、replay 或 scheduler 新接口，候选验证只使用现有公开入口。
- hard gate 状态仅为 `passed`、`blocked-unknown`、`failed-regression`；vanilla child 未验证必须 `blocked-unknown`，`blocked-peripheral` 不能 accepted。
- 先 hard gate，后外围专项；失败只丢弃 candidate 并按 allowlist 清理 node_modules/cache/temp，保留证据。
- 路径使用 `pi/extensions/openai-codex-proxy.ts`、`pi/extensions/compact-tools.ts`、`src/session-owner/**`、`packages/pi-subagents-enhanced/src/tui/**`；补充 scheduler 专项，且 scheduler 只能验证正确路径、触发/取消/恢复/重复调度，不借用计划一的新接口。
- 不添加提交步骤。

## DAG

```text
T1 baseline/环境证据 ──┬──> T2 public candidate
                     └──> T3 audit/contract
T2 ──┬──> T4 isolated candidate install
T3 ──┘
T4 ──> T5 subagent hard gate ──> T6 peripheral+scheduler audit ──> T7 final gate/report
```

依赖理由：T1 提供可重复 baseline；T2 验证 registry/package metadata，T3 验证 API 风险且提供 contract；T4 只有两者证据齐全才创建 candidate；T5 先于外围；T6 产出专项证据；T7 根据全部报告决定状态并验证清理。

## Waves

- **Wave 1：** T1
- **Wave 2：** T2、T3（可并行，WritePaths 分离）
- **Wave 3：** T4
- **Wave 4：** T5
- **Wave 5：** T6
- **Wave 6：** T7

**关键路径：** `T1 → T2/T3 → T4 → T5 → T6 → T7`。

---

### Task 1：记录 baseline 与 source dirty 证据

**Deps：** `none`

**WritePaths：** `/tmp/pi-086-candidate/<runId>/baseline.json`、`/tmp/pi-086-candidate/<runId>/baseline.md`

**Resources：** `none`

**Files：** Create candidate 临时 JSON/Markdown；Inspect only 根 manifest/lock、`npm config get registry`、`git status --short`。

**接口契约：** Produces 四核心包版本、`pi-subagents`、TypeBox、Node、registry、dirty source、vanilla extension load 和 vanilla child runtime=`blocked-unknown` 字段；不消费计划一。

**验收标准：** baseline 可复现且证据含命令输出摘要；dirty source 只记录，不自动 integrate。

- [ ] **步骤 1：编写失败测试**：临时 collector 未生成完整字段时测试失败。
- [ ] **步骤 2：运行 RED**：`node --test test/pi-086-baseline.test.mjs`，预期缺字段失败。
- [ ] **步骤 3：编写最小实现**：测试允许的临时脚本读取公开 manifest/lock，不写根目录。
- [ ] **步骤 4：运行 GREEN**：同命令。
- [ ] **步骤 5：验证**：`git diff -- package.json package-lock.json pi/settings.json`，不得有本任务写入。

### Task 2：重新验证公网可用性与内网同步状态

**Deps：** `T1`（消费 baseline registry 证据）

**WritePaths：** `/tmp/pi-086-candidate/<runId>/registry-evidence.json`、`/tmp/pi-086-candidate/<runId>/registry-evidence.md`

**Resources：** npm 公网/内网网络；最多 1 个并发。

**Files：** Create 临时证据文件；不修改仓库文件。

**接口契约：** Produces 四包 `0.86.0` metadata、tarball integrity、公网/内网结果、命令和时间戳；公网可用或内网未同步仅在本次查询证实后记录。

**验收标准：** 显式 registry 查询成功或明确失败；默认 registry 查询前后相同；失败不进入 T4。

- [ ] **步骤 1：编写失败测试**：未存在四包 metadata 时 contract 测试失败。
- [ ] **步骤 2：运行 RED**：`PI_PUBLIC_REGISTRY=https://registry.npmjs.org node --test test/pi-086-candidate.test.mjs`。
- [ ] **步骤 3：编写最小实现**：临时脚本执行 `npm view --registry` 并保存 integrity。
- [ ] **步骤 4：运行 GREEN**：同命令，四包均为 `0.86.0` 或输出明确阻断。
- [ ] **步骤 5：验证**：`npm config get registry`，结果未改变。

### Task 3：兼容 API 审计与 contract collector

**Deps：** `T1`（消费 baseline）

**WritePaths：** `/tmp/pi-086-candidate/<runId>/audit.json`、`/tmp/pi-086-candidate/<runId>/audit.md`

**Resources：** `none`

**Files：** Create 临时报告；Inspect only `pi/extensions/openai-codex-proxy.ts`、`pi/extensions/compact-tools.ts`、`src/session-owner/**`、`packages/pi-subagents-enhanced/src/tui/**`、scheduler 实现和现有 compat 入口。

**接口契约：** Produces 每项 risk 的真实路径、公开 API、测试命令、provenance 分类、阻断条件；collector 只能调用已定义公开命令/测试，不引用未定义公开函数。

**验收标准：** 重新核对 A-B 差异、deep import、`TranscriptContext`、tool JSON、SessionManager、TUI、scheduler；vanilla child 保持 `blocked-unknown`，不伪造通过。

- [ ] **步骤 1：编写失败测试**：缺任一路径或 contract 字段即失败。
- [ ] **步骤 2：运行 RED**：`node --test test/pi-086-audit.test.mjs`。
- [ ] **步骤 3：编写最小实现**：静态扫描和公开 changelog 对照，生成临时报告。
- [ ] **步骤 4：运行 GREEN**：同命令，风险明确通过/阻断。
- [ ] **步骤 5：回归**：`npm run typecheck:subagents-enhanced`。

### Task 4：创建隔离 candidate 并核验依赖

**Deps：** `T2`（公网 metadata/integrity）；`T3`（audit contract 无 hard blocker）

**WritePaths：** `/tmp/pi-086-candidate/<runId>/worktree/**`、`/tmp/pi-086-candidate/<runId>/cache/**`、`/tmp/pi-086-candidate/<runId>/report.json`

**Resources：** 临时 worktree/prefix/cache；npm 安装最多 1 个进程。

**Files：** Candidate 副本内 manifest/lock；真实根 manifest/lock 不得写入。

**接口契约：** Produces 四核心包统一 `0.86.0`、`pi-subagents 0.62.0`、TypeBox baseline、candidate `npm ls` 和 manifest/lock 一致性证据。

**验收标准：** candidate 安装失败即清理并保留失败报告；source dirty 不 integrate；成功后验证 `npm ls --depth=0`、manifest、lock、registry、根 `git diff`；candidate 与 source 隔离，失败仅回滚/丢弃 candidate，不回滚或改写生产源文件。

- [ ] **步骤 1：编写失败测试**：candidate manifest/lock 不一致时 contract 测试失败。
- [ ] **步骤 2：运行 RED**：`node --test test/pi-086-dependency-contract.test.mjs`。
- [ ] **步骤 3：编写最小实现**：只在隔离目录执行 npm，显式公网 registry。
- [ ] **步骤 4：运行 GREEN**：同命令并保存 `npm ls`。
- [ ] **步骤 5：回归**：`git diff -- package.json package-lock.json pi/settings.json` 必须无本任务变更。

### Task 5：subagent hard gate（含 vanilla child 状态）

**Deps：** `T4`（消费 candidate lock 和安装证据）

**WritePaths：** `/tmp/pi-086-candidate/<runId>/hard-gate.json`、`/tmp/pi-086-candidate/<runId>/hard-gate.md`

**Resources：** Pi Host、child process、Supervisor channel；最多 1 个并发。

**Files：** Create 临时报告；Inspect only 现有合法 public/typed probes。

**接口契约：** Produces gate 状态 `passed|blocked-unknown|failed-regression`，覆盖 RPC ready、spawn、async-started、completion、terminal、Supervisor request/pending/reply/resume、owner ACK、provenance、vanilla extension load/child。

**验收标准：** hard gate regression 明确失败；vanilla child 未验证只能 `blocked-unknown`；`blocked-peripheral` 不存在于 accepted 结论；hard gate 未 passed 不得运行 T6。

- [ ] **步骤 1：编写失败测试**：缺 completion/attention/owner ACK 或 vanilla child 证据时测试失败/blocked。
- [ ] **步骤 2：运行 RED**：`node --test test/pi-086-subagent-hard-gate.test.mjs`。
- [ ] **步骤 3：编写最小实现**：只在 candidate 运行 probes，不改生产白名单。
- [ ] **步骤 4：运行 GREEN**：输出上述三态之一。
- [ ] **步骤 5：回归**：candidate 内 `node --test` 现有 root-broker/completion/recovery probes；失败标记 `failed-regression`。

### Task 6：外围与 scheduler 专项验证

**Deps：** `T5`（仅 `passed` 才可执行；`blocked-unknown` 停止接受路径）

**WritePaths：** `/tmp/pi-086-candidate/<runId>/peripheral.json`、`/tmp/pi-086-candidate/<runId>/peripheral.md`

**Resources：** Provider stub、TUI/PTY、session registry、scheduler harness；每次一个专项资源。

**Files：** 临时测试/报告；Inspect only `pi/extensions/openai-codex-proxy.ts`、`pi/extensions/compact-tools.ts`、`src/session-owner/**`、`packages/pi-subagents-enhanced/src/tui/**`。

**接口契约：** Produces各专项 `passed|blocked-unknown|failed-regression`，覆盖 Provider `TranscriptContext`、compact payload 保真、SessionManager identity、TUI renderer、scheduler 触发/取消/恢复/重复调度。

**验收标准：** peripheral 阻断不能转为 accepted；TUI 不改 runtime payload；session-owner 保持 identity 门禁；scheduler 证据包含时间序列和重复事件结果。

- [ ] **步骤 1：编写失败测试**：每个专项缺证据即失败或 blocked。
- [ ] **步骤 2：运行 RED**：`node --test /tmp/pi-086-candidate/<runId>/peripheral.test.mjs`。
- [ ] **步骤 3：编写最小实现**：只修复有 production provenance 的 API 差异，fixture 问题只修 fixture。
- [ ] **步骤 4：运行 GREEN**：输出专项状态。
- [ ] **步骤 5：回归**：candidate 内 `npm run typecheck` 与现有 session/TUI/scheduler tests。

### Task 7：最终 hard gate、报告与清理

**Deps：** `T5`、`T6`（消费全部状态和证据）

**WritePaths：** `/tmp/pi-086-candidate/<runId>/final-report.json`、`/tmp/pi-086-candidate/<runId>/final-report.md`

**Resources：** 全量 candidate npm/Node 测试；最多 1 个并发。

**Files：** Create 临时最终报告；删除仅 allowlist 内 candidate node_modules/cache/temp；不修改真实根文件。

**接口契约：** Produces `accepted|blocked-unknown|failed-regression`；accepted 需要 hard gate=`passed`、必要外围/ scheduler passed、vanilla child 已验证；blocked-peripheral 只能作为报告内部原因，不能 accepted。

**验收标准：** 失败只丢弃 candidate；清理后验证 registry、candidate manifest/lock、`npm ls`、根 `git diff`；保存清理前证据和失败现场摘要，不留下真实根依赖变更。

- [ ] **步骤 1：编写失败测试**：unknown、regression、peripheral block 均不可 accepted。
- [ ] **步骤 2：运行 RED**：`node --test /tmp/pi-086-candidate/<runId>/final-acceptance.test.mjs`。
- [ ] **步骤 3：编写最小实现**：汇总状态、原子清理 allowlist、保存报告。
- [ ] **步骤 4：运行 GREEN**：accepted 或明确 blocked/failed。
- [ ] **步骤 5：最终验证**：`npm ls --depth=0`（candidate）、`npm config get registry`、`git diff --check`、`git status --short`；根目录无依赖/registry/settings 变更。

## 计划自检

- 占位词扫描：`grep -nE 'F(IXME|XX)' docs/plans/2026-09-20-pi-086-compatibility-upgrade.md` 必须无输出。
- DAG、Deps、Waves、关键路径一致；计划二不依赖计划一新接口。
- 无 commit 步骤；所有 candidate WritePaths 位于 `/tmp` 或受管 worktree，未把真实根 manifest/lock 列为 candidate 写路径。
