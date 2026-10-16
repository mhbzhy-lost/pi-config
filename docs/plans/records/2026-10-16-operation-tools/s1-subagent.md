# S1：七个独立 subagent 操作 factory

状态：verified-factory；Host唯一注册切换仍由S4负责，不宣称当前会话已换工具。

## 交付与边界

- `packages/pi-subagents-enhanced/src/subagent-dispatch/operation-tools.ts`
- `test/subagent-operation-tools.test.mjs`

`createSubagentOperationTools({executeStart,executeControl,renderCall?,renderResult?})`提供roster/start与status/steer/interrupt/resume/stop共七个model-only工具。单object顶层schema、additionalProperties=false，无根组合子；唯一回调保持原ToolDefinition execute参数顺序，raw结果原样。start仍由既有typed编译器决定generic/coding和细合同，不新增dispatcher/state/queue。

未知/跨面字段（包括action）拒绝且不触下游，合法control输入由factory固定注入action。start agent/task、steer/resume message有轻量非空string门禁；resume保留原output/outputMode(file-only)，不实现换模；start不扩context/view/lines/mode/childId等runtime-only字段。

## 验收

- `node --test test/subagent-operation-tools.test.mjs`：exit0，13/13。
- `npm_config_registry=https://registry.npmjs.org/ npm_config_offline=true npm --prefix packages/pi-subagents-enhanced run typecheck`：exit0。
- 新两文件no-index空白检查及tracked diffcheck通过；父精确stage后再cached diffcheck。

历史首轮12/12但package类型被S3新增Error.code类型问题阻塞，未计通过；S3修复后本轮完整通过。父静态退修action被忽略与required字段缺失，并纠正$.message错误码不复用目标身份解析码。只改本factory/tests，不削弱原compiler/owner/权限权威。
