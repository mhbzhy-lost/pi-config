# Task Scheduler 薄膜修复复核

## 最终结论

**BLOCK。** M2 已关闭；M1、M3、M4、M5 仅部分关闭。精确上游 factory、包资源隔离和“不自研调度状态机”仍成立，但父链/叶节点 symlink、确认摘要中的 Unicode 格式控制符、`details` 严格拒绝以及 checked 测试覆盖仍未达到契约。

本结论只归因于本地 membrane 及其验收测试。Store、Lock、timer、completion、occurrence 等上游问题是已接受的已知限制，未重新列为本地 Must fix。

## M1：部分关闭

**已关闭部分：** `adapter.mjs:106,116-126` 在 `session_start` 窗口内 canonicalize `ctx.cwd`，由注入配置 getter 惰性调用 `repositoryDataDir`；`:34-46` 对创建后的目录执行 `realpath` containment，并以 `chmodSync(..., 0o700)` 固定最终权限。精确上游集成测试 `task-scheduler-runtime.integration.mjs:18-22,35-38` 使用临时 state/repo 并通过。

**未关闭部分：** `checkDirectoryChain` 在遇到第一个现存目录时立即返回（`adapter.mjs:22-26`），不会继续核验该目录的祖先组件；而 `:40-41` 只对 state-home 和 scheduler 父目录调用它。动态临时目录探针证明：当现存 state-home 经祖先 symlink 指入 session repo 时，函数虽在创建后被 `realpath` containment 拒绝，却已经在仓库内留下 `pi-task-scheduler/<hash>`。

此外，最终 hash 叶节点未在 lexical 路径上执行 `lstat`；`:43-44` 先 `realpath(root)`，随后对 canonical target 做 `lstat`，因此无法识别 `root` 本身是 symlink。临时探针预置 hash 叶节点 symlink 后，`repositoryDataDir` 接受并返回了重定向目标。故“创建前拒绝父链 symlink”及“最终 dataDir 不得由 symlink 重定向”仍是纯 membrane blocker。

现有 symlink 测试 `task-scheduler-adapter.test.mjs:94-101` 只覆盖 XDG state-home 自身为 symlink，没有覆盖隐藏祖先组件或 hash 叶节点。

## M2：已关闭

`adapter.mjs:107-121` 使用冻结的 `Object.create(null)` 显式 facade，不再以宿主 Pi API 为 Proxy target；只暴露 `registerTool`、`registerCommand`、`sendUserMessage`、`on`。工具白名单在 `:7,90-99`，事件白名单及未知事件丢弃在 `:8,112-119`，命令全部丢弃在 `:110`，不存在未知 API 默认透传。

`task-scheduler-adapter.test.mjs:25-38` 核验了四工具、未知事件、命令丢弃、属性描述符、`Reflect.ownKeys`、生命周期完成值及异常透传；该测试通过。未发现新的反射、未知 API 或 event 旁路。

## M3：部分关闭

**已关闭部分：** `adapter.mjs:59-61` 对 create/delete 共用三参数 `ui.confirm(title, message, options)` 并对无 UI、拒绝及异常 fail-closed；`:55-57,95-99` 在 create 执行前先扫描 prompt，再生成含 type、schedule、enabled、name、字节数和短 hash 的摘要；delete 摘要包含限长 taskId，prompt/description 正文未显示。

**未关闭部分：** 摘要清理函数 `:54` 只删除 ASCII 控制字符 `\x00-\x1f` 和 `\x7f`，不会删除 `\u202A-\u202E` 等 Unicode 格式控制符；`:50` 的 Unicode 扫描只用于 prompt/持久化消息，并未覆盖 type、schedule、name、taskId。临时探针确认带 `U+202E` 的 name 原样进入确认框，可造成视觉重排，摘要因而仍非可靠“可核对”授权。这是 M3 范围内的新纯 membrane blocker。

测试 `task-scheduler-adapter.test.mjs:46-50` 只断言第一次 confirm 为三参数，未断言 delete 也恰为三参数，也未固定 type、schedule、name、hash、拒绝、confirm 异常、secret、Unicode及超长 prompt 边界。

## M4：部分关闭

**已关闭部分：** `adapter.mjs:111` 对 `sendUserMessage` 再扫描、添加固定不可信来源标记并强制 `expandPromptTemplates: false`；`:63-88,92` 对 list/get 的所有 text 项在截断前再扫描，累计输入上限为 1MB，最终输出计入来源标记及截断标记并限制在 50KB/2000 行；`:68` 对非 text fail-closed；`:88` 清空输出 details。

