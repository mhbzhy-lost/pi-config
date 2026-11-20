# Playwright 页面操作

## 操作顺序

1. 先用 `snapshot` 查看当前页面结构。
2. 只使用 snapshot 中已确认的 role、testId 或 CSS locator；页面跳转后重新 snapshot。
3. 未匹配返回 `locator-not-found`，多匹配返回 `locator-not-unique`，不得擅自选择第一个。
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
| `aone-config-readonly` | 固定 app `332260`，仅 `verify` 和指定单环境 `export`；不接收 URL、locator、脚本或输出路径 |

普通 snapshot/title 可能包含业务页面文字，不是秘密检测器；只在任务授权且不涉及凭据时使用。当前 CLI 没有任意页面 JavaScript、浏览器 storage、网络详情或脚本执行入口。

## 动作失败错误码

`click`、`fill`、`wait` 等动作失败时，stage 固定为 `operation`，只返回下列 code，不返回 Playwright 原始错误文本（其中含元素 HTML 片段和页面文字）：

| code | 含义 | 下一步 |
|---|---|---|
| `locator-not-found` | 当前页面没有匹配该 locator 的元素 | 重新 snapshot 并核对 role/name、testId 或 css |
| `locator-not-unique` | 匹配到多个元素 | 收窄 locator，不擅自取第一个 |
| `element-not-visible` | 元素存在但不可见 | 等前置状态；必要时先 `wait` |
| `element-not-stable` | 元素位置持续变化（动画、重渲染） | 先等稳定，或改为定位稳定父节点 |
| `element-intercepted` | 其他元素接收了指针事件（覆盖层、loading、toast 等） | 先处理或关闭遮挡元素；属于页面状态，不是工具故障 |
| `element-outside-viewport` | 元素在视口外 | 先滚动到可见，或改用可滚动容器内的定位 |
| `element-disabled` | 元素被禁用 | 等启用条件满足 |
| `element-detached` | 元素或 frame 已从 DOM 移除 | 重新 snapshot |
| `navigation-failed` | 导航被网络或地址错误拒绝 | 核对 URL 与可达性 |
| `navigation-timeout` | 导航在 `20秒` 内未达到 load | 先用较小页面复核，不重复撞同一个超时 |
| `action-timeout` | 动作在 `30秒` 动作预算内未完成 | 结合上面具体原因定位，不直接判定为工具故障 |
| `operation-timeout` | 整个操作超过 `45秒` 操作预算 | 该操作已被放弃，实例和 tab 保留；必要时 stop 后重建 |
| `operation-failed` | 未归类的失败 | 属于需要排查的未知缺陷，记录首次偏离点 |

动作预算（`30秒`）小于操作预算（`45秒`），所以正常情况下先返回具体动作原因，不会先撞上协议层超时。

## 返回和清理

返回是固定 JSON schema，不把任意对象、请求体、cookie 或授权头直通 stdout。`stop` 失败并返回 `stop-unconfirmed` 时，保留现场和租约，不抢占、不按裸 PID 清理。

## Aone 配置只读操作

先用既有 `navigate` 到 `https://cd.aone.alibaba-inc.com/unite/micro/app/332260/configitem`，再通过同一个 instance 的 `command` 调用：

```bash
node "$CLI" --instance aone-task command '{"op":"aone-config-readonly","action":"verify"}'
node "$CLI" --instance aone-task command '{"op":"aone-config-readonly","action":"export","environment":"daily"}'
```

`verify` 只接受 `op/action`，成功返回 `{"kind":"status","value":"ok"}`。`export` 必须提供 `environment`，只允许 `daily/prepub/publish`，不允许 `all/project`。任何额外字段都拒绝。固定操作不自行导航，不接通导入、删除或应用配置。

当前主 frame 的 origin/path 必须精确匹配上述 management top；无子 frame 时使用主 frame，有子 frame 时只允许一个直接子 frame，且 origin/path 必须为 `https://cd.aone.alibaba-inc.com/ec/app/332260/configItem/schema`。query/hash 不用于授权，也不回传。SDK 内部检查唯一可见且启用的“导入/导出”按钮；只点击“导出”和唯一导出 dialog 的“确定”。dialog 必须有四个唯一关联标签的 checkbox、唯一“确定/取消”，不能有 textarea。只勾选指定环境，`project()` 始终取消。

点击“导出”后，固定等待唯一可见 dialog 最多 `5秒`，随后执行四个 checkbox 和“确定/取消”校验；不轮询或选择歧义匹配。导出只接收一次下载：在点击前安装监听，固定等待开始最多 `5秒`，读取流最多 `5秒`，完成后再观察约 `200ms` 并持续监听至下载清理结束。该有界窗口不能证明页面将来不会再次触发下载。以流读取最多 `1MiB`，拒绝空文件、失败下载、无效 UTF-8/env 格式、重复 key 和 `KeyCenter/掉码/masked/redacted/hidden/***` 等不可验证值。正文不进入返回、日志或错误。成功结果固定为：

```json
{"kind":"aone-config-artifact","name":"aone-config-daily.env","bytes":123}
```

文件名按环境固定为 `aone-config-{daily|prepub|publish}.env`，大小 `1..1048576`。文件写入 `~/.playwright-sdk/artifacts/<instance>/<name>`；目录必须为当前用户所有的真实 `0700` 私有目录，文件使用独占创建、禁止跟随 symlink、`0600`，不覆盖。helper 可用已知 instance 和结果中的固定 name 定位文件；读取时仍须核对真实目录、所有者、普通文件、`0600` 和大小，消费后由 helper 删除。`stop` 保留成功 artifact，与截图生命周期一致。

所有操作错误 stage 固定为 `aone-config-readonly`，只输出以下 code，不输出页面文字、URL query、下载名或正文：

| code | 含义 |
|---|---|
| `management-top-unverified` / `management-frame-unverified` / `management-controls-unverified` | 当前页面、frame 或管理控件未唯一验证 |
| `export-dialog-unverified` / `environment-selection-unverified` | dialog、标签关联或勾选结果未唯一验证 |
| `export-download-unconfirmed` / `export-too-large` | 下载数量、状态、读取期限或大小不符合合同 |
| `export-format-invalid` / `export-masked-unverifiable` | 下载格式或值不可验证 |
| `unsafe-artifact-root` / `artifact-exists-or-unsafe` / `export-file-invalid` | 目录、目标文件或写入后校验失败 |
| `export-cleanup-failed` | 下载删除或本次失败文件清理未确认；后续 Aone 操作被阻断，停止自己拥有的 instance 后处理残留 |

无论成功或失败均取消并删除本次捕获的 Playwright 下载，移除监听器；失败删除本次创建的 artifact，保留已有文件。重复下载或清理失败即使在返回前发生也阻止成功。此接口沿用 CLI v1 wire、nonce 和原启动/停止流程。
