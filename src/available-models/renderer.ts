import { Text } from "@earendil-works/pi-tui";
import type { ToolRendererResolver } from "@earendil-works/pi-coding-agent";

export function createAvailableModelsRenderer(): ToolRendererResolver {
  return (name, next) => {
    if (name !== "list_available_models") return next();
    const base = next();
    return {
      ...(base ?? {}),
      renderShell: "self",
      renderCall(_args, theme, context) {
        return { render: () => [`${contextGlyph(context?.state?.status, theme)} ${theme.bold(name)}`], invalidate() {} };
      },
      renderResult(result, options, theme, context) {
        const failed = context.isError || result?.isError === true;
        context.state.status = failed ? "failure" : options.isPartial ? "loading" : "success";
        context.invalidate();
        return new Text("", 0, 0);
      },
    };
  };
}

function contextGlyph(status: string | undefined, theme: any): string {
  if (status === "failure") return theme.fg("error", "✗");
  if (status === "loading") return theme.fg("warning", "…");
  if (status === "success") return theme.fg("success", "✓");
  return theme.fg("dim", "•");
}
