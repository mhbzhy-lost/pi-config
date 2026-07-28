# Bug：长 Subagent title 偶发独占 Footer

## 1. 现象

部分 Subagent 运行期间，Footer 第二行被一大串 title 文本占满，其他活动 Child 和 `history` 入口消失，看起来像完整任务文本污染 Footer。

## 2. 影响

Footer 失去并发状态扫描能力；一个长 title 会遮蔽其他运行和历史计数。虽然整行最终不会越过终端宽度，但内容优先级错误，用户只能看到被截断的第一项。

## 3. 稳定复现

构造两个 active children：第一个 title 为约 100 个字符，第二个 title 为 `Short check`，另有一个 terminal run。在当前 `formatBrowserSelector()` 下分别以 32、58、100 列渲染，三种宽度都只显示第一条 title 的截断文本，第二个 Child 与 `history` 均不可见。

## 4. 证据

`title-registry.ts` 为通用显示文本设置的是 256 UTF-8 bytes 安全上限，该上限防止控制字符和无界存储，不是 Footer 排版预算。`selectorChild()` 将完整 `child.label` 与 agent 拼接；`formatBrowserSelector()` 只有在组合 items 后才按整行 width 截断。首项本身超过 width 时，窗口扩展算法无法加入任何相邻项。

本机 retained `status.json` 扫描未发现异常长 `agent` 或 `step.label`，而直接用合法长 title 调用 formatter 可稳定重现。因此问题位于显示层的单项宽度分配，不是 lifecycle、status artifact 或 roster 数据污染。

## 5. 根因

代码把“允许保存的 title 最大长度”误当成“适合 Footer 展示的最大长度”，缺少单个 selector title 的可见列上限。整行截断只能保证边界安全，不能保证多个状态项之间的公平展示。

## 6. 修复与验证策略

只在 `selectorChild()` 生成可见 label 时，把 `child.label` 截到最多 32 个可见列并使用单字符省略号；`BrowserChild.label`、持久 roster、lifecycle event 和 status 数据保持完整。agent identity 与 lifecycle glyph 不截掉。

RED 测试要求 100 列 Footer 同时显示截断后的长 title、第二个活动 Child 和 `history`；Child 模式仍保留 `›` 与状态 glyph。测试深比较 snapshot，证明 formatter 不修改数据源。完成后与通知/status 紧凑 renderer 一并做 fresh reload 和真实 TUI 验收。

## 7. 验证结果

当前 formatter 在 32/58/100 列都可稳定复现首项独占；RED 28/29，失败点为第二个 Child 不可见。加入 32 列单项预算后 Footer/browser 50/50、扩大回归 158/158 通过，snapshot 深比较保持不变。用户在 final reload 后确认长 title 被截断且 sibling 同时可见。
