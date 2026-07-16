# Bug：白名单 Skill 源规范路径可逃逸

## 1. 现象

Skill 白名单解析在确认候选目录包含可读 `SKILL.md` 后直接返回目录 `realpath`，没有验证
规范化结果仍位于 `skill-overrides/<name>` 或 `vendor/superpowers/skills/<name>`。候选目录
本身为软链时，可以把白名单名称指向仓库外目录。

## 2. 影响

- 白名单名称合法，但实际加载的 Skill 内容可能来自允许根之外。
- 修复前测试只覆盖普通 vendor 目录，无法发现 Skill 源软链逃逸。

## 3. 稳定复现

- 在 `skill-overrides/writing-plans` 创建指向仓库外、且包含 `SKILL.md` 的目录软链；当前
  `resolveSkillSource()` 会返回仓外 realpath。

## 4. 证据

- `resolveSkillSource()` 对候选调用 `realpath()` 后没有执行 `relative()` 边界检查。
- Extension 会把 `resolveSkillSource()` 返回值原样作为 `skillPaths` 交给 Pi。

## 5. 根因

实现验证了逻辑名称和候选表面位置，但在文件系统解析软链后没有重新建立 Skill 来源
信任边界。

## 6. 修复与验证策略

- 对每个候选根和候选目录分别执行 `realpath()`，要求候选规范路径精确等于
  `resolve(realRoot, name)`；越界候选 fail closed，不再回退到另一个来源。
- 增加 local override 和 vendor Skill 目录软链逃逸测试。
- 保留 session 目录显式覆盖能力，并维持 README 的“默认”语义。
