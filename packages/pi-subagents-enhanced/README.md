# pi-subagents-enhanced

`pi-subagents-enhanced` 是 `pi-config` monorepo 内维护和发行的 Pi package。源码、发布配置与问题跟踪均归属同一个 `pi-config` 仓库，不另建 GitHub 仓库。

该 package 固定封装 `pi-subagents@0.62.0`，提供项目自有的 typed `subagent` runtime、Root broker、统一 managed workspace service、child extensions，以及 footer、browser 和 transcript renderer。所有 upstream 内部 API 必须经 `src/compat/pi-subagents-0.62.ts` 导入。

普通 subagent、Goal task 和 Goal validation 都通过同一 workspace service 分配、绑定、检查与处置 worktree。package 对外只发布三项代码 API：`./dispatch-ir`、`./workspace` 和 `./workspace/admin`；Git mutation、owner token 与 durable ledger 的实现均只归 `src/workspace/` 所有。

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
