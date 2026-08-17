# Task Scheduler 薄膜实现终审

## 结论

**BLOCK。** 当前实现确实调用精确上游扩展且没有复制调度状态机，但 dataDir 绑定、代理隔离、授权摘要和持久化内容再入边界仍有属于 membrane 自身的阻断问题。Store、Lock、timer、completion、occurrence、`agent_settled` 等上游语义不在本次审查范围，也未被列为本地缺陷。

## 八项核验摘要

| 核验项 | 结论 | 证据 |
|---|---|---|
| settings 与精确上游 | 通过 | `pi/settings.json:17-23` 将扩展、技能、提示、主题全部设为 `[]`；`adapter.mjs:5,89` 直接调用已安装 `0.1.9` 的 `dist/extension.js` default factory；adapter 未实现调度状态机。 |
| 工具与命令过滤 | 阻断 | 常规调用会在 `adapter.mjs:57,77-78` 仅放行四个工具并丢弃 `/cron`；但 `:84-85` 默认透传全部 Pi API，且 Proxy 未拦截属性描述符，存在注册旁路。 |
| create/delete 授权 | 阻断 | `:34-37` 无 UI、取消、异常均拒绝，且使用三参数 confirm；`:65` 在 confirm 和上游执行前扫描 create prompt；但 `:66` 的摘要完全不含本次对象信息，用户无法知道实际授权内容。 |
| list/get 有界输出 | 部分通过 | 当前精确上游仅返回单个文本项且 `details: undefined`，文本累计上限实现为 50KB/2000 行；但 `:44,54` 原样保留非文本项和 details，通用膜边界并非真正有界。 |
| 消息与持久化再入 | 阻断 | `:79` 添加来源标记并最终强制 `expandPromptTemplates: false`；但定时发送、list/get 返回的磁盘内容均未重新扫描，文件被篡改后可绕过 create 扫描进入模型上下文。 |
| dataDir | 阻断 | `:89` 实际向上游传入注册时 `process.cwd()` 的固定目录；`:81` 只创建/校验 session cwd 对应的另一个未使用目录。父级 symlink 也未被拒绝或 canonical 校验。 |
| 生命周期透传 | 通过（受 dataDir 问题牵连） | `:77,80-85` 对宿主方法保持 target `this`，包装器返回/等待 Promise，handler 与 tool 的异常不会被吞；精确上游 handler 为 async/箭头函数，未见额外 this 破坏。session_start 前置的 dataDir 行为本身需修。 |
| 测试有效性 | 阻断 | 已真实经过精确上游 factory 得到四个工具并拦截 `/cron`，隔离测试也核验 settings；但没有成功 create/delete、授权摘要、消息标记、session cwd 哈希、symlink、真实截断、反射旁路和生命周期错误测试。 |

## Must fix

### M1：dataDir 没有绑定当前 session cwd，且父级 symlink 可把状态导回仓库

`adapter.mjs:89` 在扩展注册时计算一次 `repositoryDataDir(process.cwd())`，上游在自己的 `session_start` 中使用的始终是这个固定字符串。`:81` 针对 `ctx.cwd` 的调用只产生一个未被上游使用的目录，不能实现按当前项目分区。

此外，`:20-23` 只做 lexical containment，并只对最终 hash 目录执行 `lstat`。若 `XDG_STATE_HOME` 或 `pi-task-scheduler` 父目录是指向仓库的 symlink，`mkdirSync` 会沿 symlink 在仓库内创建最终普通目录；最终目录自身不是 symlink，因此检查通过，随后 task prompt 可能写入 Git 工作区。

**最小修复：** 在 `session_start` 进入上游 handler 前捕获 canonical `ctx.cwd`，让传给精确 factory 的唯一配置 `dataDir` 在该次 session 启动时惰性解析；不得再使用注册时 cwd。创建前拒绝 symlink 父链，创建后对最终目录 `realpath`，再次验证其既不等于仓库也不位于仓库内，并验证最终权限为 `0700`。

### M2：Proxy 不是 deny-by-default，存在反射注册旁路和额外 Pi 能力泄露

`adapter.mjs:84-85` 会绑定并透传任何未专门处理的属性，包括注册快捷键、renderer、provider、执行命令或改变 active tools 等不属于本契约的能力。更直接地，Proxy 以真实 `pi` 为 target，却没有 `getOwnPropertyDescriptor` 等反射陷阱；上游可通过 `Object.getOwnPropertyDescriptor(proxy, "registerTool").value` 取得原始注册函数，绕过四工具过滤。当前固定上游没有使用该旁路，但“没有被当前版本利用”不等于膜完成隔离。

**最小修复：** 不要以真实 Pi API 为 Proxy target；改为无原型、显式能力表的 facade，只暴露精确上游当前所需的 `on`、受控 `registerTool`、丢弃型 `registerCommand` 和受控 `sendUserMessage`。`on` 至少限制为上游需要的 `session_start`/`session_shutdown`，未知注册面 fail-closed 并记录有界诊断。

