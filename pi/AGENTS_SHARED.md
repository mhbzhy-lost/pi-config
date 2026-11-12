# 共享 Agent 规范

## 测试与逻辑变更

未经用户明确授权，agent 严禁主动新增测试、全新 fixture 或压力场景。

## Pi 内置 shell 工具

Pi shell 的受限 PATH 包含仓库 `pi/bin/` 中的原生工具：使用 `fd` 查找文件，使用 `rg` 搜索文本；需要表达多文件增删改时，使用 `apply_patch`，通过 stdin 提交完整的 `*** Begin Patch ... *** End Patch` 结构化补丁。三个工具都在当前 bash 工作目录执行。

## Git Commit 规范

- 格式为 `type(scope): 中文祈使句`，`scope` 可选；type 仅允许英文小写 `feat`、`fix`、`refactor`、`perf`、`test`、`docs`、`style`、`chore`、`build`、`ci`、`revert`。
- subject 必须包含至少一个中文字符，不超过 50 字，不以 `。` 或 `.` 结尾；以祈使句动词开头（如“增加”“修复”“重构”），不用“已修复”“实现了”“修复了”等过去时。
- 禁止以零信息词单独作为 subject：`fix`、`update`、`bugfix`、`wip`、“修改”、“更新”。subject 说明做了什么，body 解释为什么，不重复 diff 已说明的内容。
- 提交信息任何位置禁止 AI 署名或等效辅助标识，包括 `Co-Authored-By: Claude/Copilot/Cursor`、`Generated with Claude`、`AI-assisted`。
- 一次 commit 对应一个逻辑变更，不合并无关改动；修复与对应测试可放同一 commit，重构与修复必须拆开。PR 标题遵循同一规则。
- Pi `security-gates` Extension 会自动校验 type 白名单、中文字符、句号结尾、过去时、零信息 subject 和 AI 署名；机械检查不能代替人工核对，也不授予提交权限。

## 输出语言

文档、工具指导正文、代码注释等必须使用中文，仅专业用词可豁免。
