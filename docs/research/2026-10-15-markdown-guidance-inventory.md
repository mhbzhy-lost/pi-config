# 本仓 Markdown 指引归属盘点（skill / agents profile / tool descriptions → runtime 还是 MD）

- 任务：dispatch-b26d22d9（executor）
- 日期：2026-10-15
- 性质：只读研究 + 写本报告。不编实施计划（父层专责）、不迁移、不修改任何 MD 规范/skill 行为。
- 写范围：仅本文件。盘点过程中使用的临时统计脚本 `scripts/tmp-md-inventory.mjs` 已在产出后删除，仓库最终无其他新增文件。

## 1. 方法与排除边界

- 已读：根 `AGENTS.md`、`pi/AGENTS_GLOBAL.md`、`pi/AGENTS_SHARED.md`、`pi/agents/{delegate,executor,reviewer}.md`、`pi/extensions/agents-{global,shared}.ts`、`src/agents-{shared,global}/index.ts`、`src/skill-whitelist/skill.ts`、`scripts/sync-skills.ts`、`init-pi.sh`、`packages/pi-subagents-enhanced/AGENTS.md`、`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`（工具描述常量）、`src/workspace/tool.ts`、`src/subagent-dispatch/supervisor-adapter.ts`、上游 `pi-subagents` 包 `src/intercom/native-supervisor-channel.js`（contact_supervisor 工具注册）、`skill-overrides/` 全部 SKILL.md frontmatter 与正文（除 TDD）、`.pi/skills/` 全部 SKILL.md、`test/skill-list.test.mjs`、`test/skill-whitelist-extension.test.mjs`（头部）、`test/reviewer-agent.test.mjs`（头部）。
- 批量统计经一次性辅助脚本完成（1 次 bash 调用产出全部字节数/正文 chars/标题清单），未逐文件多次调用。
- 明确排除（未读正文，仅记录路径与大小）：
  - `skill-overrides/test-driven-development/SKILL.md`（10304B）与 `skill-overrides/test-driven-development/writing-good-tests.md`（8256B）——共享规范 TDD 禁令，路径登记即止。
  - `pi/auth.json`、`pi/models*.json`、`pi/settings.json`、`pi/trust.json`、`pi/run-history.jsonl`、`pi/sessions/`——敏感配置与会话，全部未读。
  - `~/.agents` 下非本仓同步的外部个人 skills——未扫描。
- 量化仅含：文件字节数、正文 chars、注入路径计数、重复条文计数。不含任何 token 节省或模型效果推断。

## 2. 注入链与分层事实（现场证据）

### 2.1 system prompt 注入（默认注入）

| 块 | 来源 | 注入机制 | 适用 |
|---|---|---|---|
| `<pi_shared_instructions source="PI_CODING_AGENT_DIR/AGENTS_SHARED.md">` | `pi/AGENTS_SHARED.md`（2749B） | `src/agents-shared/index.ts`：`before_agent_start` 追加；`input` 门禁预读快照；`session_start` 读取失败抛错并发 ACK 事件（`subagent:acknowledge-extension`，注释明确「ACK 观测不是 model 消费证明」） | main + child（child 经 `PI_SUBAGENT_CHILD=1` 以 scope=child 加载同一物理入口 `pi/extensions/agents-shared.ts`） |
| `<pi_child_execution_boundaries source="runtime">` | **runtime 代码内硬编码常量**（`src/agents-shared/index.ts` 的 `CHILD_EXECUTION_BOUNDARIES`，4 行） | 同上，仅 scope=child 追加 | 仅 child。注释声明「不来自 AGENTS_SHARED、不按标题解析抽取，只复用既有规范」——这是**文本 owner 在 runtime 代码**而非 MD 的唯一块 |
| `<pi_global_instructions source="PI_CODING_AGENT_DIR/AGENTS_GLOBAL.md">` | `pi/AGENTS_GLOBAL.md`（13477B） | `src/agents-global/index.ts` + `pi/extensions/agents-global.ts`：child guard（`PI_SUBAGENT_CHILD=1` 时 factory 前 return，不注册 hook、不读文件）；自有块最小替换去重 | 仅 main。child 确认不加载 |
| profile 正文 | `pi/agents/<name>.md` frontmatter + body（executor 954B / delegate 1150B / reviewer 1145B） | enhanced runtime 按 `systemPromptMode: append` 追加进 child system；frontmatter `models/thinking/tools/inheritProjectContext` 是 runtime 配置数据 | 仅对应 child。本 run（executor child）system prompt 中可直接看到 executor.md 正文原文 |
| 根 `AGENTS.md`（6224B）与嵌套 `packages/pi-subagents-enhanced/AGENTS.md`（2289B） | 项目上下文（上游 pi AGENTS 发现机制） | main 会话默认注入；child 是否注入由 profile `inheritProjectContext` 决定：delegate 显式 `true`，executor/reviewer 无该字段。本 run（executor child）system prompt 未收到根 AGENTS.md 内容 | main 注入；executor/reviewer child 未注入（适用性≠注入，见 §5-C2） |

