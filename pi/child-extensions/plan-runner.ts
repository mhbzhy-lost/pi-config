import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPlanCapsuleExtension } from "../../scripts/lib/plan/plan-capsule-extension.mjs";
import { createPlanRunnerDependencies } from "../../scripts/lib/plan/plan-runner-dependencies.mjs";
import { createExternalReviewAdapter } from "../../scripts/lib/plan/external-review-adapter.mjs";

export default function planRunner(pi: ExtensionAPI) {
  createPlanCapsuleExtension(pi, createPlanRunnerDependencies({
    pi,
    externalReview: createExternalReviewAdapter(),
  }));
}
