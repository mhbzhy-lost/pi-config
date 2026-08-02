# Bug: Executor owner extension 的 cwd 解析导致跨仓派发无法启动

## 1. 现象

从 `mega-aone-service` 执行普通 `executor` 派发时，child 在 session 创建和模型调用前退出。
三次真实启动分别出现：

1. 以 `plugins/crash_fix_v2` 为 cwd 时，Pi 尝试加载
   `plugins/crash_fix_v2/pi/child-extensions/root-session-owner.ts`，文件不存在。
2. 以 `mega-aone-service` 为 cwd 时，Pi 尝试加载
   `mega-aone-service/pi/child-extensions/root-session-owner.ts`，文件不存在。
3. 在业务仓建立指向真实 extension 的临时 symlink 后，入口文件可以找到，但其
   `../../scripts/lib/subagent-dispatch/root-broker-client.ts` 仍按业务仓路径解析，加载失败。

对应 run：

- `e6df3bfe-3627-4642-b267-51fc517d6474`
- `3ff14a36-6073-4e30-9dfb-c84724e6db19`
- `d1f8217e-0e94-444c-ac1d-570471c3fb8d`

## 2. 影响

`executor` 无法从 `pi-config` 之外的业务仓启动，因此 Subagent-Driven coding 在进入任务、
创建测试或写文件之前即失败。失败发生在 extension 加载层，不代表业务任务 RED、测试失败
或实现缺陷。若 acceptance 只显示 executor rejected，容易误判为子任务实现未通过。

## 3. 稳定复现

`pi/agents/executor.md` 声明：

```yaml
subagentOnlyExtensions: pi/child-extensions/root-session-owner.ts
```

从任意不包含该相对路径的业务仓 cwd 派发 executor，child 会把该值原样交给 Pi；Pi 按启动
cwd 解析本地 extension 路径并在模型调用前报文件不存在。即使在业务仓为入口文件增加
symlink，TypeScript loader 仍以业务仓中的 symlink 路径解析 extension 内相对 import，继续
报 `Cannot find module '../../scripts/lib/subagent-dispatch/root-broker-client.ts'`。

## 4. 根因

Agent profile 把配置仓拥有的 extension 写成 cwd-relative 路径，但该路径同时跨越三种所有权：

- Agent profile 位于 `pi-config`。
- child cwd 属于被操作的业务仓。
- extension 的相对 imports 依赖 `pi-config/scripts/` 目录结构。

当前 launch contract 没有在派发前把“配置仓 extension”转换为保持模块目录语义的可加载
身份，也没有真实覆盖“从外部业务仓 cwd 启动 executor”的集成测试。仅检查配置仓 cwd 下
`access(join(repoRoot, extension))` 会遗漏该问题。

## 5. 本次处置

Crash Fix V2 任务不修复 Pi/subagent 机制，不复制 broker 依赖，不移除 Root ownership guard，
也不保留业务仓 compatibility symlink。第三次失败后，临时创建的
`mega-aone-service/pi/child-extensions/root-session-owner.ts` symlink 和目录已删除；用户原有
`mega-aone-service/pi/auth.json` 未改动。

Crash Fix V2 原计划改用 Inline Execution，继续遵守相同 TDD、写入范围和真实 Xcode 门禁。
三个失败 run 均未创建或修改 Task 1 的生产代码、测试、Ruby helper、bug 文档或 `pyproject.toml`。

## 6. 后续修复与防回归要求

该问题后续必须作为独立 `pi-config` 基础设施任务处理，不能夹带在业务仓任务中。修复前应先
增加真实 RED：从一个不含 `pi/child-extensions` 和 `scripts/lib/subagent-dispatch` 的临时业务仓
cwd 启动真实 executor，并断言 extension 加载、Root ownership subscription 和 child shutdown
生命周期均成功。

修复不能只让入口文件通过 `access()`；还必须证明 extension 的相对 import 保持配置仓模块
身份，并覆盖：

- 普通 executor 跨仓启动。
- Root broker grant 尚未就绪时的有界重试。
- Root closing / socket EOF 时 child 终止。
- 正常 session shutdown 的幂等 dispose。
- 不加载 `fanout-child`，不恢复嵌套 subagent 权限。

在上述独立任务完成前，不得把当前三次失败标记为 Crash Fix V2 代码失败，也不得声称跨仓
Subagent-Driven execution 可用。
