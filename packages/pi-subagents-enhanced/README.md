# pi-subagents-enhanced

`pi-subagents-enhanced` 是 `pi-config` monorepo 内维护和发行的 Pi package。源码、发布配置与问题跟踪均归属同一个 `pi-config` 仓库，不另建 GitHub 仓库。

该 package 固定封装 `pi-subagents@0.80.0`，提供项目自有的 typed `subagent` runtime、Root broker、统一 managed workspace service、child extensions，以及 footer、browser 和 transcript renderer。所有 upstream 内部 API 必须经 `src/compat/pi-subagents-0.75.ts` 导入。

工具与消息的显示层统一由 `src/tui/tool-renderers.ts` 的纯 renderer 工厂提供，主入口与 child preview 共同消费；原生工具只从公开 `create*ToolDefinition` 消费渲染字段，未知工具返回 `undefined` 回退原生显示。所有精简、折叠、摘要只发生在 TUI renderer 层，不改写 agent 实际收到的消息、tool result、session 内容或结构化 `details`；结构化数据契约（如 `apply_patch` 与 `context_usage` 的 `structuredContent`/`outputSchema`）是显式程序数据通道，不是展示改写；model-only 的 subagent/supervisor 工具未因此新增 `outputSchema`。

普通 subagent、Goal task 和 Goal validation 都通过同一 workspace service 分配、绑定、检查与处置 worktree。package 的公开出口由 `package.json` 的 `exports` 精确声明，且由 `scripts/verify-package.ts` 的 `expectedExports` 逐字校验，共五项：

| 子路径 | 目标 | 内容 |
| --- | --- | --- |
| `./dispatch-ir` | `src/contracts/dispatch-ir.ts` | typed dispatch 合同 |
| `./host-runtime` | `src/host-runtime/index.ts` | physical Host 绑定与 peer 安装 |
| `./tui/background-activity` | `src/tui/index.ts` | 统一后台活动显示协议与 registry、subagent activity source 工厂 |
| `./workspace` | `src/workspace/service.ts` | managed workspace service |
| `./workspace/admin` | `src/workspace/administration.ts` | workspace 管理面 |

外部消费者只使用 bare specifier `pi-subagents-enhanced/tui/background-activity`（解析到 `src/tui/index.ts`），不深引 `src/tui/*.ts`。`pi.extensions` 仍只声明 `extensions/subagent-runtime.ts` 与 `extensions/custom-footer.ts` 两项 Host 入口。Git mutation、owner token 与 durable ledger 的实现均只归 `src/workspace/` 所有。

## Subagent 独立操作工具

fresh Host 的模型工具按对象与操作拆分：`subagent_start`/`subagent_roster`/`subagent_run_*`、`managed_workspace_*` 与 `supervisor_request_*`。旧union名称只用于历史记录显示，不在fresh Host注册；所有新工具仍复用原typed dispatcher、workspace service、supervisor adapter、owner/CAS与terminal proof。workspace处置以实时status/action_token为权威，coding child-owned integration不会因工具拆分改变。

## Standalone subagent workspace management

运行时公开的 `subagent_worktree` 只管理当前 root session 创建、owner 为 `standalone-subagent` 的 workspace；它不会列出或处置 Goal、validation、foreign-session 或 legacy workspace。subagent 完成时，原始主-agent上下文会收到 `subagent-workspace-reminder`；TUI 只渲染其摘要，不能改写该提醒或把 completion 文案当作 terminal proof。

保存 dispatch 返回的 `workspace_id`，并按以下 typed 流程处置：`list` 仅查看当前 session，`status` 返回 action token、`allowed_dispositions` 和 integrate blockers；随后以该 token `dispose` 为 `integrate`、`discard` 或 `preserve`。`preserve` 保留现场，完成保留用途后以 `release` 回收。completion reminder 和 status 都不替代 Root Broker 的 official terminal proof；禁止 raw `git worktree` lifecycle。

## Profile 与授权

`agent` 只表示 discovery 中的 profile identity，可按项目需要重命名；`executor.md` 只是普通默认 profile，不是必需的权限入口。完整 `dispatch-ir.v1` 结构决定 coding，generic object shape 决定 generic，同一 profile 可用于两种调用。coding 工作必须使用 typed 合同，不能以 generic 自由文本绕过。

可信 Host 的 `RunAuthorization` 是唯一授权来源：standalone coding 只有 `root.subscribe`，generic 不获得 privileged capability。名称、frontmatter 额外字段、模型和 started event 都不能授予 coding、acceptance、Goal 或 Broker capability。需要 Goal/acceptance 权限时只能由对应可信 Host 协调流程授权，不能在 profile 中声明提权。

普通 `reviewer` profile 仅用于计划执行前审阅合理性、计划执行后检查完成情况与实现偏差。每次派发前须取得用户针对该次审阅的明确批准，不可复用前次批准；选择 Subagent-Driven 也不等于批准。使用 generic shape，不分配 worktree；审阅建议不是自动验收授权。

## 统一后台活动 footer 与快捷键

