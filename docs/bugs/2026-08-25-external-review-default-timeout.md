# 外部评审默认超时过短

## 问题

external-llm-review 的 API 硬超时默认为 180 秒。一次 13,188-char exhaustive
diff 分别提交给 `idealab-anthropic` 和 `idealab-openai` 时，两个请求都在
`api_timeout_seconds=180` 被客户端硬超时，均没有返回评审结论。

## 证据

- 两个 provider 都完成了 provider 配置并开始请求。
- 两次请求均在客户端 `api_timeout_seconds=180` 到期时终止。
- 未观察到认证错误或 HTTP 错误；也没有评审结论返回。

## 影响

exhaustive review 可能需要数分钟。当前默认值会在模型完成评审前终止请求，
push gate 还可能在 reviewer 完成清理前由更短的外层进程超时终止。

## 修复方向

将 API 硬超时默认值提高到 600 秒，并让 push gate 显式传入 600 秒；外层进程
超时调整为 660 秒，为 reviewer 清理和启动保留余量。
