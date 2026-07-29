# Bug: Child ownership guard 路径错误且 Plan Runner 未纳入 lifecycle

## 症状
Executor frontmatter声明`subagentOnlyExtensions: ../child-extensions/root-session-owner.ts`。上游child从执行cwd原样解析该路径，得到仓库外`/Users/leshi.zhy/child-extensions/root-session-owner.ts`，文件不存在。Plan Runner则直接`void installRootSessionOwner(...)`，未等待startup结果、未保存handle，也未在session shutdown dispose；并与typed dispatch共用同一个broker client。

## 影响
Executor实际不会加载Root ownership guard，Root关闭后可能成为orphan。Plan Runner owner subscribe失败会形成未归属的异步rejection；正常shutdown不会释放subscription，共享client的任何dispose还会同时破坏Executor dispatch RPC。Task 3声称的Plan Runner/Executor共同Root归属没有真实argv证据。

## 复现
用已安装上游`resolvePiLaunchToolPlan`传入Executor当前`subagentOnlyExtensions`与仓库cwd，`extensionArgs`保留`../child-extensions/root-session-owner.ts`，`path.resolve`结果位于仓库外且`access`失败；`fanoutAuthorized=false`。检查Task 3提交可见`test/pi-subagents-compat.test.mjs`未修改，也没有触发项目`plan_executor_supervisor`后断言broker调用/native Root supervisor零调用的测试。

## 根因
实现未执行计划要求的真实argv probe，误把extension path当作相对agent文件而非child cwd解析。Plan Runner entry把ownership guard当作普通async helper调用，而不是Pi session lifecycle extension；为了复用又注入业务RPC，混淆了dispatch client与ownership subscription的独立资源所有权。

## 修复
Executor使用child cwd可解析的owner extension路径，并以真实`resolvePiLaunchToolPlan`和`buildPiArgs`固定argv/env。Plan Runner通过session_start/session_shutdown lifecycle安装独立ownership client，等待startup、保存并幂等dispose handle，不与typed dispatch RPC共享。增加root-owned adapter测试，直接证明两个项目tools可激活、custom supervisor只调用broker fake、native Root supervisor调用数为零。

## 验证
运行Task 3三组聚焦测试和protocol/runtime/dispatch扩展回归。断言Plan Runner与Executor argv包含owner extension、不含fanout-child，`fanoutAuthorized=false`、fanout env为`0`、parent route为空且项目代码无parent env mutation；缺env/缺grant/remote EOF/local dispose路径全部通过。
