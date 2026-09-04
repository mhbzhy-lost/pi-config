# Supervisor 消息标题在 TUI 正文末尾重复展示

## 现象

Subagent progress 或 supervisor request 已在 TUI 首行显示 dispatch title，但正文末尾仍出现同一个 `[title]`，形成重复尾巴。

## 数据来源与分类

- 实际入口：合法 subagent progress/supervisor custom message。
- 生成调用链：upstream custom message -> runtime membrane `decorateVisibleMessage()` -> 在原始 content 末尾追加 ` [title]` 并写入 `details.title` -> `formatCompactSupervisorRequest()`。
- 权威身份与顺序：run id 来自 upstream 消息 details；title 来自当前 session title registry，并由 membrane 同时投影到 content 与 structured details。
- 首个偏离点：TUI formatter 使用 `details.title` 生成首行，但未从显示正文去掉 membrane 追加的同值末尾副本。
- 分类：预期 production 数据未被正确处理。消息、run identity 与 title 均由正常 runtime 路径产生。

## 修复边界

只在 TUI renderer 的独立显示文本中移除与 `details.title` 精确匹配的末尾 ` [title]`。正文内其他方括号文本、原始 custom message、structured details、session 内容和主 agent 实际收到的信息均保持不变。
