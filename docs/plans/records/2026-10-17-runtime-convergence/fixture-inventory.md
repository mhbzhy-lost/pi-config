# Fixture / 既有测试迁移清单（F3、R12）

范围：旧 union 工具面（`subagent`、`subagent_worktree`、`subagent_supervisor` + `action` 参数）迁移到 14 个独立操作工具后，既有测试与 fixture 的实际状态。只修改既有测试/fixture，不新增用例；每项都标注实际运行结果或未运行事实。

## 本批已迁移并实际运行

| 文件 | 迁移动作 | 实际结果 |
| --- | --- | --- |
| `test/fixtures/heartbeat-provider.ts` | 新操作工具名；正常 read 工具提供真实 `commandsRun` 证据 | 源码迁移完成；prepare-only Host 未重跑（见 lifecycle-boundaries） |
| `test/fixtures/joint-upgrade/contact-provider.mjs` + `test/joint-upgrade-contact-supervisor.integration.mjs` | 新工具名、required agents-shared symlink、三个 required ACK、durable consumed/replied 等待 | fresh CLI ask/managed 2 场景 exit 0（`/tmp/runtime-convergence-fresh-contact-final2.log`） |
| `test/fixtures/deterministic-provider-state.mjs` | 按实际注册面区分 fresh operation 与 upstream 兼容 probe | 见下“保留的旧名引用” |
| `test/fixtures/recovery-resume/scripted-model-server.mjs` | `subagent` → `subagent_start` | 名称已迁移；对应端到端本批未运行 |
| `test/fixtures/repository-merge-queue-acceptance/root-provider.mjs` | `subagent` → `subagent_start` | 名称已迁移；对应端到端本批未运行 |
| `test/pi-runtime.integration.mjs` | fresh SDK 注册检查迁移到 14 工具 | 1/1 exit 0（隔离 SDK，无网络） |
| `test/subagent-managed-worktree.integration.mjs` | `tools[n]` 位置依赖 → 按工具名；移除旧 `action` 参数 | 5/5 exit 0（`/tmp/runtime-convergence-existing-worktree-migration.log`） |
| `test/subagent-runtime-resource-isolation.test.mjs` | 旧英文 description 断言 → 当前中文合同 | 1/1 exit 0（focused） |
| `test/supervisor-gate-wire.test.mjs` | 复合 tool-call ID（`call_*\|fc_*`）与新 intent 摘要 | 与 footer 联合 59/59，其中 wire 8 项 |
| `test/background-activity-{layout,details}.test.mjs` | footer 空行后的行数/索引/预算断言 | 同上 59/59 联合快照 |
| `test/managed-workspace-service.integration.mjs` | H2 proof 门禁后的状态断言 | 69/69 组合快照内通过 |
| `test/workspace-operation-tools.test.mjs` | 新工具面与固定注入 `action` 的负例 | 69/69 组合快照内通过 |
| `test/subagent-model-selection.integration.mjs` | **本轮新增迁移**：21 处 `tools[0].execute` → 按名解析；两处 `{ action: "list" }` → `subagent_roster` + `{}` | 迁移前 0/23（`INVALID_DISPATCH: subagent_roster received unsupported fields…`，`/tmp/rc-model-selection.log`）；迁移后 **23/23 exit 0**（`/tmp/rc-model-selection-migrated.log`）。生产未改，`MODEL_NOT_AVAILABLE`/`UNKNOWN_AGENT`/`AGENT_ADMISSION_UNAVAILABLE`/`VIRTUAL_MODEL_UNSUPPORTED_BY_DISPATCH` 等断言原样保持并通过 |
| `test/subagent-auto-integration-real-git.integration.mjs` | **本轮新增迁移**：1 处 `tools[0].execute("real-dispatch", …)` → 按名取 `subagent_start` | 迁移前 1 项失败（同 `INVALID_DISPATCH`）；迁移后 **4/4 exit 0**（`/tmp/rc-auto-integration-migrated.log`）。真实临时 git 仓，无网络、无真实 provider |
| `test/operation-guidance-contract.test.mjs` | 只改已授权的模型政策 needle（旧“模型不可用紧急补救”句 → 现行“默认省略 model”“不自主换模”两句） | 11/12；剩余 1 项失败是 profile 白名单冲突，见 `agent-profile-drift.md`，**不得**用放宽断言掩盖 |

## 本轮新增（用户 2026-10-19 授权新增用例）

| 文件 | 覆盖 | 实际结果 |
| --- | --- | --- |
| `test/workspace-disposition-settlement.integration.mjs` | H3/T25A-C：七个新增 settlement 故障窗口（preserve/discard 混合、含 queue 与 resume intent）、workspace-only prepare 补建 intent、startup barrier `COORDINATOR_RECOVERY_NOT_READY` 与只读诊断、跨 repository 分区隔离、不可变字段篡改 fail-closed；全部走 public client/`listen()` 与既有 fault 注入点，不为验证新增生产分支 | **12/12 exit 0**，`/tmp/rc-settlement-windows-3.log`。三轮迭代中的失败都是本用例自身断言错误（socket 名超 `sun_path` 上限、preserve 应保留受管分支、effect-committed 阶段 state 已变更），按类别 2 只修测试；临时 Git/state/socket，无网络、无真实 provider、无 SIGKILL |

