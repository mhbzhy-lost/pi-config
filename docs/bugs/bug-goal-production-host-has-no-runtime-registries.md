# Goal Engine production Host 未接通 runtime registries

## 现象

启用 Goal Engine 后，Pi 入口创建的 production Host 默认只带空的 `registries` 与 `adapterRegistry`。因此合法的 runtime condition 无法使用 Host-owned authority 完成 readiness 初始化。

## 影响

生产入口与直接注入测试 Host 的能力不一致；同时不能将配置缺失误当作空 authority。

## 修复边界

仅从非敏感 `goalEngine.runtimeHost` settings 解析 adapters、environment、fixture、resource，并在缺失或非法配置时关闭 runtime authority；不新增动态 inventory。
