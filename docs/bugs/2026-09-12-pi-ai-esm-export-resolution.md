# Pi AI ESM 公共子路径解析导致扩展启动失败

## 现象

全局 Pi 升级到 `0.85.1` 后，正常启动加载 `pi/extensions/openai-codex-proxy.ts` 失败：

```text
No "exports" main defined in @earendil-works/pi-ai/package.json
```

用户只能以安全模式恢复会话，所有新 subagent Host 同样在 extension load 阶段失败。

## 数据来源分类

分类：预期 production 数据未被正确处理。

实际入口是全局 `@earendil-works/pi-coding-agent@0.85.1` 正常发现并加载仓库配置根下的 `openai-codex-proxy.ts`。Host package、版本、extension discovery 顺序和 provider 注册均为合法 production 路径，不是测试 fixture 制造的数据。

## 首个偏离点

`hostPackageEntry("@earendil-works/pi-ai")` 使用 `createRequire(...).resolve()` 解析只有 ESM `import` condition 的 package export。`pi-ai@0.85.1` 的 `exports["."]` 没有 `require` condition，因此 resolver 在 extension factory 执行前失败。

即使 root export 可以解析，`streamOpenAICodexResponses` 也不由 package root 导出；该 API 位于公开子路径 `@earendil-works/pi-ai/compat`。

## 完整调用链

```text
Pi 0.85.1 startup
-> extension discovery
-> openAICodexProxyExtension()
-> createOpenAICodexProxyExtension()
-> loadCodexApi()
-> hostPackageEntry("@earendil-works/pi-ai")
-> createRequire().resolve()
-> ESM-only export 无 require condition
-> extension load 失败
```

## 预期行为

扩展应通过 ESM dynamic import 加载公开的 `@earendil-works/pi-ai/compat` 子路径，并取得 `streamOpenAICodexResponses`。不得回退到 `dist/compat.js` 或依赖发布目录布局。

## 验证

先在 `test/openai-codex-proxy-extension.test.mjs` 增加默认 API loader 测试并观察 RED，再实施最小修复；GREEN 后用正常 `pi --version`/fresh subagent startup 验证 extension 可加载。
