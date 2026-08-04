# pi-config

Pi Coding Agent 的独立配置与周边运行时。仓库内 `pi/` 是 Pi 全局配置根，
仓库根用于维护脚本、测试、文档和 vendor。

## 环境要求

- Git
- Node.js 22.19 或更高版本
- uv (Python package manager)
- Pi Coding Agent

## 安装 Pi

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.83.0
pi --version
```

本仓已验证 Pi `0.82.0`、`0.82.1` 和 `0.83.0`，初始化默认安装 `0.83.0`。升级 Pi 前必须重新运行单元测试、Doctor、真实 `pi-subagents` 兼容门禁和 Plan Harness smoke。

## 初始化

```bash
./init-pi.sh
```

`init-pi.sh` 是新机器的唯一初始化入口，重复执行安全。它会：

- 初始化 Git submodule。
- 安装并固定 Pi `0.83.0`。
- 在 `pi/npm` 顶层精确安装 `pi-subagents@0.37.2` 与 `typebox@1.1.38`。
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

Shell 集成固定：

- `PI_CODING_AGENT_DIR=<repo>/pi`
- 默认 `PI_CODING_AGENT_SESSION_DIR=<repo>/var/sessions`
- `--no-skills`，关闭 Pi 默认 Skill 发现

`pi/extensions/skill-whitelist.ts` 随后通过 `resources_discover` 只注入
`skill-overrides/skills.list` 中列出的 Skill。它不复制或创建软链接。

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

源解析顺序：

1. `skill-overrides/<name>/SKILL.md`
2. `vendor/superpowers/skills/<name>/SKILL.md`

`~/.zshrc` 中的 `pi-config` 受控区块由 `init-pi.sh` 维护，不要手工复制或改写；否则 Pi
会回到默认配置根并重新启用默认 Skill 发现。

## 计划执行仓

批准计划通过`/plan-run <计划路径>`启动thin Host和Standalone Plan Runner，并在独立accumulator/Attempt worktree中执行。无路径或资源冲突的Task可以并行；Executor只由官方`pi-subagents` RPC派发。

完成必须同时满足Plan终态为`validated`、`validatedHead == headCommit`以及accumulator产物审查通过。Host退出、Executor进程退出或格式化status文本都不能单独证明完成。验证不会自动合回或push；Attention、恢复、dispatch uncertain、单Writer集成和显式merge-back见[Pi计划执行仓说明](docs/pi-plan-execution-capsule.md)及[Harness运行手册](docs/knowledge/plan-runner-pi-subagents-harness.md)。

## 升级 Superpowers

1. 在 `vendor/superpowers` 检出目标 tag 或 commit。
2. 检查白名单中 Skill 的变化。
3. 运行 `npm test` 和 `npm run doctor`。
4. 人工确认后更新 submodule gitlink。