child 实际注入合计：SHARED 2749B + profile body ≈0.3–0.9KB + runtime child 块 ≈0.4KB；**不含** GLOBAL（13477B）与根 AGENTS.md（6224B）。main 实际注入：根 AGENTS.md + GLOBAL + SHARED ≈ 22.4KB。

### 2.2 skills（metadata 索引可见，正文按需 read）

| 层 | 机制 | 证据 |
|---|---|---|
| `skill-overrides/<name>/` | git 管理的唯一 skill 源（`skill-overrides/README.md`）；`init-pi.sh` 调 `scripts/sync-skills.ts` symlink 到 `~/.agents/skills`；frontmatter（name+description）由 `src/skill-whitelist/skill.ts` 校验 | sync 脚本与 README 原文 |
| `.pi/skills/<name>/` | pi 项目级 skill 目录，上游原生 discovery 扫描（3 个：cache-stats 1519 chars、external-llm-review-provider 6279 chars、manage-providers 2035 chars） | 目录现场 + skill-overrides/README 措辞 |
| metadata vs 正文 | name+description 进 skill 索引可见；SKILL.md 正文仅按需 read；skills metadata 可见不等于正文注入 | 上游 skill 机制约定；本盘点未发现正文默认注入路径 |
| whitelist 退役 | 本仓伪 whitelist（resources_discover scanner）已退役，原生 discovery 是唯一 owner（测试注释「M09」） | `test/skill-whitelist-extension.test.mjs` 头部、`test/skill-list.test.mjs` |

skill-overrides 存量（正文 chars）：exa-search 2915、git-commit-convention 1092、playwright 1756（另有 `docs/{authentication,diagnostics,maintenance,operations}.md` 共 4795 chars，正文自述「按需加载二级文档」）、test-driven-development（排除，仅登记 18560B）、writing-plans 4058、writing-skills 26221（附属 anthropic-best-practices.md 46055、persuasion-principles.md 5875、testing-skills-with-subagents.md 12825、examples/CLAUDE_MD_TESTING.md 5423）。writing-skills 附 LICENSE（上游 external 来源），但加载入口是本仓 `sync-skills.ts`（override 覆盖同名 skill）；writing-plans 正文已全面本仓化中文重写（含 pi/AGENTS.md 交叉引用），上游属性仅存 LICENSE 痕迹。

### 2.3 docs/**（不注入，按需 read）

`docs/plans/`、`docs/architecture/`、`docs/research/`、`docs/superpowers/` 等均为设计/验收/研究文档，**不在任何注入链中**；仅两种可见路径：(a) 文件工具按需 read；(b) 被有效规范点名引用（唯一实例：根 AGENTS.md「Goal 改造执行方式」引用 `docs/superpowers/plans/2026-08-13-goal-obligation-runtime.md`，59.7K——文档本体仍不注入，生效的是 AGENTS.md 中的门禁条文）。docs/superpowers/specs/、docs/decisions/ 等同层处理。

### 2.4 工具旁文本（tool descriptions / promptSnippet）

