# Worktree 工具面自解释改进实现计划（修订版）

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**目标：** 使 agent 在真实使用中自然理解并正确使用 worktree 管理——不需要预先读完 skill 全文就能走通 dispatch→commit→integrate→release 链路。

**架构：** 四层改进。T1a/T1b 在 spawn 结果文本中主动提示 workspace 处置义务（coding + generic 双路径）；T2 在 `subagent` tool description 嵌入 worktree 决策指引（双路径）；T3 将 `subagent_worktree` tool description 从操作手册改为场景导向（修正 preserve/release 语义）；T4 统一 completion-reminder 与新增文案的术语。T5 回归 + T6 真实模型验证。

**技术栈：** TypeScript、`node:test`、pi-subagents-enhanced package。

## 全局约束

- 严格 TDD：先断言级 RED，再最小 GREEN。
- 只修改声明 WritePaths；不触碰 protected paths/live state。
- Tool description 使用英文（与既有 tool description 一致）；skill/计划使用中文。
- 不改变任何工具的参数 schema 或行为语义——只改文本。
- preserve 语义统一表述："integrate or discard to finish, or preserve temporarily and later release"——不得将 preserve 称为 terminal disposition。
- completion-reminder 的文案与新增提示使用一致的生命周期术语。
- 不修改 coding dispatch schema 的必填字段（schema 简化是独立讨论，不混入本计划）。

## DAG

```text
T1a (coding spawn 提示) ──> T5 (回归)
T1b (generic spawn 提示) ──> T5
T2 (subagent description) ──> T5
T3 (workspace tool description) ──> T5
T4 (completion-reminder 统一) ──> T5
T5 ──> T6 (真实模型验证)
```

T1a/T1b 共享 `extension-ts` 资源须串行；T2 同样共享 `extension-ts`。T3/T4 独立文件可并行。T5 消费全部。T6 是独立验证节点。

## Waves

- Wave 1：T1a → T1b → T2（`extension-ts` 串行）；T3、T4（可并行）
- Wave 2：T5（等待全部）
- Wave 3：T6（等待 T5）

**关键路径：** T1a → T1b → T2 → T5 → T6。

---

### Task T1a：coding dispatch spawn 结果提示 workspace 处置义务

**Deps：** `none`

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `test/subagent-runtime-membrane.test.mjs`

**Resources：** `extension-ts`

**Files：**
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`（`executeCoding` 返回文本，约 `:871-880`）
- Modify：`test/subagent-runtime-membrane.test.mjs`

**行为规格：**

当 `workspace` 存在时，spawn 结果文本末尾追加：

```text
Workspace {workspaceId} allocated (state: {state}). After the run completes: subagent_worktree({action:"status",workspace_id:"{workspaceId}"}) to check dispositions; then integrate or discard to finish, or preserve temporarily and later release.
```

不含 token/lease/敏感路径。`worktree: false` 时文本不变。

**验收标准：**

- [ ] RED：新断言 `assert.match(result.content[0].text, /Workspace .* allocated/)` 在当前代码下失败
- [ ] GREEN：实现后通过
- [ ] `worktree: false` 时 `assert.doesNotMatch(result.content[0].text, /Workspace/)` 通过
- [ ] 不含 `action_token`、`lease`、绝对路径

---

### Task T1b：generic dispatch spawn 结果提示

**Deps：** `T1a`（理由：同一文件，串行修改）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `test/subagent-runtime-membrane.test.mjs`

**Resources：** `extension-ts`

**Files：** 同 T1a（`executeGeneric` 返回文本，约 `:990-1000`）

**行为规格：**

与 T1a 相同格式的提示追加到 `executeGeneric` 返回文本。

**验收标准：**

- [ ] RED/GREEN 同 T1a 模式，测试 generic dispatch with `worktree: true`
- [ ] generic `worktree: false` 不含提示

---

### Task T2：`subagent` tool description 嵌入 worktree 决策指引

**Deps：** `T1b`（理由：共享 `extension-ts` 资源串行）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `test/subagent-runtime-membrane.test.mjs`

**Resources：** `extension-ts`

**Files：**
- Modify：`TYPED_SUBAGENT_DESCRIPTION` 常量（约 `:153-160`）
- Modify：`test/subagent-runtime-membrane.test.mjs`

**行为规格：**

在 description 末尾追加：

```text
Worktree guidance: For coding dispatches use execution.worktree=true, and for generic dispatches use worktree=true, when concurrent children may write the same repository or need isolated baselines. Use worktree=false for read-only tasks or when the user explicitly forbids worktrees. When worktree=true, the response includes a workspace_id; after completion use subagent_worktree({action:"status"}) then integrate or discard to finish, or preserve temporarily and later release.
```

**验收标准：**

- [ ] RED：`assert.match(TYPED_SUBAGENT_DESCRIPTION, /worktree=true.*concurrent/i)` 失败
- [ ] GREEN：通过
- [ ] 同时含 `execution.worktree` 和 generic `worktree` 两种路径
- [ ] 含 "explicitly forbids" 边界条件

---

### Task T3：`subagent_worktree` tool description 场景导向重写

**Deps：** `none`

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/tool.ts`
- `test/subagent-workspace-tool.test.mjs`

