# Coordinator Unix Socket 路径过长

## 现象

真实 macOS production probe 在长路径临时 Git 仓库中发现，当前 endpoint
`<git-common-dir>/.pi-coordinator/coordinator.sock` 触发 `net.listen` 的 `EINVAL`。
Root A 进行了 3 次、Root B 进行了 2 次 production typed subagent tool start/end；两
个 Root 均因 coordinator `extension_error` 失败，0 个 child ready。首个偏离点是
coordinator 对该路径调用 `listen`，而不是 queue 或 workspace lifecycle。该问题分类为
production 可达。

第三次 production probe 进一步暴露了 endpoint propagation 缺口：registry 已将长
common-dir 映射为 hash socket，但 Root A 在 first-tool 阶段仍尝试连接
`/tmp/pi-workspace-coordinator-501/coordinator.sock` 并收到 `ENOENT`。Root B 随后被
induced `SIGTERM` 终止；最终仍为 0/5 child ready。该路径确认短 socket 的生成本身已
生效，偏离发生在 runtime 重新拼接固定 basename，且 process/client handshake 未绑定
metadata endpoint 与 instance identity。

## 根因与修复边界

Unix socket endpoint 不再跟随可能很长的 Git common-dir。metadata、owner 语义和 lock
继续由 common-dir 下的私有 `.pi-coordinator` 目录权威维护；endpoint 改为按 UID 和
repository common-dir hash 选择的固定 `/tmp/pi-workspace-coordinator-<uid>/` 下短路径。
metadata 仍保存完整 repositoryId、stateRoot、instanceId、PID birth identity 和 endpoint，
因此 stale takeover、stateRoot fencing 及不同仓库隔离继续由 canonical metadata 决定。
runtime、coordinator process 和 client 均直接消费 claim metadata；server 的 listen 参数、
process ready handshake 及 client registration reply 校验绑定同一 repositoryId、instanceId
和 endpoint，不再从 runtime directory 推导 socket basename。

## 验证

T3 coordinator integration 测试构造足够长的 common-dir，实际创建 server 并调用
`net.listen` 与 `net.createConnection`；测试同时检查 metadata/runtime 目录权限。没有用
字符串长度镜像断言替代 socket 操作。

第三次 probe 的回归测试另将 endpoint basename 视为可变实现细节，并通过真实
`coordinator-process` listen、Root Broker challenge、client registration/ping 验证完整传播；
同时覆盖 runtime 直接使用 claim metadata，避免再次连接固定 `coordinator.sock`。
