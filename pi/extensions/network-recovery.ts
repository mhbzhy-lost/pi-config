// 断网兜底入口：只做 Host API 绑定，状态机、探活与配置解析全部位于 src/network-recovery。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createNetworkRecoveryExtension } from "../../src/network-recovery/index.ts";

export default function networkRecovery(pi: ExtensionAPI): void {
  createNetworkRecoveryExtension(pi);
}
