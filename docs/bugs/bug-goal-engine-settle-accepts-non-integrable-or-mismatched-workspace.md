# Bug：settle 接受不可集成提交与 Workspace 身份/Runtime rename 绕过

## 1. 现象

Task 3 候选 `a3bc2cc` 的目标回归在现网看似通过，但独立复核给出 `Ready to integrate: No`。主要表现为：

1. `goal_settle(outcome="succeeded")` 可在 executor workspace 的 HEAD 与 `baseCommit`/branch identity 不满足可集成约束时仍被接受。尤其是以下场景会绕过 `HEAD !== baseCommit` 的核心防线：
   - **ancestor**：HEAD 是 baseCommit 的祖先/早期提交。
   - **unrelated**：HEAD 与 baseCommit 无可见祖先关系。
   - **empty-only**：仅有空提交（或无实际变更）也可被当作已完成 commit 持久化。
2. 结合 C1 场景，`goal_integrate` 的后续清理会在 `empty integrate` 后误入 `disposing` 锁定状态，出现“清理卡死/释放阻塞”风险。
3. `persisted lease`、`live branch` 和运行时派生的 `Git identity` 校验不充分，真实 commit/分支错误时，`goal_settle` 常被误标记为 `EXECUTOR_COMMIT_REQUIRED`，而非可执行身份类阻断。
4. `runtime rename` 场景为：`base` 中 tracked 文件 `.pi-subagents/tracked.txt` 被 `git mv` 到 `outside/rogue.txt`，在 `git status --porcelain=v1` 中表现为 `R  .pi-subagents/tracked.txt -> outside/rogue.txt`（`outside/rogue.txt` 位于 executor worktree 内，但不在 `.pi-subagents/**` runtime 受控范围，也可能不在授权 `writePaths` 内）。当前实现按 `slice(3)` 后仅对整串前缀过滤，导致 rename 的双端点未逐一解析，整条 dirty entry 被丢弃。
5. 现有候选中的“集成防线”缺乏真实 `RED` 覆盖：原 `integration` 真实拒绝矩阵被 `settle` 测试替换，导致 `ancestor/unrelated/empty-only` 等路径没有以最小副作用先失败。

## 2. 影响

- 可集成性不足的结果会被持久化为 `succeeded`，并在后续 `goal_integrate` 阶段造成不可逆的状态阻塞（`disposing` 死锁风险）。
- `lease`/`branch`/`executorHead` 身份不一致时误入错误路径，可能销毁无关 branch，放大生产环境风险。
- 错误分类把 identity 或基础设施问题误报为 `commit required`，给出错误修复建议，放大人工误操作概率（例如尝试 raw Git 干预而非 typed 修复）。
- `runtime` 的外部重命名被当作正常工作区变更，通过后续 `goal_settle` + `goal_integrate` 可放大到资源与证据链污染。

## 3. 触发条件

1. `succeeded settle` 前提：
   - task 状态为 `dispatched`。
   - projection 存在并带 `active workspace`。
   - 持久化 lease、worktree、branch 可回放。
2. 执行 `goal_settle(..., outcome="succeeded")` 时，`executor` HEAD 与 `baseCommit` 可落入：
   - ancestor；
   - unrelated；
   - empty-only。
3. 身份错配场景：
   - persisted lease 缺失或 `goalId/taskId/attempt/baseCommit/branch/originRoot/stateRoot` 任一字段被篡改（missing/tampered）；
   - live branch 与预期分支不一致（wrong live branch）；
   - 这些 `identity mismatch` 与 runtime 变更混在一起触发被误分类。
4. runtime rename 触发：
   - 在 base 中 tracked 的 `.pi-subagents/tracked.txt` 被 `git mv` 到 `outside/rogue.txt`，在 `git status --porcelain=v1` 呈现 `R  .pi-subagents/tracked.txt -> outside/rogue.txt`。
   - 当前 `slice(3)` 前缀过滤使该双端点条目整条被丢弃，`runtime` dirty 检测误报为 clean。
## 4. 根因

### C1：`HEAD !== baseCommit` 与可集成性缺口未形成执行前阻断
- `goal_settle` 仅检查提交是否存在/工作区是否可写，而未以 `ancestor/unrelated/empty-only` 等关系约束强制执行真正可集成性。
- 集成时未将 `executorHead` 与 `baseCommit` 做 strict binding，导致空提交、祖先提交、无关提交也能进入后续集成状态机。

### C2：persisted lease 与 live 分支/Git identity 未进行联合一致性验证
- `persisted lease`、`live branch`、`originRoot/stateRoot`、`executorHead` 在 `dispatch/settle/integrate` 中存在分段校验。
- 任何一步失败常在后续入口处“默认通过”或被重分类，未形成 fail-closed 的统一 identity 门禁。

### I1：`settled HEAD` 未绑定到 exact lease identity
- settle 阶段未要求 settlement 前后的 lease identity 与当前 HEAD 之间可证明绑定。
- `wrong live branch` 时，`dispatch`/`settle` 与后续清理/集成之间可出现“已执行分支 ≠ 预期分支”但仍继续推进。

