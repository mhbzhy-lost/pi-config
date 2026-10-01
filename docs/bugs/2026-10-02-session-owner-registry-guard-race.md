# session-owner registry guard 争用导致启动失败

日期：2026-10-02。

## 现象

真实 Pi PTY 并发执行 registry 的 create/read/release 时，`session_start` 偶发停留在 `pending` 且 `sessionFile=null`，`readyPty` 等待 active 记录超时。现场 `var/upgrade/t8-observed-{1..5}.raw.log` 与对应 trace 显示 5 次串行运行失败 3 次（首 owner 1/5，replacement owner 2/5）。

## 首个偏离点与调用链

首个已确证的偏离点是 `src/session-owner/registry.ts:153`：`acquireGuard` 读取已存在的 `.guard` 失败时，将底层异常无条件转换为无 cause 的 `registry guard is invalid`。完整调用链为：

`test/session-owner-runtime.integration.mjs:499-541` → `/usr/bin/expect` → `scripts/pi-launcher.zsh:47,89-92` → `scripts/pi-session-owner.ts:34,49-66` → `registry.ts:243-266 prepareLaunch`（写 pending）→ Pi extension `src/session-owner/extension.ts:44-52` → `lifecycle.ts:38-44 start` → `registry.ts:274 listLiveRecords` → `registry.ts:147-153 acquireGuard`。

此前保留的异常栈在 `var/upgrade/t8-observed-{1..5}.trace.json` 的 output 中指向 `registry.ts:153:18`、`withGuard:169`、`listLiveRecords:274`、`lifecycle.ts:40`、`extension.ts:47`。因此不是 `canStart` 身份判定拒绝；安全谓词尚未执行。

## 数据来源分类与影响面

分类为类别 1：真实 launcher、真实 repo-local 0.87.1 Host extension 与未替换的 public registry API 共同访问同一 registry；跨进程 create/read/release 是合法生产使用。非手工 projection、非非法 record。影响面包括 session_start、session_before_switch、before_fork 和 watcher 对 registry 的读取；当前错误会安全取消启动，但损害可诊断性并导致合法 owner 无法晋级 active。

## 取证方案与证据

第一阶段只增加原始错误与失败瞬间 `.guard` 快照，不改变 `canStart`、`matches`、`owns` 或 fail-closed 判定。原始证据目录为 `var/upgrade/`：`t8-observed-{1..5}.raw.log`、`*.trace.json`（既有异常栈），以及本轮新增的 `registry-guard-*.json` / `*.log`（底层 syscall/JSON 错误、cause 链、存在性/大小/内容/mtime/可解析性快照）。快照用于区分 guard 半写、释放瞬间 ENOENT 与其它损坏；损坏仍阻断，不删除 guard。

## 修复方案

对 guard 采用原子发布：先在同一 caller-owned 0700 目录写入临时文件、fsync/close，再以 `link` 方式以 exclusive 语义发布到 `.guard`，最后删除临时文件。读取方只会看到完整文件，不会看到 O_EXCL 创建后尚未写完的中间态；已有 guard 仍按原规则读取并等待，任何真实损坏仍 fail closed。读取/释放异常保留原始 error 与 cause 链。此修复不放宽任何安全判定、不清除已有 guard、不把损坏 guard 当作空闲。

## 目录内静默盲区

`lifecycle.ts` 的 sourceIsUnavailable/beforeSwitch/beforeFork 继续返回原有 fail-closed 布尔值，但将底层错误输出到诊断日志；`extension.ts` 的 notify、shutdown、before_fork、session_shutdown 错误将带原始异常详情输出；`registry.ts` 统一错误保留 cause。通知与 cancel/shutdown 判定保持不变。

## 验收证据

RED 原始输出、取证输出、GREEN 输出、runtime 连续两遍日志与 5 次 SIGKILL 重跑日志统一记录在 `var/upgrade/registry-guard-*`；最终汇总见 `var/upgrade/registry-guard-fix.md`。
