# N1 package 缓存阻塞确认与原用例离线重跑记录

**taskId:** N1（dispatch-e4e325f4）
**date:** 2026-10-15
**executor:** executor（unit-runner + npm-cache-writer 单槽，父层已授当前槽位优先）
**status:** blocked-environment（6 个 package fixture 用例因离线缓存缺失失败，非 production/测试/校验器缺陷）；同窗口离线 `verify:subagents-enhanced` 真实通过（exit 0）
**network-package-cache:** **not-granted**（`baseline.json` authorization.networkPackageCache.state=not-granted；父层中途指引再次确认：不能把计划执行当网络授权）

## 1. 范围与输入

本任务零代码修改，只做离线运行与记录。现场只读核对了以下输入：

- 计划 N1 合同：`docs/plans/2026-10-15-runtime-closeout.md` §5 N1（含"不手工固定『只差一个tgz』假设"的路线约束）。
- 上一批 6 个 ENOTCACHED 证据：`docs/plans/records/2026-10-13-footer-acceptance.md` F6v 命令2 失败分类（当时单一观测根因：`typescript` packument 与 `typescript-5.9.3.tgz` 缺失）。
- `test/pi-subagents-enhanced-package.test.mjs`：8 个用例；`preparedPackageFixture()` 经 memoized promise 仅执行一次真实 `npm install --prefix <隔离fixture> --ignore-scripts --omit=peer --save-exact pi-subagents@0.75.0`（fixture manifest 保留 `dependencies: {pi-subagents, typescript@5.9.3}` 与 devDependencies 4 个 `@earendil-works/*@1.0.4`，删除 bundleDependencies）；6 个 fixture 用例共享同一次安装结果。
- `packages/pi-subagents-enhanced/scripts/verify-package.ts` 与 `setup-runtime-deps.ts`：verify 只读 manifest/受控 upstream 对照/import closure/tarball dry-run；setup 才做安装，本任务未调用 root/真实 packageRoot 的 setup。
- `docs/plans/records/2026-10-15-runtime-closeout/baseline.json`：授权三态与 Node v26.8.1/npm 11.19.0 现场版本。

## 2. 离线白名单环境（未读本机 npmrc/auth）

以 `env -i` 纯白名单构造，全部 npm 子进程继承；临时目录均在仓库外（macOS TMPDIR）：

| 项 | 值 |
| --- | --- |
| `PATH` | 继承当前 shell PATH（node/npm/chmod/tar 可执行；无 proxy/token 变量混入） |
| `HOME` / `TMPDIR` | `mktemp -d` 临时目录下的 `home/`、`tmp/`（fixture 根、npm 临时、V8 cache 全部落在此，仓库零写入） |
| `npm_config_offline` | `true`（npm 进入 `only-if-cached`，任何缺失直接 ENOTCACHED，不发起网络请求） |
| `npm_config_registry` | `https://registry.npmjs.org/`（仅官方源声明） |
| `npm_config_cache` | `<repo>/var/tmp/npm-cache`（仓库既有离线缓存，仅原脚本可写） |
| `npm_config_userconfig` / `npm_config_globalconfig` | 临时**空**文件（npm 不读本机 `~/.npmrc` 与 global npmrc；本任务也未人工读取它们） |
| `npm_config_ignore_scripts` / `npm_config_audit` / `npm_config_fund` | `true` / `false` / `false` |
| `PI_HOST_ROOT` / `PI_PACKAGE_DIR` | `<repo>/node_modules/@earendil-works/pi-coding-agent`（明确物理 SDK，防回落全局旧版；实测未被触发——fixture 在安装步即失败，未走到 bindPhysicalHostPeers） |

临时目录前缀：`/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/n1-offline-env.DSzTVC/`（含运行日志与空 npmrc 证据文件，仓库外）。

## 3. 运行结果（真实 exit/counts，未 pipe 掩盖）

| # | 命令（同一白名单 env） | 结果 | exit |
| --- | --- | --- | --- |
| 1 | `npm_config_offline=true node --test test/pi-subagents-enhanced-package.test.mjs` | **8 tests / 2 pass / 6 fail / 0 skipped / 0 todo / 0 cancelled**，duration≈1521ms | **1** |
| 2 | `npm run verify:subagents-enhanced` | 通过：manifest/exports/files 断言、受控 upstream 对照 1259 files、import closure 149 edges、tarball 1818 files / 17,403,813 bytes | **0** |

命令1 输出摘要（test reporter 原文）：`ℹ tests 8 / ℹ suites 0 / ℹ pass 2 / ℹ fail 6 / ℹ cancelled 0 / ℹ skipped 0 / ℹ todo 0 / ℹ duration_ms 1521.527209`。

- **通过（2）**：`both npm verification entry points default cache under the repository root`（fake npm，无网络）、`pi-subagents-enhanced exposes a publishable pinned package contract`（manifest/exports 静态断言）。
- **失败（6，同一根因）**：`package setup and verify exercise the package-local upstream without patching`、`npm dry-run tarball contains the complete runtime closure and no repository-private files`、`package setup installs Pi core typings as development dependencies`、`the new compat facade loads from the prepared package`、`published upstream uses package exports and loads in plain Node`、`package verification rejects upstream drift, missing patch, and escaping extension entries`——全部在 `preparedPackageFixture()` 安装步骤抛同一错误：

