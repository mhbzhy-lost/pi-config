# AGENTS 与 Skill 一致性独立架构审查

**日期：** 2026-08-17
**范围：** 当前工作树中的 `pi/AGENTS.md`、实际 Skill 发现链、18 个实际可发现 Skill，以及它们明确引用的非敏感文档、文件和运行时前提。
**排除：** `docs/superpowers` 历史、Goal Engine 历史状态及其测试；未运行或调用 Goal Engine。

## 1. 结论摘要

- **[实际发现集]**：当前配置实际加载 18 个去重 Skill，且 Pi loader 返回 0 条诊断。
- **推荐**：把本报告的 18 项清单视为“当前机器快照”，不要把 `skills.list` 当成运行时白名单，因为 Extension 实际扫描目录。
- **不选原因**：仅看 `skills.list` 会漏掉 5 个个人 Skill 和 3 个项目 Skill。
- **选错代价**：换机、fresh clone 或新增个人 Skill 时暴露，修复代价中。

- **[AGENTS 是否增强]**：需要，但只建议恢复 TDD 的最小加载门禁，不复制 TDD 流程。
- **推荐**：在 `pi/AGENTS.md` 的 Bugfix 段后加入两句 TDD 路由；Playwright 与 writing-plans 先修 description，不加全局流程。
- **不选原因**：仅靠 TDD 当前 description 会漏掉配置、重构和 Skill 行为变更，而且 Pi 官方明确说明模型不总会加载匹配 Skill。
- **选错代价**：首次实现代码已写后才发现未走 RED 时暴露，返工代价高。

- **[最高风险不一致]**：writing-plans description 与授权门禁相反；TDD 的 bug 文档路径/适用范围与 AGENTS 冲突；manage-providers 会诱导直接处理密钥。
- **推荐**：先修 description 与规则正文，再处理发现链的双处维护。
- **不选原因**：这些问题会在正常启发式触发时直接改变行为，不是纯文档美观问题。
- **选错代价**：未授权写计划、绕过敏感信息门禁或 TDD 顺序错误时暴露，修复代价高。

## 2. 审查方法与安全边界

1. 以 `scripts/pi-shell.zsh`、`skill-whitelist-extension.mjs` 和 Pi 0.84.2 loader 源码还原生产发现链，而不是只看目录约定。
2. 通过 Extension 的 `resources_discover` 结果调用 Pi `loadSkills(..., includeDefaults:false)`；结果为 **18 个 Skill、0 diagnostics**。
3. 对 Git 管理状态使用 `git ls-files`，对运行时依赖只检查路径/命令是否存在；未读取脚本实现。
4. 个人服务器 Skill 仅提取 frontmatter、依赖标记和非秘密路径；输出前对可能的地址、主机和凭据值做了屏蔽。
5. **未读取** `.env`、`auth.json`、私钥/证书、cookie、token、服务器秘密或任何凭据内容。

## 3. 实际 Skill 发现机制

### 3.1 当前生产链

1. `scripts/pi-shell.zsh:4` 将 `PI_CODING_AGENT_DIR` 指向仓库 `pi/`；同文件 `:14` 对每次 Pi 调用强制追加 `--no-skills`。
2. 因此 Pi 默认位置扫描被关闭；Pi 官方也说明 `--no-skills` 关闭默认发现（`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/skills.md:24-41`）。
3. `pi/extensions/skill-whitelist.ts:1` 自动加载仓库 Extension；其实现扫描：
   - `~/.agents/skills`（`scripts/lib/skill-whitelist-extension.mjs:38-43`）；
   - 当前 `cwd/.pi/skills` 与 `cwd/.agents/skills`（`:30-35,44-49`）。
4. 扫描器只把“直接子目录/目录软链且根部存在 `SKILL.md`”加入路径（`:7-23`）；Pi 随后对每个加入的目录递归读取。它不实现官方默认扫描的 `~/.pi/agent/skills`、祖先 `.agents/skills` 或 `.pi/skills` 根级 `.md`。
5. `resources_discover` 返回的路径即使在 `--no-skills` 下仍会被追加并重新加载：Pi loader 的 `extendResources()` 见 `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js:229-245`，`noSkills` 初始化与后续追加见 `:329-338,499-510`。
6. Pi 以真实路径消除软链重复，并对同名不同文件保留先出现者：`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js:296-325`。当前快照没有同名碰撞。

