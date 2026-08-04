# Bug：升级时 pre-birth owner 恢复死锁

## 现象
旧 owner 缺少新版 birth/protocol 元数据时，升级后的恢复无法区分死亡和存活 owner。

## 影响
死亡旧锁会永久阻塞；若把缺失身份当 mismatch，又会误删存活 owner。

## 根因
旧协议只有 pid/token/createdAt，不能用于新版 canonical birth 比较。

## 修复
owner 写入 protocol 与 identity-kind；解析兼容旧目录和旧 guard。仅 kill(0)=ESRCH 可机械证明旧 PID 死亡并隔离；存活、EPERM 或身份未知一律保留。

## 验证
覆盖死亡 legacy directory、死亡 pre-birth guard，以及 locale/TZ 旧格式 live owner timeout。

## 预防
协议迁移须显式版本化，并把不可比较的存活身份视为 unknown。
