# 独立 apply_patch CLI

仅使用 Rust 标准库，不依赖 Node、Pi Host、npm 或第三方 crate。运行时读取 stdin，在进程当前工作目录应用补丁。

构建并安装到仓库的 `pi/bin`（在仓库根执行）：

```sh
cargo build --release --offline --locked --manifest-path src/apply-patch/native/Cargo.toml --target-dir .build/apply-patch
cp .build/apply-patch/release/apply_patch pi/bin/apply_patch
```

构建目标为当前 Rust Host 平台。本仓当前交付平台为 macOS arm64。release 启用 LTO、单 codegen unit、去符号和 panic abort。

支持新增、删除、更新、移动、多个 chunk、`@@` 上下文定位、文件尾锚点、空白及 Unicode 标点模糊匹配。成功输出按 A/M/D 分类；空输入退出 2，解析或应用错误退出 1。操作按补丁顺序执行，整个补丁没有事务原子性；失败后先核对已有文件变更再重试。
