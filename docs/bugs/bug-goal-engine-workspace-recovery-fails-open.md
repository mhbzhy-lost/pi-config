# Bug: Goal Engine 工作区恢复 fail-open 与多提交部分应用缺陷

## 现象
恢复链路在多类异常场景下未 fail-closed，出现“继续执行”而非“终止并重试/告警”的行为，导致状态错误时仍进入工作区恢复流程：

1. **merge-base 非 status1 被误报为未集成 false**：`git merge-base` 的返回码非 `1`（含参数错误、对象缺失等异常返回）未与异常语义区分，被当作“未集成 false”处理，后续可能继续走重试应用路径。
2. **resource branch 检查混淆分支不存在与命令异常**：当前实现未明确区分资源分支正常不存在与 `origin` 检查命令失败；前者可视为正常未集成，后者才应立即抛错并终止恢复。
3. **NUL 边界与 writePaths 校验对齐不足**：`changedFile` 与 `writePath` 同时含 NUL 字符（`\u0000`/`%00`）时，`writePaths` 边界断言可能接受该输入；文档不应据此声称必然进入 Git 流程。
4. **git cherry 空输出语义不唯一**：普通 merge 会使 executor commit 仅经第二父提交可达，此时 ancestry fallback 会误报 cherry-pick 已集成；但 cherry-pick 若在同一秒复现出完全相同的 commit SHA，`git cherry` 也会空输出，此时无条件返回 `false` 又会误报未集成。
5. **Git 集成失败遗留部分状态**：两个 executor commits 逐个 cherry-pick 时，若第二个冲突，第一提交可能残留并使 `origin` 出现部分变更；merge 冲突也会遗留未清理的合并状态。后续重试可能失败并带来不幂等后果，不应直接断言必然重复提交。

## 影响
- 恢复执行未满足 fail-closed 语义，可能在环境已损坏/状态异常时继续变更工作区。
- origin 可能残留部分 commit 或冲突状态，导致 workspace 与上游状态偏移并破坏重试幂等性。
- 日志与审计链路出现“执行看似成功但未满足一致性约束”的假象，降低故障恢复可验证性。

## 稳定复现
1. **merge-base 非 status1 被误报为未集成**
   - 构造恢复场景使 `git merge-base --is-ancestor` 返回非 `1` 的异常退出码。
   - 复现：该异常路径被当作未集成 false 处理，后续可进入重试应用。
2. **resource 分支检查缺失与异常未区分**
   - 分支正常不存在（未命中）与 `origin` 检查命令失败（网络/权限/执行错误）混在一起处理。
   - 复现：若将后者与前者混淆，可能把异常场景按普通缺失继续处理而未 fail-closed。
3. **NUL writePaths 边界断言**
   - 向恢复入口提交 `changedFile` 与 `writePath` 同时含 `\u0000` 的参数。
   - 复现：`writePaths` 边界断言会接受该输入；无法从该条件直接推出一定进入 Git 子命令或一定被拒绝。
4. **git cherry 空输出歧义**
   - 分别让 origin 通过 `--no-ff` merge 和第一父链直接包含 executorHead；两者的 `git cherry` 均可无输出。
   - 复现：前者必须返回 `false`，后者代表 commit identity 已直接落入 origin，必须返回 `true`；只用普通 ancestry 或无条件 false 都会误判。
5. **Git 集成失败后的部分状态与重试**
   - cherry-pick 使用两次 executor 提交（第一可应用、第二冲突）；merge 使用与 origin 冲突的 executor 提交。
   - 复现：cherry-pick 第二次冲突后第一提交残留；merge 冲突后保留未合并状态。两条路径的 origin 均不再等于操作前状态，后续重试可能不幂等。

## 根因
1. 恢复链路对 git 子进程返回码与输出缺少语义映射，核心判定使用“宽松真值”导致异常码和异常路径被视为可继续。
2. 异常处理采用 broad catch/continuation，未执行 fail-closed 回路。
3. 参数校验缺失，未在边界输入层拒绝 NUL，允许危险字节进入仓库路径相关操作。
4. `git cherry` 空输出没有结合 origin 第一父链判定，无法区分普通 merge 的第二父可达与 commit identity 直接落入 origin。
5. 多 commit 恢复采用逐个 cherry-pick，且 cherry-pick/merge 失败时都未统一 abort，导致“部分应用或冲突状态后继续重试”的状态泄漏。

## 促成因素
- 缺少统一恢复错误分类模型：未将 `merge-base`、`resource check`、`git cherry`、`cherry-pick` 的异常按“致命/可重试/可忽略”划分。
- 现有逻辑优先追求继续执行（fail-open），而非优先返回明确失败（fail-closed）。
- 现网已出现的 `NUL` 与非标准退出码场景未被纳入回归用例。
- 缺少 Git 集成原子恢复测试，以及 `git cherry-pick`/`git merge` 失败时必须 abort 的回滚验证。

## 修复与验证策略
### 修复策略
- **只把 `merge-base` 的 `status === 1` 当作 `false`**：将非 `1` 返回码视为异常路径，立即中断恢复。
- **资源分支检查语义区分**：把资源分支正常不存在视作未集成；将 `origin` 检查命令失败（超时、权限、网络等）归为异常并 fail-closed，不再吞错继续。
- **拒绝 NUL**：恢复输入层对路径/分支/引用字符串进行 NUL 字符校验，含 NUL 一律拒绝并报错。
- **`git cherry` 空输出检查第一父链**：空输出时仅当 executorHead 位于 origin 的第一父链才返回 `true`；普通 merge 仅经第二父可达时返回 `false`。
- **Git 集成失败时 abort**：使用单次多提交 cherry-pick，失败立即 `cherry-pick --abort`；merge 失败立即 `merge --abort`，避免部分提交或冲突状态泄漏到重试。

### 验证策略
1. 增加覆盖上述 5 类场景的回归用例（不在本次提交中实现），逐条验证恢复在异常场景下返回失败。
2. 复测主链路：首次恢复成功后，再次触发同一异常恢复场景应被明确拒绝（而非继续执行）。
3. 复测 cherry-pick 与 merge 冲突：失败后 `origin` HEAD、工作树和索引均恢复到操作前状态；重试应从一致状态开始。
4. 通过变更后静态审查确认不存在 `git` 子进程结果默认穿透、路径 NUL 未过滤，以及把 empty-output 的普通 ancestry 当作 cherry-pick 成功的回路。