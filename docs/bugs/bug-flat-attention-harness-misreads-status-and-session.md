# Flat Attention Harness 误读 status、session 与 RPC 结果结构

## 1. 现象

提交`76a7c0c`为A2真实Harness增加Supervisor roundtrip后，`node --check`和provider单测通过，但父级静态审查发现真实运行会在取证阶段错误失败或漏报错误：

1. `waitForAttentionStatuses()`直接flatten public attempts，随后却读取不存在的`attempt.taskId`；
2. 主测试读取Root session时引用只存在于`assertFutureGreen()`局部作用域的`asyncStatuses`；
3. Executor persisted session的模型消息位于JSONL entry的`message`字段，代码却把entry本身当作`role/content`消息；
4. RPC `tool_execution_end`的tool error位于`record.result.isError`，代码只检查`record.isError`。

## 2. 真实证据与反证

A1唯一GREEN保留的两个`pi-plan-status.v1`均显示：`taskId`位于task对象，attempt仅含`attemptId/status/dispatchId/runId/...`。Root persisted session样本每条模型消息形如`{"type":"message","message":{"role":...}}`。A1 Harness既有`resultValue(record)`也从`record.result`读取tool result。

`node --check`只验证词法/语法，不能发现块级变量在另一函数局部定义，也不能验证运行时JSON shape；provider 43项不执行真实Harness，因此全绿不能反证这些oracle错误。

## 3. 根因

A2改造把三个不同边界的数据结构混为一层：Plan public projection、Pi persisted session envelope和RPC execution record。实现时沿用了领域对象的直觉字段，没有复用各边界已有的读取方式；同时把局部`asyncStatuses`误当成主测试可见变量。

## 4. 正确修复

这是tests-only Harness oracle纠错，不修改production：

1. flatten waiting attempts时显式附加所属task的`taskId`；
2. Root session identity从主作用域已验证的`actualRuns[*].status.sessionId`取得；
3. Executor取证先把`type=message` entries映射为`entry.message`，再检查contact/result/bash顺序；
4. tool error检查`record.result?.isError`，并继续用`resultValue()`解析成功值；
5. 补强requested/escalated/resolved的request/attempt/run/hash字段，避免仅按事件数量误判不串Plan。

不得运行真实Harness来“试错”；修正后只做syntax/provider/static review，冻结新HEAD后才运行一次。

## 5. TDD 验证

本修复属于tests-only oracle纠错，RED证据使用已保存的A1真实status/session/RPC结构，不为测试代码再引入production测试钩子。修正后执行：

- `node --check test/plan-flat-runtime-harness.integration.mjs`；
- `node --test test/deterministic-provider.test.mjs`；
- 静态确认主作用域无`asyncStatuses`自由引用、waiting flatten保留taskId、session entry显式unwrap、RPC检查`result.isError`。

随后冻结HEAD/index/porcelain/Harness/provider哈希并只运行一次真实A2 Harness。

## 6. 影响边界

只影响A2真实Harness的取证正确性，不影响Plan Runner runtime。若不修，最早会因`taskId`为undefined假RED；绕过后会因`asyncStatuses`抛`ReferenceError`；session误读会假报没有contact call；RPC错误则可能被当成成功。错误基线一旦运行即不能重跑，因此冻结前修复代价低，冻结后暴露代价高。