### 3.2 `skills.list` 与 settings 的真实作用

- `skill-overrides/skills.list:7-17` 只被 `scripts/sync-skills.mjs:9-20` 用来创建 `~/.agents/skills` 软链；Extension **不读取**该清单。
- `scripts/sync-skills.mjs:14` 与 `scripts/doctor.mjs:181-188` 都向 `loadDesiredSkills` 传入 `null` 本地清单；因此 `skill-overrides/skills.local.list:1-3` 当前不参与同步、Doctor 或运行时发现。
- `skill-overrides/skills.local.list` 的三个名称在 `skill-overrides/<name>/SKILL.md` 均不存在；若未来把该文件传回 `loadDesiredSkills`，会因 `scripts/lib/skill-whitelist.mjs:99-110,114-129` 的仓内源约束直接失败。
- `pi/settings.json:10-15` 显式关闭 `pi-subagents` 包的 Skill；其 `pi-subagents` Skill 因而不在实际清单。
- `pi/settings.json:17` 的本地 package 路径按 settings 所在目录解析为 `/Users/mhbzhy/.r2c/integrations/pi-adapter`，本机不存在；这是独立的断裂 package 依赖，没有贡献 Skill。
- settings 没有顶层 `skills` 数组；当前 18 项全部来自自定义 Extension 的三个扫描根。

## 4. 去重 Skill 清单

“Git 管理”以当前 `git ls-files` 为准；“未跟踪”表示当前机器可用，但 fresh clone 不包含源文件。

| # | 名称 | 实际来源与发现路径 | 声明来源 | Git 管理 | 证据 |
|---:|---|---|---|---|---|
| 1 | `external-llm-review` | `~/.agents/skills` 软链 → `skill-overrides/external-llm-review` | `skills.list` | 是 | `skills.list:7`；Skill `:2-3` |
| 2 | `git-commit-convention` | 同上 | `skills.list` | 是 | `skills.list:8`；Skill `:2-3` |
| 3 | `test-driven-development` | 同上 | `skills.list` | **否，未跟踪** | `skills.list:9`；Skill `:2-3` |
| 4 | `writing-skills` | 同上 | `skills.list` | **否，未跟踪** | `skills.list:10`；Skill `:2-3` |
| 5 | `writing-plans` | 同上 | `skills.list` | **否，未跟踪** | `skills.list:11`；Skill `:2-3` |
| 6 | `subagent-dispatch` | 同上 | `skills.list` | 是 | `skills.list:12`；Skill `:2-3` |
| 7 | `using-goal-engine` | 同上 | `skills.list` | 是 | `skills.list:13`；Skill `:2-3` |
| 8 | `exa-search` | 同上 | `skills.list` | 是 | `skills.list:15`；Skill `:2-3` |
| 9 | `playwright` | 同上 | `skills.list` | 是 | `skills.list:16`；Skill `:2-3` |
| 10 | `browser-auth-session` | 同上 | `skills.list` | 是 | `skills.list:17`；Skill `:2-3` |
| 11 | `aliyun-beijing-server` | `~/.agents/skills/aliyun-beijing-server` 本机目录 | `skills.local.list:3`，但运行时靠目录扫描 | 否 | `~/.agents/skills/.../SKILL.md:2-3` |
| 12 | `aliyun-hangzhou-server` | `~/.agents/skills/aliyun-hangzhou-server` 本机目录 | `skills.local.list:2`，但运行时靠目录扫描 | 否 | 同名 Skill `:2-3` |
| 13 | `aliyun-virginia-server` | `~/.agents/skills/aliyun-virginia-server` 本机目录 | `skills.local.list:1`，但运行时靠目录扫描 | 否 | 同名 Skill `:2-3` |
| 14 | `home-mac-connect` | `~/.agents/skills/home-mac-connect` 本机目录 | 未列清单 | 否 | 同名 Skill `:2-3` |
| 15 | `zomboid-server-admin` | `~/.agents/skills/zomboid-server-admin` 本机目录 | 未列清单 | 否 | 同名 Skill `:2-3` |
| 16 | `cache-stats` | 仓库 `.pi/skills/cache-stats` | 项目扫描根 | 是 | `.pi/skills/cache-stats/SKILL.md:2-3` |
| 17 | `external-llm-review-provider` | 仓库 `.pi/skills/external-llm-review-provider` | 项目扫描根 | 是 | 同名 Skill `:2-3` |
| 18 | `manage-providers` | 仓库 `.pi/skills/manage-providers` | 项目扫描根 | 是 | 同名 Skill `:2-3` |

