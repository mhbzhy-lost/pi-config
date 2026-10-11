# Playwright 页面操作

## 操作顺序

1. 先用 `snapshot` 查看当前页面结构。
2. 只使用 snapshot 中已确认的 role、testId 或 CSS locator；页面跳转后重新 snapshot。
3. 多匹配返回 `locator-not-unique`，不得擅自选择第一个。
4. 任务结束 stop 自己的 instance。

```bash
node "$CLI" --instance task-browser command '{"op":"snapshot"}'
node "$CLI" --instance task-browser command '{"op":"fill","locator":{"kind":"testId","value":"query"},"value":"example"}'
node "$CLI" --instance task-browser command '{"op":"click","locator":{"kind":"role","role":"button","name":"Search"}}'
node "$CLI" --instance task-browser command '{"op":"wait","locator":{"kind":"testId","value":"results"},"state":"visible"}'
node "$CLI" --instance task-browser command '{"op":"inspect","query":"visible","locator":{"kind":"testId","value":"results"}}'
```

## 操作合同

| 操作 | 规则 |
|---|---|
| `navigate` | 只允许 `http:`、`https:` 和精确 `about:blank`；拒绝 userinfo、`file:`、`data:`、`javascript:` |
| `snapshot` | 返回 SDK ARIA 页面结构，不生成旧 MCP refs；结果过大返回 `result-too-large`，不静默截断 |
| `click` / `fill` / `wait` | locator 使用 `role`、`testId` 或已确认 `css`；不能填 password/MFA |
| `inspect` | 只支持 title、count、visible；URL 输出会去掉 query/hash |
| `tabs` | list/new/select/close；使用返回的 tabId，不能关闭最后一页 |
| `screenshot` | 只提供如 `result.png` 的 artifact name；写入实例私有目录、`0600`、不覆盖，不接受路径 |

普通 snapshot/title 可能包含业务页面文字，不是秘密检测器；只在任务授权且不涉及凭据时使用。当前 CLI 没有任意页面 JavaScript、浏览器 storage、网络详情或脚本执行入口。

## 返回和清理

返回是固定 JSON schema，不把任意对象、请求体、cookie 或授权头直通 stdout。`stop` 失败并返回 `stop-unconfirmed` 时，保留现场和租约，不抢占、不按裸 PID 清理。
