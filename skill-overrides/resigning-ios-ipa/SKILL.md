---
name: resigning-ios-ipa
description: Use when a user wants to re-sign an existing iOS IPA with local personal Apple Development credentials, change its Bundle ID, install it on a connected iPhone or iPad, or repeat a previously authorized re-signing workflow for another IPA or device. 关键词：IPA 重签、个人证书、改 bundleid、企业包转个人签名、连接手机安装、换包再试、新设备重签。
---

# iOS IPA 个人重签与安装

对已经构建好的 IPA，优先直接运行本 Skill 的工具。工具自动完成原包校验、描述文件与身份选择、设备覆盖检查、逐组件重签、资源差异核验、重新解包验签及可选安装，不重新走一轮人工调研或编写临时脚本。

首次使用时，告诉用户正在使用本 Skill。沿用当前会话已有授权和设备选择；用户已要求 inline 时由主会话直接执行。

## 适用条件与授权

- macOS、本机 Xcode 和 Python 3.10 以上；只使用本机已有签名身份，不导出私钥、不读取账号令牌。
- `--personal-minimal` 表示已选择个人开发签名方案：可修改主 Bundle ID、改用个人钥匙串组，并将主 entitlement 收敛为应用标识、Team、`get-task-allow` 和单个钥匙串组。
- 只有会话已允许移除不兼容扩展时才传 `--strip-extensions`；工具只处理主 App 下的 `PlugIns`、`Watch`、`AppClips`，不会默默删除其他嵌入程序。
- 用户要求安装时加 `--install`。用户明确要求换包覆盖，或已确认目标是本会话刚安装的同标识应用时，加 `--replace`；普通 `builtByDeveloper=true` 不能证明应用归属。
- 已授权的这些操作不反复询问。注册新设备、创建或下载 profile、登录账号，以及删除现有设备 App 各有自己的真实副作用，只有实际需要且会话尚未授权时才补问具体动作。

无需源码工程、CocoaPods、构建整包或重新申请无关 App ID。不要为了签 IPA 先搜索整机工程。

## 快速执行

将 `SKILL_DIR` 设为本次已读取的 `SKILL.md` 所在目录，以下命令中的路径由现场事实替换。

用户已允许个人签名、裁剪扩展并覆盖安装到指定 iPad 时：

```bash
python3 "$SKILL_DIR/resign_ios_ipa.py" resign \
  --ipa /path/to/input.ipa \
  --personal-minimal --strip-extensions \
  --device iPad --install --replace
```

仅生成重签包，不装机：

```bash
python3 "$SKILL_DIR/resign_ios_ipa.py" resign \
  --ipa /path/to/input.ipa --personal-minimal
```

工具自动扫描标准 profile 目录，将 `DeveloperCertificates` 与 `security find-identity` 返回的有效指纹求交集，通过公开证书 OU 核实 Team。原 ID 有匹配文件则保留；否则仅在有效候选唯一时选择已有的显式 Bundle ID。多个团队或 ID 候选时，用 `--profile`、`--bundle-id` 或 `--team` 指定，避免猜测。

多台设备连接时使用 CoreDevice ID 或 UDID；名称仅在唯一匹配时可用。不要用“哪台设备碰巧在旧 profile 中”选择用户刚连接的新机。

```bash
python3 "$SKILL_DIR/resign_ios_ipa.py" inventory
python3 "$SKILL_DIR/resign_ios_ipa.py" resign \
  --ipa /path/to/input.ipa --personal-minimal --strip-extensions \
  --profile /path/to/existing.mobileprovision \
  --bundle-id com.example.personalapp \
  --device DEVICE_ID --install --replace
```

每次运行创建独立工作目录，保留输入包并输出新的 IPA、`result.json`、`commands.json`、中文报告、原始/签后文件清单和重新解包的 `.app`。产物默认写入输入 IPA 同目录；`--output` 可指定路径，已有输出不会覆盖。大包处理或安装用宿主异步 Bash，启动后继续独立工作，完成以真实退出码和验证结果为准。

## 设备未被描述文件覆盖

不要反复尝试安装旧包，也不要重复询问已经取得的 profile 授权。按 [新设备与描述文件](references/profile-workflow.md) 创建隔离的单 App 签名工程，使用 Xcode 原生构建更新**已有应用标识**的描述文件，然后重新运行上面的同一条重签命令。

```bash
python3 "$SKILL_DIR/resign_ios_ipa.py" prepare-profile \
  --profile /path/to/existing.mobileprovision --device DEVICE_ID
```

该命令只准备工程，不自动登录、登记设备或申请 profile。原生构建须遵循当前会话实际授权；`ios-device-signing` 对 `-allowProvisioningUpdates` 的限制仍适用，不能靠隐藏旧 profile、伪造检查结果或换一套命令绕过。

## 安装被名额限制拦住

设备安装服务明确返回 `maximum number of installed apps using a free developer profile` 才能判定免费名额已满。`builtByDeveloper` 应用总数无法推导免费名额。

工具返回 `capacity-full` 和原始安装回执路径。列出系统实际报告的占位应用，只有用户明确选择删除某个具体应用后才卸载它。不要自动删淘宝、另一个测试 App 或个人数据。卸载后直接安装已经生成的产物，无需重新重签：

```bash
python3 "$SKILL_DIR/resign_ios_ipa.py" install \
  --result /path/to/work/result.json --device DEVICE_ID --replace
```

## 固定实施规则

1. 原包 SHA256、权限、符号链接和主 `.app` 结构现场读取，不按文件名或历史包的组件数量推断。先保存完整文件清单，再修改副本。
2. `cryptid != 0` 直接报告加密阻塞。本工具不解密或修改业务代码。
3. 主 ID 与嵌入 profile 一致。签名权限由 profile 的实际 `ApplicationIdentifierPrefix` 和 Team 构造，不把证书名称括号里的账号标识当成 Team。
4. 保留 URL schemes 和 `BGTaskSchedulerPermittedIdentifiers`，不批量替换字符串。只有 `UIApplicationShortcutWidget` 指向本次不存在或已移除的扩展时，才清理该键。
5. 框架、代码 bundle、dylib 由内到外独立签名，最后签主 App。`--deep` 不能代替逐项签名。每项都核验 Team、公开叶证书指纹、entitlements、Mach-O section 散列；签名导致的可执行文件变化与普通资源变化分别记录。
6. 重新打包后再解包验证，确认文件、权限、符号链接一致。安装前实时核对设备 UDID、开发者模式、profile 覆盖和同标识应用；安装后必须检查应用清单和安装服务回执。
7. 默认不启动 App、不执行登录或业务动作。签名通过、安装成功、启动正常、业务正常是不同结果，报告实际完成的阶段。

## 真实阻塞与报告

只在实际发现以下情况时停：签名身份不可用、profile 缺失/过期/不覆盖目标、目标设备不唯一或不可达、加密 Mach-O、不支持的嵌入程序、未授权资源变化、签名/安装失败、未获授权覆盖或删除既有应用。命令失败保留原始错误，不自动换证书、换 profile、换设备或循环重试。

最终简短报告：输入包、输出 IPA 链接、新 ID、目标设备、到期时间、实际删除与裁剪内容、验签数量、安装结果、未验证的运行行为。

经验与限制见 [已验证命令和常见误判](references/pitfalls.md)。不要把本会话某次崩溃的推测写成所有个人重签必然失败的规则。
