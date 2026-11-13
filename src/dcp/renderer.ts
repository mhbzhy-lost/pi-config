import { Text } from "@earendil-works/pi-tui";
import type { ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { createExpandedToolText } from "../compact-tools/index.ts";

export function createDcpRenderer(): ToolRendererResolver {
  return (name, next) => {
    if (name !== "compress") return next();
    const base = next();
    return {
      ...(base ?? {}),
      renderShell: "self",
      renderCall(_args, theme, context) {
        return { render: () => [`${glyph(context?.state?.status, theme)} ${theme.bold(name)}`], invalidate() {} };
      },
      renderResult(result, options, theme, context) {
        const failed = context.isError || result?.isError === true;
        context.state.status = failed ? "failure" : options.isPartial ? "loading" : "success";
        context.invalidate();
        if (options.expanded) {
          const text = Array.isArray(result?.content)
            ? result.content.filter((item: any) => item?.type === "text").map((item: any) => item.text ?? "").join("\n")
            : String(result?.content ?? "");
          return createExpandedToolText(Text, text);
        }
        return new Text("", 0, 0);
      },
    };
  };
}

function glyph(status: string | undefined, theme: any): string {
  if (status === "failure") return theme.fg("error", "✗");
  if (status === "loading") return theme.fg("warning", "…");
  if (status === "success") return theme.fg("success", "✓");
  return theme.fg("dim", "•");
}
