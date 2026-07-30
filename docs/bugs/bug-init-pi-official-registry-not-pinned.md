# Bug：初始化脚本未固定官方 npm registry

## 1. 现象

`init-pi.sh` 虽然固定了 Pi、pi-subagents 和 rpiv-todo 的精确版本，但安装命令继承用户默认 npm registry。公司镜像尚未同步目标版本时，初始化会返回 `ETARGET` 或安装到与验证环境不同的制品。

## 2. 影响

新机器和重复初始化不能稳定复现本仓已验证的运行时；全局 Pi、Pi package 和 Plan Runtime 依赖可能分别来自不同 registry。

## 3. 触发条件与证据

- 本机默认 registry 是公司镜像，升级期间曾对 `@juicesharp/rpiv-todo@2.2.0` 返回 `ETARGET`。
- `init-pi.sh` 的 `npm install`、两次 `pi install` 和 setup 命令均未传播 `NPM_CONFIG_REGISTRY`。
- RED fixture 记录每个 fake npm/Pi 进程收到的环境，实际均为 `registry=`。

## 4. 根因

升级过程的手工命令显式使用了官方 registry，但可重复初始化脚本只同步了版本号，没有把 registry 作为安装契约的一部分。

## 5. 修复决策

在脚本中固定 `https://registry.npmjs.org`，仅通过每条安装命令的 `NPM_CONFIG_REGISTRY` 环境变量传播，不修改用户全局 npm 配置。覆盖全局 Pi、Pi package 和 Plan Runtime 安装。

## 6. 验证

fixture 必须观察三类安装命令均收到官方 registry；随后重跑 init、Doctor 和 diff 检查。
