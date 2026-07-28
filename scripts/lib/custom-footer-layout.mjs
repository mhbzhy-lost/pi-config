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
  getContextUsage,
  getThinkingLevel,
  getSubagentStatus,
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
      const providerModelLabel = `${providerLabel} ${modelLabel}`.trim();
      const thinkingLabel = `thinking: ${getThinkingLevel?.() || "off"}`;

      let contextUsage;
      try {
        contextUsage = getContextUsage();
      } catch {}

      const contextWindow = contextUsage?.contextWindow || currentModel?.contextWindow || 1_000_000;
      const windowLabel = contextWindow >= 1_000_000
        ? `${(contextWindow / 1_000_000).toFixed(1)}M`
        : `${(contextWindow / 1000).toFixed(0)}k`;
      const contextLabel = contextUsage?.percent === null
        ? `?/${windowLabel}`
        : `${(contextUsage?.percent ?? 0).toFixed(1)}%/${windowLabel}`;
      const lines = [
        layoutFooter({
          width,
          left: displayedCwd,
          right: contextLabel,
          visibleWidth,
          truncateToWidth,
        }),
        layoutFooter({
          width,
          left: getSubagentStatus?.() || "",
          right: providerModelLabel,
          visibleWidth,
          truncateToWidth,
        }),
        layoutFooter({
          width,
          left: "",
          right: thinkingLabel,
          visibleWidth,
          truncateToWidth,
        }),
      ];
      return lines.map((line) => theme.fg("dim", line));
    },
  };
}
