# Bug: Pi agent loop 冻结首轮 profile tool ceiling

## 症状

Capsule在`plan_open`成功后设置完整active tools，并在streaming `tool_result`中排入follow-up。真实Plan Runner确实多执行了一个provider turn，但session仍只有`plan_open`，两个turn都输出等待文本；`plan_continue`和项目`subagent`始终不可见。

## 影响

仅靠同一agent loop的follow-up无法从bootstrap阶段进入协调阶段。若把项目`subagent`直接写入frontmatter，会破坏既定的Plan授权可见性边界；若依赖`agent_settled`异步启动prompt，一次性print child会先退出。

## 复现

1. Child启动时profile只有`plan_open,read,grep`。
2. `plan_open`调用`setActiveTools`加入Plan lifecycle和项目工具。
3. `tool_result`用`deliverAs:"followUp"`成功排入同一agent loop的后续turn。
4. Pi loop仍复用启动时工具snapshot；raw status显示`turnCount:3`、`toolCount:1`，唯一工具为`plan_open`。

## 根因

Pi文档中的“下一agent turn”不包含同一prompt loop里的steer/follow-up轮次；工具集合只在新的外层prompt构建时刷新。pi-subagents async print child完成该loop后退出，而ExtensionAPI的`sendMessage`返回void，不能在`agent_settled`可靠等待新prompt。

## 修复

保留bootstrap-only frontmatter。Plan Runner通过Root-owned通道登记durable follow-up；Root broker等待该caller的official terminal proof后，用private upstream `resume`从持久session启动新的Root一级run。Revived run获得同一logical caller的受限alias grant，订阅后有序接收pending push；不得向模型暴露resume、alias或Root身份。

## 验证

初始Plan Runner run只执行`plan_open`并正式终止；broker随后只revive一次，新run复用同一session并看到完整动态工具，调用`plan_continue`和exact `subagent`。并发follow-up合并，失败保留durable debt供后续事件重试；所有revived run纳入Root shutdown。
