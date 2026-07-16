import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPlanLauncherExtension } from "../../scripts/lib/plan/plan-launcher-extension.mjs";

export default function planLauncher(pi: ExtensionAPI) {
  createPlanLauncherExtension(pi);
}
