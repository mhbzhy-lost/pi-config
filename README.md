# pi-config

Pi Coding Agent 的独立配置与周边运行时。仓库内 `pi/` 是 Pi 全局配置根，
仓库根用于维护脚本、测试、文档和共享 Skill。

## 环境要求

- Git
- Node.js 22.19 或更高版本（用于原生执行 TypeScript type-stripping）
- uv (Python package manager)
- Pi Coding Agent

## 安装 Pi

新机器唯一入口是 `./init-pi.sh`（见下节）：它在本仓 root 安装 Pi 四核心包 `1.4.0` 的物理 `node_modules`，运行时通过仓库内 dist CLI 启动；`packages/pi-subagents-enhanced` 的 peer 依赖消费同一 root 的物理包。本仓不推荐、也不需要全局 `npm install -g` 安装 Pi。机器上可能残留历史全局安装的旧版 `pi`（如 0.87.x），它与本仓运行时无关；版本判定以物理 `package.json` 为准，勿混用。升级 Pi 前必须重新运行单元测试、Doctor、真实 `pi-subagents` 兼容门禁和 Goal Engine 回归。

## 初始化

```bash
./init-pi.sh
```

`init-pi.sh` 是新机器的唯一初始化入口，重复执行安全。它会：

- 安装并固定 Pi `1.4.0`。
- 通过 `npm ci` 与 `npm run setup:subagents-enhanced` 准备运行时与本仓 package（含受控 `pi-subagents@0.80.0` 依赖闭包；`pi/npm` 的 `@amaster.ai/pi-task-scheduler`、`@amaster.ai/pi-shared`、`croner` 保持 `0.1.9`/`0.1.9`/`10.0.1`）。
- 在 `~/.zshrc` 写入受控区块，加载 `scripts/pi-shell.zsh`。
- 运行单元测试、doctor 和真实 Pi RPC 集成测试。

初始化不读取其他 Agent 的配置或凭据。首次使用 `openai-idealab` 时，在 Pi 中执行
`/login openai-idealab`；凭据只保存到被 Git 忽略的 `pi/auth.json`。

真实集成测试使用 `--offline`，不执行启动网络请求；使用 `--no-session`，不保存
session；不向模型发送 prompt。测试通过 RPC `get_commands` 断言期望加载的 Skill 集合。Pi 启动时可能初始化被 Git 忽略的 `pi/auth.json`；集成测试不会删除或覆盖该
文件，避免影响后续真实登录凭据。

初始化后重新打开终端，或执行：

```bash
source ~/.zshrc
```

此后可以在任意目录直接启动：

```bash
pi
```

Idealab OpenAI 直连 Provider 定义在 `pi/models.json`。首次使用时在 Pi 中执行
`/login openai-idealab`，交互式填写 API key；凭据会保存到被 Git 忽略的
`pi/auth.json`：

```bash
pi
# 在 Pi 中执行：/login openai-idealab
pi --model openai-idealab/Peach-07-17-DogFooding --thinking high
```

`scripts/pi-shell.zsh` 将 Pi 默认配置根指向仓库内 `pi/`，因此直接运行 `pi` 即可匹配
`openai-idealab`。

`--thinking high` 会通过 Pi 的 Qwen 兼容模式发送 `enable_thinking: true`；使用
`--thinking off` 则发送 `enable_thinking: false`。配置直接访问 Idealab，不经过本地
cache proxy。

模型、Thinking 和 provider fallback 的选择默认只作用于当前 session；只有显式保存时，
才会更新全局默认值。

Shell 集成固定：

- `PI_CODING_AGENT_DIR=<repo>/pi`
- 默认 `PI_CODING_AGENT_SESSION_DIR=<repo>/var/sessions`
- 普通 `pi` / `pi-inline` / `pi-full` 使用 Pi 原生 Skill 发现；`pi-lite` 与用户显式 `--no-skills` 才关闭 Skill 发现

Skill 发现的唯一 owner 是 Pi 原生 resource discovery（用户 `~/.agents/skills`、受信项目祖先 `.agents/skills` 与 `.pi/skills`）；本仓已退役旧 `skill-whitelist` 扫描入口，不再注册 `resources_discover`。退役技能经 `pi/settings.template.json` 的 `skills` selector 按其声明 scope 排除，不构成全局权限白名单。managed skill 的同步与校验工具（`src/skill-whitelist/skill.ts` 等）保留。shell 入口的 `--no-skills` 已去除（M09 计划范围追加项，owner 3f3117d4…，fake physical CLI 隔离验收 13/13 exit=0；`pi-lite` 显式保留、用户显式 flag 原样透传、env/owner 不变）。真实 runtime 的 Skill 发现仍未实测：修改需刷新 shell（`source scripts/pi-shell.zsh`）并在 fresh Host 中加载后生效，本仓不自行运行验证。

