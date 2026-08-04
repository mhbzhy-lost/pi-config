# Bug：Goal Engine 无法派发 existing-tests 任务

## 1. 现象

TokenRec 在新 Pi 会话中成功执行 `goal_init`，为 `task1-skeleton` 持久化 `workflow: "existing-tests"`。workspace 已具备 Git HEAD 后调用 `goal_dispatch`，工具仍立即失败：

```text
workflow.reason is required when mode is existing-tests
```

真实会话证据：

```text
/Users/mhbzhy/pi-config/var/sessions/2026-08-04T13-15-14-158Z_019fcce9-fb6e-7ed2-a823-32b520e22127.jsonl
```

对应调用与错误位于会话记录 152–153。Goal projection 保持 version 1，任务仍为 pending、attempts 为 0、workspace 为 null，失败未追加 dispatch 事件，可在修复后安全重试。

## 2. 影响

所有通过公开 `goal_init` schema 合法创建的 `existing-tests` 任务都无法编译成 `dispatch-ir.v1`，因此不能分配 Executor。DAG 一旦以前置任务采用该 workflow，所有下游任务都会永久阻塞；`goal_amend` 又不能补写 workflow reason，用户没有合法恢复路径。

## 3. 稳定复现

1. 创建一个具有 Git HEAD 的临时仓库。
2. 调用 `goal_init`，任务设置 `workflow: "existing-tests"`，并提供非空 writePaths 与 acceptance。
3. 调用 `goal_dispatch`。
4. 观察 contract 编译报 `workflow.reason is required when mode is existing-tests`，任务仍为 pending。

也可直接把 projection 中任一 pending task 的 workflow 设为 `existing-tests` 后调用 `compileTaskContract()`，当前实现稳定抛出同一错误。

## 4. 根因

`scripts/lib/goal-engine/dispatch.mjs` 只为 `docs-only` 构造带 reason 的 workflow：

```javascript
const workflow = workflowMode === "docs-only"
  ? { mode: workflowMode, reason: "Documentation-only task produces a review or report artifact." }
  : { mode: workflowMode };
```

但 `scripts/lib/goal-engine/dispatch-ir.mjs` 明确要求 `existing-tests` 与 `docs-only` 都必须有非空 `workflow.reason`，仅 `tdd` 禁止 reason。两个模块的契约不一致，使合法 Goal 在 dispatch 阶段必然失败。

## 5. 促成因素

1. 现有单元测试只覆盖 `tdd` 与 `docs-only`，遗漏公开 schema 中的第三种 workflow。
2. Extension 集成测试只验证 docs-only reason，没有通过真实 `goal_dispatch` 覆盖 existing-tests。
3. `goal_init` 只保存 workflow mode 字符串，因此 dispatch 编译器必须为豁免模式生成合法、可审计的 reason。
4. contract 编译发生在 worktree 分配后，虽然当前清理逻辑避免了资源泄漏，但错误直到执行阶段才暴露。

## 6. 修复与验证策略

严格执行 TDD：

1. 先增加 RED，要求 `compileTaskContract()` 为 existing-tests 输出非空 reason，而 tdd 继续不含 reason。
2. 增加真实 Goal Extension RED：初始化 existing-tests task 后，`goal_dispatch` 应成功返回 contract 和 workspace，而不是走清理失败路径。
3. 最小修复 workflow 编译映射：仅为 `existing-tests` 增加明确 reason，保持 tdd/docs-only、公开 schema、事件格式及历史 projection 不变。
4. 验证原 TokenRec Goal 无需修改事件或 projection 即可在 reload 后重试派发。
5. 重跑目标测试、全部 Goal Engine 回归、Doctor 与真实 Pi Host ABI 探针。

验收命令：

```bash
node --test test/goal-engine-dispatch.test.mjs test/goal-engine-extension.test.mjs
node --test test/goal-engine-*.test.mjs
npm run doctor
```
