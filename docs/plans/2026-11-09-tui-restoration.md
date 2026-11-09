# TUI 恢复计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。只有整体交付终态全部验证通过，才算计划执行完成。TUI 只消费只读投影，不改变 subagent 派发、执行、RPC 或 worktree 合同。

**目标：** 恢复 footer 的后台活动展示和 subagent 运行状态查看，同时保留当前 `pi-subagents` async runner 与最小 RPC 工具面。

**架构：** 新建根 `src/tui/` 作为 TUI feature-owned 实现，使用 Pi SDK 注入的 TUI 依赖。footer 通过只读 ActivitySource 聚合 subagent、bash_async 和 scheduler observer；subagent source 通过 `pi-subagents` public RPC/status 与生命周期事件观察 async run。Alt+O 打开只读 subagent 状态查看器，详情只读取受信任的上游 status/session artifact，不调用控制工具。

**技术栈：** Pi Coding Agent 1.5.0 Extension API、`@earendil-works/pi-tui`、`pi-subagents@0.84.0`、Node.js 22.19+、原生 TypeScript。

## 全局约束

- 不恢复 `pi-subagents-enhanced` package、Goal、Supervisor、workspace、旧 Root Broker 或旧 compatibility facade。
- 不改变 `subagent_spawn/status/steer/stop/resume` 的输入合同和 RPC 映射。
- TUI 只消费 raw status、event 和 observer snapshot，展示精简只发生在 renderer 层，不改写 session、tool result、event payload 或执行状态。
- subagent runner 继续使用当前 async 独立进程；本轮不加入 worktree 分配或 workspace 绑定。
- footer 不发送模型消息、不创建任务、不调用 steer/stop/resume，不成为第二个运行状态权威。
- 不新增测试；只运行和调整已有测试、loader probe、类型检查与诊断命令。
- 所有新 production/CLI TypeScript 代码使用 `.ts`，最低 Node 版本为 `>=22.19.0`。
- 不使用 MCP，不接入外部服务，不读取或输出凭据。

## 整体交付终态

| ID | 必须成立的条件 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
| --- | --- | --- | --- | --- | --- |
| F1 | fresh Pi TUI 能加载唯一 footer extension，且只安装一个 footer owner 与一个 Alt+O handler | 隔离 agentDir 的真实 Pi loader，`mode: tui` 或 extension runner probe | 无 extension error；footer 入口加载；不存在重复 `setFooter`/shortcut 注册 | loader 输出、测试结果 | T3、T5 |
| F2 | footer 显示 cwd、model、thinking、context 使用率和后台活动行 | 真实 TUI component render probe，覆盖窄宽度和空/有任务状态 | 行布局不重叠，长文本截断只发生在 renderer，空状态稳定 | render probe 输出 | T3、T5 |
| F3 | bash_async 与 scheduler 现有 observer 可作为只读 activity source 接入 | 既有 controller/adapter observer，通过 source snapshot/subscribe/detail 观察 | 不改变执行/取消/发送合同；任务变化只触发 footer 重绘 | 既有测试结果、source probe | T2、T3 |
| F4 | subagent async run 能出现在 footer，并能在 run 完成或状态变化后刷新 | 使用当前 `codex-pool/gpt-6.1-terra` 的真实 async spawn；监听 `subagent:async-started`、`subagent:async-complete`、`subagent:child-status`、`subagent:process-terminal`、`subagent:jobs-changed` | 行 key 稳定；运行中/完成/停止/失败状态不误判；不创建第二份 run registry | 真实 runId、status/event probe | T2、T3、T5 |
| F5 | Alt+O 能打开只读 subagent 状态查看器，支持选择 run、查看状态和 bounded transcript/detail | 真实 TUI input/component probe；使用受信任 asyncDir/session roots | 查看器不执行控制动作；非法/缺失/过期 artifact fail closed；关闭后恢复 editor/draft | browser probe 输出 | T4、T5 |
| F6 | 当前最小 subagent 工具和 async runner 行为保持不变 | `npm run typecheck`、`npm run doctor`、现有 loader/RPC smoke | 五个 prefixed tool 合同不变，真实 spawn/status 仍成功 | 命令输出与 smoke 结果 | T5 |

**完成规则：** F1–F6 全部满足，且证据对应当前工作区版本，才可标记计划完成。单独恢复 footer 文件或 TUI 渲染通过不能替代真实 async 状态链路验证。

**未满足时：** 在本计划范围内持续 `fix → test（验证）→ 对照终态`；无法证明只读来源、身份或 artifact trust 时 fail closed，不增加执行 fallback。

## DAG

