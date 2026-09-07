# Subagent Unified Model Selector 验证记录

日期：2026-09-05
范围：Task 5 `subagent-model-selector-t5-tests`，只执行当前进程外可可靠复现的静态、package、focused 和完整仓库回归；仅修正两个过期测试文件与本验证记录，未修改生产代码、Skill、agent、计划或本机配置。

## TDD 与前置验收事实

- T1 解析器：已按 TDD 完成，RED 后 GREEN；主 agent 已复验 `test/subagent-model-selection.test.mjs` 为 6/6。
- T2 Schema 与 Coding IR：已按 TDD 完成，RED 后 GREEN；主 agent 已复验相关组合测试为 39/39。
- T3 extension 与 worktree：已按 TDD 完成，RED 后 GREEN；主 agent 已复验相关测试为 22/22。worktree 缺陷修复将 opaque 或过长的 Host `toolCallId` canonicalize 为 `host-tool-call-<sha256>`，本次并行 managed-worktree 集成测试再次通过。
- T4 public guidance：fresh-context pressure 场景已先得到 RED，再在更新 Skill 后得到 GREEN；主 agent 已复验自动化测试 16/16。最终 fresh-context child 会先读取 upstream progressive disclosure 指导，再生成有效 typed/generic `model` 调用，并正确区分 warning 与 actual model。
- 本 Task 采用 `existing-tests` 豁免流程：以上 T1--T4 的 RED/GREEN 行为实现由前置任务完成。本 Task 先复现了三个过期断言的 RED，再只更新这两个测试文件中的断言；未修改生产代码、Skill、agent、计划或本机配置。

## 本次命令结果

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `npm run typecheck` | PASS，退出 0 | `tsc --noEmit` 完成，无诊断。 |
| `npm --prefix packages/pi-subagents-enhanced run verify:package` | PASS，退出 0 | `patched: true`、`importEdges: 63`；tarball 为 1977 files、9772778 bytes。 |
| `node --test test/subagent-model-selection.test.mjs test/subagent-dispatch-ir.test.mjs test/subagent-dispatch-schema-coercion.test.mjs test/subagent-dispatch-schema-security.test.mjs test/subagent-dispatch-extension.test.ts test/subagent-model-selection.integration.mjs test/subagent-dispatch-skill.test.mjs test/subagent-managed-worktree.integration.mjs` | PASS，退出 0 | 59/59 passed，0 failed，覆盖 model parser、schema、IR、extension、Skill、模型选择集成和 managed worktree。 |
| `node --test test/subagent-runtime-membrane.test.mjs test/subagent-runtime-resource-isolation.test.mjs`（修改前） | FAIL，退出 1 | 64 tests：61 passed、3 failed。两处大小写不敏感 `CHAIN` 正则误匹配合法 `fallback chain`，一处 coding handle 旧期望遗漏 `modelSelection: { source: "default" }`。 |
| `node --test test/subagent-runtime-membrane.test.mjs test/subagent-runtime-resource-isolation.test.mjs`（修改后） | PASS，退出 0 | 64/64 passed，0 failed。facade 精确等于 `TYPED_SUBAGENT_DESCRIPTION`，fixture 的 `proactive skill methodology` 未泄漏；资源隔离继续保护不允许的方法论/调度词；coding handle 断言稳定默认 modelSelection。 |
| `node --test test/subagent-model-selection.test.mjs test/subagent-dispatch-ir.test.mjs test/subagent-dispatch-schema-coercion.test.mjs test/subagent-dispatch-schema-security.test.mjs test/subagent-dispatch-extension.test.ts test/subagent-model-selection.integration.mjs test/subagent-dispatch-skill.test.mjs test/subagent-managed-worktree.integration.mjs`（最终） | PASS，退出 0 | T5 focused 8-suite：59/59 passed，0 failed。 |
| `npm test`（最终） | PASS，退出 0 | 完整仓库回归：701/701 passed，0 failed、0 skipped/cancelled。 |

## 完整回归失败分析

以下三个失败已分类为统一模型选择变更暴露的过期测试预期，并在本 Task 的声明范围内修复：

