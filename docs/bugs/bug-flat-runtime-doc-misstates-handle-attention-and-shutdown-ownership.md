# Bug：Flat runtime 文档误述 handle、Attention 与 shutdown ownership

## 1. 现象

提交 `af75468` 新增的 flat runtime 文档把 `root-session-owner.ts` 写成保存 session-local v4 handle 的 owner，把 Plan Capsule 写成不调用 `subagent`，并把 Executor 的 Attention 写成直接向当前 Root 请求。两份文档还把 Root shutdown 写成对 Executor 使用 `interrupt` 后即可停止 Plan Runner。

## 2. 影响

这些说法会让维护者把持久化、派发、Attention 和关闭控制接到错误的边界：handle 可能不再写入当前 Root session branch；Plan Runner 可能绕过项目 `subagent` 工具授权；Attention 可能越过 owning Plan Runner；关闭时则可能在没有官方 terminal proof 的情况下释放 broker transport。文档因此不能作为 flat runtime 的实现、审查和故障恢复依据。

## 3. 根因

`af75468` 从 Standalone Host 迁移到 Root broker 时，文档沿用了旧链路的概括，没有逐项对照新实现中的 owner：Launcher 的 `pi.appendEntry(HANDLE_TYPE, handle)`、Capsule 的一次性 `subagent` 授权、broker 的 ownership routing，以及 `RootBrokerServer` 的 ordered drain 和 `upstream.stop`。

## 4. 触发条件

在 `af75468` 之后阅读 `docs/pi-plan-execution-capsule.md` 或 `docs/architecture/plan-runner-flat-runtime.md`，并按其中描述实现或审查以下任一流程时触发：Root session 恢复 handle、Plan Runner 派发 Executor、Executor 提出 native supervisor request，或 Root session 关闭。

## 5. 未被发现原因

迁移验证覆盖了 doctor、audit 与运行时边界，却没有对两份现行文档逐条核对 Launcher、Capsule、child adapter、broker 和 shutdown 代码的 ownership。文本审查也没有把 `interrupt` 与 ordered drain 的 `stop` 加官方 terminal proof 区分开。

## 6. 修复与验证

先保留本记录作为独立提交，再修正 Capsule 和 flat runtime 架构文档：Launcher 将 v4 handle 写入当前 Root session branch，`root-session-owner.ts` 只订阅 child ownership EOF/`root.closing` 并终止 child；Plan Runner 原样调用项目 `subagent` 工具，Capsule 只做一次性授权，child adapter 经 Root broker 调用本地 `pi-subagents` RPC；Executor native supervisor request 只经 broker 路由给 owning Plan Runner，持久化、Root Launcher projection 通知、Main 的 durable command 与 Plan Runner 的 fenced `plan_executor_supervisor` reply 各自分层。关闭改为停止新派发、对 Executors 请求 `stop` 并等待官方 terminal proof、对 Plan Runner 请求 `stop` 并等待 proof，最后关闭 broker transport/dispose upstream。

验证执行 `node --test test/doctor.test.mjs test/plan-runtime-migration.test.mjs`、`node scripts/doctor.mjs`，以 `rg` 检查修正文案，以 `git diff --check` 检查文档空白；提交后核对两个提交的文件边界并确认 index 为空。
