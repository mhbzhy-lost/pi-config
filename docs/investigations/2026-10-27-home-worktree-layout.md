# Home 目录与 worktree 布局只读调查

调查日期：2026-10-27。home 顶层快照时间：**2026-10-27T09:19:49.998Z**。本文用 `~/` 表示本用户 home；owner 指 **Git 元数据归属的主 checkout/common-dir**，不代表已识别人类、创建会话或运行时 lease owner。

## 结论与可执行判断

**本次没有证据证明当前 pi-config managed workspace 存在“错误使用 repo 父目录，向 home 同级散落 worktree”的 production path bug。当前实际目录和源码算法一致，默认保存在 `~/pi-config/var/workspaces/repositories/<storageRepositoryId>/worktrees/<workspaceId>`。不需要为本次现象修改 production 路径代码。**

本次 248 个 home 顶层目录中，63 个是具有自身 `.git` common-dir 的独立 checkout，只有 **1 个**是已证实的顶层 linked worktree：`~/new-api-account-pool-mihomo-doc`，归属 `~/new-api-account-pool/.git`，与 pi-config 无共享 Git 关系。另 168 个顶层目录未发现直接 `.git`；16 个系统/隐私目录仅记录名称和类型，未检查内部。没有顶层 symlink。升级 container 内额外检查的 `~/pi-upgrade-1.3.0/repo` 是第 64 个独立 checkout，不能计作 pi-config linked worktree。

上游 `pi-subagents@0.80.0` 的 **native 分配器确有“repo 父目录下的 worktrees container”默认策略**，但叶子仍为 `worktrees/<project>/pi-worktree-<runId>-<index>`，不是 home 下扁平散落任意目录；当前增强层已经统一分配 workspace，并向 upstream workflow 显式传 `worktree:false`，不走该分配器。Worktrunk 分配则采用其返回路径，实际配置与使用历史未调查，不能据此归因现场。

`~/worktrees` 一层子目录另发现 3 个有效 linked worktree，均属于 `~/mega-aone-service/.git`；6 个 `crash-fix-v2-*` 的 `.git` 指针目标不存在，是本次最明确的**可疑残留**。它们指向 mega-aone-service 的 submodule Git 管理目录，无法取得有效 common-dir，实际创建者、分支、使用状态未知；本轮不修复、不回收，也不能因为 pointer 失效就判定其文件可以删除。

参考材料中的 `~/pi-upgrade-1.4.0` **在本次顶层快照未出现**。这是快照差异，不推断删除者、原因或时间，不把历史存在状态写成本次仍存在。1.3 与 1.4 的合并/退役判断不属于本轮验证；历史证据保留也不等于运行依赖。

## 边界、方法与证据口径

已读根 `AGENTS.md`、`pi/AGENTS_SHARED.md` 和 `packages/pi-subagents-enhanced/AGENTS.md`。package AGENTS 的“固定 0.79.2”文字已过时：现场 enhanced `package.json:39` 与安装 upstream `package.json:4` 均为 **0.80.0**，以下以实际 manifest 和代码为准。

1. 自建 `/tmp/home-worktree-layout-etTLc8/inventory.ts`，一次 `readdir(home,{withFileTypes:true})` 获取顶层类型；仅目录检查直接 `.git`，排除隐私/系统目录。home 共 381 个条目，其中目录 248 个；普通文件未读取内容，未列入目录表。
2. 先 `lstat(<candidate>/.git)`，只对直接 Git 候选执行 `git --no-optional-locks -C <candidate> rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir`，并发上限 4、每项超时 10 秒。linked 关系再核对 `.git` pointer、Git 管理目录的 `HEAD`、`gitdir`、`commondir`；不读取 `.git/config`。
3. 仅明显 container 扩展一层：`~/pi-upgrade-1.3.0/repo` 和 `~/worktrees/*`，不递归扫描 home。补充脚本 `related.ts` 读取本仓 `.git/worktrees/*/{gitdir,commondir,HEAD}`，核对任务指定的 `183f86ee...` 实际 Git 定位；只输出四个路径环境变量，不输出环境全量。
4. 仓库源码只静态读取；历史使用必要的 `git log/show/ls-tree` 及明确审计文档。没有读取其他项目业务源码、session、私有 ledger、凭据、models/auth、证书、钥匙串、浏览器状态。
5. 没有执行 Host/provider/测试、workspace CLI、raw `git worktree` 命令、进程控制、目录处置或 Git 写操作。源码中提到的 mutation/list 命令仅说明实现，**本轮未执行**。

`gitdir != common-dir` 且定位成功，是 linked 的判据；自身 `<root>/.git == common-dir == gitdir` 是独立 checkout 判据。独立 checkout 不证明具体是 clone 还是 init，也不证明 remote、commit 历史相同或不同。未发现直接 `.git` 只证明当前目录本身没有该 Git 入口，**不证明其更深处没有 repo**，也不证明它一定是临时目录。

## 清点汇总与 owner 聚合

| 范围 | 成功/缺失/失败 | 解释 |
|---|---|---|
| 顶层 248 个目录 | 64 个 Git 定位成功（63 independent + 1 linked）；168 个直接 `.git` 不存在；16 个未检查；Git 定位失败 0 | 不读取普通文件内容 |
| upgrade 的一层 repo | 1 个 Git 定位成功、independent | 独立 common-dir，不共享 pi-config Git 管理目录 |
| `~/worktrees` 一层 9 个目录 | 3 个 Git 定位成功、linked；6 个失败 exit 128，pointer target `ENOENT` | 失败项逐项保留，未继续尝试修复 |
| pi-config `.git/worktrees` 注册元数据 | 1 条，`183f86ee-d4b9-482d-a5fc-1038e42d9623` | 反向路径与实际 rev-parse 对上；没有本仓 home 顶层注册 |

