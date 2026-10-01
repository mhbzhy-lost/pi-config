# `pi --version` 在 package-root 覆盖下误报版本，导致两轮错误归因

- 日期：2026-10-01
- 级别：P2（诊断陷阱；已实际造成两轮错误定性）
- 状态：已定位并给出规避规程；根治归属 pi core / 派发运行时
- 发现者：T7 A/B 对照实验子任务（主 agent 起初误判为子任务出错）

## 现象

同一条**绝对路径**命令，在不同进程环境里给出不同版本：

```text
$ command /opt/homebrew/bin/pi --version                    # 继承 ambient package-root 覆盖
0.87.1                                                       # ← 误报
$ env -u PI_PACKAGE_DIR -u PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT -u PI_REAL_BIN \
      /opt/homebrew/bin/pi --version
0.85.1                                                       # ← 真实版本
$ node -e 'console.log(require("/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/package.json").version)'
0.85.1                                                       # ← 权威交叉核实（不经二进制）
```

ambient 中存在三个指向 repo-local 的覆盖变量：
`PI_REAL_BIN`、`PI_PACKAGE_DIR`、`PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT`
（均为 `…/pi-config-upgrade/node_modules/…`，由派发运行时注入子进程环境）。

## 危害：已实际造成两轮错误归因

1. **T8 一轮**：子任务据 `--version` 输出认为"全局已是 0.87.1、历史 trace 是过期痕迹"，
   请示是否判"不可复现"。主 agent 用自己的 shell 复核得 0.85.1，**据此指责子任务误判**——
   实则双方各自环境下的读数都正确，主 agent 的 shell 恰好不含覆盖变量。
2. **T7 一轮**：同一误判再次出现，主 agent 再次以"绝对路径"为由驳回。
   直到本轮子任务显式做 `env -u` 对照，才查明真因是 **package-root 环境覆盖**，
   而非 PATH 解析、`npx`、或相对 symlink 解析（主 agent 此前列出的三个猜测成因**全错**）。

后果：两轮各浪费一次完整的请示—驳回往返，且主 agent 在 HANDOFF 与缺陷文档中写下了
错误的"权威版本事实"，险些污染后续所有归因。

## 根因方向

`pi --version` 报告的是**被 package-root 覆盖后解析到的包版本**，而不是**被调用的那个二进制**
自身的版本。二者在被覆盖环境下不一致，而输出没有任何提示，故具误导性。
覆盖变量的注入方是本仓派发运行时（子进程环境），根治需 pi core 或派发运行时
在版本输出中同时标明实际二进制路径与是否处于覆盖状态。

## 规避规程（本仓所有版本判定必须遵守）

1. **唯一权威方式**：读**绝对路径**的 `package.json`，不经过任何二进制：
   ```bash
   node -e 'console.log(require("<绝对路径>/package.json").version)'
   ```
2. 若必须用 `--version`，先清除全部覆盖变量：
   ```bash
   env -u PI_PACKAGE_DIR -u PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT -u PI_REAL_BIN \
       <绝对路径 pi> --version
   ```
3. **禁止**：`pi --version`（PATH 解析）、`npx pi`、`$PI_REAL_BIN --version`、
   对相对 symlink 目标做 cwd 相对解析。
4. 报告版本结论时**必须附上所用命令的原始输出**，并注明是否清除了覆盖变量。

## 数据来源分类

**类别 2 与类别 1 之间**：误报本身源于生产环境注入的覆盖变量与 pi core 的版本解析交互，
属真实 production 行为（类别 1 特征）；但其危害面是**诊断与归因**，不直接改变派发结果。
本轮按诊断陷阱登记，规避规程写入交接文档；根治需上游改动，另立上游回馈项。