`extensions/custom-footer.ts` 是薄 Host 入口：只注入 SDK/TUI 依赖并注册唯一 `Alt+O` 快捷键（描述 `Open subagent browser`）；实际 footer 职责全部在 `src/tui/footer-runtime.ts`——它是本仓唯一调用 `ctx.ui.setFooter` 的位置，也是统一后台活动的唯一 owner。根 `src/background-activity/*` 只显示层，经上述 bare 出口消费协议与 registry，不安装第二个 footer、不注册第二个 `Alt+O`、不成为任务权威。`ctx.mode !== "tui"` 时不安装 footer、不挂 overlay、不做 bus 握手，RPC 的 status/消息投递/执行行为不变。

- `Alt+O`：打开只读详情（统一 presenter 在场时为跨类型详情壳，否则回落 package 自有 standalone browser）；再次 `Alt+O` 或 `Esc` 只关闭并恢复 draft/editor，不执行、不取消任务。详情壳内 `←`/`→` 切条目，`↑`/`↓`/`j`/`k` 逐行滚动，`PgUp`/`PgDn`/`Home`/`End` 翻页，`x` 切换工具展开，鼠标滚轮滚动；`Esc` 不向恢复后的 editor 传播。完整键位与语义见 `../../docs/architecture/background-activity-display.md`。
- 类型图标 `●`=subagent、`⌘`=bash_async、`⏱`=scheduler，只表类型不表成败；状态是独立文字列。
- 本层不提供任务创建/取消/删除/立即执行入口，不新增 scheduler timer 或轮询，不承诺 fresh Host 的全量恢复，也不承诺人为共享 bus 的多 Host 隔离。

## 来源选择

仓库内开发使用相对 `pi/settings.json` 的 local path source：

```json
{ "source": "../packages/pi-subagents-enhanced" }
```

发布后的安装使用 npm source：

```text
npm:pi-subagents-enhanced@0.1.0
```

## Repository merge-queue acceptance probe

T9 的聚焦验收入口是 `node scripts/probes/repository-merge-queue-acceptance.ts`。它只接受 `PI_REAL_BIN` 指向的真实 Pi 1.3.0 physical Host；合同测试使用 `node --test test/repository-merge-queue-acceptance-probe.test.mjs`，不会运行五 child 验收或全量 `npm test`。

Probe 使用独立 temporary repo、session、state 和 socket roots。失败时保留现场并在 receipt 中记录路径；不要手动删除失败现场，需先检查两个 Host、queue、worktree 和 terminal proof。barrier fixture 位于 `test/fixtures/repository-merge-queue-acceptance/`，仅可通过 `subagentOnlyExtensions` 注入测试 Host。

合同层同时验证 trusted `run/cwd/HEAD/PID` barrier、来自 Git 事实的冲突 digest（含非零 rebase、unmerged entries、sequencer）和 public `agent_end`/follow-up/next `agent_start` 计数；`agent_settled` 不是 Auto Integration 成功信号。`ACCEPTANCE_OVERALL_TIMEOUT_MS` 覆盖 barrier、child settlement 与 public audit settlement，失败时保留 repository/worktree/receipts。

两种来源互斥，同一 Pi 配置中只能启用一种。不得同时安装或启用 standalone `npm:pi-subagents@0.80.0`，否则会形成重复 runtime、tool、message renderer 或模块身份。

## 准备与升级

在仓库根目录首次准备或升级 package 依赖：

```bash
npm run setup:subagents-enhanced
npm run verify:subagents-enhanced
```

升级后启动 fresh Host。原地替换期间若保留旧 Host，须暂停其子代理派发与 `/reload`，避免后续操作读取被替换的依赖；独立安装与独立状态根可以并行使用。普通 TypeScript/MJS 源码修改不需要重新安装 package，在匹配依赖版本的 Host 中执行 `/reload` 即可生效。

Pi `1.4.0` 的四个核心包只声明精确版本（`pi-coding-agent` 精确依赖 `pi-agent-core`/`pi-ai`/`pi-tui`/`pi-codemode` 的 `1.4.0`），不再存在 `1.0.4` 时期 `^1.0.4` 造成的 codemode 漂移源，因此根与本 package 已删除 `overrides: {"@earendil-works/pi-codemode":"1.0.4"}` 这条冗余约束；干净闭包直接解析到 `1.4.0`，由 `test/pi-subagents-enhanced-package.test.mjs` 断言 lock 中的 codemode 版本与 tarball。所有下载只使用官方 `https://registry.npmjs.org/`。外部 Host 安装根同样需要 `1.4.0` 四核心精确版本（以及其自身 lock），否则本 package 的已验收隔离安装不能代表外部 Host 闭包兼容。仅同步 lock 不会改变已运行 Host 内存中的模块，也不能保证其后续派发或重载仍使用旧依赖。

npm 发行清单只使用 canonical `bundleDependencies: ["pi-subagents"]`，发行包已经包含经过 registry 受控比较验证的 upstream 依赖闭包。发行前在 package 目录使用 `npm pack --dry-run --json --ignore-scripts` 检查内容；不要用非 dry-run pack 代替验证。