```text
T1 (上游状态/旧 TUI 边界核对) ──┬──> T2 (只读 ActivitySource)
                                ├──> T3 (footer owner/layout)
                                └──> T4 (subagent browser/detail)
T2 ───────────────────────────────┘
T3 ──> T5 (入口接线与整体验证)
T4 ──> T5
```

## Waves

- Wave 1：T1（关键路径，完成 public RPC/status/event 与旧 TUI 依赖清单）
- Wave 2：T2、T3、T4（T2/T3/T4 分别消费 T1 的边界结论，可并行；T3 需要 T2 的 source 接口）
- Wave 3：T5（入口接线、loader、类型和真实 async 验证）

**关键路径：** T1 → T2 → T3 → T5；T4 与 T3 并行后汇合。

---

### Task 1：冻结只读状态与旧 TUI 依赖边界

**Deps：** `none`

**WritePaths：**
- `docs/plans/2026-11-09-tui-restoration.md`

**Resources：** `none`

**Files：**
- Read：`packages/pi-subagents-enhanced/src/tui/*.ts`、`packages/pi-subagents-enhanced/extensions/custom-footer.ts`（Git 历史）
- Read：`src/bash-async/contracts.ts`、`src/task-scheduler/adapter.ts`、`src/subagent/index.ts`
- Read：`node_modules/pi-subagents/docs/extension-api.md`、`node_modules/pi-subagents/src/extension/rpc.d.ts`

**接口契约：**
- Consumes：当前 `pi-subagents` RPC `status`/ready/events、bash_async controller observer、scheduler adapter observer。
- Produces：T2/T3/T4 使用的只读 source、detail、scope 与 artifact trust 边界；不得引入旧 runtime import。

**终态关联：** `F1`、`F3`、`F4`、`F5`。

**验收标准：**

- [x] **步骤 1：核对旧 TUI 实现的纯展示部分**

  区分可恢复的 layout、footer、browser、transcript renderer 与必须丢弃的旧 title registry、workspace、presentation-status、compat runtime 依赖。

- [x] **步骤 2：核对当前上游状态来源**

  记录 `pi-subagents` 的 ready、async lifecycle event、status response、`fleet`/`asyncSnapshot` 和 artifact 字段，确定每个 TUI 字段的唯一来源。

- [x] **步骤 3：记录边界结论**

  明确 current `subagent_spawn` 的 `runId`、asyncDir、sessionFile、cwd 和 status artifact 如何进入只读展示，不把任何 TUI 字段反向写回运行合同。

### Task 2：实现只读 ActivitySource 聚合接口

**Deps：** `T1`（理由：消费 T1 冻结的 source 与 scope 契约）

**WritePaths：**
- `src/tui/background-activity.ts`
- `src/tui/subagent-activity.ts`
- `src/tui/scheduler-activity.ts`
- `src/tui/bash-activity.ts`

**Resources：** `none`

**Files：**
- Create：`src/tui/background-activity.ts`
- Create：`src/tui/subagent-activity.ts`
- Create：`src/tui/scheduler-activity.ts`
- Create：`src/tui/bash-activity.ts`

**接口契约：**
- Consumes：`pi.events` lifecycle events、`subagent` RPC status reply、`BashAsyncController.snapshot/subscribe`、`SchedulerActivityObserver.snapshot/subscribe/detail`。
- Produces：`ActivityRow`、`ActivitySnapshot`、`ActivitySource.snapshot/subscribe/detail`，以及 footer owner 可注册的 source 集合。

**终态关联：** `F3`、`F4`。

**验收标准：**

- [x] **步骤 1：定义稳定的纯展示协议**

  行 identity 使用 `kind + stable source id`，不按展示 label 去重；snapshot 区分 available/stale/unavailable；source detail 只返回 TUI component，不暴露控制方法。

- [x] **步骤 2：接入 bash_async 与 scheduler observer**

  只转发 snapshot、失效通知和受控 detail；不调用 cancel、delete、sendMessage 或 scheduler mutation。

- [x] **步骤 3：接入 subagent async 状态**

  以事件触发 bounded status refresh；active rows 和 recent rows 使用上游状态/结果事实；未知状态显示待处置或不可用，不升级为成功/失败。

- [x] **步骤 4：实现 source 代际清理**

  session_start/session_shutdown 或 session replacement 后清空旧 source listener，旧事件不得污染新 session。

### Task 3：恢复 footer owner 与布局

**Deps：** `T1`、`T2`（理由：布局需要冻结的 source 协议和现有 observer 接口）

**WritePaths：**
- `src/tui/footer-layout.ts`
- `src/tui/footer-runtime.ts`
- `pi/extensions/custom-footer.ts`

**Resources：** `none`