| 工具 | 定义位置 | 文本要点 |
|---|---|---|
| `subagent`（typed 派发） | `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:117` `TYPED_SUBAGENT_DESCRIPTION`（约 230 字，中文） | 路由规则（action→control、writePaths→coding、其余→generic）、generic/coding 参数形状、agent 名单（delegate/executor/reviewer）、`{action:"list"}` 查看名单 |
| `subagent_worktree` | `packages/pi-subagents-enhanced/src/workspace/tool.ts:60`；`SUBAGENT_WORKSPACE_DESCRIPTION`（tool.ts:28，约 330 字）+ `promptSnippet` + 2 条 `promptGuidelines`（注释 M05B：「按状态与 token 操作、coding 集成 child-owned；不复制整状态机」） | 状态机摘要（released/active/reserved/allocating/disposing/preserved/cleanup-debt 全枚举）、status 权威、action_token、CHILD_OWNS_INTEGRATION |
| supervisor 侧工具 | `src/subagent-dispatch/supervisor-adapter.ts:13` `SUPERVISOR_DESCRIPTION`（英文单行） | 读 child 请求/回复决策 |
| `contact_supervisor`（child 侧） | 上游 `pi-subagents` 包 `src/intercom/native-supervisor-channel.js:183`（enhanced 包 node_modules 依赖，非本仓源码） | 英文单行描述 + reason 三值（need_decision/interview_request/progress_update）校验在代码 |
| 其他扩展工具 | `pi/extensions/*.ts` + `src/<feature>/`（bash-async、background-activity、compact-tools 等） | 本次按需抽查，未逐字盘点（见 §8） |

## 3. 规则级盘点表

加载时机列：`startup` = main 会话默认注入；`child-startup` = child system prompt；`on-read` = 按需 read；`index` = 仅 metadata 索引可见。候选列：`保留MD` / `runtime代码` / `tool旁文本` / `保留MD+skill`。

