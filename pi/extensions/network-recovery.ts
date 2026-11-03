// 断网兜底入口：只做 Host API 绑定，状态机、探活与配置解析全部位于 src/network-recovery。
// 只主 Host 生效：child 进程必须在 factory 调用之前 return——不注册任何 hook、不排定
// 定时器、不调用 sendUserMessage。否则 ambient 加载进 child 的同一扩展会在 child 已
// settled 后自行唤醒一轮工作，绕过 child 结束与 Root Broker 边界。角色判定只依据既有
// 可靠 child 标记（runtime 在 child 进程模块初始化时置位，与 enhanced 主 entry 的
// child guard 同一事实源），不用 cwd 或 prompt 内容自判。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createNetworkRecoveryExtension } from "../../src/network-recovery/index.ts";

export default function networkRecovery(pi: ExtensionAPI): void {
  const isChildProcess =
    process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENT_FANOUT_CHILD === "1";
  if (isChildProcess) return;
  createNetworkRecoveryExtension(pi);
}