**Resources：** `none`

**Files：**
- Modify：`SUBAGENT_WORKSPACE_DESCRIPTION`（约 `:28-33`）
- Modify：`test/subagent-workspace-tool.test.mjs`

**行为规格：**

开头改为：

```text
Use this when a subagent dispatch with worktree=true returned a workspace_id and the run has completed. Every allocated workspace must be explicitly handled: integrate or discard it when finished, or preserve it temporarily and later release it. Start with action:"status" to see allowed_dispositions and any integrate_blocked_reasons. States and actions: 保留现有 MANAGED_WORKSPACE_STATES 和 allowedActionsFor(state) 动态拼接，仅替换前置说明文本
```

**验收标准：**

- [ ] RED：`assert.match(SUBAGENT_WORKSPACE_DESCRIPTION, /workspace_id.*completed/i)` 失败
- [ ] GREEN：通过
- [ ] `preserve` 与 `release` 的关系表述正确（不将 preserve 称为 terminal disposition）
- [ ] 测试验证 tool instance 的 description（不只测常量）

---

### Task T4：completion-reminder 术语统一

**Deps：** `none`

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/completion-reminder.ts`
- `test/subagent-workspace-completion-reminder.test.mjs`

**Resources：** `none`

**Files：**
- Modify：`completion-reminder.ts` 的 sendMessage 内容（约 `:53-55`）
- Modify：`test/subagent-workspace-completion-reminder.test.mjs`

**行为规格：**

现有 reminder 文案更新为与 T1a/T1b/T3 一致的术语：

```text
Subagent workspace awaiting disposition: {workspaceId}. Call subagent_worktree({action:"status",workspace_id:"{workspaceId}"}), then integrate or discard to finish, or preserve temporarily and later release.
```

**验收标准：**

- [ ] RED：更新断言匹配新术语后失败
- [ ] GREEN：通过
- [ ] 术语与 T1a/T1b/T3 一致（integrate/discard/preserve→release）

---

### Task T5：受影响范围回归

**Deps：** `T1a`、`T1b`、`T2`、`T3`、`T4`

**WritePaths：** `none`（只读回归）

**Resources：** `full-test-suite`

**验收标准：**

- [ ] `node --test test/subagent-runtime-membrane.test.mjs test/subagent-workspace-tool.test.mjs test/subagent-workspace-completion-reminder.test.mjs` 全 PASS
- [ ] `npm run typecheck:subagents-enhanced` PASS
- [ ] `PI_REAL_BIN=/opt/homebrew/bin/pi node --test --test-name-pattern='project typed worktree commit' test/pi-subagents-project-workflow.integration.mjs` PASS
- [ ] `git diff --check` PASS

---

### Task T6：真实模型行为验证

**Deps：** `T5`

**WritePaths：** `none`（观察验证，不改代码）

**Resources：** `pi-real-lane`

**行为规格：**

使用真实 Pi Host + 真实模型（非 deterministic provider），在临时 Git repo 中构造并发写入场景，让主 Agent 自主决策是否使用 worktree：

1. 给主 Agent 一个任务："同时派发两个子任务，两个子任务都需要修改 README.md 的不同部分"
2. 主 Agent 使用真实模型，能读到 tool description 和 spawn 结果中的 workspace 提示
3. 观察主 Agent 的 `subagent` 调用参数：是否选择 `execution.worktree: true`（coding）或 `worktree: true`（generic）
4. 如果选择 true：观察是否在完成后调用 `subagent_worktree({action:"status"})` 并正确处置
5. 如果选择 false：记录 transcript 中主 Agent 的可见理由

**验证报告内容：**
- 主 Agent 的完整 tool call 序列（脱敏：不含 runId/token/绝对路径）
- 每次 dispatch 的 worktree 参数选择
- 是否出现 subagent_worktree 调用
- 处置动作类型和结果
- 选择 false 时的可见理由

**环境前提：** PI_REAL_BIN 可用、真实模型 API 可用；环境不可用时标记 environment-blocked。

**验收标准：**

- [ ] 主 Agent 在并发写入场景下选择了 worktree=true（或记录了符合指引的 false 理由）
- [ ] 如果 worktree=true：主 Agent 调用了 subagent_worktree status 并完成处置
- [ ] 输出脱敏验证报告，明确标注这是真实模型行为验证
- [ ] 若模型选择 false 且无合理理由，说明文本引导不足，需迭代 description

**注意：** 这是本计划的最终验收出口。deterministic provider 不能替代此验证。

---

## 计划自检

1. **规格覆盖：**coding+generic 双路径（T1a/T1b）、decision description（T2）、workspace tool 场景导向（T3）、reminder 统一（T4）、回归（T5）、真实验证（T6）。✅
2. **占位扫描：**无。✅
3. **preserve 语义：**所有文案统一为"integrate or discard to finish, or preserve temporarily and later release"。✅
4. **DAG 审核：**T1a/T1b/T2 共享 extension-ts 串行；T3/T4 独立并行；T5/T6 串行。✅
