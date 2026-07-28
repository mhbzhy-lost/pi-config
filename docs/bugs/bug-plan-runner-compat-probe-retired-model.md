# Bug：Plan Runner 兼容探针绑定已下架模型

## 1. 现象

运行`PI_REAL_BIN="$(command -v pi)" node --test test/pi-subagents-runtime.integration.mjs`时，RPC ping、interrupt和stop部分链路可以执行，但需要模型完成的async run进入`failed`：

```text
模型已下架，建议更换新模型
model: openai-idealab/Qwen3.7-Max-DogFooding
```

依赖该run产物的nested capability probe最终等待60秒后超时。

## 2. 影响

- 真实Pi和`pi-subagents`控制面可能正常，但兼容门禁仍被外部模型生命周期判红。
- nested probe把上游模型失败表现为“未产生路由证据”，掩盖真实失败层。
- 测试需要外部Provider和可用凭据，无法作为确定性回归门禁。

## 3. 触发条件

1. 测试动态生成的`compat-worker`、`compat-ordinary`或`compat-plan`agent固定使用`openai-idealab/Qwen3.7-Max-DogFooding`。
2. Provider已下架该模型或当前环境不再提供该model id。
3. 用例等待async child完成或等待其nested route证据。

## 4. 根因

兼容测试把两个独立职责耦合在同一外部依赖上：

- 被测职责是Pi进程、RPC、async lifecycle、wait、Supervisor和工具边界。
- 实际完成child turn却依赖一个会下架的远端模型。

模型不可用时，child在协议行为发生前失败，因此测试无法区分“Harness协议不兼容”和“外部模型不可用”。nested probe继续等待本不可能产生的证据，形成二次超时。

## 5. 根因证据

- 当前Pi版本为`0.82.0`，旧测试首项仍硬编码期望`0.80.6`。
- async `status.json`记录`state=failed`，step error明确为“模型已下架，建议更换新模型”。
- 同一轮测试中不依赖模型完成的interrupt和stop用例通过，说明RPC bridge并非整体失效。
- 仓库已有`test/fixtures/deterministic-provider.mjs`，它通过Pi正式provider接口产生本地确定性assistant/tool事件，不访问远端网络。

## 6. 修复与防复发

1. 控制面兼容测试统一加载`test/fixtures/deterministic-provider.mjs`，固定`fake/deterministic`。
2. 扩展deterministic provider，使其能按测试prompt确定性调用`contact_supervisor`并在reply后输出`COMPAT_OK`。
3. 删除测试中的远端Provider、凭据和具体业务模型依赖。
4. 超时错误必须先报告child terminal failure；只有child仍active时才等待route或Supervisor证据。
5. 真实模型smoke只作为环境证据，不替代确定性Harness协议门禁。
