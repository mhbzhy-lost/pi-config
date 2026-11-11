# 已验证命令和常见误判

## 可直接复用的命令

| 事项 | 正确做法 |
| --- | --- |
| 解包与打包 | `ditto -x -k input.ipa fresh-directory`；`ditto -c -k extracted candidate.ipa`，保留权限和符号链接，重新解包检查。 |
| entitlement 读取 | `codesign -d --entitlements - --xml App.app`，在辅助进程内解析 plist，不把原始 profile 或证书内容写进报告。 |
| 提取公开叶证书 | `codesign -d --extract-certificates=/absolute/prefix- App.app`；prefix 必须与选项连写。提取只用于内部计算指纹，随后移除临时公开证书文件。 |
| 逐项签名 | `codesign --force --sign SHA1 --timestamp=none Framework.framework`，由内到外；主 App 额外传 `--entitlements file.plist`。 |
| 严格验签 | 每个代码对象独立 `codesign --verify --strict`；主 App 通过不能证明其扩展通过。 |
| 安装 `.app` | `xcrun devicectl device install app --device DEVICE_ID /path/App.app`，安装对象是从已验证 IPA 解出的主 `.app`。 |
| 验证安装 | 安装服务退出 0 并且设备应用清单存在预期 Bundle ID/版本，才报告安装成功。 |

## 避免重复踩坑

- 不把文件名 `ReleaseWithWatch` 当作实际包含 Watch 的证据；组件数量和目录从包内读取。
- 新包的 framework、扩展、主 Bundle ID、来源 Team 都可能不同；不能复用上一份输入包的硬编码清单或旧的 SHA256。
- 先保存 `before-tree.json` 再改 Info.plist。修改以后才做基线，会遗漏真正的资源变更。
- 基础快速模式只移除调用者已允许的扩展。包原本没有扩展时，报告“未删除扩展”，不能沿用前一包“删除 7 个”的结论。
- 本机有效 identity 指纹与 profile 内公开证书指纹匹配后，再用证书 OU 核实 Team；不读取或导出私钥。
- 保留业务 URL scheme、后台任务标识。改主 Bundle ID 不等于可以批量改二进制或配置中的所有旧字符串。
- 设备列表里 unavailable 的旧设备只是配对历史。指定设备用实际 CoreDevice ID/UDID 和实时连接状态。
- 同标识应用存在时，明确覆盖授权或同会话产物归属后才用 `--replace`，无需先卸载；用户本地数据是否兼容新包仍属于运行时行为。
- 免费名额错误可能被上层包装为“无法验证其完整性”。读取最内层安装错误，不据此误判为证书损坏。
- 不自动切换身份、下载 profile、登记设备、换目标、删 App 或反复试装。真正阻塞一次报告，已获授权的正常后续步骤直接继续。

## 如需分析重签后的闪退

原始日志按字节保存，使用与实际产物匹配的镜像和符号。以下说法都不能从本会话已有证据推出：

- **相同版本号或相同 `LC_UUID` 不证明二进制字节完全相同。** 对比实际代码 section 散列；签名和打包方式可改变整个文件 SHA，UUID 也可能被后续加工保留。
- **多个线程停在 mutex wait 不证明死锁，更不能证明同一把锁或锁拥有者。** 需要锁地址、拥有者、等待依赖与持续停滞证据。
- **`byProc=self`、空闲主线程和 SIGSEGV 不足以认定安全组件主动杀进程。** 异常处理器可能二次转发信号，需要捕获首次异常和原始线程上下文。
- **栈里存在 TBSDKSecurity、TBSDkSignUtility 或混淆符号，能证明调用经过该模块，不能证明是哪一项签名校验失败。** 钥匙串组变化、App Group 丢失、Bundle ID 变化都只是待验证因素，不能写成已确定根因。
- 不宣称所有个人重签都不能运行，也不承诺换公司证书或保留原 Bundle ID 必然修复。先完成用户要求的包重签与安装，再准确报告实际启动或崩溃行为。

## 本版本的验证范围

2026-10-21 创建本 Skill 时已完成以下检查：

- Python 语法与 4 个子命令的 `--help` 均通过；AppleScript 编译通过。
- 仓库的 managed skill frontmatter 校验、全部 Markdown 引用和本地 Skill 同步通过。
- 在真实的 18 组件 beta IPA 上执行 `resign --personal-minimal --inspect-only`，退出 0，自动匹配本机个人开发描述文件，检查 18 个 Mach-O 并完成 18 个输入组件的严格验签；未修改包或设备。
- 新工具的实际签名、打包后验证、原生 Xcode 构建触发及安装分支未再次执行。实现依据本会话之前实际成功的多次重签与设备安装流程，不能把本次只读检查记为新工具已经完成全流程实测。
- 没有新增测试、创建 fresh-context 评估会话或额外安装 App。
