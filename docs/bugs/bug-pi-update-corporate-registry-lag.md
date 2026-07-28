# Bug：Pi 更新目标领先于公司 npm 镜像

## 1. 现象

执行 `pi update` 时，Pi 从 `pi.dev` 得到最新版本 `0.82.0`，但 npm 安装报 `ETARGET`，提示该版本在当前时间之前不存在。

## 2. 影响

使用公司 npm 镜像且镜像尚未同步最新版本时，Pi 自更新失败；已安装的 `0.81.1` 仍可继续使用，扩展未受本次命令影响。

## 3. 稳定复现

当 `registry=https://registry.anpm.alibaba-inc.com` 时执行 `npm view @earendil-works/pi-coding-agent@0.82.0 version` 返回 404，随后执行 `pi update` 稳定失败。切换为官方 registry 后，同一版本可正常查询。

## 4. 证据

`https://pi.dev/api/latest-version` 返回 `0.82.0`。官方 npm registry 显示该版本发布于 `2026-07-24T06:12:09.982Z`，公司镜像的版本列表截至本地时间 17:16 仍停留在 `0.81.1`；本机时间与官方发布时间不存在倒挂。

## 5. 根因

Pi 的版本发现和制品下载使用不同数据源：前者使用 `pi.dev`，后者继承本机 npm registry。公司镜像存在同步延迟，导致 Pi 已发现新版本，而 npm 镜像尚无对应制品。

## 6. 修复与验证策略

仅为本次安装显式指定 `--registry=https://registry.npmjs.org`，不修改用户全局 npm registry。安装后分别运行 `pi --version` 和 `npm list -g @earendil-works/pi-coding-agent --depth=0`，确认二者均为 `0.82.0`。
