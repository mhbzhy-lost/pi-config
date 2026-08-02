# Bug：init-pi 回归门禁混入未完成实现与环境绑定

## 1. 现象

执行 `init-pi.sh` 安装依赖后进入 `npm test`，共 992 项测试中 16 项失败；随后 `npm run doctor` 也会因 Executor 模型契约不同步而失败。失败集中在 Root Broker 有序关闭、Todo renderer 加载、临时 Git 仓库分支、Root marker 恢复和 Executor 模型五组。

## 2. 影响

初始化已完成全局 Pi、仓库包、shell 集成和 Basic Memory 安装后才失败，用户得到“依赖已变更但初始化未完成”的状态。重复执行仍会在相同门禁失败，无法获得可信的初始化成功信号。

## 3. 稳定复现

```bash
npm test
npm run doctor
```

其中 `node --test test/init-pi.test.mjs` 本身通过，说明失败来自脚本末尾调用的仓库全量门禁，而不是安装命令 fixture。

## 4. 证据

- 5 项 `Root session ordered drain` 测试期望停止 owned runs，但 `closeRootSession()` 只关闭传输和清空账本，从未调用 `upstream.stop()` 或等待 official process-terminal。
- 初版有序关闭实现只快照一次 `ownedRuns`，关闭期间迟到的 Executor 会在未停止时被清空；它还会接受协议校验明确拒绝的畸形 terminal 事件，并在 grant 删除失败后清空 cleanup debt，导致重试无动作成功。
- 第一轮关闭栅栏修复仍漏掉无 `spawnKey` 的 legacy spawn，并依赖 `async-started` 才建立终止债务；Plan Runner 等待阶段仍可接收却遗漏新的 Executor。重复 runId 的冲突身份也能错误结算 terminal proof。
- 多 Plan Runner 排空会在首个失败时跳过后续运行；`start()` 在第二或第三个事件监听器注册失败时不会注销已注册监听器。artifact/dispose 重试行为也缺少直接回归断言。
- Broker 自身虽然保留失败 cleanup debt，生产 shutdown wrapper 却在 `finally` 无条件 unbind、reset 并 dispose RPC，使第二次 shutdown 无法重试原 Broker。
- Root socket/grant 使用安全 session UUID，而 pi-subagents lifecycle 在持久化 session 中使用 session file identity；Broker 把二者误当同一值，稳定拒绝 started event。
- `todo-compact-result.test.mjs` 把 TypeBox alias 固定为旧用户目录 `/Users/leshi.zhy/...`；当前仓库位于 `/Users/mhbzhy/...`，模块导入被测试主动吞掉后表现为 renderer 不存在。其余 Pi 包仍绑定 `/opt/homebrew`，在非 Apple Silicon Homebrew 环境仍会失败。
- `plan-attempt-validator.test.mjs` 固定 checkout `master`，而当前 Git 默认初始分支是 `main`。
- Pi 进程继承 `PI_ROOT_SUBAGENT_BROKER_ENABLED=1` 时，兼容测试先删除该变量，却在内部 session shutdown 后错误要求恢复到删除前的外层值；`init-pi.sh` 的全量门禁本身也未清理父 Subagent marker。
- Executor 已按现有登录能力切换到 `openai-codex/gpt-5.6-terra`，迁移测试与 Doctor 仍固定旧 `codex-pool` 值。

## 5. 根因

仓库在提交有序关闭 RED 测试后未提交对应 production GREEN；后续 GREEN 又把关闭所有权分散在 durable spawn、started event、一次性运行快照和外层 shutdown wrapper 中，没有统一跟踪 legacy/in-flight spawn、有效 spawn reply、身份冲突、关闭事件入口与失败重试。Root 协议身份和 lifecycle 身份也被错误合并，持久化 session 下无法建立运行债务。启动监听器注册不是事务化操作，清理阶段缺少按资源记录的重试测试。测试把开发者绝对路径、历史默认分支和父 Pi 环境变量误当成被测合同，而初始化门禁也直接继承调用方的 Subagent marker。

## 6. 修复与回归标准

1. 保留既有有序关闭 RED 测试，实现 Executor → observed terminal → Plan Runner → observed terminal → transport teardown；所有 legacy/durable in-flight spawn 都进入关闭栅栏，有效 spawn reply 立即建立运行债务，不依赖 started 事件。
2. 关闭期间接收的 Executor 必须在 Plan 阶段前稳定排空并封闭 started 入口；只有统一协议校验通过且身份无冲突的 terminal proof 才能结算 waiter。多 Plan Runner 必须全部尝试后聚合失败。
3. 删除 socket/grant、dispose 或等待 proof 失败时保留对应 cleanup debt；Broker 及生产 shutdown wrapper 都必须保留原 registry/RPC 供下一次 shutdown 重试，不能因外层 `finally` 清空 ownership。监听器部分注册失败必须事务化回滚。
4. Root UUID 继续作为 socket/grant 协议身份；另传 canonical lifecycle session identity 校验 started event 和 provisional upgrade，覆盖持久化/reload session。
5. 测试路径从当前仓库或实际全局 Pi 安装根目录推导；临时仓库显式创建并使用确定分支；marker 测试既证明门禁环境被清理，也证明安装阶段仍保留调用方环境。
6. `init-pi.sh` 在回归门禁子 shell 中清理 Subagent 运行时 marker，不污染脚本外层环境；同步 Executor 的迁移与 Doctor 契约。
7. 聚焦测试、`npm test`、`npm run doctor`、`npm run test:integration` 和外部评审 Python 测试全部通过。
8. 不覆盖工作树中既有的用户配置、凭据或无关未跟踪 bug 文档。