本仓版本控制内的项目 skill 放在 `.agents/skills/`。`.pi/` 仅用于本机状态、handoff 和临时产物，整个目录由 Git 忽略；初始化仍使用 `pi/` 配置根。

## T9 Repository Merge Queue 验收

验收 probe 仅用于聚焦合同验证与诊断：

```bash
node --test test/repository-merge-queue-acceptance-probe.test.mjs
node scripts/probes/repository-merge-queue-acceptance.ts
```

真实 probe 必须设置 `PI_REAL_BIN` 指向 Pi 1.3.0，并使用真实 `executor` child model；不得用 fake 或 deterministic model 替代。probe 使用独立临时 repo、session、state、socket roots，失败时保留现场并报告路径；本任务不运行五 child 真实验收或全量 `npm test`。

合同测试还校验 trusted `run/cwd/HEAD/PID` barrier ready、Git 冲突证据（非零 rebase、unmerged、sequencer、digest）、public receipt 生命周期计数，以及统一的 `ACCEPTANCE_OVERALL_TIMEOUT_MS` 门禁。失败现场不得 force cleanup；真实五-child 命令仅在 T11 完成后运行。

## Pi 1.3.0 TUI 与工具职责

Pi 官方是 fullscreen 的唯一 owner；Shell 不发送 `DECSET/DECRST 1049`。`pi` 默认使用官方 `--tui-mode fullscreen`；`pi-full` 是调用同一 `pi` 入口的薄兼容别名。显式 `pi --tui-mode regular`（或 `pi-full --tui-mode regular`）覆盖默认模式；`pi-inline` 保留为官方 regular 模式入口，`pi-lite` 的只读探索模式不变。新 shell 加载 `scripts/pi-shell.zsh` 后生效；现有 shell 可手动 source 此脚本，不影响已运行的 Pi Host。

Child browser 使用 focused overlay。`Ctrl+Shift+F` 保持官方语义，只搜索 parent primary transcript，不搜索 child transcript。compact 扩展只通过 `registerToolRenderer` 对 read/edit/write/grep/find/ls 六个原生工具与 bash 提供显示覆盖：不注册、不执行、不激活工具，原生 tool definition/metadata 身份保持；默认工具集由 `pi/settings.template.json` 的 `defaultTools` 增量与用户/项目配置按原生规则合并决定，renderer 不绕过该选择。所有面向用户的精简、折叠、摘要只发生在 TUI renderer 层，不改写 agent 实际收到的消息、tool result、session 内容或结构化 `details`；程序化数据通道（如 `structuredContent`）是显式 API，不是展示层改写。

PowerShell 当前不启用，属于非目标；未来启用前必须覆盖 Security Gates 与 Goal mutation gate。

## Subagent 独立操作工具

fresh Host 的 main 模型工具按操作拆分为 `subagent_start`、`subagent_roster`、`subagent_run_status/steer/interrupt/resume/stop`、`managed_workspace_list/status/dispose/release` 与 `supervisor_request_pending/status/reply`。旧 union 工具名只保留历史记录显示，不在fresh Host注册；操作工具继续复用既有dispatcher、workspace service、supervisor adapter和权限/receipt门禁。clear/inspect分支因上游absence不可证保持blocked。详见 `docs/architecture/subagent-operation-tools.md`。

## 统一后台活动区（TUI footer）

左下角是「一切后台活动任务」展示区，同时呈现 subagent（`●`）、bash_async（`⌘`）与 scheduler（`⏱`）三个 source：统一行结构、统一只读详情、图标只表类型而状态另列文字。架构与事实边界见 `docs/architecture/background-activity-display.md`。

