# Bug: Root Broker 缺少响应协议导致 client 无法校验归属

## 症状
`root-broker-protocol.ts`已经定义request、push和grant，但没有response schema、类型、构造器或严格parser。Task 2 server与Task 3 child client之间没有固定的reply envelope。

## 影响
后续server/client只能各自临时决定响应格式，client无法按协议拒绝错`requestId`、错Root session或错caller的JSON reply。reply可能跨请求或跨Plan Runner误关联，且错误响应没有稳定的fail-close结构。

## 复现
导入Task 1协议模块并检查导出：不存在`BrokerResponse`运行时parser或success/error response构造器。批准计划的文件职责要求该模块冻结“broker envelope、响应、push event、socket path和严格parser”，Task 3同时要求拒绝错session、错caller和非JSON reply。

## 根因
Task 1实现只覆盖了步骤示例中显式列出的`BrokerRequest`和`BrokerPush`，遗漏了文件职责与后续client验收依赖的response合同。测试也只验证request/push/grant，因此该顺序门禁缺口未被发现。

## 修复
在协议模块增加固定`pi-root-subagent-broker-response.v1` discriminated envelope：success携带`data`，failure携带exact-key`error.code/error.message`；两者都绑定`requestId/rootSessionId/callerRunId`。提供严格parser和构造器，并允许caller传expected identity进行三元匹配校验。

## 验证
先新增因response API缺失而失败的测试，再运行协议专用测试和相关subagent dispatch回归。覆盖success/failure、额外字段、非对象、错request、错session、错caller和非法error结构。
