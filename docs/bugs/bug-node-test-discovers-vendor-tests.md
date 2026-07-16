# Bug：默认测试命令误执行 vendor 测试

## 1. 现象

在仓库根目录运行 `npm test` 时，本仓 7 个测试通过，但 Node 随后继续执行
`vendor/superpowers/tests`。其中一个测试缺少上游开发依赖 `ws`，另一个参数化脚本被
当作无参数测试直接执行，最终命令失败。

## 2. 影响

- 本仓全量验证无法得到稳定的绿色结果。
- 测试结果受 vendor 内部测试布局和开发依赖影响。
- 后续 Superpowers 升级可能在未修改本仓代码时改变本仓测试集合。
- `npm test` 不能作为 CI 和发布门禁。

## 3. 稳定复现

环境：Node.js `v26.0.0`，Superpowers `v5.1.0`。

```bash
npm test
```

每次都会发现 `vendor/superpowers/tests/brainstorm-server/server.test.js` 和
`vendor/superpowers/tests/opencode/test-bootstrap-caching.mjs`，并以非零状态退出。

## 4. 证据

- `package.json` 将 `test` 定义为无路径约束的 `node --test`。
- Node 的默认测试发现会从当前工作目录递归匹配测试文件。
- `vendor/superpowers` 是本仓工作树的一部分，包含上游自己的 `tests/`。
- 单独运行 `node --test "test/**/*.test.mjs"` 时，仅执行本仓 7 个测试并全部通过。
- 失败堆栈明确来自 `vendor/superpowers/tests`，而不是 `test/`。

## 5. 根因

根因是本仓测试入口没有声明测试边界。`node --test` 的默认递归发现与 vendor 子模块
共存时，会把第三方上游测试误认为本仓测试。缺少 `ws` 只是首个暴露症状；安装该依赖
不能解决测试所有权和隔离问题。

## 6. 修复与验证策略

- 先增加契约测试，要求 `package.json` 的测试入口显式限制在
  `test/**/*.test.mjs`。
- 将 `npm test` 改为 `node --test "test/**/*.test.mjs"`。
- 保留定向测试能力，执行代理直接使用
  `node --test test/<name>.test.mjs`，不再向 `npm test` 追加路径。
- 验证 `npm test` 只运行本仓测试且全部通过。
- 验证输出中不再出现 `vendor/superpowers/tests`。
