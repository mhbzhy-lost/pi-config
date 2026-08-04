# Goal Engine rename 可绕过 writePaths 源路径授权

## 现象
`forbidden/secret.txt -> allowed/secret.txt` 后 changedFiles 只有目标路径，`allowed/**` 被错误放行。

## 影响
Executor 可读取并搬运未授权路径中的内容，把越权来源包装成允许路径后集成。

## 稳定复现
在 base 提交 `forbidden/secret.txt`；Executor worktree 执行 `git mv` 到 `allowed/secret.txt` 并提交；检查仅允许 `allowed/**`。

## 根因
`git diff --name-only` 对 rename 只提供一个展示路径，丢失 name-status 中的源路径身份。

## 本次处置
使用 `git diff --name-status -z --find-renames --find-copies-harder`，rename/copy 同时返回源和目标路径。

## 防复发
单元测试和 Extension 端到端测试均要求两侧授权；普通 add/modify/delete 行为保持不变。
