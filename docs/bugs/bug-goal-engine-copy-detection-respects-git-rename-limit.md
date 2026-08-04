# Goal Engine copy source 检测受 Git renameLimit 配置影响

## 时间
2026-08-04（复现于本次修复前的 `7c74fae`）。

## 地点
Goal Engine 的 executor workspace 安全检查：`scripts/lib/goal-engine/workspace.mjs` 中 `inspectExecutorWorkspace` 调用的 Git diff。

## 人物
独立 reviewer 在真实 Git 仓库中完成 probe；Goal Engine 的 writePaths gate 消费该 probe 产生的 `changedFiles`。

## 事件
reviewer 将仓库配置设为 `diff.renameLimit=1`，在受保护的 `forbidden/source.txt` 保持不变的情况下，把其内容复制到允许目录 `allowed/copy.txt`，并制造足够的候选使 copy detection 超过该限制。当前命令为：

```sh
git diff --name-status -z --find-renames --find-copies-harder base..head
```

Git 输出 `A\0allowed/copy.txt\0`，同时给出 rename limit 已跳过 exhaustive rename/copy detection 的 warning。因而 NUL-safe parser 只能得到 `allowed/copy.txt`，遗漏 `forbidden/source.txt`。

## 原因
安全命令没有显式传入 rename/copy limit，默认继承 repository/global 的 `diff.renameLimit`。攻击者可通过提交前可控仓库配置将其设得很小，令 `--find-copies-harder` 降级。

## 结果
当任务只声明 `writePaths: ["allowed/**"]` 时，gate 错误通过（`gatePassed=true`），随后 executor commit 被集成（`integratedCopy=true`）；受保护 origin 未被 writePaths gate 拦截。修复应在安全 diff 调用中显式加入 Git plumbing 支持的 `-l0`，同时保留 rename、copy 和 NUL-safe 双路径解析。
