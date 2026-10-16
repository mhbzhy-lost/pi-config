# P3：单次 SIGKILL→ESRCH 条件验收

状态：blocked-permission。

用户已授权Inline执行剩余主线与逐项commit，但没有明确授予本测试本窗口直接Pi child的一次SIGKILL。此前H2父Host SIGKILL只适用于历史H2实验，不继承至P3。

- harness现默认无 `PI_TEST_OWNER_SIGKILL=1` 时明确skip。
- 本窗口只运行P2五项无kill真实CLI，5/5通过；没有执行P3，没有用kill(0)或其他实验替代端到端证明。
- 待明确fixture-sigkill批准后，仅运行精确P3 pattern；driver还须复核lease/pid/birth/PPID，至多一次、无组杀无补杀。
