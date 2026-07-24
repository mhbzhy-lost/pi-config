export function layoutFooter({ width, left, right, visibleWidth, truncateToWidth }) {
  if (width <= 0) return "";

  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width, "…");

  const leftBudget = width - rightWidth - 1;
  const fittedLeft = truncateToWidth(left, leftBudget, "…");
  const padding = " ".repeat(width - visibleWidth(fittedLeft) - rightWidth);
  return fittedLeft + padding + right;
}

export function createFooterComponent({
  getCwd,
  getHome,
  getModel,
  getBranch,
  requestRender,
  theme,
  visibleWidth,
  truncateToWidth,
}) {
  return {
    dispose() {},
    invalidate() {
      requestRender();
    },
    render(width) {
      const cwd = getCwd();
      const home = getHome();
      const displayedCwd = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
      const currentModel = getModel();
      const providerLabel = currentModel?.provider ? `(${currentModel.provider})` : "";
      const modelLabel = currentModel?.id || "no-model";

      let lastInput = 0;
      try {
        const branch = getBranch();
        for (let i = branch.length - 1; i >= 0; i--) {
          const entry = branch[i];
          if (entry.type === "message" && entry.message?.role === "assistant" && entry.message?.usage) {
            const usage = entry.message.usage;
            lastInput = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
            break;
          }
        }
      } catch {}

      const contextWindow = currentModel?.contextWindow || 1_000_000;
      const percentage = lastInput > 0 ? ((lastInput / contextWindow) * 100).toFixed(1) : "0.0";
      const windowLabel = contextWindow >= 1_000_000
        ? `${(contextWindow / 1_000_000).toFixed(1)}M`
        : `${(contextWindow / 1000).toFixed(0)}k`;
      const line = layoutFooter({
        width,
        left: displayedCwd,
        right: `${percentage}%/${windowLabel}  ${providerLabel} ${modelLabel}`,
        visibleWidth,
        truncateToWidth,
      });
      return [theme.fg("dim", line)];
    },
  };
}
