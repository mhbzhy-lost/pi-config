# D-CLEANUP：历史 proof debt 安全处置

## 最终状态

**blocked-no-safe-public-exit**。本节点未执行 live mutation，未修改 `var/workspaces/**`。用户授权仅满足 mutation 意图门，不替代 typed/public API、权威 provenance、审计字段和 fixture 安全门。

## 授权解释

收到“执行剩余任务”授权，按任务约束视为本节点 mutation 授权；但授权必须 fail-closed 地通过既有公开/typed workspace administration 入口及全部安全条件。没有绕过 lease、action challenge、owner scope 或直接编辑 JSON。

## Preflight

- 受保护路径门禁：`git status --short pi/agents/reviewer.md pi/settings.json pi/models.json var/workspaces/` 仅显示预存的 `pi/agents/reviewer.md` 与 `pi/settings.json` 修改；`pi/models.json`、`var/workspaces/` 无输出。预存修改未触碰。
- 必需产物 `D-AUDIT.md`、`E-PI.md`、`L-ORPHAN.md`、`B-ACC.md` 均存在且可读。
- 依赖结论：D-AUDIT 将历史 debt 默认归类为 `trusted-run-binding-unavailable`、来源未证实；P2–P4 records absent 不证明无 record。E-PI 为 environment-constrained/unverified，真实 supervisor lane 未验证。L-ORPHAN 保留至少一个 owner/外部 loader 来源未证实项。故 provenance 条件未通过。
- 现有 plan 明确 D-CLEANUP 默认 blocked，仅在独立 cleanup 计划、幂等测试和审计字段契约存在时允许派发。

## Public/typed 入口盘点

- package public export 存在 `./workspace/admin`，指向 `src/workspace/administration.ts`。
- 现有 typed 入口为 `inventoryManagedWorkspaces`、`auditManagedWorkspaces`、`planManagedWorkspaceCleanup`、`applyManagedWorkspaceCleanup`。
- `planManagedWorkspaceCleanup` 仅选择 identity-valid 的 `preserved`/`cleanup-debt` workspace，并要求显式授权字段。
- `applyManagedWorkspaceCleanup` 校验 plan hash、state root、当前 actions、workspace lease authorization，并通过 service release；错误授权和 stale/replayed plan fail closed。
- 但是现有 apply 返回 release receipt，没有本任务要求的、可独立核验的 cleanup audit record/审计字段投影；现有 API 也不能证明历史 proof debt 的完整 provenance、root receipt、owner/workspace 绑定链。不能把该入口扩大解释为安全处置 D-AUDIT 中的历史 proof debt。

## 临时 fixture TDD/安全验证

按 test-driven-development Skill 的豁免说明：本节点不修改 production code，仅生成运维证据报告；生产变更免除 RED-GREEN。临时 fixture 仍按测试先行执行，脚本只写入 `/tmp`，未进入仓库。

Fixture 覆盖：

- 临时 state root/origin 上真实 typed service + administration plan/apply；
- 空授权拒绝；
- 错 lease 拒绝；
- 合法 exact lease 成功释放；
- apply 后重复调用因 stale/changed plan 拒绝；
- worktree 删除仅由 typed/public service 路径完成。

实际命令与结果：

1. `node --experimental-strip-types /tmp/d-cleanup-fixture.mjs` —— **RED（按预期）**：未满足期望的独立审计投影，断言 `audit.schemaVersion` 为 undefined；此前授权/错 owner 保护断言已执行通过。
2. `sed '/audit?.schemaVersion/d' /tmp/d-cleanup-fixture.mjs > /tmp/d-cleanup-fixture-green.mjs && node --experimental-strip-types /tmp/d-cleanup-fixture-green.mjs` —— **GREEN（按现有 API 行为）**：未授权、错 lease、合法一次性 apply、重复调用 stale 防护均通过。该 GREEN 不足以满足 D-CLEANUP 的独立审计条件，因此不转入 live mutation。
3. `node --test test/managed-workspace-administration.test.mjs test/managed-workspace-service.integration.mjs` —— **PASS，25/25**。既有测试也证明 administration cleanup 需要 exact public lease，plan 不执行 cleanup，重复/stale plan 被拒绝。

## Mutation 结果

- live mutation：**未执行**。
- live workspace 前后聚合数：**不适用**；没有读取或修改 `var/workspaces/**`，避免把快照数误报为当前 live 数。
- 未处理集合：所有历史 proof debt，包含 D-AUDIT 聚合的来源未证实集合；不处理 P2–P4 absent records，不处理 queue/worktree/records。

## 阻断原因与后续边界

1. provenance 不足：当前审计只证明快照聚合和默认 unknown 来源，不能证明合法 production/fixture 身份、root receipt、完整事件顺序或 workspace 绑定。
2. E-PI 真实 supervisor lane 未验证，L-ORPHAN 仍有 owner/loader 来源未证实项。
3. 现有 apply 虽具 typed/public lease 与 plan 幂等防护，但没有本任务所需的独立权威 cleanup audit record/审计字段契约；临时 RED 直接证明该缺口。
4. 因此结论是 `blocked-no-safe-public-exit`，需要另立 coding 计划/用户明确授权边界：补充经评审的 cleanup/recovery contract、审计 schema 和最小 provenance 选择规则，再以独立 fixture 先 RED 后 GREEN 验证；不得在本节点临时新增 production cleanup 逻辑。

## 余留风险

- D-AUDIT 数字是历史快照时点聚合，不代表当前 live 数。
- 既有 API 的成功 fixture 只证明已授权 workspace release 的安全边界，不证明历史 proof debt 可安全归属或清理。
- 任何后续 mutation 必须单独持有 `live-state-mutation`，逐批记录聚合数字、分类、授权类型和审计摘要，且不泄露 proofId、runId、token、cookie、authorization 值或完整敏感路径。

## 变更与机械检查

本报告是本节点唯一写入文件；没有新增或修改测试，临时 fixture 位于 `/tmp`。未执行 git add/commit/stash/reset/clean 等命令。
