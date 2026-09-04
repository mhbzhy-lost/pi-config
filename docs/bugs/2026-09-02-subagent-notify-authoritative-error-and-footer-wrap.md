# Subagent 通知未体现 authoritative failed/acceptance/runtime error，footer 超长标题被截断

## A. completion 通知

真实 `pi-subagents@0.62.0` async result 可能同时携带 authoritative `state: "failed"`、`acceptance.status: "rejected"` 和 runtime `error`，而 executor summary 仍残留 `Status: completed`。项目 notifier 当前直接沿用 summary，用户看到的正文无法判断失败、验收拒绝和运行时错误的真实原因。

来源是公开 typed executor workflow、真实 async result watcher 和项目 completion notifier；不是手工事件或测试 fixture。首个偏离点是 wrapper 没有在展示边界按 authoritative 字段重写冲突 summary。

## B. footer 超长显示

真实 dispatch title 或 agent 名称可能超过 selector 可用宽度。custom footer 当前通过 `truncateToWidth` 单行截断，丢失标题内容；child selector 还必须为状态点/选择符预留列宽，续行应与首行文本列对齐。

来源是公开 dispatch title、真实 `subagent:async-started` roster 和 footer selector 渲染；首个偏离点是 footer 将可换行内容当作单行 label。

## 修复边界

- completion wrapper 以 authoritative failed/acceptance/error 为准生成通知正文，过滤冲突的 `Status: completed` summary；保留 upstream suppression；
- footer selector 对超长标题/agent 使用确定性换行，续行文本与首行文本对齐并保留状态点/选择符列；固定三行 footer 和 main/child 模式不变；
- 不修改 `pi-subagents` node_modules、settings 或 models。

## 布局补充

首版 selector 虽已产生换行，但 `layoutFooter` 仍把整个 multiline left 当作单行调用 `truncateToWidth`，实际显示会在 provider/model 后追加省略号；custom footer 还把含换行的 selector 作为数组单项返回，使续行与 thinking 行重叠。现在布局 helper 保留预换行首行并将 right 仅拼接到首行，续行不截断；custom footer 将物理行展开后再追加 thinking/scheduler 行。单行 footer 仍保持三行。
