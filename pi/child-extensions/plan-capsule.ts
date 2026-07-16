import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPlanCapsuleExtension } from "../../scripts/lib/plan/plan-capsule-extension.mjs";

export default function planCapsule(pi: ExtensionAPI) {
  createPlanCapsuleExtension(pi);
}
