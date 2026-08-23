# Goal active-time 预算错误计量

## 现象

真实的 Goal 已处于 suspended 且没有资源占用，但因为 `createdAt` 到世界快照 `capturedAt` 超过 1440 分钟而被错误标记为 `ELAPSED_BUDGET_EXHAUSTED`。

## 原因

预算将 Goal 的墙钟年龄当作执行时长，暂停、等待用户和隔日再次活跃之间的间隔也被累计。

## 期望

`max_elapsed_minutes` 应只累计事件派生的 active execution time：activation 开始区间，suspend 结束区间，resume 开启新区间。暂停期间不计时；持续工作与隔日再次活跃不能混同。缺少可信 active-time 权威时应要求 attention，而不能回退到创建时间墙钟。
