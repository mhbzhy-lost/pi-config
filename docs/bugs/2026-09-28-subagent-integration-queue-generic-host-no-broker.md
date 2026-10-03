# generic Host 注入 integration-queue 缺少 Root Broker 时失败

## 现场与 RED

- 入口：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1515` 的 `registerRequiredChildExtensions` 将 `integration-queue.ts` 作为 required child extension 注入所有 Host，包括无 Root Broker 的 generic 顶层 RPC 场景。
- 首个偏离：`packages/pi-subagents-enhanced/child-extensions/integration-queue.ts:122` 在 `PI_SUBAGENT_ORCHESTRATOR_SESSION_ID` 或 `PI_SUBAGENT_RUN_ID` 缺失时直接抛出 `subagent integration requires a trusted Root Broker session`。
- RED：修复前 `PI_REAL_BIN=$HOME/pi-config-upgrade/node_modules/.bin/pi ... npm run test:subagents` 为 2/4；两项 generic 顶层 RPC 测试失败，分别表现为 `process-terminal proof was not observed` 与 `COMPAT_PARENT_PENDING_MISSING`，子进程加载 required `integration-queue` 时记录上述 broker 信任错误。

## 归因分类

这是 production 缺陷。required-child 注入是合法 Host 入口，generic 顶层 RPC 是合法运行模式；该场景本来没有 coding broker 会话，扩展不应把“无 broker”当作加载失败。coding broker 场景则通过可信的 `PI_SUBAGENT_ORCHESTRATOR_SESSION_ID` 与 `PI_SUBAGENT_RUN_ID` 继续完整路径。

## 最小处置

选择在 child extension 入口早返回 no-op，而不是改变 Host 注入条件：注入清单仍保持统一且不可被 generic 子进程绕过，只有真正执行 integration tool 时才要求 trusted broker。无可信会话时仅写入诊断 stderr 并返回可 dispose 对象，不注册 tool、不监听生命周期、不产生集成活动；带 broker 的 coding child 保持既有完整安全语义。
