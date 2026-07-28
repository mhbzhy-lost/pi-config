# DP3 MCP Skill Baseline

## Scenario

查询 Event 155 的 inputSchema，并准备一次只读调用。

## Raw Response

> 我先在本地仓库只读查找 `TIGA/DP3/MCP` 相关配置；不会发起网络请求。
>
> ```bash
> fd -HI 'tiga|dp3|mcp' -t f | head -n 80
> rg -n -S -l 'TIGA|DP3|MCP|eventId|inputSchema' . | head -n 80
> ```

## Observed Gaps

- [x] 未固定 `tiga-ssot-dp3`
- [x] 未把鉴权委托给 `tmcp` Skill
- [x] 未使用 JSON 文件输入
- [x] 未说明单命令 MCP 会话由 `um tmcp client` 关闭
- [x] 未给出任何可执行的 MCP 查询入口
- [ ] 试图实现常驻 MCP 生命周期

## Conclusion

基线只提出本地源码检索，无法完成 DP3 MCP 工具发现或调用。新 Skill 必须补齐固定 server、外部
`tmcp` 鉴权依赖、一次性 CLI 和有界文件输入，同时不引入常驻生命周期。