**去重结果：** 10 个共享软链 + 5 个本机个人 Skill + 3 个项目 Skill = 18；名称均与 frontmatter 一致，当前 Pi loader 无诊断。

## 5. AGENTS / Skill 规则矩阵

| 严重级别 | 类型 | 触发场景 | 影响与判断 | 文件/行号证据 |
|---|---|---|---|---|
| **高** | 直接矛盾 | 任意 feature/refactor/Skill 逻辑变更 | TDD 要求所有生产或 Skill 逻辑先建 `docs/bugs/bug-*.md`；AGENTS 只对 bug/issue/incident 要求 `docs/bugs/<日期>-<摘要>.md`。范围与命名都冲突；AGENTS `:3` 虽声明更高优先级，但执行者仍面临两种模板。 | `pi/AGENTS.md:23-29`；`test-driven-development/SKILL.md:18-22` |
| **高** | Skill 内部矛盾 | 单行、纯文档或 verified existing-test-covered 变更 | 本地化段允许三类显式豁免，后文又写 “No exceptions” 和 “Never fix bugs without a test”；虽结尾再承认豁免，首次阅读会产生互斥命令。 | TDD Skill `:18-22,32,36-50,312-325` |
| **高** | description 与正文相反 | 多步骤任务但用户未授权计划 | description 说多步骤就使用并“产出计划”；正文明确复杂/多步骤不构成授权、应直接执行。仅 metadata 在上下文时会过早规划或写文件。 | `writing-plans/SKILL.md:3,12-18` |
| **高** | 敏感信息门禁冲突 | 添加 provider 或更新 API key | AGENTS 禁止直接访问凭据；manage-providers description 指向 `auth.json`，正文示例把 key 放命令行。辅助脚本可间接操作，但模型仍需直接接触 key，且值会进入会话/进程参数。 | `pi/AGENTS.md:12-17`；`.pi/skills/manage-providers/SKILL.md:3,8,19-26,44-45,50-55,88-92` |
| **高** | 全局硬门禁已移除、触发不足 | configuration、refactor、behavior change 或 Skill 行为修改 | TDD description 只写 feature/bugfix；正文范围更广。Pi 只常驻 description，且官方承认模型不总加载，因此不可保证在首次实现前触发。 | TDD Skill `:3,18-20,24-32`；Pi docs `skills.md:64-71` |
| **高** | 跨 Skill 授权冲突 | 授权计划中包含 Skill 修改，或用户只要求编辑 Skill | writing-plans 只有用户授权才允许 commit；writing-skills 把“每个 Skill 必须完成部署”及 commit/push 放入强制清单。两者同时加载时会对未授权提交/推送给出相反结论。 | `writing-plans/SKILL.md:10,154`；`writing-skills/SKILL.md:616-667` |
| **中** | 标准优先级不清 | 编写任何新 description | 主 writing-skills 规定 description **仅写触发条件**，其明确引用的官方参考规定同时写“做什么”和“何时用”。没有写明本地规则覆盖参考规则。本文按项目本地 SDO 标准评审。 | `writing-skills/SKILL.md:18-20,95-105,142-182`；`anthropic-best-practices.md:144-152,185-219,1101-1115` |
| **中** | 规则语义重复/歧义 | writing-plans 的 Subagent-Driven 交接 | 计划要求“在任务间审查”；AGENTS 禁止每个 subagent 完成后做全量独立审查。“审查”是否等于“全量独立审查”未定义，容易恢复已删除的逐任务重审。 | `pi/AGENTS.md:5-10`；`writing-plans/SKILL.md:167-175` |
| **中** | 发现事实双处维护 | 新增、删除或迁移 Skill | README/清单称“只有列入白名单才注入”，但 Extension 实际扫描所有合格目录；个人 Skill 无需清单，项目 Skill也绕过清单。清单是同步清单，不是运行时白名单。 | `skill-overrides/README.md:3-5`；`skills.list:1-5`；Extension `:30-52` |
| **中** | 死配置 | 维护 `skills.local.list` | 三个名称与真实 home Skill 重复，但同步、Doctor、Extension 均不读该文件；其仓内目标还不存在。修改它不会改变运行时。 | `skills.local.list:1-3`；`sync-skills.mjs:9-14`；`doctor.mjs:181-188` |
| **中** | 全局 Playwright 规则已移除 | 手动登录、headed/headless 切换 | 完整策略已集中到 Skill，方向正确；当前 description 对普通页面操作可靠，但没有 `manual login/headed/headless/UI/E2E/MCP` 等触发词。建议补 description，不把流程复制回 AGENTS。 | `playwright/SKILL.md:3,38-48`；`browser-auth-session/SKILL.md:3,14`；`pi/AGENTS.md` 当前无 Playwright 段 |
| **低** | 一致 | subagent 派发、commit 文案 | AGENTS 使用最小 Skill 路由，正文流程只在对应 Skill 维护；这是推荐模式。 | `pi/AGENTS.md:5-10,31-34`；`subagent-dispatch/SKILL.md:3`；`git-commit-convention/SKILL.md:3` |
| **低** | 一致 | Skill 英文、中文人审文档 | writing-skills 明确 Skill 可全英文但人审文章服从全局语言，与 AGENTS 中文要求一致。 | `pi/AGENTS.md:36-40`；`writing-skills/SKILL.md:20-22` |

