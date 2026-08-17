# manage-providers 会暴露 provider 凭据

## 问题

`manage-providers` 曾接受 `--key` 和 `set-key <provider> <key>`，使凭据可能出现在命令行历史、进程列表或自动化日志中。`auth.json` 也曾以普通直接写入方式保存，不能保证权限或崩溃期间的一致性。任意 `--header` 还可能把认证 header 写入受 Git 管理的 `models.json`。

## 影响

API key 和会话凭据可能泄露；并发或中断写入也可能损坏或丢失 provider 配置。

## 修复方向

仅允许 `set-key <provider>` 从 `/dev/tty` 的无回显提示读取凭据；凭据不进入 prompt、argv、环境变量、stdin 文本或命令示例。`auth.json` 以 0600 的同目录临时文件、fsync 和原子替换保存。`models.json` 使用锁和原子替换；拒绝敏感 header，并为删除操作要求名称匹配的显式确认。
