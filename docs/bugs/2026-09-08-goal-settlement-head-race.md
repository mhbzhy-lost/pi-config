# Goal settlement HEAD 与 inspection race

## 复现

D6 覆盖 post-settle 的 integrate、discard、preserve 三种 disposition，以及 allow-empty commit；也覆盖 settle inspection race 与 disposition inspection/internal race。旧 fixture 注入 legacy `inspectExecutorWorkspace`，无法覆盖统一 managed-workspace 路径。

## 根因

Goal 在成功 settle 时读取 managed workspace HEAD，但事件写入前缺少最后一次 canonical service authority 检查；成功 task 的 disposition 也未将 settled ledger `executorHead` 作为 service disposal 的 CAS 条件。服务 action token 的 snapshot 防重放不能表达 Goal 的 settled HEAD authority。

## 修复

服务 status/issue/dispose 接受可选 `expectedHead`，并在 dispose 的持久 disposition intent 前重新检查 canonical Git inspection。Goal 仅从 settled ledger 取得该值：settle append 前进行有界复检；succeeded disposition 在 Goal intent 前和 service CAS 中复检。HEAD 不同稳定返回 `EXECUTOR_SETTLEMENT_HEAD_MISMATCH`，不写 Goal event 或触发 disposition/Git 副作用。
