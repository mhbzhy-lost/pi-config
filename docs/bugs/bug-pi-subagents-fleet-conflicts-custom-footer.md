# Bug：pi-subagents FleetView 与自定义 Footer 布局冲突

## 1. 现象

升级到 `pi-subagents@0.37.0` 后，subagent 运行状态会出现在编辑器下方；自定义 footer 同时继续显示 cwd、上下文、provider/model 和 thinking，底部区域形成两套相邻状态布局，视觉层级和对齐方式冲突。

## 2. 影响

subagent 状态占用多行并与三行自定义 footer 争夺终端底部空间，窄终端下尤其明显。状态信息没有进入现有左右分栏体系，cwd 下方的左侧区域空置，而 subagent 信息在独立 surface 中显示。

## 3. 稳定复现

1. 使用启用了自定义 `custom-footer.ts` 的当前 Pi 配置。
2. 安装 `pi-subagents@0.37.0`，保持默认 `fleetView: true`。
3. 启动一个 foreground 或 background subagent。
4. Pi 在 `belowEditor` placement 注册 `subagent-fleet-status` widget，同时自定义扩展通过 `setFooter()` 渲染三行 footer，稳定出现重复底部布局。

## 4. 证据

`pi-subagents` 0.37.0 的 `SubagentFleetStatus.refresh()` 在存在活动条目时调用 `ctx.ui.setWidget("subagent-fleet-status", ..., { placement: "belowEditor" })`，并渲染 main、活动 agent、耗时和 token。其配置默认 `fleetView !== false`，README 明确说明 `fleetView: false` 只隐藏该 surface，不影响状态追踪、完成通知、`/subagents-fleet` 或生命周期事件。`loadConfig()` 从 `PI_CODING_AGENT_DIR/extensions/subagent/config.json` 读取这些字段，不读取 `settings.json` 的 `subagents` 节点。当前 `custom-footer.ts` 独立调用 `ctx.ui.setFooter()`，第二行左侧为空，且没有订阅 subagent tool 或 async lifecycle。

## 5. 根因

0.37.0 新默认 FleetView 与仓库已有自定义 footer 都拥有终端底部布局，但配置没有关闭上游 surface，自定义 footer 也没有接管 subagent 状态。问题不是单个组件对齐错误，而是同一信息区域存在两个独立布局所有者。

## 6. 修复与验证策略

在 `PI_CODING_AGENT_DIR/extensions/subagent/config.json` 显式设置 `fleetView: false` 和 `asyncWidget: false`，消除重复 surface，同时保留 `/subagents-fleet` inspector。自定义 footer 订阅 `subagent` tool execution 与 `subagent:async-started` / `subagent:async-complete` 公开事件，将活动 agent 的紧凑摘要放到第二行左侧，即 cwd 正下方；provider/model 保持同一行右对齐。先用真实 TypeScript extension 的失败测试固定位置、生命周期和上游真实配置文件契约，再实现并执行 footer、reload 和 Pi 启动验证。

## 7. 验证结果

真实扩展测试确认 `subagents: executor` 位于 cwd 下一行左侧，foreground 调用转为 background run 时状态连续，完成后清空；provider/model 仍在同一行右对齐。`pi-subagents` 自身 `loadConfig()` 实际返回 `fleetView: false` 和 `asyncWidget: false`。footer、reload 边界、紧凑工具和 Todo 共 37 项聚焦测试通过；在 `~/mega-aone-service` 使用当前完整配置调用与 TUI `/reload` 相同的 `session.reload()` 耗时 149ms，extension errors 为 0。