**未关闭部分：** `adapter.mjs:64` 只拒绝非对象、null 或存在可枚举字符串键的 details，因而 `details: {}`、`details: []` 等仍会被接受后清空，不符合本次明确要求的“details fail-closed”。临时探针确认 `details: {}` 被接受。现有测试 `task-scheduler-adapter.test.mjs:57-60` 仅覆盖 image 和非空 details。

消息测试 `:52-53` 只调用安全消息，没有断言宿主实际收到的来源标记和 `expandPromptTemplates: false`；截断测试 `:61-63,75-85` 只核验宽松的 50KB 上界和标记，没有覆盖精确 2000 行、50KB 临界点及跨多项边界。

## M5：部分关闭

**已有有效证据：**

- `task-scheduler-runtime.integration.mjs:15-38` 未注入 fake factory；结合 `adapter.mjs:5,104,127`，确实经过精确安装的上游 default factory，并成功 create 一个 `enabled: false` 的任务、随后 delete、list 和 shutdown。该集成测试通过。
- runtime 使用临时 repo/state（`:16-21`），unit 的主要 session 用例也使用临时目录和注入 XDG（`task-scheduler-adapter.test.mjs:25-27,41-45,94-99`）。
- facade、消息拒绝、非 text、非空 details、字节截断、超限输入和 XDG leaf symlink 均有测试且当前通过。

**checked 验收仍缺：**

1. sessionId 仍是固定字符串（`task-scheduler-adapter.test.mjs:22`、`task-scheduler-runtime.integration.mjs:21`），并非每例唯一值；异常 session_start 用例 `task-scheduler-adapter.test.mjs:37-38` 未注入临时 XDG。
2. shutdown 位于普通执行路径而非 `finally`（unit `:35,64,99`；runtime `:37`），任一中途断言失败都会跳过 shutdown。
3. runtime 在 `:35` 主动调用 `repositoryDataDir(repo, ...)`，该调用自身会创建期望 hash 目录；测试没有枚举 lock/task 的实际 hash 路径，因此可能掩盖“上游使用了错误 cwd hash”的回归。
4. symlink 测试没有覆盖祖先组件和最终 hash 叶节点；facade 测试覆盖反射，但消息成功路径、delete 三参数确认和精确截断/2000 行边界未被断言。
5. 原 M5 要求的拒绝确认、confirm 异常、secret、Unicode、超长 prompt 及完整安全摘要字段也未固定。

因此，测试虽全部通过，仍不能作为 M1-M4 全部关闭的 checked 证据；精确上游 factory 集成本身已保留且有效。

## 包隔离与职责边界

- `task-scheduler-package-isolation.test.mjs:11-15` 读取实际 settings 并断言 scheduler 包的 extensions、skills、prompts、themes 全为 `[]`；`:17-27` 固定 scheduler/shared/croner 精确版本。该测试通过。
- `adapter.mjs:5,104,127` 静态导入并调用精确上游 default factory；`pi/extensions/task-scheduler.ts:1-7` 仅转调 adapter。
- adapter 只实现路径、能力、确认、内容和输出边界，未实现 Store、Lock、timer、occurrence、completion 或本地调度状态机。

## 复核裁定

| 项目 | 状态 | 裁定 |
|---|---|---|
| M1 | 部分关闭 | lazy session cwd、realpath containment、0700 已有；父链及 hash 叶节点 symlink 未关。 |
| M2 | 已关闭 | 无原型显式 facade，无反射、未知 API 或未知 event 旁路。 |
| M3 | 部分关闭 | 三参数确认和脱敏字段已有；Unicode 格式控制符可污染可核对摘要。 |
| M4 | 部分关闭 | 再扫描、来源标记、禁模板展开及有界 text 输出已有；空 details 未严格 fail-closed。 |
| M5 | 部分关闭 | 精确 factory 与成功 create/delete 已有；hermetic/finally shutdown、路径、消息及精确边界证据不完整。 |

