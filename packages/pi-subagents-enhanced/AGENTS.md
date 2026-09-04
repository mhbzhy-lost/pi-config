# Pi Subagents Enhanced 约束

## TUI 精简边界

所有面向用户的精简、折叠、摘要、截断和换行只能发生在 TUI renderer 层。不得为改善 TUI 展示而改写 agent 实际收到的消息、tool result、event payload、session 内容或其结构化 details；TUI renderer 必须消费原始数据并生成独立的显示文本。

## Upstream 兼容边界

所有 `pi-subagents/src/*` 深层 import 必须集中在 `src/compat/pi-subagents-0.62.ts`。其他文件只能从该兼容入口消费 upstream API，不得扩散新的深层 import。

`pi-subagents` 版本固定为 `0.62.0`；升级版本前必须同步更新兼容入口、安装补丁和完整验收。

## TypeScript 文件边界

package 内由 Node 直接执行的 `scripts/*.ts` 和所有 `src/**/*.ts` 均使用 TypeScript；Node `>=22.19.0` 负责原生 type-stripping，发布前仍需运行静态类型检查。不得为新的 package 实现新增 `.mjs`；仅保留 upstream 或尚未迁移的外部兼容文件。

## Workspace 所有权边界

所有 standalone subagent、Goal task 和 Goal validation workspace 共用 `src/workspace/` 中的一套 service、ledger 和 Git lifecycle。`src/workspace/` 外禁止直接执行 subagent/Goal 的 `git worktree` mutation，也不得建立第二套 workspace ledger、owner token 或 disposition 状态机。

公开入口只允许 package exports `./workspace` 与 `./workspace/admin`。运行时 owner token 只能保存在统一私有 ledger 中；agent、Goal event 和管理输出只能消费公开 receipt 与其 `leaseId`。