### M3：create/delete 确认框没有可核对且不泄露的授权摘要

`adapter.mjs:66` 对所有创建显示同一句“Authorize creation…”，对所有删除也同样如此。三参数调用形式正确，但用户看不到 type、schedule、enabled、taskId，也无法区分两次不同操作，因而不是有效授权。

**最小修复：** create 显示经控制字符清理和长度限制的 type、schedule、enabled、可选 name，以及 prompt 字节数和短摘要哈希；不要显示 prompt 正文或 description。delete 显示经清理和限长的 taskId。prompt 安全扫描必须继续发生在摘要生成、confirm 和上游 execute 之前。

### M4：磁盘持久化内容再进入上下文时没有重新执行膜检查

`adapter.mjs:65` 只扫描 create 入参。若同一用户下的其他进程修改 task 文件，精确上游会在运行时把 `task.prompt` 交给 `sendUserMessage`；`:79` 仅加文字警告，不检查长度、secret、注入或隐形 Unicode。list/get 也会把篡改后的 prompt、description、错误文本等作为 tool result 送入模型。来源标记和 `expandPromptTemplates: false` 是必要措施，但不能阻止 secret 被发送给模型，也不能替代入口扫描。

**最小修复：** 对 `sendUserMessage` 的持久化字符串在转交宿主前再次执行类型、8KB、secret、注入和 Unicode 检查；对 list/get 最终保留的文本执行适配 50KB 上限的同类再入检查并添加固定“不可信持久化数据”标记。失败时拒绝转交即可，不要修改上游状态机。

### M5：checked 验收缺少关键边界测试，现有单测还会接触默认真实 state

`task-scheduler-adapter.test.mjs:11,15-29` 使用真实 `process.cwd()` 和默认 XDG state，且从不调用 `session_shutdown`，可能读取本机 scheduler state、持有 lock 或启动其中的到期任务。runtime integration 虽使用临时 state，但只断言父目录存在，无法发现实际使用注册 cwd 的错误，也没有 shutdown。

**最小修复测试集：**

1. 所有会触发上游 `session_start` 的测试使用临时 XDG、临时 repo、唯一 sessionId，并在 `finally` await `session_shutdown`。
2. 用 `enabled: false` 成功创建任务后删除，核验两次 confirm 都恰为三参数、摘要包含安全身份字段且不含 prompt 正文；同时覆盖无 UI、拒绝、confirm 异常、secret、注入、Unicode 和超长 prompt。
3. 让注册 cwd 与 `ctx.cwd` 不同，断言 lock/task 只位于 canonical `ctx.cwd` 的 hash 目录、mode 为 `0700`、仓库内无状态文件；增加 XDG/中间父级 symlink 指入仓库的拒绝用例。
4. 对显式 facade 增加属性描述符/未知注册 API 旁路测试；对消息边界直接核验来源标记、强制 `expandPromptTemplates: false`、篡改内容再扫描。
5. 用合成结果覆盖 50KB、2000 行、多文本项、非文本项、details 和截断标记；保留一条经过精确上游 default factory 的集成用例，断言六个上游工具尝试中只有四个进入宿主且 `/cron` 未注册。
6. 增加宿主方法 this、async handler 完成值及同步/异步异常透传测试。

## Should fix

### S1：`boundedResult` 应对非文本和 details fail-closed，并明确标记截断

`adapter.mjs:44` 对任意非文本 content 不计预算地原样加入，`:54` 也保留任意 details。精确固定的 `0.1.9` 工具当前只产生文本且 details 为 undefined，因此这不是当前上游路径上的独立 blocker；但它使“有界膜”在返回形状漂移时失效。建议仅接受文本、清空 details，并在发生截断时加入固定且计入预算的截断标记。

### S2：Unicode/secret/injection 扫描应以测试固定边界

现有检查覆盖若干 bidi/零宽字符和常见凭据形态，执行顺序也正确，但没有测试证明 Unicode 和 secret 分支，且未覆盖所有格式控制字符。建议明确被拒绝字符类别、正规化策略与误报取舍，并以表驱动测试固定；无需尝试在 adapter 中实现通用语义级“越狱检测”。

## Acceptable

- settings 中 scheduler 包的四类资源均明确禁用；项目入口仅转调 adapter。
- adapter 静态导入并调用精确安装的上游 default extension，没有复制 Store、Lock、timer、completion 或 occurrence 逻辑。
- 常规 `registerTool` 路径确实只接受 list/get/create/delete，update、run-now、未知工具和全部 command 会被丢弃；诊断最多保留 25 条。
- create 的现有 prompt 扫描发生在 confirm 和上游 execute 之前；无 UI、取消、confirm 异常均 fail-closed；confirm 已使用 title、message、options 三参数。
- 消息已有固定来源标记，且无论上游 options 如何都最终强制 `expandPromptTemplates: false`。
- 对当前精确上游的单文本结果，50KB/2000 行是跨 content 项累计的硬上限；真正限制上游在返回前构造字符串的峰值内存需要上游或进程隔离，不应通过在本 adapter 复制 Store 来解决。
- 普通方法调用的 target this、async 返回和异常透传没有被当前包装破坏。
- 上游调度可靠性、锁语义、timer 到期、completion 判断和状态机缺陷均不作为本地 Must fix。

