# Bug: 无关 lsof warning 阻塞 managed worktree 安全释放

## 症状

在 macOS 上执行 managed worktree release 时，`lsof` 会因无关的 Time Machine SMB mount 向 stderr 输出 warning。生命周期保护将任何 stderr 视为探测不可用，因而即使 worktree 没有进程、文件也没有被打开，release 仍以 `WORKTREE_LIFECYCLE_UNSAFE_RELEASE` 失败并留下 cleanup debt。

## 影响

无关 SMB warning 使所有受影响主机上的 managed release fail closed，Goal 的后续释放与验收被阻塞。

## 根因

`activeWorkspaceUsers` 和 `activeDeletedResourceUsers` 未向 `lsof` 传递其官方 warning 抑制选项 `-w`。stderr 的 fail-closed 保护本身正确，但 warning 与真实探测异常没有在调用 lsof 前区分。

## 修复

仅在这两个 lsof 探测的参数中加入 `-w`。继续把非空 stderr、status 大于 1、error、signal 及 malformed stdout 视为 `WORKTREE_LIFECYCLE_UNSAFE_RELEASE`；真实 cwd 用户和已删除但仍打开的资源仍阻止 release。

## 验证

使用 fake lsof 复现：缺少 `-w` 时输出 Time Machine SMB warning 并以 status 1 退出；收到 `-w` 后，`+D` 与 `+L1` 均返回无匹配的 status 1。修复前 release 被阻断，修复后成功，并记录所有两类 probe 均传入 `-w`。
