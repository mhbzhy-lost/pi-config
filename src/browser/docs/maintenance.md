# browser runtime 维护与验收

## 目录边界

实现、依赖、测试、fixture、验收和二级文档必须留在 `src/browser/`。browser tool 直接调用本目录的 runtime；不要恢复外部 skill 或 CLI 入口。

## 本地验证

```bash
cd src/browser
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts
npm run typecheck
npm test
npm run verify
```

`npm test` 只执行契约/生命周期/操作/CLI 单元测试；真实 Chrome 测试文件不匹配默认 test glob，只由 `npm run verify` 显式执行。Chrome 缺失或真实 gate skip 是 blocked/失败，不是通过。

## 依赖与变更审计

- 只使用根 package-lock 锁定的依赖；不使用 npm `_npx` 缓存或 MCP。
- `playwright` 与 `playwright-core` 必须是同一稳定版本；安装时使用 `--ignore-scripts` 和 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`，除非用户另行批准资源安装。
- 静态审计范围是browser 工具 的源码、文档、测试、package/lock；不得把仓库其他 feature 的 MCP 字符串当作browser 工具 失败。
- 真实验收只使用新的临时 profile 和无认证本机页面；不读已有认证 profile，不做真实 SSO。
- 变更后检查 `git diff --check`，并确认没有凭据、浏览器 profile 或验收产物进入 Git。
