# T11：ceiling-runtime 三项失败来源分类

## 当前事实

`node --test test/joint-upgrade-ceiling-runtime.test.mjs` → **3 tests / 3 pass / 0 fail，exit 0**，日志 `/tmp/rc-ceiling-now.log`。三个用例是：

1. 真实 runtime 在 persistent session lifecycle identity 注册并重复 start 不泄漏，shutdown 撤销；
2. 真实 runtime startup 失败不得泄漏已注册 ceiling 或开放 typed spawn；
3. Root Broker drain 失败保留 ceiling，恢复后真实 shutdown 重试才释放。

该测试文件相对 HEAD **未被本批修改**（`git diff HEAD --stat` 为空），其依赖的 `test/helpers/joint-upgrade-session.mjs` 也未被修改。

## 历史与分类：unconfirmed

`docs/plans/records/2026-10-16-operation-tools/acceptance.md` 记录 S6 时期该文件 3 项失败，且“在 HEAD 对照副本同样失败，属既有缺陷/环境”。本轮在当前工作树不再复现，但：

- 没有为它修改任何生产代码，因此**不能**声称某个 ceiling 缺陷已被修复；
- 也没有取得当年失败现场的同次日志/环境快照，无法确证根因（环境、依赖闭包或旧 fixture 均有可能）。

按门禁归为 **来源未证实（unconfirmed）**：不新增防御分支、不改 ceiling 语义、不扩大 capability。

## 边界

capability ceiling 与 14 工具 model-only 合同保持不变；本记录只说明当前工作树该文件通过，并保留历史失败为历史事实。
