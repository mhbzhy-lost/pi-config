# Bug：Native child renderer 路径检查与实际读取存在替换竞态

## 1. 现象

Renderer 先对 `sessionFile` 执行 `lstat/realpath/size` 检查，随后把解析后的 path 交给 `SessionManager.open()` 再次打开。两次操作没有绑定到同一个文件描述符。

## 2. 影响

同用户进程可在检查完成后、实际 open 前替换文件或中间目录，使 renderer 读取未经 trusted-root 与大小检查的内容。文件也可在 size 检查后增长超过 64 MiB。该路径来自异步 child status，不能把静态检查结果视为后续 open 的身份保证。

## 3. 稳定复现

通过在 path-check 完成和 injected `openSession()` 执行之间替换目标，可以让检查观察合法 inode，而 parser 打开替换后的 inode。现有依赖注入恰好暴露该边界；静态 outside-root 和 final-symlink fixture 无法覆盖时序替换。

## 4. 证据

`checkPath()` 返回 `realPath/fingerprint` 后释放所有文件系统状态；`render()` 随后调用 `this.openSession(checked.realPath)`。没有 `O_NOFOLLOW` fd、`fstat` 身份比对、有界读取或不可变 snapshot 连接两个阶段。

## 5. 根因

安全验证以 path 字符串为授权对象，但 path 是可变命名；真正稳定的读取对象应是通过 no-follow open 获得并经 `fstat` 确认的 fd。公开 `SessionManager.open()` 只接受 path，因此直接把已检查 path 传入无法保持对象身份。

## 6. 修复与验证策略

先增加可控替换失败测试，证明 injected open 不能看到检查后替换的源文件。实现应以 `O_RDONLY|O_NOFOLLOW` 打开、用 `fstat` 核对 regular file/inode/size，并从该 fd 复制最多已确认长度到 mode 0600 的私有临时 snapshot；仅把 snapshot path 交给公开 `SessionManager.open()`，解析后在 finally 清理。Fingerprint 应来自已打开 fd。不得自行解析 JSONL，也不得留下 snapshot 或放宽 trusted-root containment。
