# Bug: Root Broker 方法集合可变导致协议可被运行时扩展

## 症状
`BROKER_METHODS`从协议模块直接导出内部可变数组。任一消费者可调用`BROKER_METHODS.push("nested.spawn")`，随后`parseBrokerRequest()`会接受该原本未知的方法，违反固定broker method集合。

## 影响
Root Broker协议不再是冻结合同；后续extension、测试或意外共享代码可在进程内扩大允许的RPC面。类型声明也因数组未使用literal tuple而把`BrokerMethod`、push type和grant role扩大为普通`string`，编译期无法阻止计划外值。

## 复现
导入`BROKER_METHODS`和`parseBrokerRequest`，确认`Object.isFrozen(BROKER_METHODS) === false`；向数组追加`nested.spawn`后，以该method构造其他字段合法的request。parser返回request而非抛出unsupported method错误。

## 根因
协议实现让导出的`BROKER_METHODS`与parser内部的`METHODS`引用同一个普通数组，parser使用`METHODS.includes()`判定method。公共导出因此也是内部授权真值的写入口；同时缺少`as const`使TypeScript丢失literal union。

## 修复
以literal tuple定义固定method、push type和grant role，并让运行时授权集合不可变；新增RED测试证明公共method表不可变且即使发生外部修改尝试，未知method仍被拒绝。保持请求字段、socket/grant路径和既有协议不变。

## 验证
运行`node --test test/root-subagent-broker-protocol.test.mjs`和相关subagent dispatch测试，确认method不可扩展、未知method继续fail closed、协议全部回归通过。
