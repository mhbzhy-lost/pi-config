# Pi 与 OpenCode 能力差距全面评估

> 评估日期：2026-07-21  
> 评估对象：`~/pi-config` 当前 `main`、`~/claude-config` 当前 OpenCode 配置、OpenCode 官方源码与文档  
> 版本口径：本机 Pi `0.80.10`；OpenCode 可执行文件 `1.18.4`，本地源码 `1.17.20`，本机 plugin SDK `1.14.48`

## 1. 执行摘要

当前 Pi 已经完成了从“最小终端 Agent”到“强约束个人开发运行时”的关键迁移，核心开发闭环约有 **75% 至 85%** 达到或超过现有 OpenCode 配置。尤其是 TDD/调试流程、外部评审、Subagent 隔离和 Plan Capsule，Pi 不是追赶者，而是更严格、更可审计的一方。

如果以 OpenCode 的完整产品平台为参照，当前 Pi 的覆盖约为 **50% 至 60%**。主要差距不在模型调用或编码能力，而在统一权限系统、MCP/LSP、会话服务化、多客户端、IDE/Web、组织级配置和生态兼容。

当前最紧迫问题不是继续增加功能，而是恢复可信基线。~~真实验证结果为 `221/227` 个 Node 测试通过、6 个失败，`doctor` 失败，初始化入口也会失败。主分支目前不能被视为可发布状态。~~（修复前证据；见 §12.1 修复后验证。）

综合建议：下一阶段采用“**先稳固强约束终端工作流，再补高价值平台能力**”路线，不以逐项复制 OpenCode 为目标。优先完成基线修复、统一权限/脱敏、Memory/Knowledge、会话与 Subagent 可观测性；MCP/LSP 采用按需求接入；Web/Desktop/通用 Server 暂缓。

## 2. 评估方法与边界

本报告使用四类证据：

1. 当前 Pi 配置、Extension、Agent、Skill、测试、doctor 与计划运行时源码。
2. `claude-config` 中已用于 OpenCode 的 Agent、Plugin、Skill、Memory、Knowledge 与运维文档。
3. OpenCode 官方文档、官方 GitHub Releases，以及本地官方源码。
4. 实际命令验证：`pi --version`、`npm test`、`npm run doctor`。

评分表示“当前可直接使用的产品化程度”，不是宿主 API 的理论上限。Pi Extension/SDK 能实现很多未内置能力，但未实现、未接线或未验证的能力不计为当前能力。

## 3. 总体评分

| 能力域 | 权重 | 当前 Pi | OpenCode | 判断 |
|---|---:|---:|---:|---|
| 开发流程与质量门禁 | 20% | 4.5/5 | 3.5/5 | Pi 领先 |
| Agent/Subagent 编排 | 15% | 4.0/5 | 3.8/5 | Pi 略领先；OpenCode 后台能力仍有实验项 |
| 权限与安全治理 | 15% | 3.5/5 | 4.0/5 | Pi 新增最高危硬禁止；统一 permission engine 仍为下阶段 |
| Extension/Plugin 扩展性 | 10% | 4.5/5 | 4.5/5 | 基本相当，设计哲学不同 |
| Session 与上下文连续性 | 10% | 3.2/5 | 4.5/5 | OpenCode 的父子会话、数据库和多客户端更成熟 |
| MCP/LSP/工具生态 | 10% | 2.0/5 | 5.0/5 | OpenCode 显著领先 |
| Server/SDK/客户端 | 15% | 2.5/5 | 5.0/5 | Pi 有 SDK/RPC 基础，当前配置未产品化 |
| 工程基线与运维 | 5% | 4.0/5 | 4.0/5 | Pi 基线已恢复全绿（见 §12.1） |
| **加权总分** | **100%** | **3.45/5** | **4.22/5** | Pi 是强工作流，OpenCode 是完整平台 |

OpenCode 的高分不等于默认更安全。其多数权限默认允许，Plan 与 `.env` 的官方文档和 `1.17.20` 源码还存在差异；插件也可直接执行本机代码。Pi 当前的 fail-closed 专项策略在高风险开发操作上更严格。

## 4. Pi 已达到或超过 OpenCode 的能力

