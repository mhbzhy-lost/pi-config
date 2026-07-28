# Bug：Plan Runner 将 Submodule Git 元数据目录误判为仓库根

## 1. 现象

从`plugins/crash_fix_v2`这个真实Git submodule启动正式`plan_run`后，`plan_open`成功，
但`plan_continue`报`fatal: Needed a single revision`。运行
`fb514421-7131-4384-8982-6867205cc2a8`最终为`blocked`，三个Task均保持`pending`，
没有创建Attempt。

## 2. 影响范围

影响从被父仓吸收Git目录的submodule启动的所有Plan。Plan状态、Attention、result和
control还会写入父仓`.git/modules`下的错误目录，使Root handle声明的`statusPath`与
Plan领域实际状态分裂。普通`.git`目录仓库不受影响，因此既有Harness未暴露问题。

## 3. 复现条件

1. 当前业务仓是Git submodule，工作树中的`.git`是指向父仓Git元数据的文件。
2. launcher在该仓创建`var/plan-worktrees/<planId>`并启动Standalone Host。
3. Plan Runner执行`git rev-parse --path-format=absolute --git-common-dir`。
4. 代码对返回的`.git/modules/<submodule>`执行`path.dirname()`并将结果当作仓库根。
5. coordinator在错误目录解析`<baseCommit>^{commit}`，稳定失败。

## 4. 根因

launcher创建workspace时已经持有权威`originRoot`和`stateRoot`，但Host启动契约没有传递
这两个字段。Plan Runner只能从`git-common-dir`反向重建业务路径；`path.dirname()`只对
`/repo/.git`这种普通布局成立，对submodule会得到父级Git metadata目录。同时control
错误地使用`binding.originRoot`代替`stateRoot`，放大了状态路径分裂。

## 5. 修复策略

由launcher通过Standalone Host环境带外传递权威`originRoot`和`stateRoot`，不把它们交给
模型在`plan_open`参数中声明。绑定阶段验证：业务根是Git top-level、业务根与Plan
worktree共享同一`git-common-dir`、Plan worktree严格位于
`<stateRoot>/var/plan-worktrees/<planId>`。所有status、Attention、result和control统一使用
验证后的`stateRoot`；删除`dirname(git-common-dir)`推导。

## 6. 回归与预防

- RED：使用真实`git submodule add`和被吸收Git目录创建Plan worktree；旧实现必须把
  `originRoot`解析到`.git/modules`并在首次dispatch前失败。
- GREEN：同一fixture能完成绑定、在submodule业务根写status并成功分配Attempt。
- Fencing：伪造`originRoot`、`stateRoot`或跨Git common-dir绑定必须fail closed。
- 传播：launcher输入、Host环境和生产Plan Runner entry必须完整携带两个权威根。
- 回归：运行Plan依赖、Host、launcher、Capsule定向测试及完整`npm test`；再执行真实
  submodule smoke，确认structured status只出现在handle声明路径。

## 7. 验证证据

- RED：真实submodule fixture得到的`originRoot`是父仓`.git/modules/plugins`，与业务根
  `plugins/crash_fix_v2`不相等，失败形态与生产运行一致。
- GREEN：Plan依赖测试`13/13`；Host与launcher测试`23/23`；Capsule测试`24/24`。
- 完整标准门禁`npm test`通过`457/457`，Plan相关测试没有失败。
- 集成：Plan Capsule`2/2`、Subagents`3/3`、Pi runtime`1/1`、Doctor通过。
- 真实验收：确定性Harness在父仓真实submodule中达到`validated`，
  `validatedHead=8b58da97698d217c555f226ac06c396e0290fb13`，并完成并行Attempt集成与清理。
