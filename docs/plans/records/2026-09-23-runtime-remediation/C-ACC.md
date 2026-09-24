# C-ACC：统一验收 A/B/C 跨计划结果

- 验收节点：`C-ACC`
- 身份：`dispatch-ir.v1`
- 结论：**部分通过（不伪造全量绿）**。A、B、C 的确定性目标套件通过；环境依赖套件受限；全量 `npm test` 保留既有合同迁移/schema 与环境失败。
- 写入边界：本节点仅写入本文件；未修改源码、测试、计划、Skill、配置或 live 现场。

## TDD 豁免与边界

已读取 `/Users/leshi.zhy/.agents/skills/test-driven-development/SKILL.md`。本节点是纯文档验收：只运行已有验收命令、审计既有记录和命令输出，不改变 production behavior；按 Skill 的“纯文档变更”规则豁免 RED-GREEN。证据是本文件唯一新增内容，未新增或修改测试。

A-ENV 已为 `degraded`。本节点未调用 `contact_supervisor`，未连接 live host，未读取 `var/workspaces/` 作为测试断言；现场结论只引用 `P-SNAPSHOT.md`、`P-HARNESS.md` 与已有记录。

## 一、确定性本地套件

以下结果来自本次实际运行或既有验收记录，分类为“通过”或“复现不一致/既有失败”。

| 范围 | 实际命令 | exit code | 实际结果与分类 |
|---|---|---:|---|
| C9、A0 | `node --test test/bash-cwd-policy.test.mjs test/bash-cwd-extension.test.mjs test/package-orphan-export-guard.test.mjs` | 0 | 16/16 通过；确定性本地通过。包含工作区外目录、缺失/文件、相对路径、symlink、孤儿 guard。 |
| C10 | `node --test test/init-pi.test.mjs test/external-review-config-home.test.mjs` | 0 | 2/2 通过；`c35c596` 删除意图与 bug 记录一致，删除目录未恢复。 |
| B6/B8/B7 | `node --test test/managed-workspace-state-vocabulary.test.mjs test/managed-workspace-git-diagnostics.test.mjs test/managed-workspace-git-apply-publish.test.mjs test/subagent-proof-binding-classification.test.mjs` | 0 | 15/15 通过；B 确定性专测通过。B-ACC 另记录 B6 10/10、B7 55/55、B8 diagnostics 7/7 + apply/publish 2/2。 |
| A | 计划 A 定向套件（17 个文件，连续两次） | 0 | 两次均 109/109 通过；typecheck、verify 亦通过。 |
| C12 | `for i in 1 2 3; do node --test test/root-subagent-broker.test.mjs test/durable-lifecycle.test.mjs; done` | 0 | 三次均 45/45 通过；分别覆盖 root broker 39/39、durable 6/6，确定性通过。 |
| 类型 | `npm run typecheck` | 0 | root 与 `packages/pi-subagents-enhanced` typecheck 均通过。 |
| 包校验 | `npm run verify:subagents-enhanced` | 0 | package verify 通过，importEdges 123、tarball fileCount 2258。 |
| B workspace 全套 | `npm run test:subagent-workspace` | 1 | 32/36 通过、4 失败；四项均为 `test/subagent-managed-worktree.integration.mjs` 使用已删除的 `workflow` 字段，报 `INVALID_CONTRACT`。这是 A2 workflow 合同迁移残留的**既有失败**，不是 B8 Git 诊断失败；未修改该文件，也未将其伪造为 GREEN。 |
| 全量本地 | `npm test`（连续两次） | 1 | 两次均 987 tests、975 pass、12 fail；`BROKER_TIMEOUT=0`。除上述 workflow/schema 合同迁移类失败外，另有既有配置/环境依赖失败；不能据此宣称全量绿。 |

C10 的 HEAD 导出复现记录已在 C10/C11 记录中保存；本节点不把测试期望调整误报成 production 修复。

## 二、环境依赖套件

| 实际命令/项目 | exit code | 分类 | 边界 |
|---|---:|---|---|
| `npm run test:subagents` | 1 | 环境受限未验证 | `PI_REAL_BIN` 未设置，失败为 `spawn` 的 `file` 参数 undefined；不设置环境变量伪造通过。 |
| 真实 Pi lane / Root Broker startup | 首次 1，补齐既有 binary 后 0 | 环境依赖；隔离 harness 通过 | P-HARNESS 记录首次缺失 `PI_REAL_BIN` 后，以真实 binary 重跑 1/1 通过；这证明临时 harness 能力，不证明 live host。 |
| 外部 `/Users/leshi.zhy/.agents/skills/...` 副本 | 未作为必需断言 | 环境受限未验证 | 仓库内 `skill-overrides/subagent-dispatch/SKILL.md` 已由 A-ACC 实读；外部副本不是本节点 WritePath，不以其缺失或存在推断 production 结论。 |
| live transport、live queue、live proof、live worktree | 未运行 | 环境受限/来源未证实 | A-ENV degraded；禁止连接 live host，亦未读取 `var/workspaces/` 作测试断言。 |

