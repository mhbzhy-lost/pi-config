# pi-config

Pi Coding Agent 的独立配置。仓库内 `pi/` 是配置根。

## 初始化

需要 Git、Node.js 22.19 或更高版本、npm、zsh 和 uv。

```bash
./init-pi.sh
source ~/.zshrc
```

初始化使用 npm 官方源，在仓库内安装 Pi 1.5.2 和 Basic Memory，合并本机设置，并运行 doctor 与类型检查。模型和认证保存在 Git 忽略的 `pi/models.json`、`pi/auth.json`；本机模型选择和启动偏好保存在 Git 忽略的 `pi/settings.local.json`。

`pi/settings.local.json` 可从 `pi/settings.local.example.json` 复制，支持 `enabledModels`、`defaultProvider`、`defaultModel`、`defaultThinkingLevel` 和 `theme`。默认 launcher 会把这些字段转换为本次启动参数；显式命令行参数优先。未设置 `theme` 时 Pi 使用 `system`，会根据终端的明暗外观自动选择主题。

根 `package.json` 和 `package-lock.json` 统一管理 Pi Host、本仓依赖与第三方扩展，由根 `npm ci --ignore-scripts` 安装到 `node_modules/`。Pi 只加载扩展，不再由初始化脚本调用 `pi install npm:…` 创建 `pi/npm/`。

第三方扩展先加入根依赖，再在 `pi/settings.json` 的 `packages` 中使用相对配置根的本地包路径，例如 `../node_modules/@arhen/pi-core-ask`；Pi 会读取包 manifest 的资源声明。共享默认启用项才写入模板，本机启用项只保留在本机 settings。不要通过 `pi install npm:…` 或手工补装 peer 恢复第二套依赖树。

启动入口只保留 `pi` 和 `pi-lite`；`pi` 使用完整配置，`pi-lite` 使用精简只读环境，并显式提供 deferred `search`/`browser` 工具与 `tool_search`。

扩展代码统一位于 `src/<feature>/`：`<feature>.ts` 只负责宿主接线，具体实现与它同目录；加载列表由 `pi/settings.template.json` 的 `extensions` 显式声明，已有安装运行 `node scripts/ensure-pi-settings.ts` 同步。本机额外扩展在 `pi/settings.json` 中显式声明；`pi/extensions/` 不再放本仓扩展代码。

## 最小 Subagent

当前暴露五个 `pi-subagents` RPC facade：`subagent_spawn({ task })`、`subagent_status({ runId })`、`subagent_steer({ runId, message })`、`subagent_stop({ runId })` 和 `subagent_resume({ runId, message })`。child 固定使用 `pi/agents/executor.md` profile；工具面、system prompt、extensions 和 nested policy 均由该 Markdown 声明。

接线层当前不暴露角色选择、工作区隔离、schedule 或 supervisor。`runId` 是上游返回的 async run 标识；控制工具只接受本接线层的 `runId` 和必要消息，不透传上游的其它定位字段。上游异步 runner 的生命周期与普通短命子进程不同，运行数据和 child session 会持久化。

## TUI

主会话 footer 只显示三部分：首行左对齐当前会话 cwd，右对齐 `provider/model thinking context/contextWindow`；第二行为空行；第三行起每个运行中的 subagent 或 bash_async 后台任务各占一行。按 `Alt+O` 打开只读子会话：正文直接复用 Pi 主会话的消息、Markdown 和工具调用/结果组件。使用 `↑/↓`（或 `k/j`）切换代理，`PgUp/PgDn` 翻页，`End` 回到尾部跟随；`Esc`、`Alt+O` 或 `Ctrl+C` 关闭。查看器每 750ms 通过公开 status RPC 定位选中 run 的 Session 文件，再只读解析结构化会话；不把 transcript 日志解析成消息。刷新受上游落盘时机限制，不是逐 token 流，单个会话读取上限为 64 MiB。

子会话查看器支持触控板/鼠标滚轮滚动正文；向上滚动进入历史浏览，向下滚动至底部或按 `End` 恢复尾部跟随。

`pi -c` 恢复旧会话时，从该主会话已保存的 `subagent_spawn` 结构化工具回执重建历史列表，并与实时 run 按 ID 去重。历史详情按需读取，不重新执行任务；产物或子会话文件已清理时，保留列表项并明确提示不可读取。没有持久化 spawn 回执的任务不会凭目录或文本猜测归属。

旧 enhanced runtime 已移除，其历史实现可从 Git 历史查看。既有 `var/`、`.pi-subagents/` 和 session 数据不自动删除或迁移。

## Basic Memory

`src/basic-memory/basic-memory.ts` 提供本地记忆工具。诊断可使用：

```bash
basic-memory status --local --json
basic-memory doctor --local
```

## Progressive tools

联网搜索、浏览器自动化、iOS IPA 重签和文档编写指导均已内化为 `src/<tool>/` 下的 deferred custom tools。每个工具独立维护实现、运行时和 Markdown 资料，不依赖外部文档发现、同步或软链。

工作文档保留在本机 `docs/`，该目录不纳入 Git，也不随仓库推送或分发。
