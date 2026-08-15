import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGoalEngineExtension } from "../../scripts/lib/goal-engine/extension.mjs";

// The factory owns the frozen Root Goal exact-eight ABI, including goal_finalize.
export default function goalEngine(pi: ExtensionAPI) {
  createGoalEngineExtension(pi);
}
