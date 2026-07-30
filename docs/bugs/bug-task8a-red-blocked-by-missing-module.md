# Bug：Task 8A RED 被缺失模块统一阻断

## 症状

`test/process-birth-identity.test.mjs` 的五个测试在 `process-birth-identity.ts` 缺失时都使用同一个 throwing fallback，并首先抛出 `PROCESS_BIRTH_IDENTITY_MODULE_MISSING`，没有抵达各自的目标断言。

## 影响

当前 RED 不能证明非法 PID、精确 `ps` 参数、完整 stdout 哈希、空输出和 `ps` 失败的闭合失败，以及存活进程身份稳定性。生产实现即使违反其中任一合同，也可能被统一的模块缺失错误遮蔽。

## 复现

运行 `node --test test/process-birth-identity.test.mjs`。五项都会失败，但 exact hash 和真实进程测试直接抛出自定义模块缺失错误，其余测试只比较该错误码，而非验证约定的行为。

## 根因

tests-only 阶段用单一 fallback 处理导入失败，方便标记模块尚未实现，却把所有行为测试收敛到同一前置异常。测试没有为每项行为提供最小局部替身，因此目标断言没有独立的 RED 证据。

## 修复

保留生产模块存在时使用真实导出；模块缺失时改为每个测试自己的最小 fallback。将非法 PID 的错误码和零次调用拆开，将精确 argv 与完整未裁剪 Buffer 哈希拆开；每项 fallback 只制造该项目标断言的失败。

## 验证

分别按测试名称运行，并运行完整测试文件。预期所有项仍为 RED，但失败信息只包含 `Missing expected rejection`、`Expected values` 或 `must not invoke` 等目标断言，不出现 module-missing、模块解析错误、类型错误、引用错误、语法错误、超时或取消。
