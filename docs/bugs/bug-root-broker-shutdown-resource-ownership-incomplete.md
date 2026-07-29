# Bug: Root Broker 资源归属不完整导致 shutdown 可永久阻塞

## 症状
Root Broker只把`subscribe`连接加入subscription集合。普通客户端连接后若不发送完整JSONL换行，socket不会被跟踪；`closeRootSession()`调用`server.close()`后会一直等待该连接。Root扩展创建的broker专用RPC client也没有dispose路径，且`grantCaller(role: "executor")`在运行时会被接受。

## 影响
Root session shutdown可能永久卡在`beforeRuntimeDispose`，上游runtime无法dispose，Plan Runner/Executor无法获得可靠的Root终止顺序。热启动或bind失败还可能留下监听socket/RPC listener；错误role可生成不应存在的caller grant。

## 复现
启动`RootBrokerServer`，连接其Unix socket但不发送换行；调用`closeRootSession()`并与100ms观察Promise竞争，结果为`timed-out`，手动destroy idle socket后才完成。另调用`grantCaller({role:"executor"})`会返回token而不是拒绝。

## 根因
实现把资源所有权建模为subscription和grant集合，没有维护所有已接受socket，也没有明确broker专用upstream RPC的dispose ownership。Root扩展的start/bind不是事务化cleanup；caller role只由TypeScript签名约束，运行时输入未验证。

## 修复
server跟踪每个accepted socket并在Root closing时先推送subscriber、再结束/销毁全部连接后关闭listener；明确dispose broker专用upstream RPC且幂等。Root扩展对start/bind失败执行close/unbind cleanup。`grantCaller`运行时只接受`plan-runner`。补registry、idle socket、hook失败finally、role、RPC dispose和startup rollback的RED测试。

## 验证
运行Root broker与runtime membrane聚焦测试，确认idle连接不能阻塞close、broker RPC在Root close时dispose、bind/start失败不留socket、错误role拒绝、registry bind/require/unbind合同和beforeDispose失败路径全部通过；再运行协议与dispatch相关回归及`git diff --check`。