## 保留的旧工具名引用（有意，不迁移）

| 文件 | 用途 |
| --- | --- |
| `test/workspace-operation-tools.test.mjs:100-147` | 断言调用方传旧 `action` 时被固定注入/拒绝 |
| `test/subagent-operation-tools.test.mjs:93-166` | 同上，覆盖 14 工具的 `action` fail-closed 矩阵 |
| `test/supervisor-operation-tools.test.mjs:81-176` | supervisor 三工具的内部 action 注入与拒绝 |
| `test/operation-guidance-contract.test.mjs:72-181` | 断言 reminder/notice/源码中不得回流旧 union 名 |
| `test/joint-upgrade-model-only.test.mjs:23-39` | 用例自行注册旧 factory 定义，验证 model-only 与兼容面 |
| `test/deterministic-provider.test.mjs:71-81` | deterministic provider 对 upstream 兼容 probe 的决策，旧名由上游 factory 提供 |
| `test/bash-async.test.mjs:143`、`test/subagent-acceptance-evidence.integration.mjs:43-60` | `tools[0]` 指向各自 harness 唯一注册工具，非 subagent 操作面（后者本轮实跑 3/3 通过） |

## 仍未处理

- `scripts/probes/dispatch-branch-probe.ts:18-19,29`：仍以 `Object.hasOwn(input, "action")` 路由到 control 分支。生产已无 union `action` 入口，该分支是死路径。它是诊断 CLI，不是 runtime 可达文本，也不影响模型面；保留原样并记录，是否删除该 probe 由 owner 决定，本批不擅自扩大 scope。
- `test/fixtures/repository-merge-queue-acceptance/root-provider.mjs`：名称已迁移，并通过其消费方 `test/repository-merge-queue-acceptance-probe.test.mjs` 实际验证：**43/43 exit 0**（`/tmp/rc-merge-queue-probe.log`）。该测试使用 fixture provider 与临时目录子进程，先完成副作用审计（`SIGTERM` 只用于清理自己启动的子进程、只删自己创建的临时目录），无真实 provider、无网络。五-child 真实验收 probe 仍未跑，它明确拒绝 fake model。
- `test/fixtures/recovery-resume/scripted-model-server.mjs`：名称已迁移，但全仓检索（`test`、`scripts`、`packages`、`src`、`package.json`）**找不到任何消费方**，当前是孤立 fixture，无法行为验证。未删除、未为其新增消费方；保留给 owner 决定（相关历史提交 `e3df534`）。同一合同方向的 `test/subagent-auto-integration-resumed-child.integration.mjs` 已实跑 **1/1 exit 0**（`/tmp/rc-resumed-child.log`）。
- 未做全仓 `npm test` / `test:all-integration`：广域回归需用户另行授权与资源窗口；本轮只运行上表列出的聚焦组合。
- 五-child 真实验收 probe（`scripts/probes/repository-merge-queue-acceptance.ts`）**未执行**：它明确拒绝 fake model、需要真实 provider 授权（本轮授权只含新增用例与联网），且要求 `--subagents 5 --require-conflicts ≤ 4`；一次 `--subagents 1` 的参数校验尝试直接以 `require-conflicts cannot exceed subagents - 1` 退出（`/tmp/rc-acceptance-probe-attempt.log`），未启动任何 child。其 `PI_REAL_BIN must identify the real Pi 0.87.1 binary` 文案与本仓当前受支持版本 `1.0.4`（`scripts/probes/pi-subagents-compat.ts:41`）不一致，属陈旧文案，未在本批修改。
- 分组重跑事实：把 28 个文件塞进单个 `node --test` 进程连跑会出现重 Git/proof 用例超时（1 失败、再一次 2 失败 1 取消）；同批文件按合同组/workspace 组/重 Git 三件组分别运行全部 exit 0（143 tests/142 pass/1 todo、131/131、16/16）。分类为长时同进程资源竞争，不是生产回归证据。

## 分类结论

上述所有失败都属**类别 2：测试制造的非预期数据/过期 fixture**——首个偏离点是位置依赖 `tools[0]` 与已移除的 union `action` 参数，均由已提交的 S4 工具面迁移（`operation-tools.ts`，提交 `381f86d`）造成，不是本批未提交生产改动引入：`git diff HEAD -- packages/.../extension.ts` 不含 `subagent_roster`/`registerTool`/`exposure` 变更，`test/subagent-model-selection.integration.mjs` 在迁移前相对 HEAD 无改动。处置只改 fixture，未增加任何生产兼容分支。