## 6. Skill 依赖图

### 6.1 名称依赖

```text
browser-auth-session --REQUIRED SUB-SKILL--> playwright
playwright --登录态交接（功能性硬依赖）--> browser-auth-session

writing-skills --REQUIRED BACKGROUND--> test-driven-development
writing-skills --测试执行--> subagent-dispatch
writing-skills/testing-skills-with-subagents.md --REQUIRED BACKGROUND--> test-driven-development

writing-plans --可选提交--> git-commit-convention
writing-plans --执行选项--> subagent-dispatch
writing-plans --执行选项--> using-goal-engine
using-goal-engine --派发--> subagent-dispatch

home-mac-connect --REQUIRED SUB-SKILL--> aliyun-hangzhou-server
zomboid-server-admin --操作入口--> home-mac-connect
zomboid-server-admin --中继操作--> aliyun-hangzhou-server

external-llm-review-provider --被管理目标--> external-llm-review
```

### 6.2 名称边核验

| 来源 → 目标 | 强度 | 发现/名称状态 | 证据与结论 |
|---|---|---|---|
| `browser-auth-session` → `playwright` | REQUIRED | 可发现、名称一致 | `browser-auth-session/SKILL.md:14`；通过 |
| `playwright` → `browser-auth-session` | 功能性硬依赖但未标 REQUIRED | 可发现、名称一致 | `playwright/SKILL.md:42-44`；建议改为显式 REQUIRED SUB-SKILL |
| `writing-skills` → `test-driven-development` | REQUIRED BACKGROUND | 可发现、名称一致，但源未跟踪 | `writing-skills/SKILL.md:18,395`；当前可用，fresh clone 断裂 |
| writing-skills 参考 → TDD | REQUIRED BACKGROUND | 同上 | `testing-skills-with-subagents.md:13` |
| `writing-skills` → `subagent-dispatch` | 功能性硬依赖 | 可发现、名称一致 | `writing-skills/SKILL.md:560-571`；建议显式标记 |
| `writing-plans` → commit/subagent/Goal | 条件依赖 | 三者均可发现 | `writing-plans/SKILL.md:10,154,169-175`；名称通过 |
| `using-goal-engine` → `subagent-dispatch` | 功能性硬依赖 | 可发现、名称一致 | `using-goal-engine/SKILL.md:53-55`；名称通过 |
| `home-mac-connect` → `aliyun-hangzhou-server` | REQUIRED SUB-SKILL | 可发现、名称一致 | `~/.agents/skills/home-mac-connect/SKILL.md:34`；通过 |
| `zomboid-server-admin` → home/Hangzhou | 功能性依赖 | 均可发现、名称一致 | `~/.agents/skills/zomboid-server-admin/SKILL.md:10,60`；通过 |
| provider Skill → `external-llm-review` | 目标 Skill/目录 | 可发现、目标目录存在 | `.pi/skills/external-llm-review-provider/SKILL.md:8-9,180-185`；通过 |

