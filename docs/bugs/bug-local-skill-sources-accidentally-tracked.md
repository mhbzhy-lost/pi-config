# 本地 Skill 源码被误提交

## 1. 现象

`a1`、`tmcp`、`dp3-mcp`、`crash-mcp` 与 `crash-analyzer-usage` 已由被忽略的
`skill-overrides/skills.local.list` 启用，但对应源码目录仍被 Git 跟踪并推送到远端。

## 2. 影响

本机专用 Skill 进入共享仓库，新机器会获得不属于全局配置的内部工具源码；仅修改白名单
无法撤销已提交内容，也无法阻止后续更新再次进入提交。

## 3. 触发条件

新增或迁移本机 Skill 时，只把名称写入 `skills.local.list`，但没有同时将源码目录加入本仓库
的本地排除规则，随后执行 `git add -A`。

## 4. 证据

- `skills.local.list` 包含上述五项以及既有的其他本机 Skill，`skills.list` 不包含任何本机项。
- `.git/info/exclude` 已排除旧的 local-only Skill，但没有排除新增的四个目录。
- `git ls-files` 能列出上述五个目录中的文件；最近一次提交新增了四个目录共 8302 行。

## 5. 根因

“本地清单决定启用范围”和“Git 索引决定发布范围”是两个独立边界。现有流程只维护前者，
后者依赖人工同步 `.git/info/exclude`，且没有自动化测试验证 local-list Skill 的源码必须未跟踪。

## 6. 修复与防复发

先增加两层索引契约：CI 无需本地清单即可拒绝“不在全局清单却被跟踪”的 override，本机测试再要求
当前 `skills.local.list` 中每个 Skill 目录都不出现在 `git ls-files`，并覆盖空清单与全局/本地合并
顺序；再用 `git rm --cached` 取消五个目录的跟踪并将目录加入本机 exclude，保留工作区文件。
共享 migration 契约只冻结受版本控制的全局清单，不硬编码任何本机项。定向测试、Doctor 与
`git diff --check` 通过后提交删除记录。
