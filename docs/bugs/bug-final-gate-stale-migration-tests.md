# 最终门禁仍执行陈旧迁移契约

## 1. 现象

Task 14首次运行`npm test`共403项，398项通过、5项失败；修复后全量400项通过。随后真实Pi RPC集成又发现同类陈旧断言：测试仍要求“精确8个Skill”，而当前受控global/local清单为18项，Runtime另提供3个已审计package Skill。

- `init-pi.test.mjs`仍要求安装Pi `0.80.10`，而当前支持集合和初始化默认值已更新为`0.82.0/0.82.1`与`0.82.1`。
- `migration-contract.test.mjs`仍固定旧Skill数组，缺少当前白名单中的`browser-auth-session`及本地Skill。
- `plan-coordinator-dispatch-hint.test.mjs`三项仍调用已删除的`coordinator.authorizeNext()`旧nested-dispatch API。
- `pi-runtime.integration.mjs`仍把Skill发现固定为历史8项，未同步当前global/local白名单，也未区分Runtime package自带Skill。
- `plan-capsule.integration.mjs`后半仍验证旧Parent stable RPC七字段handle、Pi `0.80.6`和旧compaction语义；前半worker recovery fixture也未注入新Execution Backend。

## 2. 影响

生产Doctor、真实Harness和核心116项故障矩阵均通过，但全量自动门禁无法完成，Goal必须保持active，不能启动Crash Fix V2正式Lane。

## 3. 稳定复现

```bash
npm test
```

## 4. 证据

失败分别为：旧Pi版本正则不匹配、Skill数组deepEqual缺少当前清单项，以及`TypeError: coordinator.authorizeNext is not a function`。Task 7已将Coordinator改为直接Backend派发；Task 13迁移测试已证明Executor路径不存在模型中转或通用Runtime。

## 5. 根因

Task 14更新当前运行契约时，没有同步两个历史fixture。旧dispatch-hint测试属于已批准删除的nested model-tool路径，却不在Task 13原始删除文件清单中，因此仍被`test/**/*.test.mjs`收集。测试断言的是已废止设计，不应通过恢复旧API来修复。

## 6. 修复与回归标准

1. init fixture改为断言默认Pi `0.82.1`；
2. migration Skill fixture从当前global/local清单同步精确预期；
3. 删除`plan-coordinator-dispatch-hint.test.mjs`，不恢复`authorizeNext`；
4. 真实Pi Skill门禁断言18个受控Skill全部存在，并只允许审计过的3个package Skill；
5. `plan-capsule.integration.mjs`只保留当前持久化领域场景，worker recovery注入官方Backend fixture；旧Parent RPC场景删除；
6. `npm test`全量通过；
7. Doctor、真实subagents、Plan和Harness门禁继续通过。
