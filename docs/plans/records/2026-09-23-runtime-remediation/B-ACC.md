# B-ACC：验收 workspace/proof 批次

- Task ID：`b-acc-workspace-proof`
- 验收对象：B6、B7、B8
- 验收日期：2026-09-23
- 结论：B 批次确定性回归通过；workspace 全套存在 4 个由 A2 workflow 合同删除引起的既有失败，不伪造全绿。

## TDD 适用性说明

本节点只运行验收命令、审计已经存在的生产/测试产物并回写本验收记录，不修改 production behavior、测试或配置；属于纯文档/证据回写，按 `test-driven-development` Skill 的项目规则豁免 RED-GREEN。证据是本次仅创建本文件，且所有行为验证均通过已有专测和 typecheck 完成。

## 受保护路径门禁

任务开始和验收结束均运行：

```text
git status --short pi/agents/reviewer.md pi/settings.json pi/models.json var/workspaces/
```

两次输出均仅显示预存修改：`pi/agents/reviewer.md`、`pi/settings.json`；`pi/models.json` 与 `var/workspaces/` 无输出。预存修改未被触碰。由于 A-ENV 为 degraded，本节点没有调用 supervisor、没有连接 live host，也没有读取 `var/workspaces/`，并将 live 现场相关结论记为环境受限/来源未证实。

## B6/B7/B8 跨模块一致性审计

### B6：状态词表与 service/tool detail

- `packages/pi-subagents-enhanced/src/workspace/ledger.ts`：导出 `MANAGED_WORKSPACE_STATES`、`ManagedWorkspaceState`、`allowedActionsFor`，作为状态词表与 fail-closed action 映射的权威来源。
- `packages/pi-subagents-enhanced/src/workspace/service.ts`：`managedWorkspaceStateFailure` 将 `state`、`allowedActions`、`nextAction` 放入 `detail`；状态转换继续使用 ledger 状态。
- `packages/pi-subagents-enhanced/src/workspace/tool.ts`：工具描述引用权威状态面；未将非 ledger 词当作 workspace state。
- `test/managed-workspace-state-vocabulary.test.mjs`：状态词表、全状态 action 覆盖、service detail、tool 文案 4 项均通过。

### B7：terminal-proof-binding 与 Host 注入边界

- `packages/pi-subagents-enhanced/src/subagent-dispatch/terminal-proof-binding.ts`：`classifyTerminalProofBinding` 在 `src` 中实现；按 `runId` 读取绑定，空绑定返回 `not-applicable`，非法/多绑定或读取异常 fail closed 为 debt；单绑定通过 `buildTerminalProof()` 注入 proof outbox。
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`：仅保留 Host 入口绑定与依赖注入，不承载 proof 分类实现。
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts`：`deliveryOutcome` 显式保留 `not-applicable`，未知 outcome 仍转为 debt。
- `test/subagent-proof-binding-classification.test.mjs`：空绑定、单绑定七字段、非法/多绑定矩阵 4/4 通过；root broker/protocol 回归 51/51 通过（合计该批次 55/55）。既有 492 条 debt 不清理。

### B8：GitFailureDetail、diagnostics、porcelain、UTF-8 与脱敏

- `packages/pi-subagents-enhanced/src/workspace/git-worktree.ts`：`GitFailureDetail` 含 `category/categories/gitStderr/porcelain/gitStatus/args`；`classifyPorcelain` 处理 `-z`、rename/quoted path、unmerged、submodule、ignored；`truncateUtf8` 按 `Buffer` 字节预算；`redactGitText` 同时作用于 stderr、porcelain、args。
- 删除失败路径只读补采 porcelain 后再分类；stderr-only 不猜 dirty/untracked，未知保留 bounded stderr。
- `test/managed-workspace-git-diagnostics.test.mjs`：7/7 通过，覆盖结构化 stderr、porcelain、quoted/space/rename/unmerged/submodule、ignored 优先级、unknown、脱敏及 512 UTF-8 bytes。
- Git apply/publish 定向回归：2/2 通过。
- B6/B8 共享 `test/managed-workspace-contract.test.mjs` 未修改；本验收按资源锁要求串行运行该共享回归。

以上审计未发现 B6/B7/B8 越界修改；本节点自身只写入本文件。

## 确定性验收结果

| 批次 | 命令 | 结果 |
|---|---|---|
| B6 | `node --test test/managed-workspace-state-vocabulary.test.mjs test/managed-workspace-contract.test.mjs` | PASS，10/10 |
| B7 | `node --test test/subagent-proof-binding-classification.test.mjs test/root-subagent-broker-protocol.test.mjs test/root-subagent-broker.test.mjs` | PASS，55/55 |
| B8 | `node --test test/managed-workspace-git-diagnostics.test.mjs test/managed-workspace-git-apply-publish.test.mjs` | PASS，7/7；apply/publish 2/2 |
| 共享/类型 | `npm run typecheck` | PASS（root 与 `packages/pi-subagents-enhanced` 均通过） |

## workspace 全套及失败归因

实际运行一次：

```text
npm run test:subagent-workspace
```

实际结果：32/36 通过，4/36 失败，exit 1。4 个失败均位于 `test/subagent-managed-worktree.integration.mjs`，断言构造的旧合同包含已被 A2 删除的 `workflow` 字段；错误为 `INVALID_CONTRACT: ... unknown field workflow`。这与 B8 Git 诊断无关，属于 A2 已裁决“删除 workflow 且不做兼容层”之后的合同迁移/测试卫生残留。该测试文件不在 B8 WritePaths，本节点不修改它，也不将 workspace suite 的 exit 1 伪造成全绿。

## 环境受限、未清理 debt 与后续前置条件

- **环境受限/来源未证实：** A-ENV degraded；不连接 live host、不读取 `var/workspaces/`，因此 live queue、proof outbox、worktree/records 数量及现场 debt 变化均未验证。不得将现场状态作为本批次测试断言。
- **未清理 debt：** 历史 492 条 proof debt 不在 B6/B7/B8 范围内；B7 只阻止无 workspace 的普通 run 产生新的误判 debt，未宣称历史 debt 已处置。
- **后续 C 前置条件：** C 阶段必须消费本记录的确定性结果；先处理 A2 合同迁移/测试卫生残留（不在 B8 WritePaths），再分别执行 C9/C10/C11/C12。环境依赖套件继续按“通过 / 环境受限未验证 / 真实失败”分类，不得以 live 重启或现场修复替代证据。

## 变更范围与机械检查

- 本节点声明写入范围：`docs/plans/records/2026-09-23-runtime-remediation/B-ACC.md`。
- `git diff --check`：PASS。
- 未执行 `git add/commit/stash/reset/clean/checkout`，无 staged 文件；受保护路径预存状态保持不变。
