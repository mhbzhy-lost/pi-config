# 缺陷：Pi 0.84 ExtensionAPI facade 分裂了 Root broker identity

## 症状

Pi 0.84.1 会为每个 extension 创建不同的 `pi` 对象和 `pi.events` facade。Root runtime 使用自己的 facade 绑定 broker，而独立加载的 extension 使用另一个 facade 查询。仅以 `pi.events` 为键的 `WeakMap` 因而无法找到 Root broker，尽管两个 facade 代表同一个 Root session。

## 影响

Root broker 已启动且 `subagent` tool 已注册，但真实 startup probe 会报告 `Root subagent broker is unavailable`。这会阻止 extension 使用 Root 所拥有的 broker。

## 根因

精确 facade identity 对所有权隔离仍然有用，但它不是进程范围的 Root session identity。Pi 0.84 有意采用 facade 分裂，因此不能将其视为共享 identity。

另一个 reload 兼容风险来自历史 process slot：`Symbol.for('pi.root-subagent-broker-registry.v1')` 在迁移前保存的是 `WeakMap`。extension reload 不会重启进程；若新 generation 将同一 v1 slot 解释为含有 `exact` 和 `byRootSessionId` 的对象，旧 `WeakMap` 会使新 generation 在 bind 前以 slot invalid 失败。该 legacy v1 slot 不能被改写、删除或迁移，因为它仍由旧 generation 按既有 shutdown debt 流程释放。

## 修复与 fail-closed 边界

保留精确 facade `WeakMap`，用于同一 facade 的兼容性和所有权。新增一个由独立、版本化 process symbol 作用域限定的 registry 对象，其中将经过验证的显式 `rootSessionId` 映射到同一个 broker。新 registry 忽略 legacy v1 slot；bind 会原子地拒绝已占用的精确键，以及被其他 broker 占用的 Root-session identity。跨 facade 查询仅在调用方显式提供非空 Root session id、且该 id 映射到 broker 时允许；缺失、格式错误或冲突的 identity 不会扫描、挑选唯一 broker 或使用 fallback。

unbind 和 startup rollback 仅在 identity 条目仍指向待移除 broker 时才移除它，因此不会删除 replacement binding。

## 验证

单元覆盖证明：不同 facade 在未提供 identity 时保持隔离；使用相同且显式的 Root session id 后可以查询；无效 identity 和重复 Root-session bind 会被拒绝；精确 unbind 会保留 replacement；在子进程中预先放入 legacy v1 `WeakMap` 后，新 registry 仍可 bind、require 和 unbind。真实 startup probe 从 `sessionManager.getSessionId()` 取得 id 并显式传递；独立 Jiti extension 能读取共享的新 slot。
