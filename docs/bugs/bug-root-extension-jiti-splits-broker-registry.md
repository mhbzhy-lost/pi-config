# Bug: Root 扩展的 broker registry 被 Jiti 模块实例隔离

## 症状

真实Pi以多个显式extension路径加载`subagent-runtime.ts`与`plan-launcher.ts`时，runtime的`session_start`已成功创建Root broker、设置`PI_ROOT_SUBAGENT_BROKER_ENABLED=1`并注册`subagent`工具，但Launcher调用`requireRootBroker(pi)`仍稳定报`Root subagent broker is unavailable`。

## 影响

持久化Root session中的`plan_run`无法启动任何Plan Runner，真实flat runtime Harness在进入Plan Runner fixture前就失败。单元测试和从同一Jiti实例加载runtime/registry的测试仍可通过，因此生产扩展加载边界被隐藏。

## 复现

1. 启动真实Pi RPC持久化session，使用`--no-extensions`后分别通过`-e`加载`subagent-runtime.ts`、`plan-launcher.ts`和一个registry probe extension。
2. 清除继承的`PI_SUBAGENT_*`与broker marker。
3. Probe的`session_start`观察到marker为`1`、Root socket已创建、`subagent`已注册。
4. Probe从自己的extension模块图导入`root-broker-registry.ts`并调用`requireRootBroker(pi)`，得到`Root subagent broker is unavailable`；Launcher的`plan_run`得到同一错误。

## 根因

`root-broker-registry.ts`把broker保存在模块级`WeakMap`。Pi为每个显式TypeScript extension创建独立Jiti模块图，同一源码在runtime、Launcher和probe中形成不同模块实例，也形成不同`WeakMap`。`pi`对象相同，但写入和读取发生在不同registry实例中。

## 修复

用`Symbol.for`标识的进程级共享slot保存唯一`WeakMap<pi, broker>`，让不同Jiti模块实例解析到同一registry，同时继续以`pi`对象隔离Root session。保留现有bind重复检查、exact broker unbind和失败回滚语义，不把broker暴露给模型或跨进程。

## 验证

新增真实Pi persisted-session integration RED：分别加载runtime与probe extension，断言probe能读取同一broker、broker identity等于`getSessionId()`且不等于`getSessionFile()`，marker为`1`，stderr/RPC中无extension error，并在EOF后清理socket。保留registry、Root broker、runtime membrane与compat回归；随后恢复flat Harness并确认失败点推进到旧Plan Runner standalone guard。