### 6.3 相对文件与运行时前提

| 依赖 | 状态 | 证据/判断 |
|---|---|---|
| TDD → `writing-good-tests.md` | 存在 | TDD Skill `:211-215` |
| writing-skills → `anthropic-best-practices.md`、`graphviz-conventions.dot`、`render-graphs.mjs`、`persuasion-principles.md`、`testing-skills-with-subagents.md`、示例 | 均存在 | writing-skills Skill `:20,318-323,484,589`；testing 参考 `:15` |
| external review → `_config.py`、`_healthcheck.py`、`_provider.py`、`reviewer.py`、provider YAML、测试 | 均存在 | external review Skill `:25-36,51-58,66-85,245-254`；provider Skill `:180-185` |
| Playwright → `playwright.py` | 存在 | Playwright Skill `:10,23-36` |
| Exa/cache/provider/个人 Skill 脚本 | 均存在 | 各 Skill 的 Commands/入口段；只核验存在性，未读脚本 |
| `node`、`python3`、`npx`、`uv`、`git` | 当前环境均存在 | 非网络、非秘密的 `command -v` 核验；Python 3.14 满足 Exa `>=3.9`（Exa Skill `:10-18`） |
| Graphviz `dot` | **缺失，但明确为可选** | writing-skills `:320` 已说明缺失时打印安装指引；软风险 |
| Exa/API/provider 凭据与网络 | 未验证 | 涉及秘密和外部服务，按边界不读取、不发请求；保留运行时风险 |

### 6.4 断裂依赖与软风险

#### 断裂依赖

1. **三个核心共享 Skill 未被 Git 跟踪。** `skills.list:9-11` 已声明并且本机软链存在，但 `test-driven-development`、`writing-skills`、`writing-plans` 的完整目录均未进入 `git ls-files`；fresh clone 会使 `resolveSkillSource()` 在 `skill-whitelist.mjs:99-110` 失败。
2. **subagent-dispatch 写错当前工具 ABI。** Skill `:14` 把 `workspace_status(...)`、`workspace_disposition(...)` 写成独立工具；实际只注册一个 `subagent` 工具，二者是 `action` 分支：`scripts/lib/subagent-dispatch/extension.ts:144-170,698-716`。应写成 `subagent({action:"workspace_status", ...})` 与 `subagent({action:"workspace_disposition", ...})`。
3. **external-llm-review 的默认路径变量缺失。** Skill 多处依赖 `${PI_CONFIG_HOME}`（`:40-57,68-85`），当前 shell 只导出 `PI_CODING_AGENT_DIR`（`scripts/pi-shell.zsh:4-6`），实际环境 `PI_CONFIG_HOME` 未设置；文档主命令不可直接复制执行。
4. **settings 本地 package 路径不存在。** `pi/settings.json:17` 解析后的 adapter 目录缺失；虽未贡献 Skill，仍是配置依赖断裂。
5. **`skills.local.list` 是潜在断裂声明。** 当前无人消费；一旦消费，其三个 `skill-overrides/<name>` 源均不存在，加载器会 fail-closed。

#### 软风险

- Playwright 使用未锁版本的 `npx -y @playwright/mcp`，Skill 已正确声明以运行时 `tools` 为权威（`playwright/SKILL.md:46-48`）；网络或上游变更仍会导致漂移。
- writing-plans `:169` 与 using-goal-engine `:66` 假设存在“提问工具”；当前 Pi 工具面没有同名标准工具。可用普通用户提问替代，因此是软风险，不是名称依赖断裂。
- 主会话通过本地 Extension 提供 `subagent` 和八个 `goal_*` 工具；delegated child 会在 `pi/extensions/subagent-runtime.ts:49-50` 主动跳过 subagent runtime。本次子会话无这些工具属于设计范围差异，Skill 应继续遵守“缺工具即停止”的规则（using-goal-engine `:43-49`）。
- 外部服务凭据、浏览器运行时 MCP 工具、服务器连接状态未验证；这不等于断裂。

## 7. 每个 Skill 的 description 评级

