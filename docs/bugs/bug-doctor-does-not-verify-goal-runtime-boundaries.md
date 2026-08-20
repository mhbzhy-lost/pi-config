# Doctor 未校验 Goal Runtime 行为边界

## 问题

Doctor 仅验证 Root Goal 的八工具 ABI，未验证运行时代际能力、合同输入边界、可恢复验证、当前世界新鲜度、Finding/Repair/Suspend 与纯终局边界。损坏或替换这些运行时能力时，配置检查仍可能报告 ready。

## 风险

运行时可能接受调用者 profile 或 command、缺少恢复接口，或让 finalization 触发观察 adapter；这些都违背 Manual Preview 的宿主权威与无副作用终局边界。

## 修复方向

以可注入的运行时能力工厂执行行为探针。Doctor 只读取模块能力和调用纯校验接口，不调用 adapter、不启动进程，也不创建 Goal、validation 或 worktree state；每项缺失或伪造能力输出稳定 issue code。
