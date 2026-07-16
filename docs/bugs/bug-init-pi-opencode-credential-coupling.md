# Bug：Pi 初始化脚本耦合 OpenCode 凭据存储

## 1. 现象

`init-pi.sh` 在初始化 Pi 时读取 `~/.local/share/opencode/auth.json`，尝试迁移
`openai-idealab` key。全新机器未安装或未配置 OpenCode 时，该路径没有业务保证。

## 2. 影响

- Pi 的独立初始化契约包含另一个工具的私有存储路径和数据结构。
- OpenCode 变更凭据格式或路径会无关地影响 Pi 初始化。
- 测试夹具必须伪造 OpenCode 状态，掩盖 Pi 本身已有 `/login` 凭据入口。

## 3. 稳定复现

- 在空 `HOME` 中执行 `init-pi.sh`。
- 脚本检查固定的 OpenCode auth 路径，并输出对应 skip 信息。
- 即使 Pi 安装和 Shell 注册完全独立，该分支仍属于每次初始化流程。

## 4. 证据

- `init-pi.sh` 声明 `OPENCODE_AUTH` 并解析其中的 `openai-idealab.key`。
- `test/init-pi.test.mjs` 创建 OpenCode auth 夹具并要求迁移到 `pi/auth.json`。
- Pi `0.80.6` 已原生支持 `/login openai-idealab`，无需外部凭据仓参与。

## 5. 根因

为了复用当前机器已有 key，把一次性本地迁移误放进了“新机器可重放初始化”职责。机器级
便利操作与仓库级安装契约没有分离。

## 6. 修复与验证策略

- 从 `init-pi.sh` 删除所有 OpenCode 路径、格式和迁移逻辑。
- 初始化只安装 Pi、注册 Shell 集成并执行验证。
- README 明确凭据由 Pi `/login openai-idealab` 独立创建。
- 测试放置一个 OpenCode auth 诱饵文件，断言初始化后 `pi/auth.json` 保持原样，证明脚本
  不读取或迁移外部凭据。
