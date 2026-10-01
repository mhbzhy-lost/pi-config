# session-owner 启动失败吞掉内部异常

日期：2026-10-01；基线：74e3cc4。

## 现象与首个偏离点

真实 Pi PTY 启动偶发在 registry 留下新的 `pending` / `sessionFile=null` record；`test/session-owner-runtime.integration.mjs:238-248` 等待 active/non-null 直至超时。`var/upgrade/t8-root-cause.md` 五次串行现场显示首次 owner 2/5 未达 active、整条用例 3/5 失败。**可观测性缺陷的首个偏离点是 `src/session-owner/extension.ts:48`：`session_start` 的无绑定 `catch` 抛弃了 `lifecycle.start` 的原始异常**，随后只通知、shutdown 并取消。相邻 `src/session-owner/extension.ts:62` 的 `session_before_switch` 异常也无错误详情。通知文字不能区分身份不匹配、registry 列取异常或路径规范化异常。

## 完整调用链

`test/session-owner-runtime.integration.mjs:85-101` → `/usr/bin/expect` → `scripts/pi-launcher.zsh:34,89-92` → `scripts/pi-session-owner.ts:34,49-76` → `src/session-owner/registry.ts:243-266` 的 `prepareLaunch` 写 pending → `pi/extensions/session-owner.ts` → `src/session-owner/extension.ts:44-52` 的 `session_start` → `identity(ctx)` → `src/session-owner/lifecycle.ts:38-44` 的 `canonical`、`listLiveRecords`、`owns` / `canStart`、`updateOwnRecord` → 异常被 `extension.ts:48` 丢弃 → `notify`、`shutdown`、`{ cancel: true }` → registry 未达到 ready 谓词。switch 路径为 `extension.ts:54-65` → `lifecycle.beforeSwitch` → `sourceIsUnavailable` / `listLiveRecords`；外层 catch 同样丢弃异常。

## 数据来源与分类

可观测性缺陷：**类别 1**；真实公开 Host extension 事件处理器自身的 catch 会无条件吞掉真实错误，不依赖模拟的非法数据。T8 pending 现场仍为**类别 3**（来源尚未证实）：由真实 launcher 和隔离临时 registry/测试 provider 产生，但错误来源、运行身份与生产资源对照尚未取得；在追加日志后重新取证，不对 `canStart` / `matches` / `owns` 或抛错条件作猜测性改动。此前 ownerId 碰撞已由 `var/upgrade/t8-root-cause.md` 的权威 registry 快照否证。

## 影响面与修复方向

启动失败仍安全取消，但运维无法判断具体原因，阻碍区分生产缺陷、测试夹具问题与未知来源；switch 的内层异常也不可追溯。仅在两个外层 catch 把异常与 cause 输出到诊断通道，维持既有通知、shutdown、cancel 行为。目录内其他静默形态另行审计，不越界修改判断逻辑。
