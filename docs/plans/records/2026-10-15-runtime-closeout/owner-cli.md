# P2：五项真实受控 CLI / PTY 验收

## 当前结论

Inline 实测 `node --test --test-reporter=tap --test-name-pattern='^真实 Pi (Expect PTY|PTY: (active recent blocks|-c pins|--no-extensions|selecting picker))' test/session-owner-runtime.integration.mjs`：**exit0，5 tests / 5 pass / 0 fail / 0 skip**，约18.9秒。测试名中的 Expect 为历史兼容名，实际全用 controlled PTY，不再执行 Expect。

通过项：持久 assistant/active owner、active recent 阻断、精确 free recent pin、no-extensions 不能绕过、selecting picker 同时阻断-c与显式session。

## 来源分类与 harness 修复

首跑4/5：`-c pins` 选择到了正在持有的old session。首偏离点是测试把页脚模型名 `deterministic` 当当前 prompt 完成，且已持久会话中旧 assistant 也会满足粗糙检查；稍后正常 `_persist` 会在测试 `utimes` 后写回文件，使mtime顺序失效。

调用链：测试 `readyPty`→公开launcher→真实Pi首帧→测试收到模型名→测试改mtime→真实本地fake响应持久化。分类为**测试制造的非预期事件顺序**，只修 harness：读取本测试合法生成的session，按当前精确user prompt定位，再等待其后的assistant entry落盘，不修改生产recent排序、owner规则或兼容逻辑。修复后单项1/1，再完整5/5。

## 进程与现场

- 每个lease输出 `[owner-pty-ledger]`：真实Pi PID=registry PID，child waitpid退出、driver退出均明确；被阻断launcher code1是预期，其余code0；所有signal=null，residualPaths=[]。
- 完整原始runner日志：`/tmp/inline-owner-cli-verified.log`；前次失败日志 `/tmp/inline-owner-cli-final.log` 与 `/tmp/inline-owner-pin.log`。
- 前次失败根 `.../session-owner-controlled-GF5S8H` 保留；成功根仅在子进程全部退出、无residual且test通过后可清理。不会删除旧heartbeat根。
- 未运行P3、未发SIGKILL、未联网、未用真实provider。
- 另有改造前旧Expect命令运行，不作为本P2证据；本记录以最终新driver完整5/5为准。
