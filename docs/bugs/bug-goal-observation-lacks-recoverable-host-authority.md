# Observation 缺少可恢复的 Host 权威

## 问题
若调用者可以提交命令、环境、裁决或进程结果，或在持久化意图前启动观察，崩溃后就可能伪造状态结论、泄露配置并遗留无法归属的资源。

## 复现
1. 以调用者提供的 executable、args、env 或 verdict 发起观察。
2. 在租约、进程、终态或记录边界重启服务。
3. 观察到同一 Condition 可重复分配资源、未知进程被记录或释放，且 artifact 之外的输入能影响结论。

## 修复方案
仅接受 Host 注册的 adapter 定义，并以 R3 durable receipt 为租约和进程权威。先生成需 append 的请求事件，再依序生成租约、进程、终态、记录和释放事件计划；Host 以 0600、no-follow artifact 重读和受控 classifier 派生 R5 evidence。任何身份无法证明或释放不明均保留 cleanup debt。
