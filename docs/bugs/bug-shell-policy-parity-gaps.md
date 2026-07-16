# shell-policy 与原安全门禁规则不一致

## 现象

现有表层测试通过时，`rm` 对不存在路径、`/tmp` 在 macOS 的 canonical 路径及符号链接祖先给出互相矛盾的判定；同时存在 Git 工作目录、引号分段和提交规则的兼容性缺口。

## 影响

门禁可能误阻断正常删除，或按字符串前缀放行穿过临时目录符号链接的删除；Git 命令和提交门禁也会出现绕过或误拦截。

## 稳定复现

对不存在 workspace 内目标执行 `rm -rf <workspace>/missing`、对 `/tmp/missing` 执行删除、以及创建祖先符号链接后删除其不存在后缀，均可稳定重现当前不一致结果。

## 证据

`node --test test/shell-policy.test.mjs` 曾显示不存在路径返回 `RM_TARGET_UNCERTAIN`、`/tmp` canonical 为 `/private/tmp` 后返回 `RM_OUTSIDE_WORKSPACE`，且真实 symlink fixture 可验证路径逃逸。

## 根因

初始实现混合了“目标是否存在”和“路径安全边界”两个概念，并在 realpath 失败后直接按词法路径或字符串临时前缀做决定，未从最长存在祖先重建 canonical candidate。

## 修复与验证策略

采用单一 canonical 边界算法：最长存在祖先 realpath 加原始相对后缀构造 candidate，仅允许 canonical workspace 或精确的 canonical temp roots（`tmpdir()`、`/tmp`、`/private/tmp`）；不以 symlink 身份额外拒绝，保留 shell expansion fail-closed。用真实 symlink、缺失后缀、`/tmp` canonical、workspace 内外缺失路径及 canonical temp 目录同级路径测试验证，禁止放宽到 `/private/var/folders`。