## 三、只读现场观察

P-SNAPSHOT 在 2026-09-23 已完成只读基线：四分区 outbox 的 pending/receipt/debt/supersession 摘要为 P1 `5/0/188/3`、P2 `0/0/110/0`、P3 `0/0/130/0`、P4 `0/0/101/0`；`records` 为 P1 present、P2–P4 absent；root worktree list 为 7 项。P-HARNESS 在完全临时目录中真实 coordinator/Root Broker/Git allocate、bind、queue、proof、cleanup 均通过，不能外推为 live 修复。

本节点没有重新读取、复制、清理或修改 live 现场，没有清理 queue、proof debt、worktrees 或旧 A4 managed workspace。因此：

- 只读基线可确认“快照时存在的现场形态”，不能确认之后 live 数量已变化或已修复。
- B7 只阻止新增无 workspace 普通 run 的误判 debt；历史 **492 条 proof debt 未清理**，仍是未处置现场债务。
- 不把隔离 harness 当作 live 修复，不把缺失 `records` 当作零条记录。

## 32 条缺陷汇总（来源与证据边界）

下表逐条对应统一总纲 §3 的 8 Blocker、17 High、7 Medium。状态含义：已处置=有本轮实际代码/验收证据；探索产物=仅产生探索或决策输入；环境受限=没有合法运行时证据；来源未证实=按 fail-closed 不归因；延后/未处置=明确不在本轮处置。

### 已处置（19 条）

| 编号 | 结论 | 证据边界 |
|---|---|---|
| BL-1 | 已处置 | A1 保留既有 validation-errors 空 `writePaths` 回归，仅迁移 canonical import；A 定向 109/109。 |
| BL-2 | 已处置 | A2 保留旧 workflow record 加载与 contract-hash 兼容专测；不放宽 requestHash。 |
| BL-3 | 已处置（live 环境受限） | A5 使用六字段 grant 形状并通过 execution-contract 定向测试；A-ENV degraded，真实 Host grant/live lane 未证实，不能外推为 live 完成。 |
| BL-4 | 已处置 | B7 采用 patch/context 内容指纹门禁，不用易漂移行号。 |
| BL-6 | 已处置 | B6/B8 声明并消费 `managed-workspace-contract-test` 串行资源锁；B-ACC 共享回归通过。 |
| BL-7 | 已处置 | B8 `truncateUtf8` 按 `Buffer.byteLength`，512 UTF-8 bytes 专测通过。 |
| BL-8 | 已处置 | 新导出 RED 规则与 B 专测遵守断言级失败要求；未以 TypeError 冒充 RED。 |
| HI-1 | 已处置 | SKILL 外部副本按存在性条件处理；仓库内 SKILL 定向测试通过。 |
| HI-2 | 已处置 | delegate/executor 的 `contact_supervisor`、`need_decision`、不得委派、证据优先语义仍在；A-ACC 审计通过。 |
| HI-4 | 已处置 | A3 `/\*\*` 分类顺序和路径 grammar 边界专测通过。 |
| HI-5 | 已处置 | B6 将状态词表、`allowedActionsFor` 权威归属统一到 ledger；专测通过。 |
| HI-6 | 已处置 | B6 按实际 failure 签名构造 detail，state/allowedActions/nextAction 专测通过。 |
| HI-7 | 已处置 | B7 在被测 `readLedger` 内按 runId 过滤；绑定分类 4/4 及 broker 回归通过。 |
| HI-8 | 已处置 | B7 `buildTerminalProof()` 无参，单绑定 proof 七字段保持不变。 |
| HI-9 | 已处置 | B7 将分类实现放入 `src/subagent-dispatch/terminal-proof-binding.ts`。 |
| HI-10 | 已处置 | B8 使用 porcelain `-z` 并覆盖 rename/quoted/space/unmerged/submodule。 |
| HI-12 | 已处置 | B8 明确定义 category 优先级并由 diagnostics 7/7 覆盖。 |
| HI-13 | 已处置 | C9 覆盖工作区外目录、缺失、文件、空/相对路径、symlink；16/16 相关套件通过。 |
| MD-1 | 已处置 | A0 负向检查只操作临时副本；guard 4/4。 |
| MD-2 | 已处置 | A2/A3 残留扫描确认 workflow 与旧路径残留清零。 |
| MD-3 | 已处置 | C10 按目标文件实际变量与 c35c596 删除决策调整，2/2 通过。 |
| MD-4 | 已处置 | C12 两目标文件三轮 45/45 通过，未一刀切放大 production deadline。 |

