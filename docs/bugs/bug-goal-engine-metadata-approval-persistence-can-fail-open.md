# Goal Engine 元数据审批持久化可失败开放

- **现象**：challenge 使用可选 `appendEntry` 后仍进入内存 pending；拒绝时第二个 rejected tombstone 写入失败会使当前进程未终结。proposal 响应只展示 hash，且 schema 暴露内部 `nonGoals`。
- **影响**：没有耐久会话记录或写入异常时，用户未经可审计审批即可留下可操作内存状态；重载/失败窗口可能复活审批。用户无法核对目标元数据，模型 API 也与 `goal_init` 的 `non_goals` 不一致。
- **根因**：持久化函数采用 optional call 且未确认成功；reject 的两次写入不是 fail-closed 原子边界；公开 schema/响应直接复用了内部投影命名并遗漏完整 proposal。
- **触发条件**：Host 缺少 `pi.appendEntry`、challenge append 抛错、reject tombstone append 抛错，或模型以 `non_goals` 提案及用户查看 proposal 时。
- **修复方案**：challenge/decision/tombstone 持久化失败必须拒绝操作且不更新内存；reject 第二写失败仍在内存及 reload 视为 terminal，且不持久化用户输入原文。公共 schema 接受 `non_goals`、拒绝 `nonGoals`，边界映射到 projection `nonGoals`；响应展示 reason、base/target metadata、proposal hash 和精确 approve/reject choices。
- **验证与回归**：注入缺失/抛错 append、reject 第二写失败与 reload；断言无 pending、不可复活且日志无输入原文；真实 Host 覆盖 schema、projection 映射和完整 proposal 展示。