### 4.1 强约束工程流程

`pi/AGENTS.md` 把 TDD、系统化调试、Bug 根因文档、评审反馈验证、中文技术文档和提交规范变成强制流程。OpenCode 能通过 Agent prompt 和 Plugin 组合出类似行为，但没有当前 Pi 这一套统一且强制的流程契约。

### 4.2 Plan Capsule

Pi 已实现独立 Session、独立 worktree、DAG、attempt、append-only 事件、lease/watchdog、取消、恢复观察、四类 Gate 和绑定提交的验证证据。OpenCode 的 Plan 是交互模式，其 workspace/worktree 仍带实验性质，不能等价替代 Pi 的执行仓。

Pi 的已知限制也很明确：不支持暂停后原生恢复，不保证 detached child 在 compaction 后延续，不自动合回 origin，不自动 push。这些是受控边界，不是隐藏缺陷。

### 4.3 Subagent 生命周期与隔离

`pi-subagents@0.34.0` 已提供前后台运行、并行、chain、状态、取消、恢复入口和 artifacts。普通 `executor`/`spark` 不获得递归派生能力，只有专用 plan-runner 获得受控 Subagent 权限。OpenCode 的父子 Session 导航更自然，但后台 Subagent 仍有实验开关。

### 4.4 专项安全 Gate

Pi 已覆盖工作区外 `rm`、符号链接、受保护配置目录、commit message、`git -C`/`cd + git`、未完成计划、push 前外部 LLM Review 和源码编辑提醒。OpenCode 的通用权限矩阵更完整，但这些业务化 Gate 需要另行配置或开发 Plugin。

### 4.5 确定性 Skill 治理

Pi 采用 override/vendor 双层来源、显式白名单、路径逃逸校验和项目 Skill 注入，目标是确定性暴露而非全目录自动发现。设计方向优于“所有 Skill 自动进入能力面”，但当前路径迁移后 doctor/测试未同步，暂时没有形成可信闭环。

## 5. OpenCode 明显领先的能力

### 5.1 统一声明式权限

OpenCode 对 `read/edit/bash/task/skill/lsp/webfetch/websearch/external_directory/doom_loop` 提供 `allow/ask/deny` 和 pattern 规则，并支持全局、Agent、Session 叠加。Pi 当前主要依赖 Agent 工具白名单和各 Extension 自行解释命令，缺少统一决策层、统一询问体验和统一审计格式。

这是当前最有价值的架构差距。Pi 不需要复制 OpenCode schema，但需要一个覆盖所有工具、Agent 和外部目录的单一权限内核。

### 5.2 MCP 与 LSP

OpenCode 原生支持本地/远程 MCP、OAuth、动态状态、工具权限和按 Agent 启用；LSP 支持内置/自定义 server、diagnostics、definition、references、symbols 和调用层级。

Pi 当前没有通用 MCP/LSP 层。Exa 和 Playwright 已通过 Skill/脚本覆盖具体需求，但 `basic-memory`、`crash-analyzer` 等现有 MCP 能力尚未有等价迁移，语言服务反馈也主要依赖 lint/typecheck 命令。

### 5.3 Session 服务与多客户端

OpenCode 使用持久化 Session/Message/Part/Todo 数据模型，支持父子会话、fork、revert/unrevert、diff、分享、压缩、token/cost，并由同一 Server 支撑 TUI、Web、Desktop、IDE 与 SDK。

Pi 原生 JSONL 会话树、fork/clone/import/export/compaction 很强，但当前 `pi-config` 没有统一 HTTP 服务、会话索引、跨客户端 attach 或父子 Session 导航界面。Plan/Subagent 状态分散在 session、artifact、event 和投影文件中。

### 5.4 产品入口与生态

OpenCode 已提供 TUI、Web、Desktop Beta、VS Code/Cursor/Windsurf/VSCodium、ACP、OpenAPI Server、类型化 SDK、GitHub 自动化和大量 Provider。Pi 有 SDK、RPC 和强 Extension API，但当前配置仍是单一 TUI 入口，外部集成需要自行建设。

### 5.5 组织级配置

