// Host binding：只装配，不承载实现。main Host 经 agentDir/extensions 目录发现
// 本入口；child 进程必须在 factory 调用之前 return——不注册 GLOBAL hook、不读取
// AGENTS_GLOBAL.md、不注入 <pi_global_instructions>、不发 ACK。GLOBAL 是 main
// 专属规范，child 的义务由 AGENTS_SHARED 注入机制与自身角色定义承担。角色判定
// 只依据既有可靠 child 标记（runtime 在 child 进程模块初始化时置位，与 enhanced
// 主 entry 的 child guard 同一事实源），不用 cwd 或 prompt 内容自判。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentsGlobalExtension } from "../../src/agents-global/index.ts";

export default function agentsGlobal(pi: ExtensionAPI): void {
  const isChildProcess =
    process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENT_FANOUT_CHILD === "1";
  if (isChildProcess) return;
  createAgentsGlobalExtension(pi);
}