评级标准采用仓内 `writing-skills/SKILL.md:95-105,142-182`：只描述触发条件，不摘要流程；包含具体场景、症状、关键词和常见同义表达；同时评估漏触发与误触发。

| Skill | 评级 | 仅触发条件 | 关键词/同义表达与风险 |
|---|---|---|---|
| `browser-auth-session` | **通过** | 是 | SSO、cookie、session、storage、CSRF、过期/刷新/验证/交接覆盖充分，误触发低。 |
| `exa-search` | **通过** | 是 | current/news/facts/docs/up-to-date/URL fetch 具体；可能广泛触发，但与能力边界一致。 |
| `external-llm-review` | **需改进** | 第二句带能力摘要 | diff/changeset/merge/push 很具体；“on push”可能把自动 gate 误解为需手工 review，`cross-model` 应改成请求场景。 |
| `git-commit-convention` | **通过** | 是 | commit/amend/PR title 与 security-gates 拒绝症状齐全。 |
| `test-driven-development` | **高风险** | 是 | 仅 feature/bugfix，漏 refactor、behavior/configuration、生产/Skill 逻辑以及“先写实现/后补测试/只做手测”等违例症状；也未反映正文豁免边界。 |
| `writing-skills` | **通过** | 是 | create/edit/verify/deployment 已覆盖 Skill 生命周期；名称本身和触发动作明确。 |
| `writing-plans` | **高风险** | **否**，含“产出”结果摘要 | “多步骤即触发”与正文“复杂/多步骤不构成授权”相反，会误触发；没有“用户明确要求/同意”关键词。 |
| `subagent-dispatch` | **通过** | 是 | executor/spark、coding/non-coding delegation、configured Pi agent 清楚；AGENTS 还提供硬路由。 |
| `using-goal-engine` | **通过** | 是 | start/resume/amend/recover/dispatch/dispose/worktree/multi-task 覆盖充分。 |
| `playwright` | **需改进** | 是 | navigate/click/form/screenshot/extract/automation 与两个精确报错良好；漏 browser UI/E2E、manual login、headed/headless、Playwright MCP 等常见说法。 |
| `cache-stats` | **通过** | 是 | cache hit/token/cost/session/model 明确。 |
| `external-llm-review-provider` | **通过** | 是 | add provider、validation errors、`_healthcheck.py [FAIL]` 三类具体症状齐全。 |
| `manage-providers` | **高风险** | 是 | add/remove/modify 清楚，但直接把敏感 `auth.json` 放入触发文本，缺 missing/invalid/model rejected 等症状，并诱导与 AGENTS 相冲突的直接配置操作。 |
| `aliyun-beijing-server` | **通过** | 是 | 中文明确短语、区域和“显式指定”边界充分。 |
| `aliyun-hangzhou-server` | **通过** | 是 | 中文明确短语、区域和“显式指定”边界充分。 |
| `aliyun-virginia-server` | **通过** | 是 | 美国/弗吉尼亚/lover 同义表达完整。 |
| `home-mac-connect` | **通过** | 是 | 家中 Mac、remote-mac、取文件、部署、连不通、隧道/中继覆盖充分。 |
| `zomboid-server-admin` | **通过** | 是 | 中英文游戏名、管理动作、连接故障、世界/mod/save/分发包场景充分。 |

### 7.1 可直接替换的 description

#### `external-llm-review`（需改进）

```yaml
description: Use when reviewing a code diff or changeset after implementation or before merge, especially when the user or project requests an independent, external, or cross-model reviewer.
```

#### `test-driven-development`（高风险）

```yaml
description: Use before changing production or Skill logic for a feature, bugfix, refactor, behavior change, or configuration change; also use when about to write implementation before a failing test, add tests only after code, or rely on manual testing. Pure documentation and explicitly justified one-line or verified existing-test-covered changes are exempt.
```

#### `writing-plans`（高风险）

```yaml
description: 仅当用户明确要求“写计划”“先规划”“实施计划”，或已明确同意编写计划时使用；任务复杂、多步骤、需要 DAG/Wave、用户沉默或未回复本身都不构成触发条件。
```

#### `playwright`（需改进）

```yaml
description: Use when interacting with or automating a web page or browser—opening or navigating pages, clicking, filling forms or login screens, UI/E2E checks, screenshots, content extraction, headed/headless sessions, or Playwright MCP workflows—or when playwright.py reports "Server not running" or "No running instances".
```