1. `test/subagent-runtime-membrane.test.mjs:759`，`headless runtime installation exposes only project-owned subagent tools`：旧负向正则 `/CHAIN|PARALLEL|proactive skill|Fable/i` 将合法 `fallback chain` 误判为 `CHAIN`。现改为断言公开 facade 精确使用 `TYPED_SUBAGENT_DESCRIPTION`，并确认 fixture 注入的 `proactive skill methodology` 未泄漏。
2. `test/subagent-runtime-membrane.test.mjs:968`，`compiles a coding contract into one workflow root and returns its correlated leaf handle`：旧 `deepStrictEqual` 期望遗漏 `modelSelection: { source: "default" }`。现已加入该稳定默认模型选择回执形状。
3. `test/subagent-runtime-resource-isolation.test.mjs:124`，`the model-facing description contains the project dispatch and push-notification contract`：旧 `/CHAIN|PARALLEL|proactive skill|Fable|watchdog|schedule/i` 同样误判合法 `fallback chain`。现保留对 `PARALLEL`、`proactive skill`、`Fable`、`watchdog` 和 `schedule` 的行为边界保护，不镜像整段描述。

结论：三个失败均为过期测试预期，已通过只更新测试断言修复，未改写合法 production 描述规避。目标文件、T5 focused 8-suite 与完整回归均全绿。

## 静态与工作区核查

- 对 `packages/pi-subagents-enhanced/src`、`skill-overrides/subagent-dispatch/SKILL.md` 和 `pi/agents/executor.md` 搜索 `modelTier`、`MODEL_TIERS` 与 tier mapping，无匹配。测试中拒绝 retired 字段的用例保留，不作为生产/public 指导残留。
- `pi/agents/executor.md` 当前 frontmatter `models` 与 `HEAD` 顺序一致：`codex-pool/gpt-5.6-terra`、`openai-codex/gpt-5.6-terra`、`codex-pool/gpt-5.6-luna`、`openai-codex/gpt-5.6-luna`、`deepseek/deepseek-v4-pro`、`deepseek/deepseek-v4-flash`。
- `git diff --check` 通过；暂存区为空。
- 本机既存 `pi/settings.json`（6 additions、1 deletion）和 `pi/models.json`（3 additions、29 deletions）有 diff。本 Task 未修改、未暂存、未纳入实现或归因这些配置改动；亦未处理既存 compact-rendering 及其他用户改动。
- 本 Task 更新了本记录和两个过期测试断言；未创建 commit 或 push。

## 最终 Host 重启与真实模型 canary

完整重启 Host 后，coding 与 generic 的公开 schema 均包含 `model`，且均不再包含 `modelTier`。以下真实 spawn 一律以 parent status、session `model_change` 和 runtime run/status/artifact 的 actual metadata 为权威；不以 child 自述替代。

- global bare：请求 `gpt-5.6-sol`，resolved 与 actual 均为 `codex-pool/gpt-5.6-sol`；顶层 `details.warnings` 包含 `MODEL_MATCH_USED_GLOBAL_CATALOG`。
- qualified：请求、resolved 与 actual 均为 `codex-pool/gpt-5.6-sol`；没有 global-catalog warning。
- executor bare：请求 `gpt-5.6-luna`。resolver 按 executor 声明顺序跳过不可用的 `codex-pool/gpt-5.6-luna`，resolved 与 actual 均为 `openai-codex/gpt-5.6-luna`，且没有 global-catalog warning。parent status 与 session `model_change` 均已核对该结果。

## 追加验证：不可用 agent 模型候选

reload 后的真实 executor canary 通过 typed `dispatch-ir.v1` 入口请求 bare `gpt-5.6-luna`。agent discovery 返回 executor 声明顺序中的 `codex-pool/gpt-5.6-luna`、`openai-codex/gpt-5.6-luna`；当前 available registry 只有后者。旧 `resolveModelSelection` 的 `agent-candidates` 分支未校验 available catalog，回执错误解析为 `codex-pool/gpt-5.6-luna`，随后 workflow child active registry 报 `Unknown subagent model` 并建议 `openai-codex/gpt-5.6-luna`。首个偏离点与调用链详见 `docs/bugs/2026-09-05-subagent-unavailable-agent-model-candidate.md`。

本次 RED 将相同候选顺序写入 resolver、extension 与 typed executor integration fixture：旧实现稳定选择不可用首项，三个 focused 断言失败。最小修复仅在 `agent-candidates` 分支按 agent 声明顺序筛选 bare ID，并要求 candidate 完整 ID 存在于 available catalog；无可用声明候选时保持 terminal `MODEL_NOT_AVAILABLE`，不搜索 agent 列表外 global catalog。qualified、no-agent-model global 与未传 model default 分支未改动。

