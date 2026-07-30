export function createPlanExecutorToolBoundary() {
  return {
    authorize() {
      throw new Error("not implemented");
    },
  };
}
