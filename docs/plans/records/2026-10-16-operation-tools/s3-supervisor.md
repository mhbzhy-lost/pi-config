# S3：三个独立 supervisor 操作 factory

状态：verified-factory，尚未切换Host注册（S4负责）。

## 交付

- `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-operation-tools.ts`
- `test/supervisor-operation-tools.test.mjs`

`createSupervisorOperationTools(adapter, {renderCall?,renderResult?}?)`提供pending/status/reply三model-only定义，只委托同一个adapter.execute。固定action从factory注入，未知字段拒绝；reply的replyTo/message schema与runtime均非空。raw结果引用、content/details/isError原样保留，无新queue/receipt/observer。inspect/clear不创建、不伪装完成。

## 验收

子代理实际运行：

- `node --test test/supervisor-operation-tools.test.mjs test/subagent-supervisor-adapter.test.mjs`：exit0，12/12（8新增+4原adapter）。
- `npm_config_registry=https://registry.npmjs.org/ npm_config_offline=true npm --prefix packages/pi-subagents-enhanced run typecheck`：exit0。
- 父精确stage后`git diff --cached --check`覆盖新文件，不以tracked diff为空冒充untracked空白检查。

父静态验收退修三项：schema缺minLength、Error对象code/keypath缺类型、显式null被??{}洗成空参数；均在原两文件最小修复，并补null/数组/原始类型负例。这些是新factory合同/类型缺陷，不更改原adapter权威或增加兼容fallback。

当前只完成factory，不声称fresh Host已注册新三工具；S4仍依赖G2+G2-wire发布。
