# Live lifecycle RED 使用错误的 revived caller token

## 1. 现象

post-proof wake GREEN 后，前两条新测试通过，第三条在 generation 2 `subscribe` acknowledgement 上得到 `success=false`，尚未执行“无第二次 resume”的核心断言。

## 2. 影响

测试把认证失败误报为 debt 消费失败，可能诱导 production 放宽 caller token 或 alias 校验。

## 3. 时间线

- tests-only RED 使用 `createLiveLifecycleFixture()` 先 spawn Executor，再触发 Plan Runner revival。
- GREEN 使 revival 实际发生后，第三条测试首次走到 generation 2 subscribe。
- focused run 定位失败行为为 `false !== true` 的 subscribe acknowledgement。

## 4. 根因

fixture token 序列为 `a`、`b`、`c`：初始 Plan Runner 消费 `a`，live lifecycle 前的 Executor grant 消费 `b`，revived Plan Runner grant 消费 `c`。测试错误地沿用无 Executor fixture 的 `b` token。

## 5. 触发条件

测试完成 live Executor spawn 和 successful revival，并使用硬编码 `b.repeat(64)` 认证 generation 2 subscription 时触发。

## 6. 修复与验证

只把第三条测试的 revived caller token 改为 `c.repeat(64)`；production token、grant、alias 和认证逻辑不变。重新运行三条 live lifecycle 测试，确认其到达并通过“next generation proof does not resume again”断言。
