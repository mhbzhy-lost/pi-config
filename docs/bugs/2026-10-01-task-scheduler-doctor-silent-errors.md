# task-scheduler 恢复异常与 doctor 文件探测误判

## 现象及首个偏离点

- A1：`pi/extensions/task-scheduler.ts:13-17` 直接求值 `recoverySource()` 时的同步异常逸出初始化；Promise rejection（source 异步拒绝、`consumeRecoveryOutcome` 校验失败、`onRecoveryOutcome` 抛错）落入 `.catch(() => undefined)`，无 callback、无日志，恢复结果不可见。首个偏离点是 `task-scheduler.ts:13` 的同步求值及 `:17` 的丢错 catch。
- C1：`scripts/doctor.ts:76-81` 的 `readIfExists` 将任何 readFile 错（包含 EPERM）变为 null；`:287-288` 因此误报 `/var/` 未忽略。`:262-307` 的 legacy 路径 access 的空 catch 将 EPERM 误作路径不存在，漏报遗留自动发现入口或运行时代码。

## 生成调用链及数据来源分类

- A1：Host 加载 `pi/extensions/task-scheduler.ts` → `registerTaskSchedulerAdapter(pi)` → 注入的 public bridge `recoverySource()` → `src/task-scheduler/adapter.ts:24-37` `consumeRecoveryOutcome(outcome)` → `bridge.onRecoveryOutcome(result)`。bridge 回调是合法 public 扩展入口；有效恢复结果亦可遇到调用方回调失败。无须虚构损坏的 projection 或绕开权威 Store；此处修的是回调失败被吞的诊断而不是为非法 outcome 增加兼容。分类 1：可由预期 production 桥接调用产生的异常处理缺陷；非法 outcome 仍维持原校验拒绝。
- C1：CLI `scripts/doctor.ts` → `inspectConfiguration(repoRoot)` → `readIfExists(.gitignore)` / `access(repoRoot/legacy)` → Node FS 权限拒绝（EPERM/EACCES）；文件内容来自真实仓库、目录项由真实文件系统提供，不是手工拼造事件。分类 1：合法运行环境的文件系统读/探测失败；测试将用 OS 文件系统探测所需条件，不引入 production 兼容。

## 影响面与最小修复边界

A1 丢掉失败原因且无法观察恢复投影；仅发独立、含原始 error/cause 的非阻断诊断，不改 outcome、不改 fail-closed 校验和异步调度。C1 仅 ENOENT 代表不存在；其他读取/探测失败报告 unreadable 并携原错误 cause，不把权限失败误报为缺少 ignore 或 legacy 不存在，不改变 doctor 的实际检测目标。审计 `var/upgrade/silent-swallow-audit.md` 的 A1/C1 均判为真缺陷、fail-closed 否；遵循 `var/upgrade/silent-swallow-decisions.md` 的统一原则，不处理其它审计项。