| # | 规则（原文摘要） | 精确 path | 加载时机 | main/child | 与 tool 描述重复 | 候选归属 | owner | 迁移需保存内容 | 风险 |
|---|---|---|---|---|---|---|---|---|---|
| R1 | 调研/审阅/执行默认委派 subagent，禁止默认 inline | `pi/AGENTS_GLOBAL.md` 任务执行模式 | startup | main | 无 | 保留MD | 仓主 | —（政策，人类决策链） | 迁 tool 会把编排政策固化为机械规则 |
| R2 | 派发格式 generic/coding 字段与示例代码块 | 同上 派发格式 | startup | main | 与 TYPED_SUBAGENT_DESCRIPTION 路由句同义（扁平字段、writePaths→coding） | tool旁文本（参数 schema 与路由）+ MD 留语义索引 | 仓主 + enhanced 包 | 示例仅入 tool description；MD 保留「任务语义不因字段形状改变」 | 双源漂移：字段改名后示例失效 |
| R3 | `list` 查看可用 agent 与档位 | 同上 Subagent 组合流程 step1；extension.ts:117 | startup | main | 2 处重复 | tool旁文本 | enhanced 包 | list 语义（名单+档位只读） | 拆独立工具后两处都要同步（见 §5） |
| R4 | 首轮 reviewer 自动一次、后续每轮用户授权、无固定上限 | 同上 Reviewer 授权与次数 | startup | main | 无 | 保留MD | 仓主/用户 | —（人类授权决策，不可 tool 化） | — |
| R5 | 计划编写必须本会话 inline，禁止交 subagent | 同上 计划编写、修改 | startup | main | 无（writing-plans「执行交接」明确「本 Skill 不定义或重复任何执行方式的协议」——非重复的正面样例） | 保留MD | 仓主 | — | — |
| R6 | 模型分级：review 档/primary 档/deterministic 档；裸名解析失败停止派发 | 同上 模型分级 + `pi/agents/*.md` frontmatter `models/thinking` | startup + child-startup | main | 无重复：frontmatter 是 runtime 数据，`src/subagent-dispatch/model-selection.ts` 是执行 | 保留MD（政策）+ frontmatter（数据） | 仓主 | 档位→角色映射 | 测试已锁：`test/reviewer-agent.test.mjs` 断言 profile frontmatter 不得授予新权限 |
| R7 | 模型不可用紧急补救（qualified 显式 provider/model，不得绕 API guard） | 同上 模型不可用紧急补救 | startup | main | 无 | 保留MD | 仓主 | 恢复决策顺序 | tool 权限无法替代「是否 qualified」的人类/上级判断 |
| R8 | worktree 选择规则与 writePaths 文法 | 同上 Worktree 选择 | startup | main | 与 dispatch schema 校验（`subagent-dispatch-writepaths-grammar.test.mjs` 所测实现）部分同义 | 保留MD（政策）+ runtime 校验（执行） | 仓主 | — | 文法细则两处需同步版本 |
| R9 | Workspace 处置状态机（status 权威、allowed_dispositions、action_token、CHILD_OWNS_INTEGRATION、released 终态）+ JS 处置示例 | 同上 Workspace 处置 | startup | main | **3 处重复**：SUBAGENT_WORKSPACE_DESCRIPTION 全文枚举状态机 + promptGuidelines 2 条 + 本节 | **最大迁移候选**：每操作独立工具后，各工具 description 承接各自动作说明；MD 留跨工具「status 权威」短索引 | enhanced 包 + 仓主 | 状态机语义、token 一次性语义、child-owned 集成边界 | 拆分后 discoverability 下降；重复说明分散到 N 个工具 |
| R10 | dispatch 后不 sleep/poll；status 仅限用户要求/干预/诊断 | 同上 生命周期 | startup | main | 无（bash-async/async-progress 是 runtime 实现，非文本） | 保留MD（跨工具运行协议） | 仓主 | — | — |
| R11 | resume 必须携带非空新 message；暂停/完成/失败有恢复路径，stopped 不可恢复 | 同上 生命周期 | startup | main | 与上游 recovery-resume-contract 执行同源 | 拆分后「非空 message」进 resume 工具 description；恢复**决策顺序**保留 MD | enhanced 包 + 仓主 | 偶发失败优先 resume、不重放已完成步骤、resume≠原进程续跑 | 决策策略工具化会丢人类判断点 |
| R12 | 偶发 provider 故障优先 resume 原 run，不自动 fresh 重派/换模/无限重试 | 同上 主管恢复规则 | startup | main | 无 | 保留MD | 仓主 | —（恢复策略=人类决策链） | — |
| R13 | TDD 默认禁令（含不得 read/load TDD skill） | `pi/AGENTS_SHARED.md` 测试与逻辑变更 | startup+child-startup | 全部 | 无 tool 重复 | 保留MD | 仓主 | 排除路径：`skill-overrides/test-driven-development/{SKILL.md,writing-good-tests.md}`（仅登记未读） | 见冲突 C1 |
| R14 | 敏感信息：凭据不直接访问；Git 信息脱敏；泄露不自动轮换 | 同上 敏感信息 | startup+child-startup | 全部 | manage-providers skill（`.pi/skills`，2035 chars）将「凭据经 /dev/tty 无回显输入」操作化 | 保留MD（政策）+ skill（操作） | 仓主 | — | 分层良好样例 |
| R15 | git commit 需遵循 git-commit-convention skill；本条不是提交授权 | 同上 Git Commit 规范 | startup+child-startup | 全部 | 无重复：skill 承接格式细则（Type Whitelist/AI Signature 等于 skill-overrides，1092 chars） | 保留MD（授权门禁）+ skill（格式） | 仓主 | — | 分层良好样例 |
| R16 | 输出语言中文（专业用词豁免） | 同上 输出语言 | startup+child-startup | 全部 | 无 | 保留MD | 仓主 | — | — |
| R17 | 工单/申请需用户确认 | 同上 工单；GLOBAL 工单和阻塞决策；runtime child 块第 3 条 | startup+child-startup | 全部 | **3 处同文**（含 runtime 硬编码复刻） | 保留双源但登记同文（见 D4） | 仓主 + agents-shared 代码 | — | 三处漂移风险 |
| R18 | 辅助脚本批量处理，禁止大量 bash 挨个调用 | 同上 辅助脚本 | startup+child-startup | 全部 | 无 | 保留MD | 仓主 | — | — |
| R19 | TUI 只渲染精简投影，不改写 raw payload | 根 `AGENTS.md` TUI 精简边界 + SHARED 安全边界第 2 条 + `packages/pi-subagents-enhanced/AGENTS.md` TUI 精简边界 | startup（+enhanced 包内嵌套发现） | main（+包内工作者） | **3 处近同文**（见 D1） | 保留MD，单一来源候选：SHARED/包级引用根条文 | 仓主 | — | 三处措辞漂移 |
| R20 | 缺陷数据来源分类门禁（三类来源、fail closed） | 根 `AGENTS.md` 缺陷数据来源分类门禁 | startup | main（适用全部） | 无 | 保留MD（项目政策/经验知识） | 仓主 | — | — |
| R21 | 目录职责与依赖边界（scripts/、pi/extensions/、packages 边界） | 根 `AGENTS.md` 目录职责与依赖边界 | startup | main（适用全部） | 无 | 保留MD | 仓主 | — | — |
| R22 | 禁止 MCP 接入，外部工具走 skill wrapper | 根 `AGENTS.md` 外部工具接入规范 | startup | main（适用全部） | `src/mcp-policy/` 是执行阻断（代码非文本）；exa-search/playwright skill 是替代通道 | 保留MD（政策）+ runtime（执行） | 仓主 | — | runtime 阻断是执行不是文本源，不构成重复 |
| R23 | npm 官方源；settings.json 提交规则；models.json 本机配置 | 根 `AGENTS.md` npm 源规范 / pi/settings.json 提交规则 / pi/models.json 本机配置 | startup | main | 无 | 保留MD（git 卫生政策） | 仓主 | — | settings/models 文件本身禁读（本盘点未验证字段现状） |
| R24 | 停止条件（四类：前提矛盾/越写路径/验收不可能/权限阻塞） | SHARED 停止条件 + GLOBAL 派发停止条件 + runtime child 块第 2 条 | startup+child-startup | 全部 | **3 处重叠**（child 块复刻 SHARED+GLOBAL 并集，见 D3） | 保留MD；child 块是刻意复刻（代码注释声明「只复用既有规范、不发明新 authority」） | 仓主 + agents-shared 代码 | — | 三处漂移 |
| R25 | child 不新增委派、不接管 DAG | runtime child 块第 1 条 + delegate/executor/reviewer 正文「不得委派其他 subagent」+ GLOBAL（main 侧） | child-startup | child | 2 层（runtime 块 + profile 正文同义） | 保留双源（防御纵深：runtime 强制 + 角色自觉） | agents-shared 代码 + 仓主 | — | 同文漂移 |
| R26 | 决策阻塞经 contact_supervisor need_decision 上报等待 | SHARED 停止条件、GLOBAL Escalation、child 块第 2 条、delegate/executor 正文 | child-startup | 全部 | contact_supervisor description（上游包，英文单行）仅说明工具用途，**不含**何时必须上报的政策——分层正确 | 保留MD（政策）+ tool 描述（用途） | 仓主 + 上游包 | — | 上游描述英文，与 MD 中文政策互补不重复 |
| R27 | 30 分钟派发预算非 watchdog 硬上限；粒度上限一次一精确变更 | GLOBAL 派发适合性 | startup | main | 无 | 保留MD | 仓主 | — | — |
| R28 | 不假设 child 继承 skills；skill 全文不入 task，给确切路径先 read 再用；不注入 TDD skill 路径 | GLOBAL 派发适合性末条 | startup | main | 无 | 保留MD（跨会话协议） | 仓主 | — | 与 §2.2 的「metadata 可见≠正文注入」一致 |
| R29 | 外部 CLI 专业知识（playwright 生命周期/headed 边界/二级文档按需加载；exa-search REST 用法/Query Tips） | `skill-overrides/playwright/SKILL.md` + docs/*.md；`skill-overrides/exa-search/SKILL.md` | index + on-read | 按需 | 无 | 保留skill MD（经验知识） | 仓主 | — | 正文自述二级文档按需加载——skill 内部分层样例 |
| R30 | cache-stats 用法；manage-providers 非敏感 provider/model 定义管理；external-llm-review provider 八步触碰点 | `.pi/skills/{cache-stats,manage-providers,external-llm-review-provider}/SKILL.md` | index + on-read | 按需 | 无 | 保留skill MD | 仓主 | external-llm-review-provider 正文含「TDD 测试」步骤字样——指外部 provider 仓的测试流程，非 TDD skill，不计入排除对象，但措辞易误触 R13 禁令 | 择机改为「测试」中性措辞（不属本任务） |
| R31 | skill 创建/编辑方法论 | `skill-overrides/writing-skills/SKILL.md`（26221 chars）+ 附属 4 文档 | index + on-read | 按需 | 无 | 保留skill MD；上游 external 来源（LICENSE）+ 本仓 override 加载入口 sync-skills.ts | 仓主（override）/上游（原文） | — | 附属文档含 TDD Mapping/RED-GREEN 章节标题，与 R13 的适用关系需 owner 裁决（见 C3） |
| R32 | 编写实现计划（用户授权门禁三态、DAG/Deps/Wave、任务模板） | `skill-overrides/writing-plans/SKILL.md`（4058 chars） | index + on-read | 按需 | 与 GLOBAL R5 明确互不重复（skill 末条声明） | 保留skill MD | 仓主 | — | 见冲突 C1 |
| R33 | Goal 改造 R0–R13 门禁；planned-goal 冻结账本 | 根 `AGENTS.md` Goal 改造执行方式（引用 docs/superpowers/plans/2026-08-13-goal-obligation-runtime.md，59.7K） | startup（条文）+ on-read（文档） | main | 无 | 保留MD（门禁条文）；计划文档属 docs 分层不注入 | 仓主 | — | — |
| R34 | enhanced 包内约束（TUI 边界副本、upstream 深层 import 集中 compat 入口、pi-subagents 0.75.0 锁版） | `packages/pi-subagents-enhanced/AGENTS.md`（2289B） | startup（包内嵌套发现） | 包内工作会话 | TUI 条与 R19 重复 | 保留MD；compat 边界是工程约束留 MD | 仓主 | — | TUI 三处漂移（同 D1） |

## 4. 重复与冲突清单

重复（同文/近同文，迁移时需同源化但不得丢政策属性）：

- **D1** TUI raw 不改写：根 `AGENTS.md` ↔ `pi/AGENTS_SHARED.md` 安全边界 ↔ `packages/pi-subagents-enhanced/AGENTS.md`。3 处。
- **D2** dirty 现场不覆盖/stash/reset 禁令：`pi/AGENTS_SHARED.md` 安全边界第 3 条（通用）↔ `pi/AGENTS_GLOBAL.md` Workspace 处置「origin dirty 时不得自动 stash/reset」。2 处，视角不同（通用安全 vs workspace 处置），合并需保留两视角。
- **D3** 停止条件：SHARED 停止条件 ↔ GLOBAL 派发停止条件（Escalation）↔ runtime `CHILD_EXECUTION_BOUNDARIES` 第 2 条。3 处；child 块为刻意复刻（代码注释声明），漂移需人工同步。
- **D4** 工单确认：SHARED 工单 ↔ GLOBAL 工单和阻塞决策 ↔ runtime child 块第 3 条。3 处。
- **D5** workspace 状态机与处置规则：GLOBAL Workspace 处置（规则+JS 示例）↔ `SUBAGENT_WORKSPACE_DESCRIPTION`（状态机全文枚举）↔ `promptSnippet`/`promptGuidelines`。3 处——**最大重复块**，也是 §5 新方向的主要迁移对象。
- **D6** contact_supervisor 门禁：SHARED ↔ GLOBAL ↔ child 块 ↔ delegate/executor profile 正文。4 处同义。
- **D7** 派发路由与参数形状：GLOBAL 派发格式 ↔ `TYPED_SUBAGENT_DESCRIPTION`。2 处。
- **D8** `{action:"list"}`：GLOBAL Subagent 组合流程 ↔ `TYPED_SUBAGENT_DESCRIPTION`。2 处。

冲突：

- **C1** `skill-overrides/writing-plans/SKILL.md` 任务模板把「编写失败测试→RED→最小实现→GREEN」设为默认任务步骤（概述亦写「遵循 DRY、YAGNI 和 TDD」），而 `pi/AGENTS_SHARED.md` 规定默认禁止 TDD、需用户明确授权。按系统提示优先序 SHARED 胜出，但 skill 正文未作任何让位声明（对比 R5 的正面样例），child read 该 skill 后易按模板默认走 RED/GREEN。属**文本级冲突**，需 owner 择一：skill 加让位条款或模板改中性验证步骤。（本任务不改。）
- **C2** 根 `AGENTS.md` 首段称「本根目录工程规范对所有 agent（含 subagent）的适用」，但 executor/reviewer profile 无 `inheritProjectContext`，本 run（executor child）实测未收到根 AGENTS.md 注入。「适用」（规范性义务）与「注入」（交付机制）是两回事：child 合规依赖父会话在 task 合同中 inline 相关约束。文本未错但存在误读风险，宜在 AGENTS.md 或 profile 注释中写明交付机制。
- **C3** writing-skills 附属文档（testing-skills-with-subagents.md 等）含 RED/GREEN/TDD Mapping 章节标题（本盘点仅标题级，未展开正文）。与 R13 禁令的适用关系（方法论引用 vs 可执行 TDD 流程）未知，保留给 owner。
- **C4** delegate profile `inheritProjectContext: true` 而 executor/reviewer 缺省——三类 child 的项目上下文不对称。是否有意（delegate 需要工程上下文、executor 靠合同 inline）未知，保留。

## 5. 架构方向影响登记：全部拆开，每个操作独立工具

方向：每个操作独立工具；per-tool `description`/`promptGuidelines` 承接该操作的调用说明；跨工具运行协议在 MD 留**简短索引**（指向状态权威与工具清单，不重复每工具长篇政策）。本节仅登记，不实施、不删除、不改 closeout 计划/生产。

**受影响的有效文本（当前生效，迁移点）：**

| 位置 | 现文 | 新方向下的迁移点 |
|---|---|---|
| `pi/AGENTS_GLOBAL.md` Workspace 处置 | 整节 + JS 示例 `subagent_worktree({action:"status"/"dispose"/"release"})`、互斥分支、`allowed_dispositions`/`action_token`/`CHILD_OWNS_INTEGRATION` 规则 | `subagent({action})` 示例整段失效：拆分后需改为各独立工具名；处置规则拆为 per-tool 说明 + MD 留「以 status 为权威」跨工具短索引 |
| `pi/AGENTS_GLOBAL.md` 生命周期 | dispatch 不 sleep/poll；`status` 仅限用户要求；`resume` 非空新 message；stopped 不可恢复 | sleep/poll 禁令与 status 使用时机是跨工具协议→MD 短索引；resume 参数要求→resume 独立工具 description |
| `pi/AGENTS_GLOBAL.md` Subagent 组合流程 step1 | `list` 查看可用 agent 与档位 | list 独立工具化后此处改指新工具名 |
| `src/subagent-dispatch/extension.ts:117` | 路由句含 `action→control` 与 `{action:"list"}` 查看名单 | list 从 typed 工具参数中拆出；**start/generic/coding 路由是任务语义，保留在派发工具，不因此拆出全新调度器** |
| `src/workspace/tool.ts:28` `SUBAGENT_WORKSPACE_DESCRIPTION` | 单工具 description 内枚举完整状态机 + list/status/dispose/release 动作 | 拆分后每工具 description 只含本动作前置条件与 token 语义；状态机全枚举保留在 status 工具（它就是状态权威投影）或 MD 索引 |
| `src/workspace/tool.ts:60-70` promptSnippet/promptGuidelines（M05B 注释） | 「按状态与 token 操作、coding 集成 child-owned；不复制整状态机」 | 该注释本身就是「不复制整状态机」原则的既有实践，拆分后逐工具续用该原则 |
| 受影响测试（仅登记，不编计划） | `test/subagent-workspace-tool.test.mjs`、`test/subagent-workspace-recovery-tool.test.mjs`、`test/subagent-dispatch-rpc.test.mjs`、`test/subagent-dispatch-extension.test.ts` 等断言单工具 action 参数面 | 工具拆分将改变参数面，测试归父层后续安排 |

**不属于拆分对象：** contact_supervisor 的 `reason` 三值（need_decision/interview_request/progress_update）是请求语义枚举而非多操作复用；generic/coding/start 派发是任务语义（用户「每操作」不构成拆新调度器的依据）。

**设计文档 vs 当前有效文本：** `docs/plans/2026-09-10-unified-delegation-workspace-harness.md`（53.2K）、`docs/plans/2026-09-03-unified-subagent-workspace-lifecycle.md`（41.8K）、`docs/architecture/task-scheduler-adapter-contract.md` 等为设计/验收文档，非 runtime 注入输入；其中与「合并 workspace/单工具处置」相关的提案被本方向覆盖的部分，以本节登记为准，不回改设计文档。

**待明确决策（未决，不假设）：** 旧单工具 `subagent_worktree`（及 typed 工具内 action 参数）的兼容期长短/是否保留 alias 双注册——本报告仅登记该决策存在，不提方案。

**可评估的影响（不编 token 收益）：** 工具数增加→工具索引条目变多；说明由 1 处长文变 N 处短文→跨工具重复说明的风险点从 1 个变 N 个；discoverability 依赖每工具 description 的自描述质量。以上可用「重复段落计数 + 每工具 description 是否含他工具参数说明」的结构性检查评估（见 §6-V2），不做效果断言。

## 6. 单一事实来源建议与可验证标准

原则（延续任务方向，非实施计划）：**政策/角色/经验知识留 MD**（委派默认、授权门禁、恢复决策、分类门禁、安全边界）；**操作调用说明进 tool 旁文本**（参数、状态、token 语义）；**跨工具协议留 MD 短索引**（不复制 per-tool 细则）；runtime 硬编码块（child boundaries）维持现状但建立同文对照。

建议（每条附可验证标准，均可用 grep/计数/存在性断言，不需要模型效果评估）：

- **S1** workspace 状态机细则单一来源迁 per-tool description：V1 `grep -c "subagent_worktree" pi/AGENTS_GLOBAL.md` 拆后为 0 或仅存独立工具名清单；V2 逐工具检查 description 不含其他工具的参数说明（reviewer 核对清单项）；V3 状态机枚举只出现在 status 工具或 MD 索引之一：`grep -c "cleanup-debt" <status工具定义文件>` 恰为枚举处。
- **S2** GLOBAL 派发示例与 TYPED_SUBAGENT_DESCRIPTION 去同文：`grep -c "writePaths" pi/AGENTS_GLOBAL.md` 与 description 保留各自语义层（字段语义 vs 编排政策），示例代码块仅在 MD 或仅在 tool 二选一。
- **S3** TUI 条文三处同文断言：辅助脚本 diff 根 AGENTS.md 与 SHARED/包级 AGENTS.md 对应段落（规范化空白后应逐字一致），进 doctor 类检查的候选。
- **S4** writing-plans TDD 冲突（C1）：skill 正文出现「RED」「GREEN」次数与 SHARED 让位条款存在性的组合检查；行为试跑见 §7-T3。
- **S5** child 注入三块 tag 存在性：SHARED tag 有、GLOBAL tag 无、child boundaries tag 有（本 run 已实证该组合）；可固化为集成断言（现 `test/heartbeat-parent-death.integration.mjs` 已 symlink agents-shared 入口，具备挂载点）。
- **S6** runtime child 块与 SHARED 的同文对照：D3/D4 涉及条文在两侧各出现一次且文字一致（脚本比对常量与 MD 段落），防漂移。

## 7. 验证建议（不运行）

最小证据验证（脚本级，无模型调用）：

- V-a 按 §6 各 grep/计数标准建立检查清单（一次性脚本即可）。
- V-b skill 正文 chars 基线表（本报告 §2.2 数字）入库，变更时 diff 可见。

真实行为试验（建议，未执行；均需父层授权与排期）：

- **T1** main 会话试跑一次 `worktree:true` 派发的完整处置对话（status→dispose→release），在拆分前后各一次，核对 child/parent 是否按「status 权威」行动，观察新工具选择是否自然。
- **T2** 派发 executor/generic 探针 child，让其复述 system prompt 中存在的规范块（SHARED/child 块）与不存在的块（GLOBAL/根 AGENTS.md），实证注入链（对照 §2.1）。探针只报告 tag 存在性，不打印正文全文。
- **T3** reviewer 试审一份含 RED/GREEN 模板的计划，观察是否按 SHARED 禁令拦截（C1 冲突的实际影响面）。
- **T4** writing-skills 使用试跑：创建一个测试 skill，观察 TDD Mapping 章节是否诱导 TDD 行为（C3 影响面）。

## 8. 未知与残留风险

- 「禁止 GPT 用户 scope」：在本仓有效文本中未找到对应条文；相关配置可能位于禁读的 `pi/models*.json`/`pi/settings.json` 或 dispatch runtime 校验中，**未知保留**。已知有效文本中的模型禁令仅有 deepseek（SHARED 安全边界）。
- supervisor 侧工具（`supervisor-control-plane.ts`、`root-broker-server.ts`）的完整 tool description 未逐字盘点（仅 `SUPERVISOR_DESCRIPTION` 单行）；src/ 其余扩展工具（bash-async、background-activity、compact-tools 等）旁文本未逐条对照。
- `.pi/skills` 与 pi config root（`pi/`）并存的确切 discovery 优先级属上游行为，未读上游源码验证；本报告按「两者都被原生 discovery 扫描」记录。
- 旧单工具兼容期：待明确决策（§5），本报告不做假设。
- contact_supervisor 工具定义位于上游 `pi-subagents` 包 node_modules（非本仓源码）；其 description 变更不受本仓直接管控。
- 全程未运行测试/npm/tsc/网络；未 stage/commit/stash/reset；`git status` 既有 dirty 文件（README.md、docs/plans/* 等 20+ 项）未被触碰，无 staged 文件。
