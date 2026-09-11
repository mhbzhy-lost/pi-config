# Generic Subagent Prompt 合同调研

## 范围与结论

本记录只归纳已确认的官方资料，不把任一框架的对象模型误称为通用规范。资料共同要求把工作目标、相关上下文、执行边界、产物和完成判据区分处理，因此新 generic prompt 采用全部必传的五段：`task`、`context`、`constraints`、`deliverable`、`done`。空数组是调用方明确声明“没有额外上下文或约束”，不是省略字段。

`executor` 继续由 Skill 引导使用包含身份、风险、工作流、写入范围及证据的 coding contract；`reviewer` 使用此 generic contract，且执行 workspace 固定为 `worktree:false`。profile 只描述角色行为，不能变成 capability、Goal 或 workspace authority 的来源。

## 已确认官方来源

| 组织或项目 | 官方资料 | 与字段决策的关系 |
| --- | --- | --- |
| OpenAI | [Agent Definitions](https://developers.openai.com/api/docs/guides/agents/define-agents)、[Handoffs](https://openai.github.io/openai-agents-python/handoffs/)、[Orchestration and Handoffs](https://developers.openai.com/api/docs/guides/agents/orchestration) | agent 指令、handoff 输入和编排职责要求目标及上下文明确，并由编排层保有路由。 |
| Anthropic | [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)、[Multi-Agent Research System](https://www.anthropic.com/engineering/multi-agent-research-system)、[Effective Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)、[Advanced Tool Use](https://www.anthropic.com/engineering/advanced-tool-use)、[Demystifying Evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)、[evaluator-optimizer cookbook](https://github.com/anthropics/anthropic-cookbook/blob/main/patterns/agents/evaluator_optimizer.ipynb) | 最小高信号 context、清楚的工具/角色边界、可评估产物和 evaluator 判据分别支持 context、constraints、deliverable、done。 |
| Google | [A2A specification](https://github.com/google/A2A/blob/main/docs/specification.md)、[A2A task lifecycle](https://github.com/google/A2A/blob/main/docs/topics/life-of-a-task.md)、[ADK LlmAgent](https://adk.dev/agents/llm-agents/)、[ADK multi-agent patterns](https://developers.googleblog.com/en/developers-guide-to-multi-agent-patterns-in-adk/) | 任务输入、生命周期状态和 agent instruction 分离，支持稳定任务目标、上下文与可观察结束状态。 |
| Microsoft | [AutoGen Swarm](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/swarm.html)、[AutoGen Termination](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html)、[Semantic Kernel Handoff](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/handoff) | handoff 的职责划分和显式 termination 支持调用者声明交付物与完成条件，而非由角色名称猜测。 |
| LangGraph | [LangGraph Supervisor](https://github.com/langchain-ai/langgraph-supervisor-py) | supervisor 负责 delegation、context 传递及路由，说明 route 不是子任务调用方可自报的事实。 |
| SWE-agent | [Config/ACI](https://swe-agent.com/1.0/config/config/) | 任务配置、agent 行为和受控 ACI 分层，支持把工作约束从自然语言目标中分离。 |
| OpenHands | [Task Tool Set](https://docs.openhands.dev/sdk/guides/task-tool-set)、[File-based Agents](https://docs.openhands.dev/sdk/guides/agent-file-based) | task、工具集与文件化 agent 配置分离，支持交付物与 runtime/tool authority 不由 task caller 决定。 |

## 共同模式与反模式

共同模式是：先给可执行目标，再提供最小且相关的事实；明确不允许的行为和责任边界；指定可检查的产物；用可观察的完成条件终止、评估或移交。五段不是这些资料的逐字字段名，而是它们的可移植交集。

不采用以下输入：

- caller-supplied tools 或 capabilities：工具许可属于 Host、profile 和 runtime 的交集，不能由 prompt 提权。
- caller-supplied return route：handoff/supervisor 的接收方是 Host 编排决定，不能由 child 输入伪造。
- caller-supplied Goal authority：Goal ticket、acceptance 和 workspace publish/apply 是可信 Host 边界。
- 以 `kind`、`role` 或自由文本任务推断合同：角色只选择行为说明，不能省略结构化工作维度。

## 字段取舍

| 字段 | 必传性 | 决策 |
| --- | --- | --- |
| `task` | 必传，非空字符串 | 描述要完成的工作；没有目标无法可靠 delegation。 |
| `context` | 必传数组，可为空 | 把已知事实和必要背景显式传递；空数组保留“已审阅但无补充”的语义。 |
| `constraints` | 必传数组，可为空 | 表达负空间、范围与安全限制；不从角色名或工具列表推断。 |
| `deliverable` | 必传，非空字符串 | 指定结果形状，使 reviewer/evaluator 可消费。 |
| `done` | 必传、至少一项 | 形成可观察完成条件，不能以模型自行停止替代。 |
| `runtime` | 可选 | `cwd`、timeout、session、worktree 只在 Host/runtime consumer 使用，不参与 prompt 意义。 |
| `result` | 可选 | output、schema、progress、artifacts 只由结果 consumer 使用。 |

所有影响 prompt 或 spawn 的必传字段必须进入各自 canonical hash；可选 runtime/result 字段也必须在其被相应 consumer 使用时进入该 consumer 的 canonical identity。现有 `dispatch-ir.v1` 的 source hash 和历史语义保持不变，coding renderer 只做向五段内部 IR 的投影。