| Git owner/common-dir | 顶层 linked | container 一层有效 linked | 本次额外观察 | 归属证据 |
|---|---:|---:|---|---|
| `~/pi-config/.git` | 0 | 0 | 本仓内当前 managed linked 1 个 | `.git/worktrees/183f86ee.../gitdir` 指向本仓 `var/workspaces/.../.git`，common-dir 回到本仓 |
| `~/new-api-account-pool/.git` | 1 | 0 | owner 自身为独立 checkout | mihomo-doc 的 `.git` pointer、HEAD、反向 gitdir、`commondir=../..` 与 rev-parse 一致 |
| `~/mega-aone-service/.git` | 0 | 3 | owner 自身为独立 checkout | 三个 cfv2 目录各自 `.git/worktrees/<name>` 与共同 common-dir 一致 |
| `~/mega-aone-service/.git/modules/plugins/crash_fix_v2`（仅 pointer 声明） | 0 | 0 | 6 个 pointer target 不存在 | 不能当作已验证 common-dir；当前 owner 状态 unknown |
| 独立 checkout 总计（含上述三个 owner 和 upgrade repo） | 0 | 0 | 共 64 个 independent Git root，各自拥有 `.git` | 附录逐项列出 common-dir/HEAD；不根据相似名称合并 owner |

### 直接候选与普通验证目录

| 路径 | 类型/分类 | 真实 Git 归属与证据 |
|---|---|---|
| `~/pi-config` | directory；主独立 checkout | gitdir/common-dir 均 `~/pi-config/.git`；`refs/heads/main` |
| `~/pi-upgrade-1.3.0` | directory；普通 container | 直接 `.git` 不存在；不能算 linked |
| `~/pi-upgrade-1.3.0/repo` | directory；独立 checkout | gitdir/common-dir 均自身 `repo/.git`；`refs/heads/upgrade/pi-1.3.0` |
| `~/pi-upgrade-1.4.0` | 本次未观测 | 不存在于本次顶层目录名称快照；不推断历史动作 |
| `~/new-api-account-pool-mihomo-doc` | directory；有效 linked | `.git` → `~/new-api-account-pool/.git/worktrees/new-api-account-pool-mihomo-doc`；common-dir `~/new-api-account-pool/.git`；`refs/heads/docs/mihomo-agent-guidance`；反向 gitdir 为本目录 `.git` |
| `~/aone-ci-validation.rtFL1H` | directory；独立 checkout | common-dir 自身 `.git`；`refs/heads/main`，不是名字所属其他仓库的 linked |
| `~/service-dingtalk-ci.bCRFNZ`、`~/service-dingtalk-ci.hp9aDa` | directory；两个独立 checkout | common-dir 分别为自身 `.git`；HEAD 分别 main、master，彼此不共享 common-dir |
| `~/worktrees` | directory；普通 container | 直接 `.git` 不存在；其一层结果见下表 |
| `~/a2-verify`、`~/qoder-a2-compile`、`~/qoder-fix2-tmp`、`~/workflow-probe`、`~/test-workspace` | directory；无直接 Git 入口 | 各目录 `.git=ENOENT`；具体业务用途/创建者 unknown |
| `~/overlay-selftest-bcf346of`、`~/overlay-selftest-gmvyjlge`、`~/overlay-selftest-ijdp9mp_`、`~/overlay-selftest-sfxe3b7u`、`~/overlay-selftest-thatntv1`、`~/overlay-selftest-wgbqiopp` | directory；无直接 Git 入口 | 六项 `.git=ENOENT`；名称暗示 selftest，但不能据此证明来源或可删 |
| `~/sub2api-v0211-worktrees`、`~/.sub2api-v0211-workspaces`、`~/sub2api-v0211-candidates` | directory；未展开 container | 直接 `.git=ENOENT`；未递归，内部 Git 归属 unknown，不计为 pi-config linked |

### `~/worktrees` 一层逐项证据

下表所有条目都是 directory，直接 `.git` 都是普通 pointer 文件。有效项的 `commondir` 文件均为 `../..`，反向 `gitdir` 文件均指回该行目录的 `.git`。

| 名称（位于 `~/worktrees/`） | Git 定位/归属 | HEAD 或失效证据 |
|---|---|---|
| `mega-aone-cfv2-a` | linked；gitdir `~/mega-aone-service/.git/worktrees/mega-aone-cfv2-a`；common-dir `~/mega-aone-service/.git` | `refs/heads/agent/cfv2-a-oss` |
| `mega-aone-cfv2-f` | linked；gitdir `~/mega-aone-service/.git/worktrees/mega-aone-cfv2-f`；同上 common-dir | `refs/heads/agent/cfv2-f-runner` |
| `mega-aone-cfv2-integration` | linked；gitdir `~/mega-aone-service/.git/worktrees/mega-aone-cfv2-integration`；同上 common-dir | `refs/heads/agent/cfv2-main-integration` |
| `crash-fix-v2-b` | 失效 pointer；有效 common-dir unknown | pointer `~/mega-aone-service/.git/modules/plugins/crash_fix_v2/worktrees/crash-fix-v2-b`；target `ENOENT`；rev-parse exit 128 |
| `crash-fix-v2-c` | 失效 pointer；有效 common-dir unknown | pointer 同上前缀，末段 `crash-fix-v2-c`；target `ENOENT`；exit 128 |
| `crash-fix-v2-contracts` | 失效 pointer；有效 common-dir unknown | pointer 同上前缀，末段 `crash-fix-v2-contracts`；target `ENOENT`；exit 128 |
| `crash-fix-v2-d` | 失效 pointer；有效 common-dir unknown | pointer 同上前缀，末段 `crash-fix-v2-d`；target `ENOENT`；exit 128 |
| `crash-fix-v2-e` | 失效 pointer；有效 common-dir unknown | pointer 同上前缀，末段 `crash-fix-v2-e`；target `ENOENT`；exit 128 |
| `crash-fix-v2-integration` | 失效 pointer；有效 common-dir unknown | pointer 同上前缀，末段 `crash-fix-v2-integration`；target `ENOENT`；exit 128 |

