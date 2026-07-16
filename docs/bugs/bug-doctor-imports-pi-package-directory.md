# Bug：Doctor 将 Pi Package 目录当作 ESM 入口

## 1. 现象

`pi-subagents@0.34.0` 已正确安装时，doctor 仍报告 `pi-subagents RPC probe failed`。

## 2. 影响

执行 `init-pi.sh` 后 `npm run doctor` 会失败，初始化流程无法完成；用户会误以为社区包损坏。

## 3. 稳定复现

创建版本为 `0.34.0`、声明 `pi.extensions` 且入口文件存在的临时 package，然后调用 `inspectConfiguration()`。

## 4. 证据

当前实现调用 `import(pathToFileURL(<package-directory>))`。Node ESM 对绝对目录抛出 `ERR_UNSUPPORTED_DIR_IMPORT`；`pi-subagents@0.34.0` 的 `package.json` 也没有 `main` 或 `exports`，真实入口位于 `pi.extensions[0]`。

## 5. 根因

Doctor 把 Pi package 的扩展发现协议误当成 Node package 默认入口协议。Pi 根据 `package.json` 的 `pi.extensions` 加载 Extension，不会导入 package 根目录。

## 6. 修复与验证策略

版本匹配后读取并校验 `pi.extensions` 至少包含一个安全的相对路径，并确认每个声明入口可读；缺失或不可读继续使用 `pi-subagents RPC probe failed` 诊断。用完整临时 fixture 验证零误报，并保留缺失、错版本、坏入口测试。