OpenCode 支持 remote config、global/project config、环境注入、managed config 和 macOS MDM 优先级。Pi 有 global/project 配置与项目 trust，但缺少组织策略下发、不可覆盖策略和集中配置审计。

## 6. 从 claude-config 尚未迁移的能力

| 能力 | 状态 | 价值判断 |
|---|---|---|
| Memory 与 Knowledge Gate | 未迁移 | 高；可降低 compaction/跨会话信息丢失 |
| `secret-redaction` | 未迁移 | 高；日志、评审、Subagent artifact 都需要统一脱敏 |
| `skill-resolve-preflight` | 未迁移 | 中高；可在执行前验证 Skill 依赖与路径 |
| 双层 permission 配置/同步 | 未迁移 | 高；应并入统一权限内核，不宜原样搬运 |
| WCAG、worker 类专用 Skill | 未迁移 | 中；按实际使用频率迁移 |
| 动态工作流运行时 | 未迁移 | 低到中；现有 Plan Capsule 和 pi-subagents 已覆盖主要场景 |
| cache proxy | 明确未迁移 | 低到中；只有真实成本/缓存数据证明收益时再恢复 |
| OpenCode TUI 主题 | 不可直接迁移 | 低；宿主 schema 不兼容 |
| 历史 knowledge/runbook | 大量未迁移 | 中；应蒸馏有效知识，不应整库复制 |
| remote-exec Plugin | 未形成稳定迁移 | 中；Pi Extension API 可实现，但需先确认使用场景 |

## 7. 当前 Pi 的阻断问题

### P0：发布基线不可信

- `npm test`：227 项中 221 通过、6 失败。
- `npm run doctor`：因读取不存在的 `agents/skills.list` 失败。
- README 声明只验证 Pi `0.80.6`，实际安装为 `0.80.10`。
- `init-pi.sh` 会执行当前失败的测试，因此“一键初始化”无法闭环。

5 项 Node 失败的直接根因是 `b7a922e` 将 `agents/skills.list` 移到 `skill-overrides/skills.list`、将 `pi/SYSTEM.md` 拆为模型专用文件后，doctor、README 和测试仍引用旧路径。Python reviewer 测试则仍断言 Anthropic payload 包含 `temperature`，实现已不再发送。

### P0：契约表述冲突

- Plan 文档声称 external review `unavailable` 时 fail-closed，代码与测试允许继续验证。
- README 宣称精确加载八个 Skill，实际全局和本地清单已扩展。
- 当前 OpenAI Idealab 模型名为 `Peach-07-17-DogFooding`，Qwen prompt 匹配 `/Qwen/i`，不会命中该模型。

### P1：安全面仍有缺口

- Shell 检查不是完整 shell parser，对管道、换行、`sh -c` 等复杂形态的覆盖有限。
- push 外部评审可显式跳过，provider 全不可用时 fail-open。
- 缺少统一 secret/PII 脱敏。
- 缺少覆盖所有工具的声明式权限和询问层。
- 本机 OpenCode audit 日志为 `0644` 且可能包含命令参数，说明迁移审计能力时必须同时设计权限和脱敏。

### P1：版本矩阵漂移

当前同时存在 OpenCode binary `1.18.4`、源码 `1.17.20`、plugin SDK `1.14.48`。Pi 也存在文档固定 `0.80.6`、实际 `0.80.10` 的差异。下一阶段应把宿主、插件、配置 schema 和真实集成测试纳入一个版本矩阵。


## 7.5 已批准范围

基于差距评估，以下范围已获批准：

**P0 全部执行：**
- 恢复发布基线（测试全绿、doctor 全绿、版本统一）
- 统一契约表述（Plan Gate 完成语义、Skill 数量、模型匹配）
- 安全面关键收口（最高危硬禁止）
- Basic Memory 本地专用工具接入

**最高危硬禁止仅含：**
- 凭据文件访问（`auth.json`、`.env`/`.env.*` 等认证文件）
- 不可逆 Git 操作（`git reset --hard`、`git clean -fd`、`git checkout -- file` 等）与工作区外删除
- 危险包装器绕过（`sh -c` 等 shell wrapper 中的同类危险命令）

