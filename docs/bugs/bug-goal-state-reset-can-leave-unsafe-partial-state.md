# Goal reset 可能留下不安全的半完成状态

## 根因

`secureFile` 原先以路径执行 `lstat`、`readFile`、再 `lstat`。路径解析和读取不是同一文件描述符，攻击者可以在读取期间替换路径并在最终检查前恢复，从而使检查身份与被读取内容不一致（TOCTOU）。

reset 先替换 registry，再删除退役 goals。若退役目录删除失败，旧实现仅报错而不回滚：新 registry 已声明空状态，退役目录却仍在根目录，使后续 inspect 拒绝该根目录。此时既不能作为空状态使用，也不能作为原状态 inspect。

## 复现与断言

两项确定性集成 RED 分别以最小文件系统故障注入复现：读取期间替换 registry 路径必须被拒绝；退役目录清理失败后，`stateHash`、`goalIds` 和 events ledger 字节必须与 reset 前一致，且不遗留临时 registry 或 retired 目录。二者均不依赖调度 race，也不改变 CLI 边界。

## 修复方向

文件应以 `O_NOFOLLOW` 打开，在同一 fd 上前后 `fstat` 并读取，最后以 `lstat` 验证路径仍指向该 fd 身份；同时验证常规文件、单链接及 `0600` 模式未漂移。reset 清理失败时必须在锁内恢复原 registry 与 goals；若恢复本身失败，返回稳定的 `RECOVERY_REQUIRED`，保留文件系统诊断而不回显 ledger 内容。
