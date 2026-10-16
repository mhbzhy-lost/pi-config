# Pi 1.0.4 的 codemode 传递依赖接口漂移

## 来源与复现

合法入口：`test/pi-subagents-enhanced-package.test.mjs` 的 preparedPackageFixture → 本仓 setup-runtime-deps → 官方 npm install（临时 package、ignore-scripts）→ plain Node `import('pi-subagents')` → pi-coding-agent 非 bundle ESM 入口 → codemode/tool.js → pi-codemode/declarations。

官方源在线8项7pass/1fail；切回同缓存offline同为7pass/1fail。唯一失败为加载公开package入口，错误是 `MCP_TYPESCRIPT_PREAMBLE` 导出缺失。verify单独通过，因此校验tarball/import路径闭包不等于ESM符号链接通过。

分类：**合法公开安装链的依赖兼容缺陷（类别1）**，不是fixture手拼非法数据。首个偏离点为pi-coding-agent1.0.4按旧declarations接口导入符号，但它声明的pi-codemode `^1.0.4`允许后续不兼容1.x版本进入。当前本机root lock/node_modules观察到pi-codemode1.1.0；最初失败fixture已由既有test.after清理，未保存其完整lock，因此不能凭root1.1.0断言该fixture精确resolved版本。缺符号错误本身及caller的依赖范围已证实。

## 最小修复

- 根 `package.json` 与 enhanced package `package.json` 增加 `overrides: {"@earendil-works/pi-codemode":"1.0.4"}`，沿用固定Pi1.0.4版本族，来源仍是官方源。
- 根package-lock-only同步记录该官方1.0.4 tarball/integrity；不改node_modules、不patch上游、不换registry、不删plain Node入口测试。
- package overrides在该package作为安装root（本仓setup和隔离fixture）生效；npm不会让依赖package的overrides自动管辖外部consumer，因此外部Host需在自己的安装root采用同一约束，不能宣称发布manifest可自动修复所有Host。
- 本次lock-only不会改当前物理Host已装的1.1.0，也不热替换当前运行会话。fresh安装/Host部署需消费新lock与override。

## 验证状态

- 原官方在线/离线均7/8，verify0，根manifest/lock在原两次运行前后hash未变化。
- 首次pin后误用默认 ~/.npm offline缓存，2pass/6ENOTCACHED；分类为执行环境错误，尚未进入ESM校验，不当pin无效证据。
- 恢复隔离HOME/空user/global npmconfig、官方registry、明确var/tmp/npm-cache后，online八项8/8、offline八项8/8、verify exit0；job837021bf真实终态succeeded。
- metadata合同断言已补：根/package override精确等于1.0.4，根lock的codemode项为官方1.0.4且含integrity。补断言后offline8/8、root/package types和diffcheck均exit0，job ff1df6bc实际succeeded；不增加production防御/fallback。