- 唯一 owner：`packages/pi-subagents-enhanced/src/tui/footer-runtime.ts`（唯一 `ctx.ui.setFooter` 调用点）+ `packages/pi-subagents-enhanced/extensions/custom-footer.ts`（唯一 `Alt+O` 注册）。根 `pi/extensions/background-activity.ts` 只发布统一 presenter factory，不调 `setFooter`、不注册快捷键；package 无根 presenter 时回落自有 standalone footer（standalone fallback）。
- 公开入口（bare specifier）：`pi-subagents-enhanced/tui/background-activity` → `packages/pi-subagents-enhanced/src/tui/index.ts`（协议/registry + subagent source 工厂）；根显示 feature 公开入口 `src/background-activity/index.ts`（re-export 协议 + `layout.ts`/`detail-controller.ts`/`presenter.ts`）；两个 source 入口 `src/bash-async/index.ts`、`src/task-scheduler/index.ts`。消费者不深引 package `src/`。
- 快捷键：`Alt+O` 打开只读详情（统一详情壳或 standalone browser）；详情内 `←`/`→` 跨类型切条目、`↑`/`↓`/`j`/`k` 逐行滚动、`PgUp`/`PgDn`/`Home`/`End` 翻页、`x` 展开/收起工具、鼠标滚轮滚动；`Alt+O` 或 `Esc` 只关闭并恢复 draft/editor。
- 不提供的能力（明确边界）：详情无取消/删除/立即执行按钮，不改变命令授权；不新增 scheduler timer或轮询、不造实时 scheduler 状态；不建第二个任务/投递权威、不建 daemon；不把 `lastStatus=success` 当业务成功、不把 bash `accepted` 当消费 ACK、不把 subagent `reported`/unknown 当已完成；不新增全量恢复扫描器（fresh Host 首屏恢复缺口保留）；同 Host reload 仅恢复本分区 plain roster。身份只按稳定 row key，不按 label/状态字符串猜。`ctx.mode !== "tui"` 不构 terminal UI；RPC 的 status、消息投递与执行行为不变；raw 消息/tool result/session/结构化 `details` 不被改写。

## 角色流程与失败恢复

组合流程指令归 `pi/AGENTS_GLOBAL.md`（仅父会话适用），角色方法论归 `pi/agents/{delegate,executor,reviewer}.md` 正文（`systemPromptMode: append`，由用户明确确认），共同安全与工程约束归 `pi/AGENTS_SHARED.md`；SHARED 不收纳多工具流程。三个角色 profile 保留 Pi 原生 system preamble/tools/rules，角色正文作为附加部分，不整体替换原生 prompt；models/tools/inheritance 元数据不因此扩大。

child 出现上游过载、暂时性流中断等偶发 provider/transport 故障且原 child 持久化 session、身份与执行合同仍有效时，主管优先 `resume` 原 run（附非空新指导，继续既有 child 会话历史），不自动 fresh 重派、不自动更换模型、不建立常驻重试；不可恢复/stopped、权限或身份失败、来源不明不属于该规则范围。此规则是主管决策顺序，不是 runtime 自动重试。

## 配置模板与运行时边界

`pi/settings.template.json` 是模板而非 Host 配置：只有 `ensure-pi-settings` 的合并产物写入 `<agent-dir>/settings.json` 后才被 Host 读取。共享默认标量只有 `hideThinkingBlock`；本机模型、认证、theme、`enabledModels` 等 per-machine 字段不被覆盖、不入 Git。task-scheduler 同 source 条目的 `extensions/skills/prompts/themes` 四类资源收敛为本仓声明，其余 package source 的本机资源不改。

steer 消息的消费回执（delivered：含 run/request/index/deliveryStatus 等字段、归属父会话）的公开事件转发仍阻塞于上游——它不是 subagent completion 事件，完成通知由现有 channel 承载；本仓不伪造 delivered 可见性，详见 `docs/plans/records/2026-10-10-runtime-modernization/public-boundaries.md`。

历史记录（早期升级期的回滚手段，不属当前流程，不自动执行；历史升级审计不重写）：如需回滚到精确 `0.84.2`：

```bash
npm install -g --ignore-scripts --registry=https://registry.npmjs.org \
  @earendil-works/pi-coding-agent@0.84.2
pi --version
```

## Basic Memory 本地持久存储

Pi 通过 `pi/extensions/basic-memory.ts` 注册五个工具：

| 工具 | 用途 |
|------|------|
| `memory_search` | 搜索笔记 |
| `memory_read` | 读取指定笔记 |
| `memory_context` | 构建上下文 |
| `memory_recent` | 最近活动 |
| `memory_write` | 写入笔记 |

约束：

- 所有命令强制 `--local`，不连接云端
- 默认 project 由 Basic Memory 自动解析
- `memory_write` 在写入前检测疑似凭据/秘密并拒绝
- 不提供 `--overwrite`、delete、reset、reindex

诊断命令：

```bash
basic-memory status --local --json
basic-memory doctor --local
```

## Skill 选择

Git 管理的共享 Skill 唯一来源是 `skill-overrides/<name>/SKILL.md`；所有非隐藏直接子目录中的合法 Skill 会由 `scripts/sync-skills.ts` 自动同步。个人 Skill 直接放在 `~/.agents/skills`，不由仓库清单管理。
`~/.zshrc` 中的 `pi-config` 受控区块由 `init-pi.sh` 维护，不要手工复制或改写。
