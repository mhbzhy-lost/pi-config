# Pi 兼容探针假定 Homebrew 安装前缀

## 现象

`pi-subagents` 浏览器兼容探针在非 `/opt/homebrew` 的 Node 全局安装环境加载失败，即使已安装兼容的 Pi 版本。

## 根因

探针以静态 `import` 引用 Homebrew 专用的绝对路径。Node 会在模块加载阶段解析该路径，因而无法利用实际 npm 全局模块根目录，也无法由调用方恢复。

## 影响

Doctor 与兼容回归可能把有效的 Linux、nvm、Volta 或自定义 npm prefix 环境误判为不兼容；测试也无法证明安装位置无关。

## 不变量

探针必须从当前 npm 的全局模块根目录定位 `@earendil-works/pi-coding-agent/dist/index.js`；调用方显式传入的 Pi module 仍优先；不得读取认证配置或猜测多个路径。

## 修复策略

将公开 Pi API 改为按需动态加载，并允许测试提供临时全局模块根目录。全局根目录通过异步子进程解析，避免阻塞已是 async 的浏览器兼容检查；若解析失败，保留子进程 stderr 以便诊断。浏览器兼容检查仅在未传入 `piModule` 时触发该加载。

## 回归测试

在临时目录构造最小全局 package 布局，验证 loader 从异步解析得到的目录实际导入模块；空根目录必须 fail closed，解析异常必须保留 stderr。若恢复 Homebrew 固定路径或忽略异步 resolver，测试将无法取得 fixture 的导出标记。
