# Bug: revival diagnostics RED 误标 resume active generation

## 现象

`c40d6ab` 新增的 diagnostics RED 在 `resume.succeeded` 阶段预期 `activeRunId: "plan-runner-2"`、`generation: 1`。但 production 架构的顺序是 upstream `resume` 先返回候选 run，随后才由 `grantRevivedCaller` 原子地激活 alias；候选 run 在 grant 前并不是 logical caller 的 active 身份。

该提交尚无 production 实现；父级在进入 GREEN 前的审查中发现了这项测试合同错误。spark 连续四次返回 502，未产生可补充的工作区证据或改动。

## 影响

若按该 RED 断言实现，诊断会把尚未激活的候选 run 谎报为 active 身份，并提前把 generation 标为 1。这会削弱 alias 与 grant 作为 active 身份权威来源的语义，使诊断无法可靠地区分 resume 返回和 grant 完成之间的状态。

## 复现

检视 `c40d6ab` 中 `test/root-broker-revival.test.mjs` 的 `persists sanitized revival diagnostics in proof-first order`：循环断言将 `resume.succeeded` 与 `grant.issued`、`revival.succeeded` 一同预期为 `plan-runner-2`、generation 1。该测试为 tests-only RED，当前 diagnostics 仍为空，因此修正该单项预期后仍会以同一目标 RED 失败；其余三个 RED 不变。

## 根因

RED 按 phase 名称推导目标 generation，把 `resume.succeeded` 误解为新 generation 已 active。它混淆了 upstream resume 返回候选 run 的结果与 `grantRevivedCaller` 完成 alias 原子激活之后的 active 状态，未以 grant 作为身份切换的唯一边界。

## 修复

修正测试合同及后续 diagnostics 语义：`resume.succeeded` 继续记录旧 active `plan-runner-1`、generation 0，同时额外记录候选 `revivedRunId: "plan-runner-2"`。仅 `grant.issued` 与 `revival.succeeded` 记录新 active `plan-runner-2`、generation 1；不得让 production 为错误诊断语义让步。

## 验证

修正 tests-only 断言后，运行既有 revival diagnostics RED：由于 production 尚未写入 diagnostics，断言仍会因 diagnostics 为空而失败，保持同一目标 RED。确认另外三个 RED 的失败条件和预期均不因本项合同修正而改变；GREEN 实现前不修改测试、production 或 Harness。
