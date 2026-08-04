# Goal Engine 绿色恢复评估

## 结论

- **不执行“删状态后重新初始化”**。已有 active Goal 时，不能通过删除持久状态并调用 `goal_init` 绕过现有 Goal；也不能直接编辑或删除 events/projection，或手工清理 Goal worktree。
- 当前所述“全部 pending、workspace 为 null”只表示**没有可处置的 active workspace**。dispatch 在持久事件产生前失败的包装层信息，不能证明存在 attempt、session、artifact 或 worktree，因此此刻不应调用 `goal_settle` 或 `goal_integrate`。
- `.state/goal-engine/` 被跟踪是代码库卫生问题，不是销毁 Goal 的理由。后续应在完整保留其本地持久内容的前提下，让该路径不再受版本跟踪并被忽略，同时确认 Executor worktree 仍有有效 Git HEAD；本次仅作决策评估，不执行这些操作。

## 恢复顺序

1. **停止破坏性动作**：不删 `.state/goal-engine/`，不重建 Goal，不根据上次 dispatch 的 failed/timeout 文本推断状态。
2. **先确认权威状态**：读取当前 typed schema 后调用 `goal_status`，不填写本文未展示的参数。核对 active Goal、task 状态、workspace，并以返回的 machine action 为唯一下一步依据。
3. **修正跟踪问题但保留活状态**：只纠正 `.state/goal-engine/` 的版本跟踪与忽略规则，不改其 events/projection，不手工清理 Goal worktree；同时复核有效 HEAD、相对 worktree 的 `writePaths` 和 acceptance commands。
4. **再次确认动作**：修正完成属于新的恢复/协调轮次，应再次读取当前 schema 并调用 `goal_status`。不能仅凭“pending + null workspace”断言下一动作；若返回的 machine action 指向 `goal_dispatch`，才按其当前 schema 调用。
5. **重新派发时**：把 `goal_dispatch` 返回的完整 `dispatch-ir.v1` contract 原样交给 executor，不改写、不补参数。若包装层再次失败或超时，回到 `goal_status`，不要自行生成任何版本号、尝试标识或工作区调用。
6. **后续闭环**：executor 已终止且存在真实 artifact/evidence 后，才依 machine action 调用 `goal_settle`；settle 后才依 machine action 调用 `goal_integrate`。成功任务选择 integrate；失败或 blocked 的 active workspace 选择 discard；只有人类明确要求保留现场时才选择 preserve。当前 workspace 为 null，所以本轮没有 settle/integrate 对象。
7. **最终验收**：在 `goal_accept` 前运行 contract 中的 acceptance commands；只有 task succeeded、验收通过且 workspace 已 integrate/released，并且 machine action 指向 `goal_accept` 时才调用。每个新协调轮次仍从 `goal_status` 开始。

## `goal_amend` 的时机

- 经理要求的“删除状态再初始化”是恢复手段要求，不是 Goal 范围变更；它本身不触发 `goal_amend`，也不允许 `goal_init`。
- 只有人类确实修改范围、task DAG、依赖、workflow、`writePaths` 或验收标准，或状态进入 blocked/preserved 且需要调整计划时，才在 `goal_status` 的 machine action 指示下、读取当前 schema 后调用 `goal_amend`。
- 若失败/blocked 且仍有 active workspace，应先在已 settle 的前提下用 `goal_integrate` discard，再由下一次 `goal_status` 决定重新 `goal_dispatch` 还是 `goal_amend`；明确 preserve 后则先 amend，不 re-init。
- `goal_init` 只适用于真正的新 DAG：必须不存在 active Goal、初始化检查表全部满足，且 machine action 明确指示；不属于本场景的恢复路径。

## 如何确认下一 machine action

唯一确认方式是重新调用 `goal_status` 并读取其返回值。当前描述最多说明“很可能可重新 dispatch”，不能替代真实 machine action；任何 reload、compaction、失败恢复或动作完成后的新一轮都应重新查询，而不是沿用对话历史。

## 残余风险

- 若纠正版本跟踪时误删本地 `.state/goal-engine/` 内容，active Goal 的持久证据可能丢失；必须把“停止跟踪”与“删除活状态”严格分开。
- 本次按要求未实际调用 `goal_status`，所以无法断言此刻 machine action 就是 `goal_dispatch`；执行者必须以现场返回为准。
- 包装层声称“持久事件前失败”仍不能单独排除边界竞态；再次 `goal_status` 是消除歧义的门禁。

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "文档给出不删状态、不 re-init 的状态驱动恢复顺序，明确 goal_amend 条件、machine action 确认方法，并单列三项残余风险。"
    }
  ],
  "changedFiles": [
    "/tmp/using-goal-engine-green-recovery.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "已完整读取 using-goal-engine/SKILL.md。",
    "按决策评估约束，未执行任何真实 Goal 或 Git 操作。",
    "正文仅使用 Skill 列出的七个 Goal Engine 工具名，未构造未展示的 typed-schema 参数。"
  ],
  "residualRisks": [
    "停止版本跟踪与删除活状态若被混淆，会造成持久证据丢失。",
    "未现场调用 goal_status，实际下一 machine action 仍须运行时确认。",
    "dispatch 包装层失败信息不能替代持久状态核验。"
  ],
  "noStagedFiles": true,
  "diffSummary": "新增一份 /tmp 下的中文恢复决策评估；未修改项目代码或持久 Goal 状态。",
  "reviewFindings": [
    "no blockers"
  ],
  "manualNotes": "本次严格保持只读决策评估：拒绝经理提出的删状态再初始化方案，并保留现场 goal_status 作为下一动作的唯一权威。"
}
```