#### `manage-providers`（高风险）

```yaml
description: Use when Pi's non-secret custom provider or model definitions need to be added, removed, or updated, or when a provider/model is missing, invalid, or rejected; credential inspection, retrieval, or rotation is outside this skill's scope.
```

> 最后一项的 description 修复不能替代正文整改；正文仍需移除把真实 key 放入命令行的示例，并改成不让模型接触凭据值的安全入口。

## 8. TDD、writing-plans、Playwright 专项结论

### 8.1 TDD

**仅靠 description 与当前发现机制：不可靠。**

- 可发现性当前成立，但三个核心目录未跟踪，fresh clone 不成立。
- description 对 feature/bugfix 较强，却漏掉正文实际覆盖的 refactor、behavior、configuration 与 Skill 逻辑（TDD Skill `:3,18-32`）。
- TDD 是“首次实现前”的顺序门禁；Pi 官方承认匹配时模型也不总读取 Skill（Pi docs `skills.md:66-71`）。错过首次触发后无法无成本补救。
- 应同时：修 description、消除正文/AGENTS 的 bug 文档冲突、恢复 AGENTS 最小加载门禁。

### 8.2 writing-plans

**仅靠 description 与当前发现机制：不可靠，而且当前会误触发。**

- 正文授权规则本身清楚：只有用户明确要求或同意才写计划，复杂/多步骤/沉默均不算授权，未授权直接按 TDD、subagent 与项目规则执行（`:12-18`）。
- description 却把“多步骤”设成触发条件并宣称“产出计划”（`:3`）。模型若只看到 metadata，可能不读取授权门禁。
- 当前 `AGENTS.md`、根 `AGENTS.md` 和本次可见 developer 级项目规则没有要求复杂任务自动写计划，因此**没有外部规则要求覆盖用户授权**；主要冲突是 Skill 自身 description。
- “未授权直接执行”与 `pi/AGENTS.md:7-10` 不冲突：直接推进仍须通过适用的 `subagent-dispatch`，不是让主 agent 自行 coding。
- 另有跨 Skill 冲突：writing-skills 的强制 commit/push 清单会违反 writing-plans 的提交授权门禁，应由 writing-skills 删除自动提交假设。
- 不应在 AGENTS 添加“多步骤就加载 writing-plans”；只需把 description 改成明确授权触发。

### 8.3 Playwright

**当前对普通网页操作较可靠，对登录/模式策略仍有漏触发；修 description 后可继续依赖 Skill，不必复制流程回 AGENTS。**

- 当前 description 已含导航、点击、表单、截图、抽取、自动化及两个 wrapper 报错（`:3`），普通场景启发式强。
- 完整 headless/headed/登录态交接策略集中在 Skill `:38-48`，且 `browser-auth-session` 对 SSO/cookie/session/storage/CSRF 的 description 很强、正文显式要求 Playwright（browser auth `:3,14`）。
- 缺少 manual login、headed/headless、UI/E2E、MCP 等常见入口；先采用本报告替换文案。
- 敏感信息已有 AGENTS 全局硬门禁（`:12-17`）；在没有实际漏加载证据前，把整套模式流程重新复制进 AGENTS 会造成高维护成本。

## 9. `pi/AGENTS.md` 是否需要增强

### 9.1 明确判断

**需要最小增强，但仅增加 TDD 加载门禁。** 不建议恢复旧 TDD 流程全文，不建议恢复 Playwright 策略全文，也不建议增加 writing-plans 自动路由。

### 9.2 精确候选文本与插入位置

**插入位置：** `pi/AGENTS.md:30` 之后，即 Bugfix 段结束与 `## Git Commit 规范` 之间。

```markdown
## 逻辑变更

任何生产代码、配置或 Skill 的逻辑/行为变更，在首次修改实现前必须加载 `test-driven-development` Skill。具体流程与豁免条件只在该 Skill 维护；未加载不得开始实现。
```

### 9.3 为什么不能只靠 description

