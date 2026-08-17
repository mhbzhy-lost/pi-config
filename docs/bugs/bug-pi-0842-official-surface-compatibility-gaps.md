# Bug：Pi 0.84.2 官方能力与本仓旧兼容层发生重叠

## 一句话描述
本仓 Zsh 备用屏幕、non-capturing child overlay 和手工复制的 tool definition 绕过或覆盖了 Pi 0.84.2 已提供的官方行为。

## 复现流程
1. 在外层发送 DECSET 1049 后再以 `--tui-mode fullscreen` 启动 Pi，观察双重备用屏幕所有权造成的恢复错屏。
2. fullscreen child browser 激活时按 Ctrl+Shift+F 并输入字符，搜索框打开但 query 为空。
3. 设置 `PI_EXPERIMENTAL=1`，比较原生 read 与 compact override 的 `constrainedSampling`，后者缺失该字段。
4. 切换主题并重绘已缓存 child transcript，观察旧 ANSI 颜色未失效。

## 已发现根因
Pi 的 shortcut handler 每次调用都会构造新的 `ExtensionContext`；它不能与 `session_start` 的 `ctx` 做对象恒等比较。两者共享当前 `SessionManager`，因此 shortcut 必须以 `sessionManager` identity 作为会话边界。

## 官方优先修复方案
删除外层 1049；使用官方 fullscreen 设置、focused overlay、组件 `handleInput()` 和 overlay handle；compact tool 展开官方定义后只覆盖显示与动态 cwd；宿主 invalidate 必须清除 child ANSI cache。

## Task 5 验收记录（未完成：外部审查 provider 不可用）

- 候选 CLI：`var/test-runtimes/pi-0.84.2/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`，`--version` 输出精确 `0.84.2`。
- 候选真实 PTY：以 `/usr/bin/expect` 启动新鲜 `zsh -f`、加载 `scripts/pi-shell.zsh`，并以本仓 deterministic provider fixture、`--offline`、`fake/deterministic` 运行 bare `pi`。`TERM=xterm-256color` 的原始 ANSI（仅写入本次创建的系统临时文件，随后已删除）显示官方 fullscreen `DECSET 1049` 与退出 `DECRST 1049` 各一次；Pi 0.84.2 TUI 已进入，Ctrl-D 后退出并返回 shell。shell 源码/自动测试均确认 wrapper 不发送 `1049`，故未出现嵌套备用屏幕。
- 自动证据：T4 已有新鲜候选结果为 integration 2/2、subagents 3/3、project workflow 1/1、0.45 workflow 1/1；全量 1349 tests 为 1319 pass、30 个已归因且非 0.84.2 的基线失败；direct candidate Doctor 11.098s、exit 0、Root broker ready。child search/focus/PageUp/wheel/theme 继续以已通过的真实 `TuiAltScreen` raw-input 与 native renderer 测试为证据，未在 iTerm2 作人工确认。
- 外部审查 Round 1：已依照 allowlist 在系统临时目录生成隔离 sanitized snapshot（排除 settings、auth、models、npm、state、var、Skill/vendor/AGENTS 和并行改动）并调用 `idealab-anthropic` exhaustive review。调用在发送审查前因未解析的 `ANTHROPIC_API_KEY` 退出；未读取或输出任何 key。临时 snapshot 已删除。因此没有外部审查结论，也没有可作 threat-model 的 Critical/Important。
- 根据安全门禁，未执行全局 npm 安装、未启动全局新 session、未运行全局回归，也无需回滚；全局安装仍待 provider 可用后的 sanitized Round 1。残余人工项：仍需在 iTerm2 验证真实 fullscreen 的视觉恢复、child browser/search、分页/滚轮与主题切换。

## Task 5 DeepSeek sanitized Round 1 最终外审记录（通过）

- 保留上述历史 `idealab-anthropic` provider 在发送前因未解析 `ANTHROPIC_API_KEY` 失败的记录；该记录没有被覆盖。
- 本次使用已完成 Pi auth bridge 的 DeepSeek provider。前两次 sanitized snapshot 构造不完整，未作为有效审查结论；最终有效 Round 1 严格覆盖 allowlist 中 35 个 changed/new 文件及临时 spec，共 75,251 chars，未读取或输出凭据。
- Round 1 最初报告 3 个 Critical、7 个 Important。经逐项 threat-model 与完整源码复核，均为误报、事实错误或非阻断问题；没有未解决的 Critical/Important，也没有阻断项。
- 因最终有效 Round 1 已完成且无阻断，不需要 Round 2；后续不再调用 external reviewer。

## Task 5 全局安装验收（通过，未回滚）

- 安装前新进程 `pi --version` 为精确 `0.84.1`，全局 `npm ls -g --depth=0 @earendil-works/pi-coding-agent` 同为 `0.84.1`。随后仅执行官方 registry 的 `npm install -g --ignore-scripts --registry=https://registry.npmjs.org @earendil-works/pi-coding-agent@0.84.2`，未执行 `pi install`。
- 安装后全新 `zsh -f` 进程中 `pi --version` 为精确 `0.84.2`；`npm ls -g --depth=0 @earendil-works/pi-coding-agent` 为 `/opt/homebrew/lib` 下精确 `@earendil-works/pi-coding-agent@0.84.2`。
- 以动态 `npm root -g` 得到的新全局 package root 运行十个 targeted 文件，106/106 通过。`PI_REAL_BIN=$(command -v pi) node scripts/doctor.mjs` 退出 0，只有现有 preserved/parallel worktree warnings，且 `Root subagent broker: ready`，没有 Pi version error。
- 清除全部继承 `PI_SUBAGENT*` marker 并设置真实全局 `PI_REAL_BIN` 后，RPC integration 2/2、Subagent/Supervisor 3/3、project workflow 1/1 全部通过。
- `/usr/bin/expect` 在全新 `zsh -f` source `scripts/pi-shell.zsh`，以全局 Pi 0.84.2、`--offline` 和 deterministic `fake/deterministic` provider 执行 bare fullscreen；官方 `1049h`、`1049l` 各精确一次，Ctrl-D 后返回 shell。原始 ANSI 仅写入系统临时文件，验证后已删除；shell wrapper 不发送 1049，故无外层嵌套。
- 没有候选阶段之外的新 0.84.2 回归，因此未回滚，保持全局 `0.84.2`。残余人工项不变：最终用户仍需在 iTerm2 确认真实视觉/鼠标体验、child browser/search、分页/滚轮与主题切换。
