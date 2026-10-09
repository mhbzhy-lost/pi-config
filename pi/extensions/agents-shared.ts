// Host binding：只装配，不承载实现。main Host 经 agentDir/extensions 目录发现本文件；
// child 经 required-child 注册以绝对路径加载同一物理文件，main 与 child 共用同一共享注入。
// scope 由既有可靠 child 标记显式判定（runtime 在 child 进程模块初始化时置
// PI_SUBAGENT_CHILD=1，与 enhanced 主 entry 的 child guard 同一事实源），不让模型自判角色。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentsSharedExtension } from "../../src/agents-shared/index.ts";

export default function agentsShared(pi: ExtensionAPI): void {
  const isChildProcess =
    process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENT_FANOUT_CHILD === "1";
  createAgentsSharedExtension(pi, { scope: isChildProcess ? "child" : "main" });
}
