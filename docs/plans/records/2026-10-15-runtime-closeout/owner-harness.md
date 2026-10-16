# P1：受控 session-owner harness 与事务收口

用户改为 Inline 后完成。P0 提交 `33710b4` 提供 direct-child PTY，替代旧 Expect 包装层。

## 改动

- 六个真实 Pi 测试通过 `startControlledPty` 启动 launcher；registry PID 必须等于 driver 的直接 Pi child PID，不再接受 wrapper/后代猜测。
- 白名单环境固定物理 SDK、隔离 HOME/agent/session/registry/workspace/goal/tmp、offline/无 MCP/无 skills；不继承用户 token/proxy。
- 每个 root 记录全部 lease。正常关闭 Esc/Ctrl+U/Ctrl+D 后 waitpid/reap，再关 driver；仅所有 child 和 driver 都确认退出且无 residual 才清自造 root。失败保留 root/ledger；无强杀 fallback。
- P3 默认 skip，只有 `PI_TEST_OWNER_SIGKILL=1` 才进入一次 lease/pid/birth/PPID 门禁；本窗口未运行 P3。
- 保留原六项产品断言和八项非 PTY 测试，未修改 production owner 语义以迁就 harness。

## 真实验收

- `node --check test/session-owner-runtime.integration.mjs`：exit 0。
- 非 PTY 指定 pattern：8 tests / 8 pass / 0 fail，exit 0。
- `node --test test/session-owner-contract.test.mjs test/session-owner-registry.test.mjs test/session-owner-extension.integration.mjs`：78 tests / 78 pass / 0 fail，exit 0。
- `git diff --check`：exit 0。

当前 runtime 测试还包含上一批 S1v 三个真实 SDK 场景，因此与 session-owner reserve/commit/abort 生产改动及其测试一起提交为完整事务单元；不把 P1 harness 单独提交成依赖未提交实现的绿假象。P2 五项真实 CLI 运行另记录，不把本合同阶段当真实 TUI 通过。

## 历史运行边界

Inline 开始前派发的旧 Expect 入口命令不作为 P2 证据，新的 P2 只消费本受控 driver。旧 heartbeat 根未触碰、未杀进程、未联网。
