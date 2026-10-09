import * as coding from '@earendil-works/pi-coding-agent';
import * as tui from '@earendil-works/pi-tui';
import * as core from '@earendil-works/pi-agent-core';
import * as ai from '@earendil-works/pi-ai/compat';
import { upstreamSubagentRuntime } from '../compat/pi-subagents-0.75.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** 显式探针入口，不属于自动发现；使用正式compat的真实consumer。 */
export default function physicalIdentityProbe(pi: ExtensionAPI) {
  upstreamSubagentRuntime(pi);
  pi.registerCommand('physical-host-identity', { description: '读取physical Host身份', handler: async () => ({ SessionManager: coding.SessionManager, Container: tui.Container, Agent: core.Agent, streamSimple: ai.streamSimple }) as any });
}
