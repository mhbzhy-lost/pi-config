# pi-config

Pi Coding Agent 的独立配置与周边运行时。仓库内 `pi/` 是 Pi 全局配置根，
仓库根用于维护脚本、测试、文档和共享 Skill。

## 环境要求

- Git
- Node.js 22.19 或更高版本（用于原生执行 TypeScript type-stripping）
- uv (Python package manager)
- Pi Coding Agent

## 安装 Pi

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.87.1
pi --version
```

本仓已验证 Pi `0.82.0`、`0.82.1`、`0.83.0`、`0.84.1`、`0.84.2`、`0.84.3`、`0.85.1` 和 `0.87.1`，初始化默认安装精确 `0.87.1`。升级 Pi 前必须重新运行单元测试、Doctor、真实 `pi-subagents` 兼容门禁和 Goal Engine 回归。

## 初始化

```bash
./init-pi.sh
```

`init-pi.sh` 是新机器的唯一初始化入口，重复执行安全。它会：

- 安装并固定 Pi `0.87.1`。
- 在 `pi/npm` 顶层精确安装 `pi-subagents@0.71.0` 与 `typebox@1.1.38`。
- 在 `~/.zshrc` 写入受控区块，加载 `scripts/pi-shell.zsh`。
- 运行单元测试、doctor 和真实 Pi RPC 集成测试。

初始化不读取其他 Agent 的配置或凭据。首次使用 `openai-idealab` 时，在 Pi 中执行
`/login openai-idealab`；凭据只保存到被 Git 忽略的 `pi/auth.json`。

真实集成测试使用 `--offline`，不执行启动网络请求；使用 `--no-session`，不保存
session；不向模型发送 prompt。测试通过 RPC `get_commands` 断言只加载白名单 Skill。Pi 启动时可能初始化被 Git 忽略的 `pi/auth.json`；集成测试不会删除或覆盖该
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
- `--no-skills`，关闭 Pi 默认 Skill 发现

`pi/extensions/skill-whitelist.ts` 随后通过 `resources_discover` 扫描全局与项目 Skill 目录；它不读取仓库 Skill 清单，也不复制或创建软链接。

## T9 Repository Merge Queue 验收

验收 probe 仅用于聚焦合同验证与诊断：

```bash
node --test test/repository-merge-queue-acceptance-probe.test.mjs
node scripts/probes/repository-merge-queue-acceptance.ts
```

真实 probe 必须设置 `PI_REAL_BIN` 指向 Pi 0.87.1，并使用真实 `executor` child model；不得用 fake 或 deterministic model 替代。probe 使用独立临时 repo、session、state、socket roots，失败时保留现场并报告路径；本任务不运行五 child 真实验收或全量 `npm test`。

合同测试还校验 trusted `run/cwd/HEAD/PID` barrier ready、Git 冲突证据（非零 rebase、unmerged、sequencer、digest）、public receipt 生命周期计数，以及统一的 `ACCEPTANCE_OVERALL_TIMEOUT_MS` 门禁。失败现场不得 force cleanup；真实五-child 命令仅在 T11 完成后运行。

## Pi 0.87.1 TUI 与工具限制

Pi 官方是 fullscreen 的唯一 owner；Shell 不发送 `DECSET/DECRST 1049`。`pi` 默认使用官方 `--tui-mode fullscreen`；`pi-full` 是调用同一 `pi` 入口的薄兼容别名。显式 `pi --tui-mode regular`（或 `pi-full --tui-mode regular`）覆盖默认模式；`pi-inline` 保留为官方 regular 模式入口，`pi-lite` 的只读探索模式不变。新 shell 加载 `scripts/pi-shell.zsh` 后生效；现有 shell 可手动 source 此脚本，不影响已运行的 Pi Host。

Child browser 使用 focused overlay。`Ctrl+Shift+F` 保持官方语义，只搜索 parent primary transcript，不搜索 child transcript。compact renderer 是官方 tool definition 上的薄适配；它会注册同名 extension tools，因此不启用 `defaultTools`。需要严格工具集合时使用官方 `--tools`（或 `--exclude-tools`/`--no-tools`）。

PowerShell 当前不启用，属于非目标；未来启用前必须覆盖 Security Gates 与 Goal mutation gate。

如需回滚到精确 `0.84.2`：

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
`~/.zshrc` 中的 `pi-config` 受控区块由 `init-pi.sh` 维护，不要手工复制或改写；否则 Pi
会回到默认配置根并重新启用默认 Skill 发现。