修复后执行 `node --test test/subagent-model-selection.test.mjs test/subagent-dispatch-extension.test.ts test/subagent-model-selection.integration.mjs test/subagent-dispatch-skill.test.mjs test/subagent-managed-worktree.integration.mjs`：PASS，30/30 passed、0 failed，覆盖 resolver、extension、model integration、Skill 可执行示例与 managed-worktree focused 回归。`npm run typecheck` PASS，无 TypeScript 诊断；`git diff --check` PASS，无 whitespace error。resolver fixture 还包含另一个排序更靠前但声明更靠后的 available provider，证明 agent-candidates 不按 global catalog 重排。

最终完整重启后的 executor bare canary 已按上述 actual metadata、parent status 和 session `model_change` 复核通过；不再保留 reload 或真实 spawn pending 状态。

## 追加验证：standalone worktree facade run kind

reload 后的真实 generic standalone managed worktree canary 已证明 production 可达：workspace `22fb76a7-600b-4436-bfe9-70b4dc98c94f` 成功分配，child `8712082d-b02f-458d-890b-f3a13a8e7334` 已在隔离后的 managed dispatch cwd 中成功读取 README；但 tool 在 `registerFacadeRun(authoritativeBinding)` 阶段返回 `SUBAGENT_RPC_FAILED: Facade run identity is invalid`。collector 的 authoritative binding 只有 `runId`、`asyncDir`、`sessionId`、`pid`、`agent`，而 Root Broker 还严格要求非空 `kind`。真实来源、首个偏离点和完整调用链记录在 `docs/bugs/2026-09-05-subagent-worktree-facade-run-kind.md`。

本次先将 coding 与 generic standalone worktree 的 `registerFacadeRun` callback 改为 production 等价严格校验。修复前执行 extension 与 managed-worktree focused tests，5 个 worktree 用例稳定 RED，均返回 `SUBAGENT_RPC_FAILED: Facade run identity is invalid`；同一轮非-worktree 注册次数为 0 的断言保持通过。最小修复只在 extension facade 注册边界补齐 domain-known kind：coding 为 `kind: "coding"`，generic 为 `kind: "generic"`。workspace `bindRun` 仍接收原始五字段 lifecycle binding，public details 也不包含 kind；RootBrokerServer validator 与 package runtime callback 均未修改。

修复后的首轮 GREEN 为 19/19 passed，覆盖 extension 与 managed-worktree integration。integration 的 facade callback 不再为空，并严格验证 `runId`、`asyncDir`、`sessionId`、`pid`、`agent` 和对应 kind；并行 tool-call identity 回归也使用同一严格 callback。

最终执行 `node --test test/subagent-dispatch-extension.test.ts test/subagent-managed-worktree.integration.mjs test/root-subagent-broker.test.mjs test/subagent-model-selection.test.mjs test/subagent-model-selection.integration.mjs test/subagent-dispatch-skill.test.mjs`，51/51 passed、0 failed；`npm run typecheck` 通过且无 TypeScript 诊断。`git diff --check` 通过，暂存区为空。Root Broker 与 package runtime entry 无 diff。

真实 workspace `22fb76a7-600b-4436-bfe9-70b4dc98c94f` 已通过 typed service 先 `preserve` 后 `release`，对应临时 clone 已删除，不尝试恢复。完整重启后的后续真实 managed-worktree canary 已覆盖 facade 注册与 terminal proof 路径；本地 focused GREEN 不再是唯一验收依据。

## 最终 executor bare model canary

- child 环境观测（通过 bash 读取）：`PI_PROVIDER=openai-codex`，`PI_MODEL=gpt-5.6-luna`。
- 该观测与预期 resolved model `openai-codex/gpt-5.6-luna` 一致，且未读取凭据。
- 完整重启后，parent status、session `model_change` 与 runtime actual metadata 已独立核对 resolved/actual；该 bare agent-candidate 路径没有 global warning。

## 追加验证：workspace terminal proof adapter

真实 managed workspace `dc8d05e1-5f97-49e8-b301-3a04ec6ef27c` 当前仍为 `active`，关联 child `97e93d38-c01c-4917-b118-215a4cd98279` 的 process terminal 已由 Root Broker 观测为 `observed`；修复前真实 `workspace_status` 报 `MANAGED_WORKSPACE_TERMINAL: terminal proof is invalid`。完整 production provenance 记录于 `docs/bugs/2026-09-06-subagent-workspace-terminal-proof-adapter.md`。

