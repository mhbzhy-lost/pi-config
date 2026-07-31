import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGoalEngineExtension } from "../../scripts/lib/goal-engine/extension.mjs";

export default function goalEngine(pi: ExtensionAPI) {
  createGoalEngineExtension(pi);
}
