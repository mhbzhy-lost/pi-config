# Goal Engine 远端重构后重新基线化与收敛计划

> **执行约束：** 本计划继承用户已批准的无人值守 Subagent-Driven 执行方式。`docs/superpowers/plans/2026-08-13-goal-obligation-runtime.md` 的 R13 全绿并启动 fresh Host 前，禁止用 Goal Engine 编排、执行或验收本计划；只能由 Root Pi 通过普通 user message 派发 subagent。

**目标：** 以 `40976b98b6e1657015051abbf247c3adfcaf7848` 为新的远端基线，恢复可复现初始化，消除 TypeScript/package/workspace 迁移后的真实回归，将既有可选全量无脱敏 runtime trace 与 persisted terminal proof 实验适配新架构，最后在 `openai-codex` provider 的 fresh Pi Host 中完成复杂任务实测。

**当前事实：**

- 远端将 Goal Engine production 实现迁到 `src/goal-engine/**`，将 subagent、Root Broker 与统一 workspace service 迁到 `packages/pi-subagents-enhanced/src/**`。
- `npm run typecheck` 在本机离线恢复 TypeScript 后通过。
- `init-pi.sh` 已完成增强 package 安装、补丁、Skill 同步、shell 集成和 Basic Memory 更新，但全量测试为 `672/675`；两个失败仍从旧 `pi/npm` 解析 `typebox/jiti`，一个失败证明 task-scheduler 的真实 peer 解析与 Doctor 所有权规则冲突。
- `npm run test:goal-engine` 还暴露残留 `src/goal-engine/workspace.mjs` import、临时 mutation fixture 未复制 `events.ts` 依赖、旧 fixture 缺统一 managed-workspace receipt，以及既有实验 diff 引入的 expected criteria 断言漂移。未经 provenance 分类不得修改 production fallback。
- 主工作区已有用户/前序实验改动，禁止 reset、restore、stash、宽泛 stage 或 raw worktree mutation。

## DAG 与 Waves

```text
B0 重新基线与 provenance 冻结
 ├──> B1 初始化/包边界恢复
 └──> B2 Goal 测试迁移恢复
          └──> B3 既有 observability 与 terminal proof 重放
B1 ───────────────────────────────┘
                         └──> B4 R13 分层/全量验收
                                  └──> B5 fresh Pi 复杂 canary
```

- Wave 0：B0。
- Wave 1：B1 与 B2 可并行；写入路径不重叠时才并行派发。
- Wave 2：B3，等待初始化与测试 harness 都可信。
- Wave 3：B4，只读验收；发现 production 缺陷必须回到对应任务补中文问题记录和 RED。
- Wave 4：B5；只通过 RPC user message 控制 Pi，trace 只读观测，不增加控制工具。

## B0：冻结新基线与失败分类

**WritePaths：** `docs/audits/**`、`docs/bugs/**`、本计划。

- [ ] 记录远端 commit、当前 dirty diff、Node/Pi/package 版本和初始化命令。
- [ ] 将每个失败标为：production 可达、测试制造、或 provenance 未证实；记录实际入口、权威身份、事件/资源顺序和首个偏离点。
- [ ] 对历史 worktree 只做 managed audit，不执行删除、release、reanchor 或 raw Git lifecycle。

## B1：以 TDD 修复初始化与 package 运行时闭包

**WritePaths：** `docs/bugs/2026-09-04-*.md`、`scripts/setup-subagent-runtime-deps.ts`、`scripts/doctor.ts`、`test/setup-subagent-runtime-deps.test.mjs`、`test/doctor.test.mjs`、`test/task-scheduler-adapter.test.mjs`、`test/subagent-dispatch-{schema-coercion,validation-errors}.test.mjs`，以及确有必要的 package manifest/lockfile。

