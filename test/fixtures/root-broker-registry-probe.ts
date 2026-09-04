import { writeFileSync } from "node:fs";

import { requireRootBroker } from "../../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts";

const outputPath = process.env.PI_ROOT_BROKER_PROBE_OUTPUT;
if (!outputPath) throw new Error("PI_ROOT_BROKER_PROBE_OUTPUT is required");

export default function rootBrokerRegistryProbe(pi: any): void {
  pi.on("session_start", (event: any, ctx: any) => {
    const sessionManager = ctx?.sessionManager;
    const rootSessionId = sessionManager?.getSessionId?.();
    let broker: any;
    let error: string | null = null;
    try {
      broker = requireRootBroker(pi, rootSessionId);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    writeFileSync(outputPath, JSON.stringify({
      eventReason: event?.reason ?? null,
      getSessionId: sessionManager?.getSessionId?.() ?? null,
      getSessionFile: sessionManager?.getSessionFile?.() ?? null,
      brokerMarker: process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED ?? null,
      activeToolNames: [...pi.getActiveTools()].sort(),
      allToolNames: pi.getAllTools().map((tool: any) => tool?.name).filter(Boolean).sort(),
      brokerRootSessionId: broker?.rootSessionId ?? null,
      brokerServerExists: Boolean(broker?.server),
      error,
    }));
  });
}
