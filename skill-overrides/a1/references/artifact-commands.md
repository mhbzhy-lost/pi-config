# artifact 命令完整参考

## a1 artifact — 制品 / Maven

`a1 artifact` 管理构建产物。Maven 相关命令当前用于本地工程直传 Artlab；如果用户要走 Aone 官方二方库发布流水线，应查看 `references/pkg-commands.md` 中的 `a1 pkg deploy-cr` 或 `a1 pkg deploy-intg`。

---

## artifact mvn deploy \<project-dir\>

从本地 Maven 工程扫描模块并部署到 Artlab（详见命令 `--help`）。

- 典型用途：本地开发验证、SNAPSHOT 上传、预发仓库上传等。
- 不承担变更单驱动的 Aone 官方二方库发布流程职责；正式版二方库发布请使用 `a1 pkg deploy-cr`。

常用示例：

```bash
a1 artifact mvn deploy .
a1 artifact mvn deploy /path/to/project --repository snapshot
```