该层命名既不匹配 upstream 0.80 的 `<project>/pi-worktree-*` nesting，也不匹配当前 enhanced 的 partition/UUID 布局。元数据已证明 Git 归属或 pointer 声明方向，但不足以识别到底是手工命令、其他工具还是旧版本创建。没有访问该项目的实现来反推。

## 当前 production 路径完整链路

### 公开路径选择与 canonical state root

- `scripts/pi-shell.zsh:9`：`PI_CODING_AGENT_WORKSPACE_DIR` 非空值优先，其次继承的 `PI_CODING_WORKSPACE_DIR` 非空值，最后 `$_PI_CONFIG_ROOT/var/workspaces`。`_PI_CONFIG_ROOT` 根据 shell 脚本位置定位 repo，不是当前 shell 的父目录。
- 当前调查进程只白名单观察四项：`PI_CODING_WORKSPACE_DIR=~/pi-config/var/workspaces`；`PI_CODING_AGENT_WORKSPACE_DIR` 未设置；`PI_CODING_AGENT_DIR=~/pi-config/pi`；`PI_SUBAGENTS_WORKTREE_DIR` 未设置。这是调查进程的继承值，不冒充所有历史 Host 的环境。
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:363`、`:374`、`:384`：从同一 `PI_CODING_WORKSPACE_DIR` 连接 coordinator，并构造 workspace service，后者接收 coordinator identity 的 `storageRepositoryId`。
- `src/workspace/coordinator-registry.ts:17` 的 `canonicalWorkspaceStateRoot()`：对已存在祖先取 realpath，再补齐尚不存在尾段，用于 canonicalStateRoot 元数据比较。ledger 的 `normalizedStateRoot()`（`ledger.ts:80`）要求 normalized absolute path，并作同类真实路径解析，避免 `/var` 与 `/private/var` 等别名拆成两个根；不把 state root 改写为 repo 父目录。未配置/非法值不能从 service 默认为 home。

上述 workspace 源码路径除另有说明外，均相对 `packages/pi-subagents-enhanced/`。

### repository 身份、storage partition 与 Git 创建路径

`src/workspace/repository-identity.ts:18` 的 `resolveRepositoryIdentity(cwd)` 先解析 top-level 与真实 common-dir，再通过实现内部的 Git registration 信息确定 canonical main `originRoot`。**本次没有运行这个 helper**（它内部使用 raw worktree list），只读取代码和定位元数据。

其 `repositoryId=sha256(realpath(common-dir))` 表示共享 Git 身份；`storageRepositoryId=sha256(realpath(originRoot))` 表示持久 storage partition。linked cwd 的旧 partition hash 仅以 `migrationDebt/action:inventory-only` 暴露，不自动迁移。两种 ID 不应混同。无显式 storage ID 时，ledger 本地的旧 `repositoryId(origin)` helper 也按 canonical origin hash，不会拿 cwd basename 拼 home。

公开 spawn 的 `worktree:true` → `src/subagent-dispatch/extension.ts:1076` 生成 standalone request → `workspaceService.ensureAllocated()`（`:1081`）→ `src/workspace/service.ts:210` reserve/allocating → `src/workspace/ledger.ts:111` `managedWorkspacePaths()`：

```text
canonicalStateRoot
  /repositories
  /storageRepositoryId（64位 sha256）
  /worktrees
  /workspaceId（限制字符，禁止 ..）
```

`ledger.ts:397` 的 requestPlan 将 `record.path` 设为该 worktreePath，`dispatchCwd=worktreePath + relative(originRoot, requestedCwd)`，分支为 `refs/heads/pi-managed/<workspaceId>`。`src/workspace/git-worktree.ts:254` 的 `ensureManagedGitWorkspace()` 只将该 record.path 作为内部 Git add 参数，随后复验 identity；没有 `../<repo>-<task>` 默认。这里描述实现而非本轮执行 mutation。

### 当前 `183f86ee...` 的现场闭环

本轮按 `realpath(~/pi-config)` 计算得到：

```text
storageRepositoryId = 8c8998242b29f89a730a38ec62996cbf9daa4dbd877bb1da1c04da24ec902d84
workspaceId = 183f86ee-d4b9-482d-a5fc-1038e42d9623
```

元数据实测链路：

```text
PI_CODING_WORKSPACE_DIR = ~/pi-config/var/workspaces
→ ~/pi-config/var/workspaces/repositories/
  8c8998242b29f89a730a38ec62996cbf9daa4dbd877bb1da1c04da24ec902d84/
  worktrees/183f86ee-d4b9-482d-a5fc-1038e42d9623
