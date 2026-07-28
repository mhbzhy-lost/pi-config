# Bug：Git 工作树覆盖绕过 workspace 外删除门禁

## 1. 现象

从 `/Users/leshi.zhy/empty-dir` 启动的 Pi 会话中，直接执行 `rm /Users/leshi.zhy/pi-config/...` 会被阻断；改用 `git --git-dir=/Users/leshi.zhy/pi-config/.git --work-tree=/Users/leshi.zhy/pi-config rm ...` 后，外部工作树中的文件会被成功删除。

## 2. 影响

Agent 可以从当前 workspace 外选择任意 Git 仓库和工作树，再通过 `git rm` 删除其中的受跟踪文件。`GIT_DIR` 与 `GIT_WORK_TREE` 环境变量形式具有相同影响，使 workspace 删除边界失效。

## 3. 稳定复现

创建当前 workspace 和外部 Git 工作树，在外部工作树暂存一个测试文件。策略会阻断直接 `rm`，却对以下命令返回允许，实际执行后测试文件消失：

```sh
git --git-dir=<outside>/.git --work-tree=<outside> rm -f victim.txt
GIT_DIR=<outside>/.git GIT_WORK_TREE=<outside> git rm -f victim.txt
```

## 4. 证据

会话 `019f8e84-cc22-7162-b8cf-6e08e5289e09` 的 cwd 是 `/Users/leshi.zhy/empty-dir`。其中两次普通 `rm` 均返回“禁止 workspace 外 rm”，但后续 `git --git-dir=... --work-tree=... rm ...` 返回成功并删除 `scripts/lib/bash-compact-renderer.mjs` 与对应测试文件。临时仓库最小复现也观察到策略返回 `ALLOW` 且目标文件被删除。

## 5. 根因

`shell-policy.mjs` 只将命令名为 `rm` 的调用交给 workspace 路径检查；Git 策略仅禁止部分破坏性子命令和 `git -C`。它会跳过 `--git-dir`、`--work-tree` 以寻找子命令，却不禁止这些工作上下文覆盖；`unwrap()` 还会丢弃 `GIT_DIR`、`GIT_WORK_TREE` 前缀，导致策略看不到 Git 的真实工作树。

## 6. 修复与验证策略

像现有 `git -C` 一样 fail-closed 禁止显式 Git 仓库或工作树覆盖，包括参数的分离/等号形式及 `GIT_DIR`、`GIT_WORK_TREE` 环境形式；普通当前 workspace 内的 Git 命令保持不变。先增加历史命令形态的 RED 测试，再实现最小策略检查，并运行 shell policy 与 security gate 全部测试。
