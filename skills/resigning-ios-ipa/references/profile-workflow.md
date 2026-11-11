# 新设备与描述文件

本流程适用于已有个人开发身份和显式应用描述文件，但新 iPhone/iPad 尚未被覆盖的情况。使用既有应用标识，不改 Portal App ID、capability 或其他项目。

## 授权与准备

用户已同意将新设备纳入个人开发团队、创建/下载描述文件并安装时，直接继续；“信任此电脑”只解决连接配对，不代表设备已进入开发描述文件。

```bash
python3 "$SKILL_DIR/resign_ios_ipa.py" prepare-profile \
  --profile /path/to/existing.mobileprovision --device DEVICE_ID
```

命令会核验 profile 中的 Team 与有效本机身份、固定目标设备，使用 `xcodegen` 创建只有一个 App target 的工程，无测试、Pods 或扩展。JSON 输出包含 `project`、`workdir`、`device` 和 `destination`；不直接读取 Xcode 账号配置。

需要准备 `xcodegen` 时先检查本机是否已有，不为此升级整套 Xcode 工具链。已有精确匹配的隔离工程可复用，但不能拿其他 Bundle ID 的业务项目申请该应用的 profile。

## 原生 Xcode 更新已有 profile

1. 读取并遵循 `ios-device-signing` 的检查规则；用刚生成的真实 project、scheme `IpaProfileRepair`、配置 `Debug`、精确 physical destination 运行 bundled inspector。不得伪造 metadata、删除旧 profile 或隐藏设备覆盖错误。
2. 已确认源 owner 是缺少新设备覆盖、且账号/profile/设备登记授权齐备时，使用 Xcode 的原生签名界面处理同一 owner；以下 AppleScript 只实现本会话已经成功使用的 Product → Destination → Build，不传 `-allowProvisioningUpdates`。
3. 用 `xcode-select -p` 得到实际 `.app` 路径；本机 Xcode 可能名为 `Xcode-27.0.0.app`，不要假设 `open -a Xcode` 一定可用。
4. 打开输出的 project，前台窗口加载完成后运行：

```bash
osascript "$SKILL_DIR/xcode_profile_build.applescript" \
  "$DEVICE_NAME" "$UNIQUE_WORKDIR_BASENAME"
```

脚本核对前台工程工作目录标识、匹配唯一设备菜单项，然后触发一次 Build。它返回 `build-requested` 只代表已触发，不能当作成功。若窗口尚未加载、菜单存在歧义或系统要求登录/2FA，报告实际状态，不能换到另一个工程或设备。

5. 构建期间继续独立工作；从 Xcode 的实际 Build Succeeded/Failed 状态或真实产物判断结果，不运行 sleep/wait 或轮询脚本来假装推进。构建失败保留错误，不盲目重试。
6. 成功后再运行 `inventory --device DEVICE_ID` 和 bundled inspector，核验新 profile 覆盖目标、Team/身份/entitlement 匹配。然后调用 `resign --profile 新文件 ...`。新的 IPA 必须嵌入新 profile，旧包不会自动更新。

没有额外 App ID/capability 创建授权时，不通过自动签名创建其他 ID。若本机无法证明仅更新既有应用的 profile，停在该具体 owner 报告。

## 已观察到的采集器限制

- `security find-identity` 的证书名称括号可能是账号标识，真实 Team 取公开证书 subject 的 OU。仅依据标签可误报 `missing-identity`；用实际签名产物或公开证书证据解决，不篡改 metadata。
- `plistlib` 返回的 profile 日期可能为 UTC 的无时区 `datetime`，应显式附上 UTC 再转换。直接 `.astimezone()` 会把它误当本机时区。
- 不知道免费团队名额时写 unknown，不能把 `capacityGate=ready/available` 的默认值冒充实际容量证据，也不能据此删除应用。

## 删除应用的边界

遇到免费名额已满，先展示设备安装服务明确报告的具体应用。只有用户明确指定待删除应用后，实时核对目标设备和完整 Bundle ID，再执行：

```bash
xcrun devicectl device uninstall app --device DEVICE_ID EXACT_BUNDLE_ID
```

再次查询应用清单确认卸载成功。只删除用户选择的那一个，随后使用已经生成的 `result.json` 执行 `install`。