**延后至后续阶段：**
- 通用 `allow/ask/deny` 权限引擎
- 统一可观测性面板
- 完整 Memory/Knowledge 系统（自动写入、MCP 桥、cloud 同步）
- Secret/PII 全链路脱敏
- MCP/LSP 通用层
- Web/Desktop/Server

**Basic Memory 接入约束：**
- 仅暴露五个工具：`memory_search`、`memory_read`、`memory_context`、`memory_recent`、`memory_write`
- 强制 `--local` 路由，不开放 delete/reset/cloud/MCP 通用桥
- 写入前拒绝包含秘密/凭据的内容

## 8. 建议路线图

### 阶段 A：恢复可信基线，预计 2 至 4 天

1. 修复 Skill 清单、系统提示、doctor、README、reviewer 测试的契约漂移。
2. 明确 Pi 唯一受支持版本，升级或回退后跑完整 unit/integration/subagent/plan 验证。
3. 统一 external review `unavailable` 的真实策略和文档。
4. 增加 Anthropic request rewriter 的直接测试。
5. 将 `npm test`、doctor 和关键集成测试接入 CI。

完成标准：新机器初始化成功，测试全绿，doctor 全绿，版本与 Skill 数量只有一个事实来源。

### 阶段 B：补齐治理内核，预计 1 至 2 周

1. 建立统一 permission engine：工具、路径、命令、Agent、外部目录统一输出 `allow/ask/deny`。
2. 将现有 shell-policy、commit、push review、project trust 接入统一决策和审计格式。
3. 增加 secret/PII redaction，对 tool input/output、review、日志、artifact 和 export 生效。
4. 增加 Skill preflight，验证依赖、路径、宿主能力和敏感权限。
5. 默认保护 `.env`、凭据目录、auth 文件和审计日志权限。

完成标准：安全策略不再散落于多个独立 Gate，所有高风险操作有一致决策、提示和审计。

### 阶段 C：补齐连续性与可观测性，预计 1 至 2 周

1. 迁移 Memory/Knowledge 的最小高价值子集，与 goal-contract/compaction 恢复协议连接。
2. 提供统一 `/runs` 或 TUI 面板，聚合主 Session、Subagent、Plan、成本、状态和 artifact。
3. 为 Plan/Subagent 增加明确的恢复能力矩阵，不伪装支持宿主不具备的 resume。
4. 增加结构化脱敏 export 和问题诊断包。

完成标准：经过 compaction、父会话重启或子任务失败后，用户能从一个入口判断状态、证据、阻断和下一步。

### 阶段 D：按需求补平台能力，预计 2 至 6 周

优先做薄适配而不是重建 OpenCode：

1. 对现有 `basic-memory`、`crash-analyzer` 做 Skill/Extension 适配；只有出现第三个高价值 MCP 时再建设通用 MCP bridge。
2. 先接入 LSP diagnostics，定义/引用等 Agent 工具保持可选，避免常驻服务和上下文成本。
3. 只有出现 IDE、远程控制或团队协作的明确需求时，才把 Pi RPC 包装为本地 HTTP/OpenAPI 服务。
4. Web/Desktop/公开分享保持非目标；它们投入大，并扩大认证、数据治理和维护面。

## 9. 不建议追赶的 OpenCode 能力

- 不追求 Provider 数量对齐。应以实际账号、模型质量和可靠性为准。
- 不复制默认宽松权限。Pi 应维持显式、可审计、最小权限方向。
- 不优先建设 Desktop/Web。当前目标是个人强约束开发运行时，不是通用 Agent 产品。
- 不恢复全部动态工作流。Plan Capsule 与 pi-subagents 已覆盖主要价值。
- 不自动分享 Session。OpenCode 分享链接会同步完整历史，敏感环境不适合作为默认能力。
- 不因 OpenCode 原生支持 MCP 就全量迁移。具体 Skill/CLI 往往更易审计、上下文更小。

## 10. 决策建议

- **[下一阶段主线]**：先建设“可信、可治理、可恢复”的终端工作流。
- **推荐**：按阶段 A、B、C 顺序推进，因为当前主要损失来自基线漂移、安全分散和状态割裂。
- **不选原因**：直接追 Web/MCP/LSP 会扩大维护面，却不能修复当前不可验收状态。
- **选错代价**：若团队近期转向多客户端产品，阶段 D 会延后 2 至 6 周，代价中。