### I2：`git status --porcelain=v1` rename 双端点未结构化解析
- `R`/`C` 条目在解析时被统一 `slice(3)` 后按整条字符串前缀过滤，未拆分 `old -> new` 双端点。
- 当 `old` 位于 `.pi-subagents/**` 而 `new` 在 runtime 外（如 `outside/rogue.txt`）时，整条 dirty entry 被过滤丢弃。

### I3：runtime rename 误分类未触发准确身份障碍
- 上述失配会使 `RUNTIME_RENAME_*` 异常被合并到 `EXECUTOR_COMMIT_REQUIRED` 等通用错误，掩盖 `missing/tampered lease` 与 `wrong live branch` 这类身份错配场景。
## 5. 修复策略

1. 在 settle 前添加严格的可集成性门禁：
   - 解析 lease，读取真实当前 HEAD 与 `baseCommit`。
   - 仅允许“当前 HEAD 相对 baseCommit 可被集成”的关系，明确禁止 ancestor/unrelated/empty-only 通过。
   - 以 `stateChanged=false` 零副作用返回明确 code（含 remediation 与 requiredNextAction）。
2. 将 `settled HEAD` 与 lease identity 建立闭环绑定：
   - 在 settle 成功前后都记录并复核 `goalId/taskId/attempt/baseCommit/branch/originRoot/stateRoot/executorHead`。
   - 与 `workspace` 清单做一致性断言，不一致直接阻断并暴露人类可执行决策。
3. 建立统一 identity 审核层：
   - 在 dispatch/settle/integrate 前，复核 persisted lease 与 live branch/worktree 的一致性。
   - 将未记录或被篡改的 lease/workspace 判为 `non-orphan` 与 `orphan` 的可分支错误，而非混入 commit-required 分类。
4. 升级 runtime 重命名检测：
   - 使用 `git status --porcelain=v1 -z`（或等价结构化输出）而非依赖 `slice(3)` 的纯文本前缀过滤。
   - 对 `R`/`C` 条目分别解析 `old` 与 `new` 双端点；仅当两个端点都严格位于 `.pi-subagents/**` 时才豁免，任一端点超出则按 dirty/reject 处理。
5. 明确错误分类：
   - 将 identity/infrastructure 失败拆分成独立 code（如 `WORKSPACE_IDENTITY_MISMATCH`、`LEASE_NOT_FOUND`、`RUNTIME_RENAME_OUTSIDE_WORKSPACE`）；
   - 保留 `EXECUTOR_COMMIT_REQUIRED` 仅用于“确实存在可集成提交缺失”的场景。
6. 保持本提交为纯文档。

## 6. 验证方案

> 本次为文档-only任务，故未执行实现与测试修改。待修复实现阶段按以下真实 RED 顺序补齐：

1. **真实 Git RED（可集成性）**
   - ancestor：`HEAD` 为 `baseCommit` 祖先时，`goal_settle(succeeded)` 直接失败（`stateChanged=false`）。
   - unrelated：`HEAD` 与 `baseCommit` 无交集时失败。
   - empty-only：仅有空提交时失败，不允许进入 `goal_integrate`。
2. **真实 Git RED（branch/identity）**
   - wrong live branch：lease branch 与实际 branch 不一致，`goal_settle`/`goal_integrate` 不得走成功分支。
   - missing/tampered lease：任一关键字段缺失或篡改，返回身份类可恢复 error。
3. **真实 Git RED（runtime path）**
   - runtime rename 的双向矩阵：
     - `runtime->outside`（如 `.pi-subagents/tracked.txt -> outside/rogue.txt`）
     - `outside->runtime`（如 `outside/tracked.txt -> .pi-subagents/rogue.txt`）
   其中 `outside` 含义为 runtime 范围外（可能不在授权 `writePaths`），并不等于文件系统 workspace 外。
   - 两类场景均应在结构化解析下被识别，不应误判为 clean。
4. **真实 Git RED（blocked/failed 幂等）**
   - 触发 blocked/failed 时，验证与事件、registry、workspace 的一致性；错误分类不允许继续执行 disposed。
   - 尤其验证 empty-only 进入失败后，`disposing` 与 release 分支可回到可恢复状态，不会锁死。
5. **真实 Git RED（预算 + integration defense-in-depth）**
   - 对 dispatch/settle 派生 contract、derived budget 执行真实边界测试（32-item/4096-byte）；在触发 budget 失败时绝不落地事件/副作用。
   - 保留独立的 integration defense 测试：`goal_integrate` 在上述不合法 HEAD/identity 条件下应 fail-closed，不允许 settle 替代集成门禁。

## 备注

- 以上为纯文档记录（docs-only）。
- 实现必须保持 TDD/RED→GREEN 节奏：先补全上述真实 RED，再进行 GREEN。
- 变更目标仅为此 Bug 文档，不影响生产实现与测试。