→ rev-parse git-dir = ~/pi-config/.git/worktrees/183f86ee-d4b9-482d-a5fc-1038e42d9623
→ rev-parse common-dir = ~/pi-config/.git
→ 管理目录 commondir 文件 = ../..
→ 管理目录 gitdir 文件 = 上述实际 workspace 目录/.git
→ HEAD = refs/heads/pi-managed/183f86ee-d4b9-482d-a5fc-1038e42d9623
```

本仓 `.git/worktrees` 只有此一项注册。上述闭环验证的是布局和 Git owner；没有读取私有 ledger，也没有用目录存在推断 run/lease 的终态、活跃性或可回收性。任务提示的 footer 独立补丁无需为路径判断打开或修改。

## 当前、历史、手工入口比较

| 入口/证据 | 路径策略 | 是否会默认生成 home 顶层 sibling 叶子 | 判定 |
|---|---|---|---|
| 当前 enhanced managed service | `<canonicalStateRoot>/repositories/<storageId>/worktrees/<workspaceId>` | 不会；当前根为 repo/var/workspaces | 当前实际链路匹配，无本轮布局缺陷证据 |
| 当前 `scripts/worktree-lifecycle.ts:5,61` | `PI_CODING_WORKSPACE_DIR ?? resolve(dirname(import.meta.url), '../var/workspaces')`；origin 是 `process.cwd()` | 不会；`../` 相对 **scripts 目录**，回到 repo/var/workspaces | 当前仅 audit/reconcile CLI，不是分配 sibling 目录的入口；实际 imports workspace administration |
| `src/workspace/administration.ts:27,137` | 公开 audit/inventory 消费同一 stateRoot，并可展示 legacy/孤儿登记 | 不会为 audit 创建 worktree | 本轮未运行，避免读取私有 ledger/队列 |
| 历史 CLI `ee82f12`（2026-08-16）`scripts/worktree-lifecycle.mjs:103` | create → `scripts/lib/worktree-lifecycle/managed-worktree.mjs:193`，默认 `<origin>/.state/worktree-lifecycle/worktrees/<id>`；helper 支持明确 explicitPath | 默认不会；显式路径另当别论 | 历史受管入口，不是父目录默认 |
| 更早 `c0942c6`（2026-08-08）managed helper `:192` | `<origin>/.state/worktree-lifecycle/worktrees/<id>` | 不会 | 已核对必要历史起点 |
| 历史 standalone `ee82f12:scripts/lib/subagent-dispatch/workspace.mjs:61` | `<origin>/.state/subagent-dispatch/worktrees/<workspaceId>` | 不会 | 后被统一 service 收敛 |
| 历史 Goal `6fd8d05`（2026-07-31）及 `ee82f12:scripts/lib/goal-engine/workspace.mjs` | `resolve(stateRoot,'worktrees')/<goal-task-attempt>` | 取决于外部 stateRoot；算法本身不取 repo 父目录 | 没有读取历史私有状态，不能推断某次实际环境 |
| `b898bc2`（2026-09-04）`scripts/worktree-lifecycle.ts:5` | 已是脚本相对 `../var/workspaces` | 不会 | 与当前默认一致，非 home 逃逸 |
| upstream 0.80 native | config `worktreeBaseDir` > 环境 `PI_SUBAGENTS_WORKTREE_DIR` > `<dirname(repoRoot)>/worktrees`；再加 `<basename(repoRoot)>/pi-worktree-<runId>-<index>` | 默认生成 sibling **container**，不是父目录直属叶子 | by design，增强层当前托管路径不使用 |
| setup/probe 代码 | `scripts/setup-subagent-runtime-deps.ts` 定位 package、pi/npm、npm cache；`scripts/probes/dispatch-branch-probe.ts` 是 IR 路由样本；merge queue acceptance probe `:363` 将 workspace 设为隔离 stateRoot/workspaces | 所核对代码没有 sibling worktree 分配 | 未执行 setup/probe，也不把样本当 production 轨迹 |
| 明确历史手工审计 | 2026-08-05 审计记载 shell raw add `/private/tmp/...` 是当时本仓 93 个 linked 的主要来源 | 证明历史手工临时路径存在，不能证明当前 home 布局来源 | 原报告机器/home 与本次不同；只引用历史事实，不扫描另一个用户 |

### upstream 0.80 在什么场景生效

安装包 `src/runs/shared/worktree.js:509` 的 `resolveWorktreeDedicatedRoot()` 包含上述 sibling container 默认；`:548` 的 `buildNativeWorktreePath()` 固定 project/run/index nesting。配置相对路径从 repoRoot 解析，`~/` 展开为 home；位于 Pi extensions 内的 repo 默认另放到 `getAgentDir()/worktrees`。`:574` 明确拒绝 leaf 直接位于 repoParent。`worktreeProvider=auto` 在 Worktrunk machine interface 可用时可选择 Worktrunk，否则 native；明确 baseDir/env 会选择 native，与显式 worktrunk 组合则拒绝。没有运行 provider capability probe。

安装包 `src/runs/background/subagent-runner.js:3778,3799` 在 parallel `group.worktree` 为真时分配；`:4202,4204` 在 `seqStep.worktree` 为真时分配；原生配置 `worktree:true` 可作为省略每次参数时的默认。说明见安装包 `docs/configuration.md:609` 起。

增强层则在 `src/subagent-dispatch/execution.ts:48` 将 managed cwd 绑定到实际 executor，`:54` 显式写 `worktree:false`；`workflow-spawn.ts:93,105` 将 leaf 与 root 调用都设为 false。因此**增强层公开 worktree:true 与 upstream 再次分配不是同一个动作**。没有证据显示当前 managed workspace 会因上游 sibling 默认再创建第二套目录；本轮也未通过真实运行验证旁路入口。

### 环境继承与历史 raw 命令：能证明到哪里

`docs/bugs/2026-09-29-pi-shell-inherits-cross-repo-state-roots.md:18` 记录过真实 production 的跨 checkout 状态根继承：旧 `pi-new` 明确传 AGENT_ 变量，而新 shell 只消费已有非 AGENT_ 值，导致新 checkout 的 broker/workspace 状态落到旧 checkout 的 `var/workspaces`。当前 `scripts/pi-shell.zsh:9` 已优先消费 AGENT_ 通道。历史缺陷影响的是 **state root 选择**，没有证明发生 home 顶层扁平 worktree 散落；普通裸 source 仍保留非 AGENT_ 的显式/继承覆盖语义。

`docs/audits/2026-08-05-worktree-lifecycle-audit.md:58` 与 `docs/bugs/bug-agent-worktrees-lack-durable-ownership-and-reclamation.md:13` 明确记载历史 raw 手工 add，示例目的地是 `/private/tmp/pi-config-<task>`。本次对相关历史入口、docs 中 `git worktree add` 的 `../`/当前个人 home 形式检索，**没有找到可核对的“raw 命令生成本次 home 顶层这些目录”的证据**。未读 shell history/session/私有 ledger，不能从未命中文本推出历史从未发生过。

故当次现场分类为：当前 enhanced 布局无 bug 证据；upstream sibling container 为 by design；历史跨 checkout 环境缺陷有明确报告但不能归因本次目录；有效外仓 linked 的 Git 归属已证实，创建工具 unknown；6 个失效 pointer 的历史来源和可删性 unknown。不得据此给 production 加 fallback 或自动兼容/清理逻辑。

## 可疑残留与安全后续建议

- 优先保留并单独列账 `~/worktrees/crash-fix-v2-{b,c,contracts,d,e,integration}`。后续若用户另行授权，可在 **mega-aone-service/submodule owner** 范围核对原 Git 管理目录迁移、未提交成果、branch/object 可恢复性和运行依赖，再决定恢复定位还是退役。当前只有 pointer target 不存在这一事实，不提供删除/prune 命令。
- `new-api-account-pool-mihomo-doc` 和三个 `mega-aone-cfv2-*` 都有有效双向 Git 关系，没有证据可称为孤儿。未检查脏文件、未集成 commit 或进程，也不能宣称可回收。
- `pi-upgrade-1.3.0/repo` 是独立 checkout，不能由 pi-config worktree lifecycle 接管。是否按既有用户标准退役应沿独立 checkout 的成果保全流程另行处理；本轮不重新验证升级业务。1.4.0 本次未观测，毋须在当前清单创建虚构对象。
- 若未来只希望目录收敛，enhanced 继续使用当前 repo/var/workspaces；实际启用原生 upstream allocator 的其他入口可明确设置其 `worktreeBaseDir`/`PI_SUBAGENTS_WORKTREE_DIR`。这只是配置建议；当前没有应用配置、迁移目录或发送处置请求。
- `~/sub2api-v0211-worktrees` 等未展开 container、隐私目录、更深层 repo、已移走登记、非标准 bare/GIT_DIR 布局不在完整覆盖范围。需要更多归因时先补可公开的路径/元数据证据，不要求凭据，不扩大业务源码读取。

## 验证记录与限制

| 实际执行类别 | 结果 |
|---|---|
| 临时批量 inventory 脚本 | 成功；顶层 248 directory；249 行（含 upgrade repo）；independent 64、linked 1、absent 168、not-inspected 16；顶层失败 0 |
| 临时 related 元数据脚本 | 成功完成；当前 managed 1；worktrees container 3 linked + 6 个预期失败 128/ENOENT，失败已保留 |
| `rg`/只读源码与必要 `git log/show/ls-tree` | 已核对当前算法、历史 `.state` 默认、脚本相对路径、upstream sibling 默认及 enhanced 禁用二次分配；最初若干不存在的 glob 路径返回检索错误，已定位实际文件继续，未当作不存在实现的证据 |
| 测试/Host/provider/setup/probe/CLI | 均未运行；没有新增测试，符合本轮只读合同 |
| 报告静态一致性核对 | 附录 249 行与快照逐项对应；顶层 248、子项 1；owner/pointer 分类计数一致；个人 home 前缀已替换；没有占位符或行尾空白 |
| `git --no-optional-locks diff --cached --name-only` | 核对时输出为空；本轮未 stage/commit |

本轮唯一仓库写入为本报告。辅助脚本和脱敏中间 JSON 仅在自建 `/tmp/home-worktree-layout-etTLc8/` 中；没有清理任何用户目录或 Git 资源。目录快照不是锁定的事务，现场可能在调查后由其他行为变化。报告不验证 Git remote、创建时间、创建人、工作区终态或独立 checkout 成果可退役性。

## 附录：完整顶层目录清单与直接 Git 定位

下表列出全部 248 个顶层目录，另加唯一展开的 upgrade repo（标明子项）。每个 independent 行的 top-level 为名称本身、gitdir/common-dir 都是该行自身的 `.git`，具体 common-dir 和 HEAD 均逐项保留。无直接 `.git` 的行不宣称内部全无 Git。所有类型均现场观测为 directory。

| 名称/路径 | 类型 | 判定 | 元数据证据 |
|---|---|---|---|
| `~/.agents` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.ai` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.aider` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.ali-claude-code` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.android` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.aone_copilot` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.aone-copilot-preview` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.aone-mcp` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.aone-mr-baselines` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.aria2` | directory | 独立 checkout | gitdir=common-dir=`~/.aria2/.git`；HEAD=`ref: refs/heads/master` |
| `~/.basic-memory` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.bun` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.bundle` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.cache` | directory | 未检查内部；unknown | 仅记录顶层名称/类型，避开隐私/系统目录 |
| `~/.claude` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.cli-hub` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.cline` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.cloudshell-gitsync` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.cocoapods` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.codex` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.colima` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.conda` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.config` | directory | 未检查内部；unknown | 仅记录顶层名称/类型，避开隐私/系统目录 |
| `~/.constcheck-tmp` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.copilot` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.crash-analyzer` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.cursor` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.djl.ai` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.docker` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.dws` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.gem` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.gk` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.gnupg` | directory | 未检查内部；unknown | 仅记录顶层名称/类型，避开隐私/系统目录 |
| `~/.gradle` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.hammerspoon` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.handoff-tmp` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.harmony` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.hawtjni` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.hermes` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.hermes-qoder-probe` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.homebrew` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.Huawei` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.hvigor` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.idapro` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.iflow` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.iflow-aone` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.lc` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.leetcode` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.lldb` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.local` | directory | 未检查内部；unknown | 仅记录顶层名称/类型，避开隐私/系统目录 |
| `~/.loongsuite-pilot` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.luarocks` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.m2` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.maestro` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.mega-analyzer-rules` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.mtl-cli` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.mtl-cli-env` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.nano` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.nanocompose` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.ncs` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.normandy` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.normandy-credential.local` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.npm` | directory | 未检查内部；unknown | 仅记录顶层名称/类型，避开隐私/系统目录 |
| `~/.nuget` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.nvm` | directory | 独立 checkout | gitdir=common-dir=`~/.nvm/.git`；HEAD=`62387b8f92aa012d48202747fd75c40850e5e261` |
| `~/.oc-cc` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.oh-my-zsh` | directory | 独立 checkout | gitdir=common-dir=`~/.oh-my-zsh/.git`；HEAD=`ref: refs/heads/master` |
| `~/.ohos` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.ohpm` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.ollama` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.opam` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.openclaw` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.opencode` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.parallel` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.pi` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.pi-subagents` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.pip` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.playwright-mcp` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.playwright-sdk` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.pnpm-state` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.pymobiledevice3` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.pytest_cache` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.qmind` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.qoder` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.qoder-cli` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.qoder-cn` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.qodersec` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.qoderwork` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.r2c` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.real` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.refine` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.remote-files` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.repoconfig` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.rustup` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.smartassist` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.sogouinput` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.ssh` | directory | 未检查内部；unknown | 仅记录顶层名称/类型，避开隐私/系统目录 |
| `~/.ssh_pod` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.sub2api-v0211-workspaces` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.swiftpm` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.tb-mobile-harness` | directory | 独立 checkout | gitdir=common-dir=`~/.tb-mobile-harness/.git`；HEAD=`ref: refs/heads/main` |
| `~/.tbctx7` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.tbmh-worker` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.tbtools` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.tmpp` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.tnpm` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.token-switch` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.Trash` | directory | 未检查内部；unknown | 仅记录顶层名称/类型，避开隐私/系统目录 |
| `~/.um` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.uniinfra_kmp` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.venvs` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.vscode` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.vscode-shared` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.wanganquan` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.warning-analyzer-agent` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.warning-analyzer-remote` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.warning-daily-local` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.warning-online-readonly-20260916-141746` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.yunke` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.zcompdump-leshizhys-MacBook-Pro-5.9.lock` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/.zsh_sessions` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/27S1` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/a2-verify` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/ability_demo` | directory | 独立 checkout | gitdir=common-dir=`~/ability_demo/.git`；HEAD=`ref: refs/heads/update_uniapi` |
| `~/abilityidl` | directory | 独立 checkout | gitdir=common-dir=`~/abilityidl/.git`；HEAD=`ref: refs/heads/fix/checkversioncode` |
| `~/abilityidl_dynamic` | directory | 独立 checkout | gitdir=common-dir=`~/abilityidl_dynamic/.git`；HEAD=`ref: refs/heads/master` |
| `~/AgentSkills` | directory | 独立 checkout | gitdir=common-dir=`~/AgentSkills/.git`；HEAD=`ref: refs/heads/feat/i18n_platform` |
| `~/ai-coding-trace` | directory | 独立 checkout | gitdir=common-dir=`~/ai-coding-trace/.git`；HEAD=`ref: refs/heads/fix/pi-adapter-registration-repair` |
| `~/AliColor` | directory | 独立 checkout | gitdir=common-dir=`~/AliColor/.git`；HEAD=`ref: refs/heads/develop` |
| `~/alidocs-skill` | directory | 独立 checkout | gitdir=common-dir=`~/alidocs-skill/.git`；HEAD=`ref: refs/heads/master` |
| `~/AliProtoDBAdapter` | directory | 独立 checkout | gitdir=common-dir=`~/AliProtoDBAdapter/.git`；HEAD=`ref: refs/heads/main` |
| `~/aone-ci-static-analyzer` | directory | 独立 checkout | gitdir=common-dir=`~/aone-ci-static-analyzer/.git`；HEAD=`ref: refs/heads/master` |
| `~/aone-ci-validation.rtFL1H` | directory | 独立 checkout | gitdir=common-dir=`~/aone-ci-validation.rtFL1H/.git`；HEAD=`ref: refs/heads/main` |
| `~/aone-worker-client` | directory | 独立 checkout | gitdir=common-dir=`~/aone-worker-client/.git`；HEAD=`ref: refs/heads/main` |
| `~/apache-maven-3.5.0` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/Applications` | directory | 未检查内部；unknown | 仅记录顶层名称/类型，避开隐私/系统目录 |
| `~/atdtest` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/basic-memory` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/bin` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/brightness-control` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/build-cli-pipeline` | directory | 独立 checkout | gitdir=common-dir=`~/build-cli-pipeline/.git`；HEAD=`ref: refs/heads/main` |
| `~/claude-config` | directory | 独立 checkout | gitdir=common-dir=`~/claude-config/.git`；HEAD=`ref: refs/heads/opencode` |
| `~/cmms` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/code_gen_templates` | directory | 独立 checkout | gitdir=common-dir=`~/code_gen_templates/.git`；HEAD=`ref: refs/heads/feat/mcp` |
| `~/code-assistant` | directory | 独立 checkout | gitdir=common-dir=`~/code-assistant/.git`；HEAD=`ref: refs/heads/refine` |
| `~/command-line-tools` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/cpp_base` | directory | 独立 checkout | gitdir=common-dir=`~/cpp_base/.git`；HEAD=`ref: refs/heads/master` |
| `~/crash-analyzer-agent` | directory | 独立 checkout | gitdir=common-dir=`~/crash-analyzer-agent/.git`；HEAD=`ref: refs/heads/main` |
| `~/CrashAgentService` | directory | 独立 checkout | gitdir=common-dir=`~/CrashAgentService/.git`；HEAD=`ref: refs/heads/main` |
| `~/Desktop` | directory | 未检查内部；unknown | 仅记录顶层名称/类型，避开隐私/系统目录 |
| `~/DevEcoStudioProjects` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/DisplayFixer` | directory | 独立 checkout | gitdir=common-dir=`~/DisplayFixer/.git`；HEAD=`ref: refs/heads/main` |
| `~/docs` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/Documents` | directory | 未检查内部；unknown | 仅记录顶层名称/类型，避开隐私/系统目录 |
| `~/Downloads` | directory | 未检查内部；unknown | 仅记录顶层名称/类型，避开隐私/系统目录 |
| `~/empty-dir` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/git` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/go` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/interactsdk_publish` | directory | 独立 checkout | gitdir=common-dir=`~/interactsdk_publish/.git`；HEAD=`ref: refs/heads/feat/photo_di_new` |
| `~/ios-app-tool` | directory | 独立 checkout | gitdir=common-dir=`~/ios-app-tool/.git`；HEAD=`ref: refs/heads/main` |
| `~/iostest` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/langfuse` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/lib` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/Library` | directory | 未检查内部；unknown | 仅记录顶层名称/类型，避开隐私/系统目录 |
| `~/LocalizableStringsOptimizer` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/logs` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/MachOView` | directory | 独立 checkout | gitdir=common-dir=`~/MachOView/.git`；HEAD=`ref: refs/heads/master` |
| `~/mcp_demo_card` | directory | 独立 checkout | gitdir=common-dir=`~/mcp_demo_card/.git`；HEAD=`ref: refs/heads/master` |
| `~/mega-aone-pipeline-runtime` | directory | 独立 checkout | gitdir=common-dir=`~/mega-aone-pipeline-runtime/.git`；HEAD=`ref: refs/heads/main` |
| `~/mega-aone-private-evidence` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/mega-aone-service` | directory | 独立 checkout | gitdir=common-dir=`~/mega-aone-service/.git`；HEAD=`ref: refs/heads/main` |
| `~/mega-aone-service-dynamic-ability` | directory | 独立 checkout | gitdir=common-dir=`~/mega-aone-service-dynamic-ability/.git`；HEAD=`ref: refs/heads/master` |
| `~/mega-mtl-smoke` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/Megability-iOS` | directory | 独立 checkout | gitdir=common-dir=`~/Megability-iOS/.git`；HEAD=`ref: refs/heads/fix/camera-stream-duo-rotation-20261020` |
| `~/megability-ios-1` | directory | 独立 checkout | gitdir=common-dir=`~/megability-ios-1/.git`；HEAD=`ref: refs/heads/feat/tmall-merge-2.2.1.58` |
| `~/MegabilityIDLInterface_iOS` | directory | 独立 checkout | gitdir=common-dir=`~/MegabilityIDLInterface_iOS/.git`；HEAD=`ref: refs/heads/feature/mcp_server` |
| `~/MegaDemo` | directory | 独立 checkout | gitdir=common-dir=`~/MegaDemo/.git`；HEAD=`ref: refs/heads/feat/broadcast-e2e` |
| `~/MegaDesign-iOS` | directory | 独立 checkout | gitdir=common-dir=`~/MegaDesign-iOS/.git`；HEAD=`ref: refs/heads/feat/decrease_package` |
| `~/memory-distill` | directory | 独立 checkout | gitdir=common-dir=`~/memory-distill/.git`；HEAD=`ref: refs/heads/main` |
| `~/mihomo-probe-fkwall` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/mihomo-probe-linkcube` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/mihomo-probe-nonus-local` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/minigame-storage` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/miross-employees` | directory | 独立 checkout | gitdir=common-dir=`~/miross-employees/.git`；HEAD=`ref: refs/heads/fix/20261008-crash-agent-input-fidelity` |
| `~/model-access-policy-snapshots` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/Movies` | directory | 未检查内部；unknown | 仅记录顶层名称/类型，避开隐私/系统目录 |
| `~/mtl-cli` | directory | 独立 checkout | gitdir=common-dir=`~/mtl-cli/.git`；HEAD=`ref: refs/heads/master` |
| `~/mtl-cli-app-publish-mega-task` | directory | 独立 checkout | gitdir=common-dir=`~/mtl-cli-app-publish-mega-task/.git`；HEAD=`ref: refs/heads/master` |
| `~/mtl-cli-crash-analyzer-bridge` | directory | 独立 checkout | gitdir=common-dir=`~/mtl-cli-crash-analyzer-bridge/.git`；HEAD=`ref: refs/heads/main` |
| `~/mtl-cli-dynamic` | directory | 独立 checkout | gitdir=common-dir=`~/mtl-cli-dynamic/.git`；HEAD=`ref: refs/heads/master` |
| `~/mtl-cli-internationalization` | directory | 独立 checkout | gitdir=common-dir=`~/mtl-cli-internationalization/.git`；HEAD=`ref: refs/heads/master` |
| `~/mtl-cli-mega-ability-idl` | directory | 独立 checkout | gitdir=common-dir=`~/mtl-cli-mega-ability-idl/.git`；HEAD=`ref: refs/heads/feat/mcp` |
| `~/mtl4-plugin-app-publish-build-task` | directory | 独立 checkout | gitdir=common-dir=`~/mtl4-plugin-app-publish-build-task/.git`；HEAD=`ref: refs/heads/develop` |
| `~/mtl4-plugin-mtl-cli-build-plugin` | directory | 独立 checkout | gitdir=common-dir=`~/mtl4-plugin-mtl-cli-build-plugin/.git`；HEAD=`ref: refs/heads/master` |
| `~/mtl4-plugin-shell-plugin` | directory | 独立 checkout | gitdir=common-dir=`~/mtl4-plugin-shell-plugin/.git`；HEAD=`ref: refs/heads/dev/plugin-core-1.1.0` |
| `~/mtl4-plugin-upload` | directory | 独立 checkout | gitdir=common-dir=`~/mtl4-plugin-upload/.git`；HEAD=`ref: refs/heads/develop` |
| `~/Music` | directory | 未检查内部；unknown | 仅记录顶层名称/类型，避开隐私/系统目录 |
| `~/NanoCompose` | directory | 独立 checkout | gitdir=common-dir=`~/NanoCompose/.git`；HEAD=`ref: refs/heads/develop` |
| `~/new-api-account-pool` | directory | 独立 checkout | gitdir=common-dir=`~/new-api-account-pool/.git`；HEAD=`ref: refs/heads/main` |
| `~/new-api-account-pool-mihomo-doc` | directory | linked worktree | gitdir=`~/new-api-account-pool/.git/worktrees/new-api-account-pool-mihomo-doc`；common-dir=`~/new-api-account-pool/.git`；HEAD=`ref: refs/heads/docs/mihomo-agent-guidance` |
| `~/opencode` | directory | 独立 checkout | gitdir=common-dir=`~/opencode/.git`；HEAD=`ref: refs/heads/plugin-tool-views` |
| `~/overlay-selftest-bcf346of` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/overlay-selftest-gmvyjlge` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/overlay-selftest-ijdp9mp_` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/overlay-selftest-sfxe3b7u` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/overlay-selftest-thatntv1` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/overlay-selftest-wgbqiopp` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/pi-config` | directory | 独立 checkout | gitdir=common-dir=`~/pi-config/.git`；HEAD=`ref: refs/heads/main` |
| `~/pi-upgrade-1.3.0` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/pi-upgrade-1.3.0/repo`（container 子项） | directory | 独立 checkout | gitdir=common-dir=`~/pi-upgrade-1.3.0/repo/.git`；HEAD=`ref: refs/heads/upgrade/pi-1.3.0` |
| `~/pic-to-dsl` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/Pictures` | directory | 未检查内部；unknown | 仅记录顶层名称/类型，避开隐私/系统目录 |
| `~/Public` | directory | 未检查内部；unknown | 仅记录顶层名称/类型，避开隐私/系统目录 |
| `~/PyCharmMiscProject` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/PycharmProjects` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/qking-bundler` | directory | 独立 checkout | gitdir=common-dir=`~/qking-bundler/.git`；HEAD=`ref: refs/heads/master` |
| `~/qoder-a2-compile` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/qoder-fix2-tmp` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/remote-access-mac` | directory | 独立 checkout | gitdir=common-dir=`~/remote-access-mac/.git`；HEAD=`ref: refs/heads/main` |
| `~/remote-mac-client` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/rocketmq-install` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/sa-node-server` | directory | 独立 checkout | gitdir=common-dir=`~/sa-node-server/.git`；HEAD=`ref: refs/heads/main` |
| `~/service-dingtalk-ci.bCRFNZ` | directory | 独立 checkout | gitdir=common-dir=`~/service-dingtalk-ci.bCRFNZ/.git`；HEAD=`ref: refs/heads/main` |
| `~/service-dingtalk-ci.hp9aDa` | directory | 独立 checkout | gitdir=common-dir=`~/service-dingtalk-ci.hp9aDa/.git`；HEAD=`ref: refs/heads/master` |
| `~/Sites` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/strings-to-binary` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/sub2api-v0211-candidates` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/sub2api-v0211-worktrees` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/taoappuse` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/taobao-biz-workspace` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/taobao-ios-workspace` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/taobao-mobile-workspace` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/TaobaoBuildTools` | directory | 独立 checkout | gitdir=common-dir=`~/TaobaoBuildTools/.git`；HEAD=`ref: refs/heads/main` |
| `~/tbutility` | directory | 独立 checkout | gitdir=common-dir=`~/tbutility/.git`；HEAD=`ref: refs/heads/master` |
| `~/test` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/test-mtl-module` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/test-workspace` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/texas-godot` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/themis-graphics` | directory | 独立 checkout | gitdir=common-dir=`~/themis-graphics/.git`；HEAD=`ref: refs/heads/develop` |
| `~/tmcp-server` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/TMMegaAI` | directory | 独立 checkout | gitdir=common-dir=`~/TMMegaAI/.git`；HEAD=`ref: refs/heads/master` |
| `~/tmp` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/work-skills` | directory | 独立 checkout | gitdir=common-dir=`~/work-skills/.git`；HEAD=`ref: refs/heads/master` |
| `~/workflow-probe` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/worktrees` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/xcactivitylog-parser` | directory | 独立 checkout | gitdir=common-dir=`~/xcactivitylog-parser/.git`；HEAD=`ref: refs/heads/feat/app` |
| `~/xcode_test_project` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/xcodes-downloads` | directory | 无直接 Git 入口；内部 unknown | 直接 `.git` 不存在（ENOENT） |
| `~/zsh-autocomplete` | directory | 独立 checkout | gitdir=common-dir=`~/zsh-autocomplete/.git`；HEAD=`ref: refs/heads/main` |