- **[权限体系]**：建立 Pi 原生语义的统一 permission engine。
- **推荐**：复用现有 Gate 规则，统一为工具/路径/Agent 的 `allow/ask/deny` 决策，因为这是最大横向缺口。
- **不选原因**：继续新增独立 Gate 会造成规则重叠、旁路和审计不一致。
- **选错代价**：在复杂 shell 或新工具接入时暴露，返工代价高。

- **[Memory/Knowledge]**：迁移最小闭环，不复制全部历史资料。
- **推荐**：只迁移 compaction 恢复、项目知识索引和 Knowledge Gate，因为它们直接改善长任务连续性。
- **不选原因**：整库迁移会把过期 OpenCode 运维知识带入 Pi。
- **选错代价**：知识召回噪声在长会话中暴露，清理代价中。

- **[MCP/LSP/Server]**：采用需求触发的薄层接入。
- **推荐**：先做两个现有 MCP 能力和 LSP diagnostics，再用使用数据决定是否通用化。
- **不选原因**：一次性复制 OpenCode 平台会偏离 Pi 的最小核心，并引入认证、服务生命周期和供应链风险。
- **选错代价**：若高频工具快速增加，后续统一接口需二次整合，代价中。

## 11. 最终判断

当前 Pi 不适合被定位为“OpenCode 的完整替代品”，但已经可以定位为“**比 OpenCode 更严格的个人终端开发执行系统**”。

下一步不应继续横向堆功能。先把测试、doctor、初始化、版本与文档恢复到单一事实来源，再补权限/脱敏和 Memory/可观测性。完成前三阶段后，Pi 在目标工作流上的能力可以达到 OpenCode 的 90% 左右，并在计划执行、质量 Gate 和可审计性上保持明显优势；是否继续建设 Server/IDE/Web，应由真实协作需求决定，而不是由功能列表驱动。

## 12. 主要证据

- Pi 当前能力：`README.md`、`pi/AGENTS.md`、`pi/settings.json`、`pi/extensions/`、`scripts/lib/`、`test/`
- Plan Capsule：`docs/pi-plan-execution-capsule.md`、`scripts/lib/plan/`
- Claude/OpenCode 遗留能力：`~/claude-config/userconf/plugins/`、`userconf/skills/`、`.claude/memory/`、`docs/knowledge/`
- OpenCode 官方文档：<https://opencode.ai/docs/agents/>、<https://opencode.ai/docs/permissions/>、<https://opencode.ai/docs/plugins/>、<https://opencode.ai/docs/mcp-servers/>、<https://opencode.ai/docs/lsp/>、<https://opencode.ai/docs/server/>、<https://opencode.ai/docs/sdk/>
- OpenCode Releases：<https://github.com/anomalyco/opencode/releases>

## 12.1 修复后验证（P0 Hardening 完成）

修复前状态（评估日 2026-07-21）：
- `npm test`：221/227 通过，6 失败
- `npm run doctor`：失败（版本漂移、Skill 数量不匹配）
- `init-pi.sh`：会失败

修复后状态（计划 `af9d78dc` 执行后）：

```
$ npm test
ℹ tests 268
ℹ pass 268
ℹ fail 0

$ node --test test/shell-policy.test.mjs test/security-gates-extension.test.mjs test/basic-memory-extension.test.mjs
ℹ pass 48
ℹ fail 0

$ uv run --no-project --with httpx --with python-dotenv --with pyyaml python -m unittest discover -s skill-overrides/external-llm-review/tests
Ran 66 tests in 0.022s — OK

$ basic-memory --version
Basic Memory version: 0.22.1
```

变更摘要：
- 契约漂移全部修复（PI_VERSION、Skill 数量、模型匹配、Anthropic payload）
- Plan Gate `unavailable` → fail-closed
- 新增安全硬禁止：凭据文件、不可逆 Git、sh -c 包装器绕过
- 接入 Basic Memory 五个本地工具，secret ingress 拒绝
- init-pi.sh 固定 basic-memory==0.22.1，doctor 诊断版本
