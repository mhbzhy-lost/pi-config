# pi-config

Pi Coding Agent 的独立配置。仓库内 `pi/` 是配置根。

## 初始化

需要 Git、Node.js 22.19 或更高版本、npm、zsh 和 uv。

```bash
./init-pi.sh
source ~/.zshrc
```

初始化使用 npm 官方源，在仓库内安装 Pi 1.5.0、scheduler 依赖和 Basic Memory，合并本机设置，并运行 doctor 与类型检查。模型和认证保存在 Git 忽略的 `pi/models.json`、`pi/auth.json`；`pi/settings.json` 中的 `enabledModels` 为本机配置。

启动入口为 `pi`，`pi-inline` 使用 regular TUI，`pi-lite` 为不自动加载 extension 和 skill 的只读探索模式。

## 最小 Subagent

当前暴露五个 `pi-subagents` RPC facade：`subagent_spawn({ task, skills? })`、`subagent_status({ runId })`、`subagent_steer({ runId, message })`、`subagent_stop({ runId })` 和 `subagent_resume({ runId, message })`。generic child 使用当前模型和工作目录，仅提供 read、grep、find、ls；默认不加载 skill，`skills` 只选择本次显式指定的 skill 名称。

接线层当前不暴露角色选择、工作区隔离、schedule 或 supervisor。`runId` 是上游返回的 async run 标识；控制工具只接受本接线层的 `runId` 和必要消息，不透传上游的其它定位字段。上游异步 runner 的生命周期与普通短命子进程不同，运行数据和 child session 会持久化。

## TUI

footer 只读展示当前 cwd、model、thinking、context 和后台活动。`subagent`、`bash_async`、scheduler 的状态通过各自 observer 或 `pi-subagents` status/event 投影汇聚，不参与执行和控制。按 `Ctrl+O` 可打开只读 subagent 状态查看器，选择 run 后查看 bounded transcript/status；查看器不会调用 steer、stop 或 resume。

旧 enhanced runtime 已移除，其历史实现可从 Git 历史查看。既有 `var/`、`.pi-subagents/` 和 session 数据不自动删除或迁移。

## Basic Memory

`pi/extensions/basic-memory.ts` 提供本地记忆工具。诊断可使用：

```bash
basic-memory status --local --json
basic-memory doctor --local
```

## Skill

仓库共享 Skill 放在 `skill-overrides/`，由 `scripts/sync-skills.ts` 同步；个人 Skill 放在 `~/.agents/skills`。仓库项目 Skill 位于 `.agents/skills/`。
