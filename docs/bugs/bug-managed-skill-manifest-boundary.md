# Bug：受管 Skill manifest 未验证路径边界

## 1. 现象

`syncSkills()` 直接遍历 `.pi-config-managed-skills.json` 的 `skills` 键，并将键作为
Skill 名拼接到 `agentDir/skills/<name>`。manifest 内容没有执行与白名单相同的名称和
值类型校验，manifest 自身也允许是软链。

此外，`syncSkills()` 在完成全部目标 preflight 前创建 `agentDir/skills`，因此冲突导致
同步失败时仍会留下新目录。

## 2. 影响

- `../escape` 形式的 manifest 键可使过期项检查越过 `skills` 目录。
- 当越界目标是指向 manifest 记录源的软链时，清理流程可能删除该软链。
- 非字符串 manifest 值会进入路径和目标比较逻辑，产生不明确错误。
- manifest 软链会让同步器读取预期路径之外的 JSON 文件。
- preflight 失败并非完全无副作用。

## 3. 稳定复现

1. 在临时 `agentDir` 写入 manifest，令 `skills` 包含 `"../escape": <source>`。
2. 在 `agentDir/escape` 创建指向 `<source>` 的软链。
3. 使用空白名单运行同步。
4. 当前实现会把越界项当成过期受管 Skill，并删除 `agentDir/escape`。

目录副作用可通过在不存在的 `agentDir` 下制造一个白名单目标冲突后运行同步复现；命令
失败后 `agentDir/skills` 已被创建。

## 4. 证据

- Skill 白名单输入通过 `SKILL_NAME_PATTERN` 校验。
- manifest 的 `Object.entries(manifest.skills)` 没有对应校验。
- `join(agentDir, "skills", "../escape")` 规范化为 `agentDir/escape`。
- `readManifest()` 只检查 version、skills 是否存在以及是否为数组。
- `mkdir(agentDir/skills)` 位于 desired/stale preflight 循环之前。

## 5. 根因

实现把 manifest 当成可信内部状态，但该文件跨进程、跨版本持久化并位于用户可修改目录，
实际是一个输入边界。同步器只保护了白名单输入，没有在恢复持久化状态时重新建立同样的
名称、类型和文件类型约束。

## 6. 修复与验证策略

- 对 manifest 使用严格 schema：regular file、`version === 1`、`skills` 为普通对象、
  每个键符合 Skill 命名规则、每个值是绝对路径字符串。
- 拒绝 manifest 软链和所有 schema 异常，且不修改目标目录。
- 在完成 desired 和 stale 的全部 preflight 后再创建 `agentDir/skills`。
- 增加路径穿越、非字符串值、manifest 软链和 preflight 无目录副作用测试。
- 运行全量测试及隔离端到端同步。