```text
npm error code ENOTCACHED
npm error request to https://registry.npmjs.org/typescript failed: cache mode is 'only-if-cached' but no cached response is available.
```

**离线证明与无重复安装证据**：
- 错误文本自证 `cache mode is 'only-if-cached'`——缺失即失败，未发起任何网络请求；日志中无 ECONNREFUSED/ETIMEDOUT/DNS/证书类联网迹象（grep 证据：0 条），未触发"联网迹象立即停"停止条件。
- `ENOTCACHED` 出现 12 行 = 6 个失败用例各打印 2 次；唯一一次真实安装命令（唯一 fixture 根 `.../tmp/enhanced-runtime-fixture-OYqiyP/package`）——memoized fixture promise 保证只安装尝试一次，符合"网络拒绝不反复跑 6 个必失败 fixture"。

## 4. 缓存状态审计（`var/tmp/npm-cache`，只读解析 index/content）

官方源（registry.npmjs.org）缓存共 191 个请求键：9 个 packument、182 个 tarball。与本次 fixture 安装直接相关：

| 依赖 | packument | tarball | 结论 |
| --- | --- | --- | --- |
| pi-subagents@0.75.0 | ✔ | ✔ 0.75.0 | 已齐（verify 离线通过即证明） |
| typebox@1.3.27 | ✔ | ✔ 1.3.27 | 已齐 |
| typescript@5.9.3 | ✘ 缺 | ✘ 缺（仅有 7.0.2） | **本次观测阻塞点** |
| yaml@2.8.3（pi-subagents 直依赖） | ✘ 缺 | ✘ 缺（仅有 2.9.0） | 待补 |
| acorn@8.18.0（pi-subagents 直依赖） | ✘ 缺 | ✘ 缺 | 待补 |
| jiti@2.7.0 / undici@8.10.2 | ✘ 缺 packument | ✔ tarball 已在 | packument 待补 |
| @earendil-works×4 @1.0.4（fixture devDeps） | ✔（含 1.0.4 dist 条目，指向官方源） | ✘ 官方源 1.0.4 tarball 缺（官方源仅缓存过 0.87.1；1.0.4 tarball 仅存在于内网镜像 registry.anpm.alibaba-inc.com 的历史缓存，不满足官方源约束） | 待补 |

推论：修掉 `typescript` 单点后，fixture 安装仍会依次暴露 acorn/yaml 等缺失——印证计划"不手工固定『只差一个tgz』假设"。且 fixture devDeps（4 个 @earendil-works peer）的完整传递依赖树（pi-ai 的 anthropic/aws/google/openai 树、pi-coding-agent 的 chord/codemode/mcp/telemetry 树等）大半无官方源 packument，**完整官方依赖清单只能在获批联网窗口内由 npm 实际解析枚举**，本记录不冒称完整。

## 5. 授权状态与下一步（需用户授权）

- `network-package-cache = not-granted`：本轮未联网、未安装、未运行 root/package 的 setup，仅原测试脚本在其隔离 fixture 内尝试安装（offline 下被 ENOTCACHED 拒绝）。
- **用户后续需单独明确授权**从官方源 `https://registry.npmjs.org/` 补缓存（禁止生命周期脚本，`ignore-scripts=true` 不变），目标缺失至少含：`typescript` packument 与 `typescript-5.9.3.tgz`、`yaml-2.8.3.tgz`、`acorn-8.18.0.tgz`、jiti/undici packument、官方源 4 个 `@earendil-works` 1.0.4 tarball 及其传递树；获批后按计划 N1 第 3–4 步：`npm_config_offline=false` 同一原测试（仅隔离 fixture 内安装）→ 回到 offline=true 重跑 8 项 → `npm run verify:subagents-enhanced`。
- 在获批前，6 个 fixture 用例保持 **blocked-environment**，不删用例、不放宽校验器、不冒充通过。

## 6. 不变量与边界核对

- 未修改 production/test/settings/manifest/lock/校验器：`git status --porcelain` 与运行前快照逐字节一致（delta none），`package.json`、`package-lock.json`、package manifest、两个 scripts 的 mtime 均为运行前原值；`packages/pi-subagents-enhanced/node_modules/@earendil-works/` 四个 peer 符号链接原样（PI_HOST_ROOT 绑定路径与现值一致，bindPhysicalHostPeers 为幂等 no-op 且本次实际未被触发）。
- 未 stage/commit/stash/reset/clean：`git diff --cached --name-only` 为 0 条。
- 缓存目录副作用仅为原脚本 npm 日志轮转（`_logs/` 计数保持 11，轮转替换旧日志），属允许的 `var/tmp/npm-cache` 写入。
- 未重复无关全套测试（未跑 F1/P0/D0 的测试；父层指引：其余任务测试前先问槽）；本记录不覆写 `2026-10-13-footer-acceptance.md`，其 F6v 失败分类原文保留。
- 未读取本机 npmrc/auth/token/proxy 配置（白名单 env -i + 空 user/globalconfig 双重保证）；未启动真实 Host。
