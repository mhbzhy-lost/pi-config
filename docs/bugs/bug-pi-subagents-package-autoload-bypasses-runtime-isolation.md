# Bug：pi-subagents package 自动加载绕过主 Agent 隔离边界

## 1. 现象

项目原本通过 `subagents:rpc:v1` 调用 pi-subagents，希望只把它作为 child runtime；但交互式主 Agent 仍能看到并直接调用原生 `subagent`、`subagent_wait` 等工具，模型上下文中还包含 upstream 的 chain、parallel、fanout、管理和安全方法论描述。

## 2. 影响

主 Agent 可以绕过项目自有的结构化派发合同，继续用自由 `task` 字符串启动 executor/spark。Upstream 工具描述随版本升级直接改变主 Agent 的行为和 prompt 成本，项目无法声明自己拥有稳定的 delegation API。

## 3. 稳定复现

`pi/settings.json` 以字符串 package 形式声明 `npm:pi-subagents@0.37.0`。该包的 `package.json` 在 `pi` manifest 中同时声明 `extensions`、`skills` 和 `prompts`；Pi ResourceLoader 因此执行 `index.ts`。运行后的主 Agent 工具列表包含原生 `subagent`，其 description 与 `src/extension/tool-description.ts` 的完整方法论一致。

## 4. 证据

Upstream `src/extension/index.ts` 在同一个默认 extension 内完成以下工作：构造 executor/state、注册 RPC bridge、注册原生 `subagent` tool、注册 `subagent_wait`、注册 slash commands 和生命周期监听。RPC bridge 并不是独立 package resource，因此“加载 upstream extension 以获得 RPC”会同时加载模型可见工具。

Plan Runner profile 明确不包含 `subagent`，所以 Plan Runner 自身的执行路径已经通过 RPC 隔离；executor/spark profile 也不允许 nested subagent。缺口只存在于交互式主 Agent 的 package resource surface。Package skill 当前被项目 skill whitelist 挡住，但原生 tool description 已经直接进入模型上下文。

## 5. 根因

配置把 pi-subagents 同时当作两种依赖：Node runtime dependency 和 Pi package resource。前者只需要模块代码；后者会让 Pi 自动发现并注册 upstream 所有声明资源。项目建立了 RPC 调用边界，却没有建立 ResourceLoader 注册边界，因此只隔离了执行路径，没有隔离主 Agent 可见 API。

## 6. 修复与验证策略

把 `pi/settings.json.packages` 中的 pi-subagents 改为 object entry，并把 `extensions`、`skills`、`prompts`、`themes` 全部设置为 `[]`。Pi 继续负责精确版本安装与升级，但 ResourceLoader 不执行任何 upstream package resource。项目自有 extension 内部启动 upstream default extension，并通过 default-deny `ExtensionAPI` membrane 拒绝普通 `registerTool`、`registerCommand`、`registerShortcut` 和 provider 注册；保留 event bus、RPC bridge、async tracker、消息 renderer 和 lifecycle。

项目注册两个自有 model-facing tools。`subagent` facade 要求 executor/spark 提交 `dispatch-ir.v1`，对其他 agent 原样 RPC spawn，控制仅暴露 `status/steer/interrupt/stop`。`subagent_supervisor` facade 拥有项目静态 schema 和 description；由于 upstream 没有公开 supervisor service/RPC，membrane 在 `session_start` 时只截获真实 runtime 创建的 `subagent_supervisor.execute` closure，并绑定到私有 adapter。调用的五个执行参数和 resolved result 不改写，upstream definition 本身不进入真实 Pi registry。

Supervisor 兼容性基于固定的开源 `pi-subagents@0.37.0` 实现和独立 Pi lifecycle 测试，不在生产运行时动态推断 schema。Upstream `subagent`、`subagent_wait`、`intercom`、skills、prompts 和 commands 仍不可见；生产 dispatch 模块不导入 Plan Runner、Plan Capsule 或旧 shared RPC client。

验证覆盖 package zero-resource filter、membrane default-deny、supervisor 私有 closure 绑定、项目工具描述、coding contract fail-closed、generic task 原样透传、RPC capability negotiation、reload dispose，以及独立 `/opt/homebrew/bin/pi --print` 进程中的 skill discovery、generic spawn、typed spark handle 和 supervisor status。
