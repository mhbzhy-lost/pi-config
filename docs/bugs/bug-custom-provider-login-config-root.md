# Bug：全局 Pi 无法匹配仓库自定义 Provider

## 1. 现象

在全局 `pi` 中执行 `/login openai-idealab` 时，登录候选无法匹配
`openai-idealab`；同一 Provider 已能在加载仓库 Shell 集成后通过模型列表验证。

## 2. 影响

- 用户无法从错误的 Pi 配置根进入自定义 Provider 的交互式 API key 输入流程。
- 仅通过临时命令设置配置根会掩盖日常 Shell 没有加载仓库配置的问题。

## 3. 稳定复现

- 在仓库根执行 `pi --list-models openai-idealab`，输出 `No models available`。
- 加载 `scripts/pi-shell.zsh` 后执行 `pi --list-models openai-idealab`，能够发现
  `Qwen3.7-Max-DogFooding`。
- 使用 Pi `0.80.6` 的 `ModelRegistry` 加载仓库内 `pi/models.json` 后，
  `openai-idealab` 能通过 API-key 登录候选判断。

## 4. 证据

- `scripts/pi-shell.zsh` 显式设置 `PI_CODING_AGENT_DIR=<repo>/pi`，并为 `pi` 固定
  `--no-skills`。
- 全局 `pi` 没有该环境变量，因此读取默认配置根，不加载仓库内 `pi/models.json`。
- Pi 的登录候选来自当前 `ModelRegistry.getAll()` 中的 Provider；未加载模型时没有
  `openai-idealab` 候选。

## 5. 根因

Provider 配置属于仓库专用 Pi 配置根，但日常 Shell 没有设置该默认目录。模型发现和登录
候选都依赖当前进程加载的配置根；凭据是否已存在不会让另一个配置根自动注册 Provider。

## 6. 修复与验证策略

- 由 `~/.zshrc` 加载 `scripts/pi-shell.zsh`，使任意目录下的日常 `pi` 都使用仓库配置根。
- Shell 集成继续固定 `--no-skills`，避免恢复 Pi 默认 Skill 发现。
- 验证新 zsh 会话中的 `pi` 能发现模型，并检查 Pi 内部登录候选能精确匹配
  `openai-idealab`。
