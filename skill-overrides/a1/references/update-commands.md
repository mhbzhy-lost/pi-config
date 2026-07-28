# a1 安装与自更新命令参考

## 初始安装

```bash
curl -fsSL https://git.cn-hangzhou.oss-cdn.aliyun-inc.com/aone-cli/install.sh | sh
```

官方文档：<https://a1.io.alibaba-inc.com/>

## update

```bash
a1 update [version] [flags]
```

### 参数与 flag

- 省略 `version`：查询并安装 cli-hub 的最新稳定版本。
- 普通 SemVer `version`（如 `0.2.27`）：通过 cli-hub 安装指定稳定版本，可用于回退。
- `--channel alpha`：从内部 OSS 安装最近一次 shared 发布的不可变 alpha 版本。
- `--channel alpha MAJOR.MINOR.PATCH-alpha`：从版本族 manifest 解析并安装最新 shared `alpha.N`。
- `--channel alpha MAJOR.MINOR.PATCH-alpha.N`：从内部 OSS 安装该精确 alpha 版本，可用于复现或回退。
- `--channel stable|beta|alpha`：稳定版、beta 灰度通道或内部 alpha 通道。
- `--force`：即使解析后与当前版本相同，也重新下载并安装。
- `--env production|test`：仅影响仍使用 manifest 的辅助组件/测试环境选择，不把 alpha 变成自动通道。

### 示例

```bash
# 最新稳定版
a1 update

# 指定稳定版本
a1 update 0.2.27

# 安装最新共享内部 alpha
a1 update --channel alpha

# 安装 0.2.28 版本族的最新共享内部 alpha
a1 update --channel alpha 0.2.28-alpha

# 精确安装/回退
a1 update --channel alpha 0.2.28-alpha.52539452

# beta 灰度通道
a1 update --channel beta
```

## Alpha 安全边界

1. alpha 只发布到内部 OSS，不发布到 cli-hub，也不会修改 cli-hub 的 stable 指针。
2. alpha 没有后台检查、启动提示、灰度分群或自动安装。只有显式携带 `--channel alpha` 时，CLI 才访问 alpha manifest；裸写 alpha 版本会被拒绝。
3. `a1 update --channel alpha` 解析最近一次 shared 发布；`X.Y.Z-alpha` 是可变的版本族别名，只能解析到同一版本族中最新的 shared `X.Y.Z-alpha.N`。CLI 会校验 shared 模式与版本族，拒绝错误解析。
4. `X.Y.Z-alpha.N` 是不可变版本。manifest 版本必须与请求完全一致，二进制必须通过 SHA-256 校验。
5. 安装 alpha 不会把用户持久化订阅到 alpha。之后执行普通 `a1 update` 会重新按稳定版逻辑解析。

当用户只说“升级 a1”时，默认使用 `a1 update`，绝不能主动推荐 alpha。只有用户明确要求内部体验版、alpha 版本或给出 `-alpha` 版本号时，才构造 alpha 命令。
