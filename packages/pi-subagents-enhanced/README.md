# pi-subagents-enhanced

`pi-subagents-enhanced` 是 `pi-config` monorepo 内维护和发行的 Pi package。源码、发布配置与问题跟踪均归属同一个 `pi-config` 仓库，不另建 GitHub 仓库。

该 package 固定封装 `pi-subagents@0.62.0`，提供项目自有的 typed `subagent` runtime、Root broker、统一 managed workspace service、child extensions，以及 footer、browser 和 transcript renderer。所有 upstream 内部 API 必须经 `src/compat/pi-subagents-0.62.ts` 导入。

普通 subagent、Goal task 和 Goal validation 都通过同一 workspace service 分配、绑定、检查与处置 worktree。package 对外只发布三项代码 API：`./dispatch-ir`、`./workspace` 和 `./workspace/admin`；Git mutation、owner token 与 durable ledger 的实现均只归 `src/workspace/` 所有。

## Standalone subagent workspace management

运行时公开的 `subagent_worktree` 只管理当前 root session 创建、owner 为 `standalone-subagent` 的 workspace；它不会列出或处置 Goal、validation、foreign-session 或 legacy workspace。subagent 完成时，原始主-agent上下文会收到 `subagent-workspace-reminder`；TUI 只渲染其摘要，不能改写该提醒或把 completion 文案当作 terminal proof。

保存 dispatch 返回的 `workspace_id`，并按以下 typed 流程处置：`list` 仅查看当前 session，`status` 返回 action token、`allowed_dispositions` 和 integrate blockers；随后以该 token `dispose` 为 `integrate`、`discard` 或 `preserve`。`preserve` 保留现场，完成保留用途后以 `release` 回收。completion reminder 和 status 都不替代 Root Broker 的 official terminal proof；禁止 raw `git worktree` lifecycle。

## Profile 与授权

`agent` 只表示 discovery 中的 profile identity，可按项目需要重命名；`executor.md` 只是普通默认 profile，不是必需的权限入口。完整 `dispatch-ir.v1` 结构决定 coding，generic object shape 决定 generic，同一 profile 可用于两种调用。coding 工作必须使用 typed 合同，不能以 generic 自由文本绕过。

可信 Host 的 `RunAuthorization` 是唯一授权来源：standalone coding 只有 `root.subscribe`，generic 不获得 privileged capability。名称、frontmatter 额外字段、模型和 started event 都不能授予 coding、acceptance、Goal 或 Broker capability。需要 Goal/acceptance 权限时只能由对应可信 Host 协调流程授权，不能在 profile 中声明提权。

普通 `reviewer` profile 仅用于计划执行前审阅合理性、计划执行后检查完成情况与实现偏差。每次派发前须取得用户针对该次审阅的明确批准，不可复用前次批准；选择 Subagent-Driven 也不等于批准。使用 generic shape，不分配 worktree；审阅建议不是自动验收授权。

## 来源选择

仓库内开发使用相对 `pi/settings.json` 的 local path source：

```json
{ "source": "../packages/pi-subagents-enhanced" }
```

发布后的安装使用 npm source：

```text
npm:pi-subagents-enhanced@0.1.0
```

两种来源互斥，同一 Pi 配置中只能启用一种。不得同时安装或启用 standalone `npm:pi-subagents@0.62.0`，否则会形成重复 runtime、tool、message renderer 或模块身份。

## 准备与升级

在仓库根目录首次准备或升级 package 依赖：

```bash
npm run setup:subagents-enhanced
npm run verify:subagents-enhanced
```

依赖准备必须在没有旧 Pi Host 使用待替换 runtime 时执行。升级后启动 fresh Host；普通 TypeScript/MJS 源码修改不需要重新安装 package，在当前 Host 中执行 `/reload` 即可生效。

npm 发行清单只使用 canonical `bundleDependencies: ["pi-subagents"]`，发行包已经包含经过验证和补丁处理的 upstream 依赖闭包。发行前在 package 目录使用 `npm pack --dry-run --json --ignore-scripts` 检查内容；不要用非 dry-run pack 代替验证。
