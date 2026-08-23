# Goal active-time 预算错误计量

## 现象

真实的 Goal 已处于 suspended 且没有资源占用，但因为 `createdAt` 到世界快照 `capturedAt` 超过 1440 分钟而被错误标记为 `ELAPSED_BUDGET_EXHAUSTED`。

## 原因

预算将 Goal 的墙钟年龄当作执行时长，暂停、等待用户和隔日再次活跃之间的间隔也被累计。runtime 的 durable active 状态只表示最近一次 activation 后尚未收到 suspend，并不等于 agent 在整个墙钟区间持续执行；若最后一次 Goal event/activity 后没有 owned run，suspend 前的空闲尾段不能计入 active time。

## 修复

初始 suspension 没有 `affectedRunIds` 时，active interval 使用 projection 的 canonical `updatedAt` 关闭；携带 owned run 时才使用 suspension 的 `occurredAt` 关闭。时间倒退直接 fail closed，不以零进行 clamp；重复 closure 不会重复关闭 interval。

## 期望

`max_elapsed_minutes` 应只累计事件派生的 active execution time：activation 开始区间，suspend 结束区间，resume 开启新区间。暂停期间不计时；持续工作与隔日再次活跃不能混同。缺少可信 active-time 权威时应要求 attention，而不能回退到创建时间墙钟。
