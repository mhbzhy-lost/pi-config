# Bug：自定义 Footer 在窄终端恢复会话时超宽崩溃

## 1. 现象

在 `~/new-api-account-pool` 和 `~/taobao-mobile-workspace` 重启 Pi 并继续历史会话时，Pi 因 `Rendered line 4466 exceeds terminal width (59 > 58)` 退出。

## 2. 影响

较窄终端或较长 cwd 下无法恢复已有会话，Pi 在首次完整渲染阶段直接退出。

## 3. 稳定复现

终端宽度设为 58，在 cwd 为 `~/new-api-account-pool`、右侧为 `76.1%/272k  (codex-pool) gpt-5.6-sol` 时渲染 footer。当前实现生成 59 列。

## 4. 证据

`pi-crash.log` 第 4466 行唯一超宽，内容正是自定义 footer。`custom-footer.ts` 使用 `Math.max(1, width - visibleWidth(left) - visibleWidth(right))` 强制至少一个空格，但从不截断左右内容；当两侧内容宽度之和等于或超过终端宽度时必然超宽。

## 5. 根因

Footer 布局把“至少一个分隔空格”当成无条件约束，却没有为窄终端定义内容优先级和截断策略，违反 TUI 组件每一行不得超过传入 width 的契约。

## 6. 修复与验证策略

先增加 58 列回归测试，复现长 cwd 加 provider/model 导致超宽。实现独立布局函数：优先保留右侧状态，至少保留一个分隔空格，按剩余宽度用 `truncateToWidth()` 截断 cwd；若右侧自身过宽则截断右侧。验证所有输出 `visibleWidth <= width`，再对两个项目执行恢复会话 smoke test。
