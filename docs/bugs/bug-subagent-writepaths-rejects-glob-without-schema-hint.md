# Subagent writePaths 拒绝 glob 但 schema 未提示

## 现象

派发契约在 `boundaries.writePaths` 使用 `docs/bugs/bug-ai-socket-full-game-*.md` 时返回 `INVALID_PATH`，提示不支持路径模式。

## 影响范围

需要在发现未知 bug 后按摘要创建新根因文档的任务，无法预先声明动态文件名；调用方也无法从工具 schema 得知只接受精确路径。

## 复现步骤

提交合法 `dispatch-ir.v1`，在 `writePaths` 中放入带 `*` 的单个路径；其余字段合法，工具立即拒绝。

## 根因

运行时校验把 writePaths 定义为精确路径，但公开 schema 仅声明字符串，没有 pattern 或“禁止 glob”的说明。

## 修复方案

在 schema/错误文档明确 writePaths 只接受精确路径；若要支持 bug-first 流程，可允许受限目录前缀或显式 `writeDirectories` 字段。

## 验证方式

增加契约测试：精确文件通过、glob 给出可操作错误、受支持的目录授权按文档工作。
