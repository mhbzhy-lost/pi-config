# Bug：Plan Host 将首轮会话持久化误当作启动握手

## 1. 现象

通过新根Pi进程调用正式`plan_run`后，v3 Host已创建`host/sessions`并成功启动Pi。stdout在约0.64秒时出现`type=session`事件，随后模型开始生成第一次`plan_open`工具调用；但5秒内目录仍无JSONL，launcher报`Standalone Plan Runner session file was not created`并终止Host。

## 2. 影响范围

影响所有首个assistant响应超过5秒的Standalone Plan Runner。失败发生在Plan领域状态创建前，导致合法的慢模型启动被误判为Host失败。真实运行`1ef279e0-b40c-444e-8b84-77c87fd7e3f3`以exit 143结束，workspace已回滚且无残留进程。

## 3. 复现条件

1. Host通过`--session-dir`启动持久Pi JSON模式。
2. Pi已发出`type=session`事件，但首个assistant消息尚未完成。
3. `SessionManager`已分配内部`sessionFile`路径，但物理JSONL尚未创建。
4. `createPlanHostRuntime()`调用`waitForSessionFile()`，5秒后将文件不存在解释为启动失败。

## 4. 根因

Pi `SessionManager.newSession()`会立即计算`sessionFile`，但`_persist()`在出现assistant消息前保持`flushed=false`，不创建文件；这是为了避免保存只有用户输入、没有assistant响应的空会话。Plan Host跨进程无法读取内部路径，于是错误地用目录中的JSONL存在性代理启动完成。该代理实际绑定的是“首个assistant消息已经持久化”，不是“Pi进程和session identity已经建立”。

## 5. 修复策略

Host启动时提供受控的显式session文件路径，并从JSON stdout等待首个合法`type=session`事件作为启动信号。事件证明Pi runtime和session manager已建立；显式路径让v3 handle无需等待物理文件即可持有稳定的session identity。保留有界启动超时、进程身份fencing和失败清理，但超时等待的条件不再依赖首轮模型耗时。

## 6. 回归与预防

- RED：fake Pi立即输出`type=session`、长期不创建JSONL时，Host仍应快速返回稳定v3 handle；旧实现会等待5秒后误杀。
- GREEN：定向Host测试通过，session路径位于私有session目录且首轮持久化前即可返回。
- 回归：完整`npm test`通过，既有Host失败清理、PID fencing和单session约束不退化。
- 真实验收：新根Pi进程通过正式`plan_run`返回v3 handle，RPC ping中的`sessionFile`与handle一致，并到达Plan领域状态。