### 探索产物（2 条）

| 编号 | 结论 | 证据边界 |
|---|---|---|
| HI-3 | 仅探索/约束保持 | A6/T13 产出 8 类实际 route probe、provider 兼容矩阵和推荐方案；未实现根级 union。 |
| HI-14 | 仅探索/约束保持 | A6/T13 已运行无副作用 probe；不把探索文档当 production 修复。 |

### 环境受限（2 条）

| 编号 | 结论 | 证据边界 |
|---|---|---|
| BL-5 | 已按验收设计拆组，但全量 exit=0 不作为门槛 | `npm test` 仍 exit 1；这是已知合同迁移/schema 与环境组合，不要求伪造全绿。 |
| HI-15 | 三组验收已拆分，真实 Pi/live 部分受限 | `npm run test:subagents` 的 `PI_REAL_BIN` 缺失已实际复现；P-HARNESS 仅为隔离环境。 |

### 来源未证实（1 条）

| 编号 | 结论 | 证据边界 |
|---|---|---|
| C11 对应的 supervisor target 行为（来源未证实） | 不归因 production，不改 compat production/test | 工作树普通环境与 HEAD 导出通过，而 `env -i` 对同一断言出现 resolve；缺少完整 Host/Store identity receipt，按 bug 文档分类 `(3) 来源未证实`。 |

### 延后/未处置（6 条）

| 编号 | 结论 | 证据边界 |
|---|---|---|
| HI-11 | 延后 | `.gitmodules` 读取失败与无 submodule 的全链路决策未在本轮确认。 |
| HI-16 | 已部分处置，live 门禁延后 | 计划任务步骤 0 已逐项存在并实际运行；不声称其解决所有 live 证据缺口。 |
| HI-17 | 延后 | TDD 信号自然语言化的机械强制仍是 A6 探索/风险，不新增门禁。 |
| MD-5 | 已处置 | SKILL 使用完整句子锚点，A3 grammar/SKILL 回归通过。 |
| MD-6 | 已处置 | 统一 DAG 明确 B6/B8 锁串行及 C12 `full-test-suite` 独占；B-ACC/C-ACC 按此执行。 |
| MD-7 | 延后/未处置 | 原任务粒度的计划治理问题不改变本轮 production 行为，未另开计划修订。 |

> 注：总纲中的编号原本按审阅来源分类；上表对 BL-3、BL-5、HI-15、HI-16 等同时具有“代码已处置”和“真实环境未验证”的条目，分别记录实现状态与证据边界，避免把“隔离测试通过”误报为 live 完成。A0 allowlist 实际 **5 条而非旧预期 3 条**（`durable-run-registry.ts`、`lifecycle-identity.ts`、`lifecycle-policy.ts`、`supervisor-replay.ts`、`workspace/coordinator-process.ts`），未擅自删除或打勾为已清理。

## 计划正文恢复核对

计划 A 文档正文曾被恢复；当前文件同时存在原文计划内容、`T-ENV` 结论占位/结论区和 A-ACC 验收记录。A-ACC 记录明确说明“原正文曾被错误覆盖，已从成功 write/heredoc 证据确定性重建”，因此原文与 A-ACC 记录都存在，未把恢复动作误报为源码修复。

## 现场与残余风险

- B7 未清理历史 proof debt；live queue/worktrees/records 未清理。
- `npm test` 两次均 exit 1（987/975/12），不能声明全量绿；workspace 套件四个 `workflow` 迁移失败仍待后续测试卫生处理。
- `PI_REAL_BIN` lane、live Host control-plane、外部 SKILL 副本和 C11 来源仍受环境/来源边界限制。
- 仅允许的现场动作是既有 P-SNAPSHOT/P-HARNESS 的对照阅读；本节点没有触碰 live host 或 `var/workspaces/`。

## 机械验证

- `git diff --check`：通过。
- `git diff --cached --quiet`：通过，无 staged 文件。
- 受保护路径状态：仅既有 ` M pi/agents/reviewer.md`、` M pi/settings.json`；`pi/models.json` 与 `var/workspaces/` 无输出。
- 本节点 WritePath：仅 `docs/plans/records/2026-09-23-runtime-remediation/C-ACC.md`。