**Files：**
- Create：`src/tui/footer-layout.ts`
- Create：`src/tui/footer-runtime.ts`
- Create：`pi/extensions/custom-footer.ts`

**接口契约：**
- Consumes：Pi `setFooter`、`setWidget`/TUI component API、SDK markdown theme、T2 ActivitySource。
- Produces：唯一 footer owner、唯一 Alt+O 委托、可重绘的 footer component、当前 session scope 的 source registry。

**终态关联：** `F1`、`F2`、`F3`、`F4`。

**验收标准：**

- [x] **步骤 1：恢复基础 footer 行布局**

  恢复 cwd、context usage、provider/model、thinking 和后台活动行；窄宽度下使用 TUI truncate/visibleWidth，不能改写 raw 数据。

- [x] **步骤 2：安装唯一 owner**

  footer extension 只通过一次 `setFooter` 安装；session 代际变化时替换当前 view，不叠加旧 footer；Alt+O 只注册一次并委托当前 browser。

- [x] **步骤 3：接入 source snapshot/subscribe**

  source 失效只请求 render，不在 footer 中执行任何 run/tool 控制；异常隔离，单个 source 不得阻塞其他 source。

- [x] **步骤 4：完成 TUI component probe**

  用纯 component render 验证空状态、单行、多行、长 cwd、长模型、多个后台活动和窄宽度布局。

### Task 4：恢复 subagent 状态查看器

**Deps：** `T1`（理由：消费上游 status/artifact 与 trust 边界）

**WritePaths：**
- `src/tui/session-browser.ts`
- `src/tui/browser-adapter.ts`
- `src/tui/session-viewport.ts`

**Resources：** `none`

**Files：**
- Create：`src/tui/session-browser.ts`
- Create：`src/tui/browser-adapter.ts`
- Create：`src/tui/session-viewport.ts`

**接口契约：**
- Consumes：T2 subagent source、上游 status `view/transcript/lines` 或受信任 session artifact、Pi TUI editor/custom component API。
- Produces：只读 browser snapshot、选择/滚动/展开控制、bounded transcript/detail renderer。

**终态关联：** `F5`。

**验收标准：**

- [x] **步骤 1：实现 browser roster**

  active/recent run 列表按 stable runId/child index 管理；状态只消费上游事实；不恢复旧 title registry 或 enhanced presentation-status。

- [x] **步骤 2：实现详情读取防线**

  对 status/transcript/artifact path 做 canonical root、regular file、symlink、大小和 JSON/文本边界检查；异常显示固定 warning，不读取任意路径。

- [x] **步骤 3：实现只读输入交互**

  支持选择、滚动、关闭和 editor/draft 恢复；不注册 steer/stop/resume 操作，不改变 session。

- [x] **步骤 4：完成 browser component probe**

  覆盖无 run、running、complete、failed/unknown、缺 artifact、超长 transcript 和窄宽度。

### Task 5：入口接线与整体验收

**Deps：** `T2`、`T3`、`T4`（理由：入口必须同时绑定 source、footer 和 browser）

**WritePaths：**
- `pi/settings.template.json`
- `README.md`
- `test/pi-runtime.integration.mjs`（仅调整既有断言；不新增测试）

**Resources：** `none`

**Files：**
- Modify：`pi/settings.template.json`（启用当前 footer 入口的自动发现/资源配置，保持旧 subagent tools 不变）
- Modify：`README.md`（描述 footer 与只读状态查看能力）
- Modify：`test/pi-runtime.integration.mjs`（只调整现有 loader 工具/extension 断言）

**接口契约：**
- Consumes：T2/T3/T4 的公开 TUI factory 与现有 Pi loader。
- Produces：fresh Host 可加载的 footer TUI、subagent 状态查看和既有最小 RPC runtime 共存。

**终态关联：** `F1`–`F6`。

**验收标准：**

- [x] **步骤 1：接入 fresh Host**

  确认 footer extension 自动加载且不重复注册；`subagent_spawn/status/steer/stop/resume` 工具列表保持不变。

- [x] **步骤 2：运行静态和既有检查**

  运行 `npm run typecheck`、`npm run doctor`、`git diff --check` 和适用的既有 Pi runtime/TUI 测试。

- [x] **步骤 3：执行真实 async 状态 smoke**

  使用 `codex-pool/gpt-6.1-terra` 启动一个短任务，核对 footer source 能观察到 runId、running/complete 状态及结果 artifact；不调用控制工具。

- [x] **步骤 4：对照 F1–F6 完成验收**

  记录每项终态的命令、环境、结果和未覆盖限制；未能证明的 TUI 状态或 artifact 读取路径不得标记为通过。
