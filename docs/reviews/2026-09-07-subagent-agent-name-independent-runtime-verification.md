# Subagent Agent 名称去耦验证记录

**记录日期：** 2026-09-07
**范围：** `agent-name-independent-runtime` 的最终非 Goal 验证，以及用户明确缩小后的 Goal compile-only 范围。

## 结论边界

名称去耦的非 Goal 主路径已获得稳定验证证据：coding/generic 由调用结构而非 profile 名称决定；可信 Host 创建的 `RunAuthorization` 是 capability 的唯一来源；root identity 与 lifecycle identity 分离；Broker v2 与旧格式 decoder 有明确边界；profile 在任何 spawn、workspace 或 Goal 前均先发现（always-discover）。

本记录不宣称完整计划、完整 `npm test` 或 Goal runtime 功能已经通过。Goal 部分只保证 TypeScript 编译；未运行也不作为通过证据的项目包括 Goal integration、local convergence、Goal canary 和完整 `npm test`。

## 核心验证结果

### 调用结构与授权

- 完整 `dispatch-ir.v1` typed contract 决定 `coding`，`{agent,title,task}` generic 结构决定 `generic`；`agent` 只表示已发现的 profile identity。相同 profile 可分别进入两条路径，名称不会改变 execution kind。
- `RunAuthorization` 由可信 Host 按调用分支及已核验的 Goal ticket 创建。standalone coding 仅有 `root.subscribe`；Goal coding 另有 `acceptance.submit`；managed generic worktree 仅作 terminal identity tracking，capabilities 为 `[]`。
- root/lifecycle identity 已分离：持久化 Host 的 lifecycle session 可以是绝对 session-file 路径，逻辑 root session identity 仍独立使用。授权和 terminal 核对 lifecycle identity；grant 与 workspace owner 使用 root identity，不能由路径派生权限。
- Broker v2 写入中性 capability grant 和 execution proof。旧 `root-broker.executor-proof.v1`/旧 grant 仅由 `legacy-executor-compat.ts` 读取并归一化，不应产生新的 v1 `role:"executor"` artifact。
- always-discover 已作为调用边界：coding 与 generic 均须先发现精确 profile，之后才可进行 Goal prepare、workspace allocation、RPC ping、title registration 或 child spawn；未知 profile fail closed。

### Reviewer 配置与审批策略

`pi/agents/reviewer.md` 的精确 metadata 为：

- models：`openai-codex/gpt-6-astra`
- thinking：`xhigh`
- tools：`read,grep,find,ls`（只读）

`pi/agents/executor.md` 已恢复原有六项 fallback models 链：`codex-pool/gpt-5.6-terra`、`openai-codex/gpt-5.6-terra`、`codex-pool/gpt-5.6-luna`、`openai-codex/gpt-5.6-luna`、`deepseek/deepseek-v4-pro`、`deepseek/deepseek-v4-flash`。`temperature` 未进入运行请求，因此已删除；executor 正文不感知 runtime 或 model。

Skill 的 fresh-context pressure baseline 已明确修正为 GREEN：修改前规则存在歧义；修改后可推出两个审阅时点，且每一次实际派发都必须获得用户当次明确批准，批准不可复用。选择 Subagent-Driven 不等于批准；reviewer 是 generic、`worktree:false`，也不是 acceptance authority。本任务没有实际 spawn reviewer。

## 非 Goal 测试证据

以下均为父级完成的最终非 Goal 验证结果：

| 验证集合 | 结果 |
| --- | --- |
| 稳定非 Goal 集合 | 89/89 通过 |
| 最终核心集合 | 39/39 通过 |
| Broker 正向白名单 | 9/9 通过 |
| extension 非 Goal 白名单 | 18/18 通过 |
| managed/runtime fixture 白名单 | 13/13 通过 |
| Doctor | 1/1 通过 |
| package verify | 成功 |
| typecheck | 通过 |
| diff-check/staging | 通过 |

这些集合相互存在重叠，故不汇总为虚假的单一总测试数。

## 模型路由 Canary

此前以显式 model override 调用 executor 时，实际使用 `gpt-6-astra`；省略 `model` 后，实际使用 `gpt-5.6-terra`。这证明 explicit override 与默认 fallback 路由均生效。随后 Astra 已配置给 reviewer；该历史 canary 不表示 executor 当前 metadata 使用 Astra。

## Goal 范围、误执行与残余风险

Goal 相关只完成 TypeScript 编译验证。未运行 Goal integration、local convergence、Goal canary 或完整 `npm test`，因此不宣称它们通过。

曾误执行混合 suite 中的 Goal-labelled cases；这些 case 均在前置 fixture/profile mismatch 处失败。这些误执行不构成验收证据，也未被归入通过或失败的 Goal 功能验证。

残余 Goal 风险如下：

- v2 settlement/evidence 与 runtime v1 分支尚未做功能验证。
- Goal 测试 fixture 和历史 workspace imports 仍可能失败。
- Goal 的唯一正向证据为 typecheck，不能外推为运行时正确性。

## 持久化 Host Rename Canary 阻塞

真实 persistent Host rename canary 未达 GREEN。Pi `0.84.4` 可执行，但 isolated child catalog 对 `codex-pool/gpt-5.6-terra` 返回 `MODEL_NOT_AVAILABLE`。fake provider 不可用于 child，且 `openai` fetch 失败；因此没有执行 child-start。临时资源已清理，本记录不宣称该 canary 为 GREEN。

## 静态边界检查

package 核心旧 API/名称授权扫描无命中。`root-broker.executor-proof.v1` 仅存在于 `packages/pi-subagents-enhanced/src/subagent-dispatch/legacy-executor-compat.ts`。Goal 旧字段仍在用户限定的 compile-only 范围内；它们未被纳入功能验收，不能宣称已全部清零。

## 可复现性说明

复现本记录的非 Goal 结论时，应仅运行上述稳定白名单、Doctor、package verify、typecheck 与 diff/staging 检查，并保持 Goal 功能测试不运行。真实 Host rename canary 需要 child catalog 能提供可用模型及可访问的 provider；当前环境前提不满足时，应记录为环境阻塞而非实现 GREEN。