1. 当前 description 的范围小于正文，漏配置、重构、行为和 Skill 逻辑。
2. Pi 的 progressive disclosure 只保证 description 常驻，不保证模型读取 Skill（Pi docs `skills.md:64-71`）。
3. TDD 的时点不可逆：写实现后再加载会触发删除重做，风险与返工成本显著高于普通参考 Skill。
4. 仓内已有同型先例：subagent 与 commit 只在 AGENTS 保存一条路由，细节留在 Skill（`pi/AGENTS.md:7,33-34`）。

### 9.4 双处维护代价

- **低到中。** AGENTS 只维护“哪些变更必须加载”的触发边界；TDD Skill 单独维护 RED–GREEN–REFACTOR、豁免、测试质量和完成证据。
- 若 TDD 适用范围变化，需要同步一行触发文本；不需要同步流程步骤。
- Playwright 与 writing-plans 暂不加 AGENTS 路由，避免为每个 Skill 建第二份 description。

## 10. 行动清单

### Must fix

1. **跟踪或撤回三个核心源。** 将 `test-driven-development`、`writing-skills`、`writing-plans` 完整纳入 Git；否则从 `skills.list` 移除。当前“清单已跟踪、源未跟踪”不可发布。
2. **修 writing-plans description。** 采用 §7.1 文案，使用户明确授权成为唯一触发；保留正文授权门禁。
3. **统一 TDD 规则。** 明确豁免对 Iron Law 的优先级；bug 文档只服从 `pi/AGENTS.md:23-29` 的范围与命名，不得把所有 feature/refactor 写成 bug。
4. **恢复 AGENTS 最小 TDD 路由。** 采用 §9.2 两句文本，不复制流程。
5. **修 subagent 工具 ABI。** 把 Skill 中独立 `workspace_status`/`workspace_disposition` 调用改为 `subagent` 的 `action` 形态。
6. **修 manage-providers 的秘密处理。** 删除直接处理 `auth.json` 与命令行 key 的指导，提供不会把值暴露给模型、日志或 argv 的间接入口；description 同步替换。
7. **修 external review 路径前提。** 导出并文档化 `PI_CONFIG_HOME`，或统一改用当前已有的 `PI_CODING_AGENT_DIR` 可推导路径。

### Should fix

1. **统一发现事实来源。** 将 `skills.list` 明确定义为“共享软链同步清单”，把 Extension/README 中“白名单”命名改为实际语义；或者让 Extension 真正消费清单，二选一。
2. **删除或接通 `skills.local.list`。** 当前是无消费者的第二事实来源；个人 Skill 已由 `~/.agents/skills` 自动发现。
3. **修 Playwright 与 external-review description。** 采用 §7.1 文案；Playwright 不需把流程复制回 AGENTS。
4. **消除 writing-skills 参考冲突。** 明确“仓内触发-only description”覆盖其官方参考的“what + when”；删除未经用户授权的强制 commit/push。
5. **把功能性硬依赖显式标成 REQUIRED。** 至少包括 Playwright → browser-auth、writing-skills/using-goal-engine → subagent-dispatch。
6. **修复或移除 settings 中缺失 adapter。** `pi/settings.json:17` 不应长期指向不存在目录。
7. **把“提问工具”改成能力描述。** 写成“向用户提问并结束当前轮次”，不要假设不存在的具体工具名。

### No change

1. 保留 AGENTS 对 `subagent-dispatch` 与 `git-commit-convention` 的最小路由；当前职责分界正确。
2. 保留 Playwright 策略集中在 Skill、browser auth 通过 REQUIRED SUB-SKILL 复用 Playwright 的结构。
3. 保留 13 个评级为“通过”的 description。
4. 不因本次审查修改 Goal Engine Skill、工具或历史状态；其名称依赖当前可发现，且不在本次运行验收范围。

## 11. 验证与残余风险

- `resources_discover` + Pi `loadSkills(includeDefaults:false)`：18 个 Skill，0 diagnostics。
- 定向只读测试：`global-rules`、`core-skills-local`、`writing-plans-authorization`、`playwright-skill-policy`、`skill-whitelist-extension`，共 11 项通过。
- 未运行 Goal Engine 测试，也未调用任何 `goal_*` 工具。
- 当前工作树在审查前已存在大量未提交修改；本报告评价的是当前快照。尤其三个未跟踪核心 Skill 可能是尚未纳入 Git 的进行中工作。
- 未验证网络、API 配额、登录态、服务器连通性或任何凭据值；这些保持为运行时残余风险。