**最终：BLOCK。** 解除阻断至少需要关闭 M1 的 symlink 绕行、M3 的确认摘要 Unicode 重排、M4 的 details 严格拒绝，并补齐 M5 的 checked 边界测试。

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "逐项给出 M1-M5 的已关闭/部分关闭结论，并引用 adapter、入口及三份测试的具体行号和动态临时目录证据。"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Store、Lock、timer、completion、occurrence 明确作为已接受上游限制排除，未列为本地 Must fix。"
    },
    {
      "id": "criterion-3",
      "status": "satisfied",
      "evidence": "确认精确上游 default factory 集成通过，同时指出固定 sessionId、非 finally shutdown、路径断言自创建及消息/截断边界覆盖不足。"
    },
    {
      "id": "criterion-4",
      "status": "satisfied",
      "evidence": "最终裁定为 BLOCK，阻断依据限定于 M1、M3、M4 的本地 membrane 缺口及 M5 checked 测试缺口。"
    },
    {
      "id": "criterion-5",
      "status": "satisfied",
      "evidence": "报告正文与人工说明均为中文；仅保留验收契约要求的固定 JSON 字段、枚举和代码标识符。"
    }
  ],
  "changedFiles": [
    "docs/reviews/2026-08-17-task-scheduler-thin-membrane-followup.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "node --test test/task-scheduler-adapter.test.mjs",
      "result": "passed",
      "summary": "5/5 通过；仅使用 fake upstream，不创建真实 scheduler state 或执行到期任务。"
    },
    {
      "command": "node --test test/task-scheduler-package-isolation.test.mjs",
      "result": "passed",
      "summary": "1/1 通过；实际 settings 中 scheduler 四类包资源全禁用，依赖版本精确固定。"
    },
    {
      "command": "node --test test/task-scheduler-runtime.integration.mjs",
      "result": "passed",
      "summary": "1/1 通过；临时 XDG/repo 下经精确上游 factory 成功 create(enabled=false)、delete、list、shutdown，未执行到期任务。"
    },
    {
      "command": "node --check scripts/lib/task-scheduler/adapter.mjs && node --check test/task-scheduler-adapter.test.mjs && node --check test/task-scheduler-runtime.integration.mjs && node --check test/task-scheduler-package-isolation.test.mjs",
      "result": "passed",
      "summary": "adapter 与三份目标测试语法检查通过。"
    },
    {
      "command": "临时目录 symlink 与边界内联探针",
      "result": "passed",
      "summary": "复现祖先 symlink 在拒绝前写入仓库、hash 叶节点 symlink 被接受、Unicode 格式控制符进入确认摘要，以及空 details 被接受。"
    },
    {
      "command": "git status --short && git diff --cached --name-only",
      "result": "passed",
      "summary": "复核前暂存区为空；工作区存在大量既有无关改动，本任务未修改代码、测试或配置。"
    }
  ],
  "validationOutput": [
    "adapter 单测 5/5 通过。",
    "package isolation 1/1 通过。",
    "精确上游 runtime integration 1/1 通过。",
    "包资源 extensions、skills、prompts、themes 均保持禁用。",
    "最终复核结果：BLOCK。"
  ],
  "residualRisks": [
    "父链 symlink 可在 post-realpath 拒绝前把目录创建进仓库，hash 叶节点 symlink 可被接受并重定向 dataDir。",
    "Unicode 格式控制符可进入 create/delete 授权摘要并造成视觉重排。",
    "空对象或空数组 details 未严格 fail-closed。",
    "checked 测试未完整固定 hermetic shutdown、实际 cwd hash 路径、消息成功路径和 50KB/2000 行精确边界。"
  ],
  "noStagedFiles": true,
  "diffSummary": "仅新增本中文只读复核报告；未修改代码、测试或配置。",
  "reviewFindings": [
    "阻断：scripts/lib/task-scheduler/adapter.mjs:22-26,40-44 - 父链检查提前返回，canonical target 上的 lstat 无法识别 lexical hash 叶节点 symlink。",
    "阻断：scripts/lib/task-scheduler/adapter.mjs:50,54-57,98 - 授权摘要字段未清理 Unicode 格式控制符，存在视觉重排。",
    "阻断：scripts/lib/task-scheduler/adapter.mjs:64 - 空对象/空数组 details 被接受，不满足严格 fail-closed。",
    "阻断：test/task-scheduler-adapter.test.mjs:22,35-38,48,52-64,94-101 与 test/task-scheduler-runtime.integration.mjs:21,35-37 - checked 测试的唯一 session、finally shutdown、消息、路径及精确截断边界不完整。"
  ],
  "manualNotes": "未读取真实 scheduler state 或凭据，未运行 Goal 测试，未执行任何到期 timer，也未执行 commit、push、stage、merge、stash；上游 Store/Lock/timer/completion 限制未作为本地缺陷。"
}
```
