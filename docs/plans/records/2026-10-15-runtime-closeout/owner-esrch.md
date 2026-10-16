# P3：单次 SIGKILL→ESRCH 条件验收

状态：verified（用户已授权本窗口一次受控SIGKILL，实际exit0、1/1通过）。

用户在明确列出的三个尾项之后指示“方案明确就直接做”，本窗口已据此授权P3仅对受控直接Pi child的一次SIGKILL。此前H2父Host SIGKILL不是本次授权来源；本次不杀组、不补杀。

- harness现默认无 `PI_TEST_OWNER_SIGKILL=1` 时明确skip。
- P2五项无kill真实CLI已5/5通过。
- 实际命令：`PI_TEST_OWNER_SIGKILL=1 node --test --test-reporter=tap --test-name-pattern='^真实 Pi PTY: SIGKILL' test/session-owner-runtime.integration.mjs`，jobId=`ebdac123-aa66-4699-be46-5f3a93098aaa`。
- 完成回执：outcome=succeeded、exitCode=0、1 test / 1 pass / 0 fail / 0 skip，命令约3504ms；不是启动回执推断。
- 精确自造根：`/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/session-owner-controlled-RFzyZ0`。
- 被kill的直接Pi child PID=63509、driverPid=63508。driver按leaseId/pid/reference birth/PPID验证后送出唯一SIGKILL；waitpid记录signal=9、status=9、code=null、reapedAt=`2026-10-16T08:26:45.087647+00:00`。driver退出code0。
- ESRCH在child已reap后验证通过，registry清理旧owner；replacement child PID=63546、driverPid=63545，新owner唯一且不同于旧owner，child正常code0、signal=null、status0，reapedAt=`2026-10-16T08:26:46.332149+00:00`，driver退出code0。
- 两个lease均residualPaths=[]、clean=true；无组杀、无补杀、无额外SIGKILL。通过的根按harness既有全退出+test通过条件允许清理；原始回执保留上述退出账本。
- 本次未设置T8_TRACE_FILE，所以不宣称另有完整birth值/killAt trace artifact；identity重核和一次性门禁由实际通过的driver路径与测试断言证明，不编造未输出字段。