根因是 `RootBrokerServer.inspectFacadeTerminalProof` 合法返回 rich snapshot `{runId,state,proofHash,proof,conflict}`，package runtime 的 `terminalProofProvider` 却将其原样传入 managed workspace service；后者的 `proofValue` 正确要求 exact keys `{state,conflict,proofHash}`。首个偏离点因此位于 package runtime adapter 边界，不在 Root Broker 或 workspace strict codec。

精确 RED 使用真实 `RootBrokerServer` 注册 facade run 并接收合法 official terminal proof，再将其产生的五键 rich snapshot 按旧 provider 行为原样返回。`workspace_status` 稳定失败为 `MANAGED_WORKSPACE_TERMINAL: terminal proof is invalid`。纯 adapter 的 pending、observed、conflict 与 malformed observed 四个用例在实现前也因 adapter 不存在而 0/4 失败。

最小修复在 `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts` 抽取 `projectManagedWorkspaceTerminalProof`，production provider 统一调用该函数。无 run、无 snapshot 与 pending snapshot 返回 `{state:"pending"}`；observed snapshot 只返回 `{state:"observed",conflict,proofHash}`；runId 不匹配、state 非 observed、conflict 非 boolean 或 proofHash 非 64 位小写十六进制时抛稳定 `MANAGED_WORKSPACE_TERMINAL_PROOF_ADAPTER`。Root Broker rich snapshot 与 workspace service exact-key validator 均未修改。

GREEN 与回归结果：

- adapter focused：4/4 passed，覆盖 pending、observed、conflict、malformed observed。
- Root Broker + managed workspace service 集成：1/1 passed；真实 broker rich snapshot 经 production adapter 后，service status 得到 strict 三键 observed proof，typed `workspace_status` 返回 `process_terminal: observed` 并包含 `discard`。
- runtime membrane/resource isolation/root upstream：70/70 passed。
- Root Broker：20/20 passed。
- managed workspace contract/ledger/service/worktree：24/24 passed。
- package tests：6/6 passed。
- `npm run typecheck` passed，无 TypeScript 诊断。
- `npm --prefix packages/pi-subagents-enhanced run verify:package` passed：`patched: true`、`importEdges: 63`、tarball 1977 files/9773775 bytes。

`test/subagent-runtime-root-broker-startup.integration.mjs` 在未启动 Host 前因环境未提供 `PI_REAL_BIN` 失败，断言为 `PI_REAL_BIN must point to the real Pi binary`。补齐该变量会启动 Pi Host，与本任务“不得启动/停止/restart Pi Host”边界冲突，因此未执行其 Host 路径；其余 package runtime suites 已单独全绿。

## 最终 managed-worktree canary 与清理

真实 worktree 演进完整保留了三层 production 缺陷、中文问题记录和 TDD 修复证据：首轮复合 Host `toolCallId` 暴露 persisted owner identity 不兼容，修复为安全 canonicalization；次轮 facade 注册暴露缺少 domain-known `kind`，修复为 coding/generic 边界补齐；第三轮 rich terminal proof snapshot 暴露 adapter 未投影，修复为 strict 三键 terminal proof adapter。三项对应的问题记录分别为 `2026-09-05-subagent-worktree-tool-call-identity.md`、`2026-09-05-subagent-worktree-facade-run-kind.md`、`2026-09-06-subagent-workspace-terminal-proof-adapter.md`，各自均记录 RED 后 GREEN 的最小 TDD 修复。

最终 workspace `6c52a09c-a24b-46a6-a722-a533af34b036` 关联 child `35e307e2-fdb3-4e9d-8f79-acb18501e91d`。真实入口接受 compound tool ID，typed `workspace_status` 返回 `process_terminal: observed`，允许 `preserve` 与 `discard`；使用该 status 签发的 action token 执行 `discard` 后 workspace 已 released。

旧 workspace `dc8d05e1-5f97-49e8-b301-3a04ec6ef27c` 已在完整重启后从 pending 状态通过 typed `preserve` 再 `release` 处置。所有本次临时 clone 与 managed path 均已删除；未使用 raw worktree mutation。

## 最终回归与未单独运行项

- 最新 `npm test`：705/705 passed，0 failed。
- `npm run typecheck`、`npm --prefix packages/pi-subagents-enhanced run verify:package` 与 focused suites 均通过。
- `test/subagent-runtime-root-broker-startup.integration.mjs` 未单独运行：该测试需要自行启动带 `PI_REAL_BIN` 的 Host，违反本 docs-only 收尾任务不得启动/停止/restart Host 的边界。其需要的真实 Host startup、模型选择和 managed-worktree terminal-proof 行为已由上述完整重启后的真实 canary 覆盖。
