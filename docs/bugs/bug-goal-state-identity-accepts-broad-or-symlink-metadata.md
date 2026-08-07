# Bug：Goal cwd identity 接受宽权限或符号链接元数据

## 现象

`ensureGoalStateIdentity()` 仅在首次创建时请求 `identity.json` 使用 `0600`，随后只比较 JSON 内容。若 namespace 目录或 identity 文件已存在且权限过宽，或者 identity 路径被替换为符号链接，只要内容相同就会被接受。

## 影响

- 同机其他用户可能读取 cwd 与 Goal namespace identity，违反私有状态目录合同。
- 符号链接可把 identity 读取重定向到 namespace 外部，削弱 cwd 绑定的文件系统边界。
- “首次创建安全”不能证明 reload、并发竞争或人工误配置后的状态仍安全。

## 根因

实现使用 `mkdirSync(..., mode: 0o700)` 和 `writeFileSync(..., mode: 0o600, flag: "wx")`，但这些 mode 对已存在路径不生效。`EEXIST` 分支随后直接 `readFileSync(path)`，没有验证目录类型、文件类型、权限和符号链接，也没有通过已打开文件描述符固定被读取的 inode。

## 触发条件

1. 配置绝对 `PI_CODING_GOAL_DIR`；
2. 对应 cwd namespace 或 `identity.json` 已存在；
3. 目录权限不是 `0700`、文件权限不是 `0600`，或 identity 是符号链接；
4. identity 内容仍与预期 canonical cwd 和 namespace 一致。

## 修复方案

1. identity 创建或 `EEXIST` 后使用 `lstat` 验证 namespace 是非符号链接目录且权限精确为 `0700`。
2. 使用带 `O_NOFOLLOW` 的只读文件描述符打开 identity，通过 `fstat` 验证普通文件、权限精确为 `0600`，再从同一 fd 读取和解析内容。
3. 任一类型、权限、打开竞态或内容异常统一 fail closed 为稳定 identity 错误；不得自动 chmod 或覆盖已有路径。

## 验证方法

- 先将真实 fixture 的 namespace 改为 `0755`、identity 改为 `0644`，确认旧实现仍错误接受。
- 再把 identity 替换成指向相同内容文件的符号链接，确认旧实现仍读取链接目标。
- GREEN 后三种情况均拒绝且不修改原权限、链接或内容；正常首次创建和幂等 reload 继续通过。
