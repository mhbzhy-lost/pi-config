# Bug：兼容性 Probe 使用了错误的 Pi prompt envelope

## 1. 现象

真实兼容测试已能从 `get_commands` 发现 `/compat-probe`，但调用该命令时 Pi 返回 `Cannot read properties of undefined (reading 'startsWith')`，内层 stable RPC `ping` 未执行。

## 2. 影响

外层 headless 控制入口无法触发临时 Extension，Task 1 仍无法验证 event-bus RPC、Plan child、nested safety 和 lifecycle artifacts。若只修正表面异常而不核对协议，后续还会把 stable reply 的字段解析错误。

## 3. 稳定复现

运行 `PI_REAL_BIN="$(command -v pi)" node --test test/pi-subagents-runtime.integration.mjs`。Extension 加载断言通过，随后发送 `{type:"prompt", prompt:"/compat-probe"}`，Pi `0.80.6` 稳定在 prompt 展开阶段读取 undefined。

## 4. 证据

Pi `0.80.6` 的 `RpcCommand` 类型和 `docs/rpc.md` 都规定 prompt 请求为 `{id?, type:"prompt", message:string}`；当前测试使用不存在的 `prompt` 字段。上游 `pi-subagents@0.34.0/src/extension/rpc.ts` 同时规定 reply 为 `{success:true,data}` 或 `{success:false,error:{code,message}}`，当前临时 probe 和本地 client 却使用 `{ok,result,error:string}`，单元测试也按错误 fixture 固化了该协议。

## 5. 根因

实现没有以 Pi `0.80.6` 和 `pi-subagents@0.34.0` 的实际类型定义作为协议事实源，而是根据字段语义猜测了两层 envelope：外层把 payload 字段写成 `prompt`，内层把 reply 字段写成 `ok/result`。第一处使 command 无法执行，第二处会在修复第一处后继续把合法 reply 判为失败。

## 6. 修复与验证策略

先修改单元测试 fixture 为上游真实 stable reply envelope，观察现有 client 正确 RED；再最小修改 client 解析 `success/data/error.message` 并验证 GREEN。真实测试把外层请求改为 `message:"/compat-probe"`，临时 Extension 复用相同 envelope 解析；先证明 `ping` 返回 version、methods 和 capabilities，再逐项增加 spawn/status/interrupt/stop，不合并多个未经证明的行为。
