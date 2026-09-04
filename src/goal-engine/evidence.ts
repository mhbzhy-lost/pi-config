export function classifyGoalEvidence(projection) {
  const evidence = [...projection.tasks.values()].flatMap((task) => task.evidence || []);
  const normalizedSource = (item) => item.source || "self_produced";
  const hasExternalReview = evidence.some((item) => normalizedSource(item) === "external" && item.type === "external_review");
  const hasPreExisting = evidence.some((item) => normalizedSource(item) === "pre_existing");
  return {
    evidenceCount: evidence.length,
    hasExternalReview,
    hasPreExisting,
    allSelfProduced: evidence.length > 0 && evidence.every((item) => normalizedSource(item) === "self_produced"),
  };
}

export function completionVerdictFor(projection) {
  return classifyGoalEvidence(projection).hasExternalReview
    ? "COMPLETE"
    : "DONE_WITHOUT_EXTERNAL_VERIFICATION";
}