## 验证记录与残余风险

仅运行不会启动 scheduler、不会读取真实 scheduler state 的 package isolation 测试及语法检查；出于本次明确禁令，没有执行 adapter/runtime 测试。工作区在审查前已有大量无关改动，本次唯一写入文件为本报告；`git diff --cached --name-only` 为空。

当前残余风险即上述 M1-M5；在修复并补齐 checked 测试前不能 PASS。即使修复后，同进程方案仍不能限制精确上游在返回前的瞬时内存分配，也不承诺上游调度状态机可靠性，这两项属于已接受范围边界。

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "报告明确排除 Store、Lock、timer、completion、occurrence 和 agent_settled，只把 M1-M5 归因于 membrane 边界。"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "逐项核验了工具与命令过滤、三参数确认、消息标记与再扫描、session cwd dataDir、symlink、权限和 Proxy 生命周期透传。"
    },
    {
      "id": "criterion-3",
      "status": "satisfied",
      "evidence": "M5 给出六组最小测试补强，覆盖成功 create/delete、消息、路径、反射旁路、截断及生命周期。"
    },
    {
      "id": "criterion-4",
      "status": "satisfied",
      "evidence": "终审结论为 BLOCK，并列出五项 Must fix。"
    },
    {
      "id": "criterion-5",
      "status": "satisfied",
      "evidence": "人审报告正文全部使用中文；结构化字段仅保留验收契约规定的固定英文枚举和标识符。"
    }
  ],
  "changedFiles": [
    "docs/reviews/2026-08-17-task-scheduler-thin-membrane-review.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "node --test test/task-scheduler-package-isolation.test.mjs",
      "result": "passed",
      "summary": "1 个隔离测试通过，确认 settings 资源全禁用及精确依赖安装契约。"
    },
    {
      "command": "node --check scripts/lib/task-scheduler/adapter.mjs && node --check test/task-scheduler-adapter.test.mjs && node --check test/task-scheduler-runtime.integration.mjs && node --check test/task-scheduler-package-isolation.test.mjs",
      "result": "passed",
      "summary": "adapter 及三份目标测试文件语法检查通过。"
    },
    {
      "command": "git status --short; git diff --stat; git diff --cached --name-only",
      "result": "passed",
      "summary": "确认工作区已有大量无关改动，暂存区为空。"
    },
    {
      "command": "node --test test/task-scheduler-adapter.test.mjs test/task-scheduler-runtime.integration.mjs",
      "result": "not-run",
      "summary": "现有 adapter 单测会使用默认真实 state 且不 shutdown；遵守禁止读取真实 state 和执行到期 timer 的要求而未运行。"
    }
  ],
  "validationOutput": [
    "package isolation：1/1 通过。",
    "四个目标 JavaScript 文件语法检查通过。",
    "静态核验确认精确上游 0.1.9 注册六个工具和 /cron，宿主常规路径只接受四个工具。",
    "终审结果：BLOCK。"
  ],
  "residualRisks": [
    "dataDir 仍绑定注册时 cwd，且父级 symlink 可绕过仓库外约束。",
    "Proxy 仍有反射注册旁路并透传未授权 Pi API。",
    "授权摘要和持久化内容再入扫描未完成。",
    "关键边界缺少 hermetic checked 测试。",
    "同进程后置截断不能约束精确上游返回前的瞬时内存分配，此项不应通过复制 Store 修复。"
  ],
  "noStagedFiles": true,
  "diffSummary": "仅新增中文只读终审报告，未修改代码、测试或配置。",
  "reviewFindings": [
    "blocker: scripts/lib/task-scheduler/adapter.mjs:89 - dataDir 固定为注册时 process.cwd，而非当前 session cwd。",
    "blocker: scripts/lib/task-scheduler/adapter.mjs:20-23 - 父级 symlink 可绕过仓库外路径约束。",
    "blocker: scripts/lib/task-scheduler/adapter.mjs:84-85 - Proxy 默认透传且存在属性描述符注册旁路。",
    "blocker: scripts/lib/task-scheduler/adapter.mjs:66 - create/delete 确认摘要不可核对实际授权对象。",
    "blocker: scripts/lib/task-scheduler/adapter.mjs:59,79 - 篡改后的持久化内容可未经再扫描进入模型上下文。",
    "blocker: test/task-scheduler-adapter.test.mjs:11-29 - 测试接触默认 state 且未 shutdown，关键膜边界未覆盖。"
  ],
  "manualNotes": "未运行 Goal 测试、未启动到期 timer、未读取真实 scheduler state 或凭据，也未执行 commit、push、stage、merge、stash。"
}
```
