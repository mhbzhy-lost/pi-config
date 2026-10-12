# Runtime 后续问题与体验改进验收记录

## 状态

- 执行方式：Inline（用户明确选择）。
- 结论：用户清理并确认工作区后，T0 已按 11 条计划相关文档路径重建；静态调用链、覆盖边界和暂缓决策已记录，但生产 provenance 与通知行为合同尚不完整，五项问题均未修复。
- 验收类型：本次仅完成文档/JSON 结构检查与静态记录核对；不把记录产出、暂缓决策或 checkbox 当作完整合同或真实 runtime 验收。
- 当前用户决策：仅文档化、提交并推送；暂不作实际代码改动，不解除真实 Host/RPC/模型/系统通知/危险实验的授权边界。
- 版本：Pi `1.0.4`；`pi-subagents` `0.75.0`；Node `v26.8.1`（仓库最低仍为 `>=22.19.0`）。
- 基线：`baseline.json` schema v2；HEAD `3a710c6107c905caf6e6719f20f791d3d69b027a`；index 为空；status 仅包含本计划及其关联 bug/decision/TODO 文档。

## 任务状态矩阵

| 任务 | 结果 | 证据 | Production 改动 |
| --- | --- | --- | --- |
| T0 | 通过：用户确认清理后，11 条计划相关文档路径精确冻结 | `baseline.json` schema v2 | 否 |
| T1 | 静态记录已产出；生产 provenance 不完整 | `rpc-provenance.json` + RPC bug doc | 否 |
| T2 | 静态状态映射已产出；生产消费证据不完整 | `supervisor-provenance.json` + supervisor bug doc | 否 |
| T3 | 静态覆盖矩阵完成 | `2026-10-11-heartbeat-orphan-cleanup-provenance.md` | 否 |
| T4 | 所查 sender 边界已记录；本仓 selector 输入与接入可行性尚未证明 | `2026-10-11-dispatch-receipt-trigger-turn.md` | 否 |
| T5 | 产品条件与现有缺口已记录；登记/epoch/status 生命周期设计未完成 | idle decision doc | 否 |
| T6 | 修复资格/关闭决策完成；不改 production | RPC bug doc | 否 |
| T7 | 合同决策/关闭完成；不改控制面 | supervisor bug doc | 否 |
| T8 | 上游/静态边界决策完成；不改 lifecycle | heartbeat bug doc | 否 |
| T9 | 暂缓本轮实现，尚未证明所有本仓接入点均不可行 | triggerTurn decision doc | 否 |
| T10 | 暂缓本轮实现，缺少现成 registry 不代表不能设计新增 | idle decision doc | 否 |
| T11 | 文档收口完成；完整行为合同及生产验收未完成 | 本文件与 TODO 账本 | 否 |

## 关键结论

- RPC 的 `rpc:v1/session` 是复合能力标签；没有真实字段级启动 metadata，不能选择 session context、cwd 或资源世代作为唯一根因。保持 fail-closed，不加 fallback。
- supervisor 的 `submitted`、`queued/delivered`、`consumed` 和 `gate-open` 已明确为不同来源/派生状态；不以 upstream pending 为空或 reply 提交成功解除本仓 gate。
- heartbeat 的 45–65 秒是由静态常量推导，不是 crash 实测；generic、绑定失败和 detached descendant 不被宣称已清理。
- 当前所读路径中，`triggerTurn` sender 在上游 notify.js，本仓 TUI completion observer 不是 sender；未证明可供本仓使用的结构化 selector 输入。暂停本轮实现，不据此证明所有本仓接入方案均不可行。
- idle notification 的产品语义已确认，当前实现没有专用 run registry；这属于待设计能力，不代表不能新增。登记、resume 和 session epoch 合同仍需闭合，且用户此前暂缓实现，本轮不调用 `osascript`。

## 验证范围与日志

- JSON/Markdown/源码静态检查：使用精确文件读取、结构脚本和 `git diff --check`；未启动 Host/RPC/provider/model/MCP/PTY/child。
- 未运行 Node test、root/enhanced `tsc` 或真实 status/reply/steer；本轮没有 production diff 需要类型/单测证明。
- 未读取真实 settings/models/auth、凭据、完整 session 或 authority；baseline 对 status 路径做了脱敏。
- 调查期间未执行 SIGKILL、`osascript`、commit、push、reset、restore、stash 或 raw managed-worktree 操作。后续文档提交/推送由本次用户单独授权，实际结果以 Git 回执为准。

## 未验证与后续授权

- T1/T2 仍需要用户提供的字段级非敏感生产 metadata，才能升级 source classification；不得读取完整 session。
- T9 需继续核实 receipt 的稳定输入、本仓合法 options 接入点与上游边界；现有调查不证明上游新增字段是唯一解法，不得修改 node_modules。
- T10 需设计 feature-owned run registry 与 session epoch 生命周期；没有现成实现是设计输入，不是不可实现的结论。代码实施须修订 WritePaths 并重新取得授权，真实系统通知调用需单独确认。
- 三项 TODO 的实现授权仍未获得；RPC/supervisor 继续按 bug 文档等待 provenance 样本。

## 资源与工作区

- 未启动 worker、unit-runner、真实 Host、provider、model 或危险进程；无遗留进程/定时器。
- 初次 T0 把 14 条非本计划路径统一脱敏并错误推断敏感，且未及时执行停止条件；该偏差不作为合规证据。旧 baseline 后被 schema v2 覆盖，当前只能保留本说明，不能宣称旧原始 JSON 已完整留存。
- 用户随后确认清理完成。schema v2 的 HEAD 与路径是当时观测事实，不更新为后续 Git HEAD；本次重新核对仅有上述 11 条文档路径，未读取敏感配置、session 或 authority，提交前 index 为空。
- 本次未启动额外 writer 或运行进程；工作区稳定只由路径级 Git 观测与用户确认支持，不宣称枚举了全部外部 writer。
- 本记录描述调查范围；文档提交/推送授权来自用户本轮明确请求，不是由本记录授予。