- [ ] 先写中文问题记录，证明 normal `init-pi.sh` 后 scheduler import 的 `typebox` 解析失败；旧路径测试只按 fixture 污染处理。
- [ ] RED 必须运行真实 setup fixture 后 import scheduler，并断言 subagent tests 从增强 package compat/依赖闭包加载，不再引用 `pi/npm` 的 retired upstream。
- [ ] 最小 GREEN 必须统一“host peer 所有权”与 Node ESM 实际解析，不靠人工残留 `node_modules`，且不得把 Pi core peer 打进增强 package。
- [ ] 验收：setup/verify、三项原失败测试、Doctor、typecheck；正常重复初始化不得需要额外环境变量。

## B2：以 TDD 修复 Goal Engine TypeScript/workspace 迁移测试

**WritePaths：** `docs/bugs/2026-09-04-*.md`、相关 `test/goal-engine-*.integration.mjs` 与测试 helper；只有证明 production 入口断裂时才修改 `src/goal-engine/**` 或 workspace package public entry。

- [ ] 把残留 `workspace.mjs` import 改为统一 `pi-subagents-enhanced` workspace public contract/测试 service；禁止重建 `src/goal-engine/workspace.*` facade。
- [ ] 修复 mutation/concurrency fixture，使复制到临时目录的 TypeScript 模块拥有完整依赖闭包；不得给 production 添加测试专用 fallback。
- [ ] 对缺 managed receipt、expected criteria 与 suspension authority 的失败逐项证明数据来源；测试手工 projection/旧 fixture 只修 fixture。
- [ ] 验收：迁移相关聚焦测试和 `npm run test:goal-engine` 至少连续两轮结果一致。

## B3：重放并收敛既有实验改动

**WritePaths：** 当前 dirty 的 `src/goal-engine/**`、`pi/extensions/goal-engine.ts`、`packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-*.ts`、对应测试、runtime trace 设计/问题记录。

- [ ] 审核 runtime trace 开关：默认关闭、开启后完整不脱敏、记录全部 tool call/result、Goal event、自动 prompt 注入与 gate 决策；只能观测，不能控制。
- [ ] 用真实新版本 Pi/subagent 产生 `process-terminal.json`，记录 writer、mode、字段与顺序；只有 production 可达证据成立才调整 terminal proof reader/writer。
- [ ] RED 覆盖“内存 terminal event 丢失、持久 sidecar 恢复”，再做最小 GREEN；不得信任 `status.json` 或调用者证明。
- [ ] 清除重构造成的 deep import 与测试注入逃逸，保持八个 goal tools ABI 不变。

## B4：R13 只读验收

**WritePaths：** 仅验收报告/summary；不得在本任务直接修改 production。

- [ ] `npm run typecheck`。
- [ ] Goal Engine、Root Broker、subagent、managed workspace/validation 分层套件全绿。
- [ ] `npm test`、Doctor、Pi Host integration 全绿；任何已知环境限制必须明确列出，不能算 GREEN。
- [ ] 外源只读复审最多两轮；只对有证据的 Critical/Important 回流修复。
- [ ] 核验没有新增 Goal/validation/worktree/process/resource debt，主工作区已有用户改动未被覆盖。

## B5：fresh Pi 复杂任务实测

**前置：** B4 全绿且 Goal Engine 由 fresh Host 加载；provider 必须为 `openai-codex`。

- [ ] 使用足够复杂的多阶段真实任务，流程必须覆盖 `goal_init/status/dispatch/settle/integrate/accept/amend/finalize` 全部八工具。
- [ ] Pi 仅通过 RPC user message 接受初始化、继续、修订或中断；任何额外 typed 接口只允许只读观测。
- [ ] debug 时开启完整不脱敏 trace；关闭时不产生 trace 写入。对照 session JSONL、trace、Goal events、Root Broker 与 workspace ledger。
- [ ] 至少覆盖一次失败/修订/恢复路径和一次正常完成路径；资源、进程与 workspace 全部通过受管协议收尾。
- [ ] 只有终态谓词、资源清零、fresh evidence 和外源复审同时成立，才声明“可投入实验性使用”。
