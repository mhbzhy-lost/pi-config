// 断网兜底 feature 的公开入口：Host 入口（pi/extensions/network-recovery.ts）与其他
// feature 只能经本文件消费能力，不得深引 extension/probe/settings 内部实现。

export {
  createNetworkRecoveryExtension,
  type NetworkRecoveryState,
} from "./extension.ts";
export { DEFAULT_PROBE_TIMEOUT_MS, probeEndpointReachability, type ProbeOptions } from "./probe.ts";
export {
  DEFAULT_DELAY_MS,
  MIN_DELAY_MS,
  resolveNetworkRecoveryConfig,
  type NetworkRecoveryConfig,
} from "./settings.ts";
