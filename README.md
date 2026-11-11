# pi-config

Pi Coding Agent 的独立配置。仓库内 `pi/` 是配置根。

## 初始化

需要 Git、Node.js 22.19 或更高版本、npm、zsh 和 uv。

```bash
./init-pi.sh
source ~/.zshrc
```

初始化使用 npm 官方源，在仓库内安装 Pi 1.5.0、scheduler 依赖和 Basic Memory，合并本机设置，并运行 doctor 与类型检查。模型和认证保存在 Git 忽略的 `pi/models.json`、`pi/auth.json`；`pi/settings.json` 中的 `enabledModels` 为本机配置。

根 `package.json` 管理本仓直接依赖；Pi 按 `pi/settings.json` 的 npm package 声明管理 `pi/npm/`，不再维护第二份受版本控制的 manifest/lock 或手工补装 peer。初始化显式安装这些声明（Pi 的 update 会跳过固定版本）。scheduler 的上游资源全部禁用，仅由本仓适配器通过公开 extension 入口受控加载。

启动入口为 `pi`，`pi-inline` 使用 regular TUI，`pi-lite` 为不自动加载 extension 和 skill 的只读探索模式。

## 最小 Subagent

当前暴露五个 `pi-subagents` RPC facade：`subagent_spawn({ task, skills? })`、`subagent_status({ runId })`、`subagent_steer({ runId, message })`、`subagent_stop({ runId })` 和 `subagent_resume({ runId, message })`。child 固定使用 `pi/agents/executor.md` profile；工具面、system prompt、skills、extensions 和 nested policy 均由该 Markdown 声明。启动时只将本仓 `pi/agents/` 中同时声明 `advertise: true` 且在 RPC allowlist 内的 profile 元数据注入主会话；`skills` 只选择本次显式指定的 skill 名称。

接线层当前不暴露角色选择、工作区隔离、schedule 或 supervisor。`runId` 是上游返回的 async run 标识；控制工具只接受本接线层的 `runId` 和必要消息，不透传上游的其它定位字段。上游异步 runner 的生命周期与普通短命子进程不同，运行数据和 child session 会持久化。

## TUI

主会话 footer 第一行展示 cwd、model 和 thinking，第二行展示运行中的 subagent 与折叠的历史数量。按 `Alt+O` 打开只读子会话：正文直接复用 Pi 主会话的消息、Markdown 和工具调用/结果组件；已加载子会话时，footer 展示子会话元数据，不重复显示主会话活动列表。使用 `↑/↓`（或 `k/j`）切换代理，`PgUp/PgDn` 翻页，`End` 回到尾部跟随；`Esc`、`Alt+O` 或 `Ctrl+C` 关闭。查看器每 750ms 通过公开 status RPC 定位选中 run 的 Session 文件，再只读解析结构化会话；不把 transcript 日志解析成消息。刷新受上游落盘时机限制，不是逐 token 流，单个会话读取上限为 64 MiB。查看器不调用 steer、stop 或 resume，也不聚合 bash/scheduler 活动。

子会话查看器支持触控板/鼠标滚轮滚动正文；向上滚动进入历史浏览，向下滚动至底部或按 `End` 恢复尾部跟随。

`pi -c` 恢复旧会话时，从该主会话已保存的 `subagent_spawn` 结构化工具回执重建历史列表，并与实时 run 按 ID 去重。历史详情按需读取，不重新执行任务；产物或子会话文件已清理时，保留列表项并明确提示不可读取。没有持久化 spawn 回执的任务不会凭目录或文本猜测归属。

旧 enhanced runtime 已移除，其历史实现可从 Git 历史查看。既有 `var/`、`.pi-subagents/` 和 session 数据不自动删除或迁移。

## Basic Memory

`pi/extensions/basic-memory.ts` 提供本地记忆工具。诊断可使用：

```bash
basic-memory status --local --json
basic-memory doctor --local
```

## Skill

仓库共享 Skill 放在 `skill-overrides/`，由 `scripts/sync-skills.ts` 同步；个人 Skill 放在 `~/.agents/skills`。仓库项目 Skill 位于 `.agents/skills/`。
