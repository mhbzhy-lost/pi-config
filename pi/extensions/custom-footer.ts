import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { layoutFooter } from "../../scripts/lib/custom-footer-layout.mjs";

function createFooterComponent({ getCwd, getHome, getModel, getBranch, requestRender, theme }: any) {
  return {
    dispose() {},
    invalidate() {
      requestRender();
    },
    render(width: number) {
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

export default function customFooter(pi: ExtensionAPI) {
  let invalidateFooter: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setFooter((tui, theme, _footerData) => {
      const component = createFooterComponent({
        getCwd: () => ctx.cwd,
        getHome: () => process.env.HOME,
        getModel: () => ctx.model,
        getBranch: () => ctx.sessionManager.getBranch(),
        requestRender: () => tui.requestRender(),
        theme,
        visibleWidth,
        truncateToWidth,
      });
      invalidateFooter = () => component.invalidate();
      return component;
    });
  });

  pi.on("model_select", () => {
    invalidateFooter?.();
  });

  pi.on("session_shutdown", () => {
    invalidateFooter = undefined;
  });
}
