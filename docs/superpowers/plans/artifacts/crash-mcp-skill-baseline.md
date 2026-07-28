# Crash MCP Skill Baseline

## Scenario

查看 Crash MCP 工具并描述实例列表工具的 inputSchema，不启动 crash 修复。

## Raw Response

> 我先在本地仓库里查一下是否已有 `motu_querySimpleReportRecordPage` 或 Crash MCP 的配置/Schema
> 线索；只做本地读取，不发网络请求。
>
> 回答随后输出了两个不可执行的伪 `<tool_call>`，尝试通过跨仓 `cd` 后使用 `rg/grep/fd` 搜索本地
> `motu_querySimpleReportRecordPage|Crash MCP|crash-mcp|mcpServers` 文本。

## Observed Gaps

- [x] 未固定 `tiga-ssot-crash`
- [x] 未把鉴权委托给 `tmcp` Skill
- [x] 未区分 Crash 数据查询与 crash 修复
- [x] 未使用 JSON 文件输入
- [x] 未说明单命令 MCP 会话由 `um tmcp client` 关闭
- [x] 输出不可执行的伪 tool call
- [x] 使用被安全门禁禁止的跨仓 shell `cd`
- [ ] 试图实现常驻 MCP 生命周期

## Conclusion

基线无法调用或发现 Crash MCP 工具，并引入了错误的本地搜索与跨仓命令。新 Skill 必须固定
TMCP server、依赖 `tmcp` 鉴权、区分数据查询与 `crash-analyzer-usage` 修复，同时只提供一次性 CLI。
