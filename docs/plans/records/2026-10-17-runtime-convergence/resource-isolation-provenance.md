# T10：resource-isolation 既有失败来源分类

## 分类：test-manufactured（过期断言）

- **首个偏离点：** `test/subagent-runtime-resource-isolation.test.mjs` 断言旧英文 model-facing description 文本，而现行生产描述在 S5 迁移后是中文合同。失败来自断言与已提交生产文本不一致，不是资源隔离行为退化。
- **调用链：** 测试读取注册的 operation tool description → 与硬编码英文串比较 → 不等即失败。生产侧 description 由 `subagent-dispatch/operation-tools.ts` 与 `workspace/operation-tools.ts` 提供，本批未改其语义。
- **数据来源判定：** 断言文本是测试自造期望值，非合法生产入口产出的数据；按门禁只修测试，不给生产增加兼容分支或双语 fallback。

## 处置与证据

- 只迁移断言到当前中文合同；未放宽任何资源隔离、capability ceiling 或工具可见性。
- 迁移后：`node --test --test-name-pattern='model-facing description'` 1/1 exit 0；本轮整文件 `node --test test/subagent-runtime-resource-isolation.test.mjs` → **9 tests / 9 pass / 0 fail，exit 0**，日志 `/tmp/rc-resource-isolation-now.log`。

## 边界

未运行真实 Host 下的资源隔离端到端；本记录只覆盖该既有测试文件的合同断言。
