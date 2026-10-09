# verify-package 默认 npm cache 指向旧仓

## 来源与分类

这是 production verifier 的默认配置缺陷（类别 1）：两个真实 npm 执行入口 `npmPackUpstream` 与 `npmPackDryRun` 在未设置 `npm_config_cache` 时，会生成 `${HOME}/pi-config-upgrade/var/tmp/npm-cache`。入口由 `verifyEnhancedPackage` 的上游包校验和 dry-run 打包流程调用，属于正常 production 路径；不是测试手工拼接的数据。

## 生成链与首个偏离点

`verifyEnhancedPackage` → `verifyControlledUpstream` → `npmPackUpstream`，以及 `verifyEnhancedPackage` → `npmPackDryRun`。两个入口在构造 npm 子进程环境时以旧仓 HOME 路径作为 fallback，首个偏离点是 `npm_config_cache` 默认值。显式 `process.env.npm_config_cache` 已是合法覆盖，应继续保留。

## 修复策略

默认 cache 从脚本所属 package 路径推导到权威主仓 `var/tmp/npm-cache`，不删除旧仓目录、不改变 manifest/lock、不触发网络安装。测试使用受控 fake npm CLI 捕获两个真实执行入口收到的 env，避免 grep 源码或 npm pack/install 网络副作用。
