# Plan cancel 跳过 Child 持久化确认

## 现象

`/plan-cancel` 通过可选注入记录取消意图后立即调用 stable RPC stop，未要求 Plan child 在自身 session JSONL 中追加 `plan.cancelled`，也未验证持久化确认。

## 影响范围

Parent 可能在 child 没有记录取消领域事件时终止其进程；伪造的 handle 路径或非终态 RPC 回包也可能被误报为取消成功，破坏审计事实源。

## 复现步骤

使用真实临时 stateRoot 创建 Parent handle；令 child 未写 acknowledgement 或写入不匹配 acknowledgement。当前 launcher 仍可调用 stop，且只依赖可选 runtime 状态读取。

## 根因

取消协议没有跨进程、原子持久化的 request/ack 通道，launcher 的默认实现缺失，Child Capsule 也没有后台处理请求的控制循环。

## 修复方案

在受限 `var/plan-runs/<planId>/control` 目录以原子 JSON 文件交换 cancel request/ack；Child 重放自身事件、追加 `plan.cancelled`、写 status 后确认。Parent 仅接受匹配确认，随后 stop 并等待终态 runtime artifact。

## 验证方式

新增 control、dependencies、capsule 与 launcher 的真实临时目录测试，覆盖 request 到事件到 ack 到 stop 到终态的顺序、超时/无效 ack/stop 失败、幂等以及 forged statusPath 拒绝；运行目标测试与 `npm test`。
