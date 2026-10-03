# coordinator git probe 失败缺少诊断

合法 coordinator 刷新授权 HEAD 时，git rev-parse 或 merge-base 失败原本静默返回，保持“不刷新授权头”的安全判定但丢失 workspace、queue item 与原始错误。修复仅增加 diagnosticSink 事件，不改变授权头或 admission 判定。
