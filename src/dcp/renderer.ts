import { Text } from "@earendil-works/pi-tui";
import type { ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { createExpandedToolText } from "../compact-tools/index.ts";
import { statusGlyph, syncStatusAnimation } from "../compact-tools/index.ts";

export function createDcpRenderer(): ToolRendererResolver {
  return (name, next) => {
    if (name !== "compress") return next();
    const base = next();
    return {
      ...(base ?? {}),
      renderShell: "self",
      renderCall(_args, theme, context) {
        syncStatusAnimation(context, context?.state?.status);
        return { render: () => [`${statusGlyph(theme, context?.state?.status)} ${theme.bold(name)}`], invalidate() {} };
      },
      renderResult(result, options, theme, context) {
        const failed = context.isError || result?.isError === true;
        context.state.status = failed ? "failure" : options.isPartial ? "loading" : "success";
        syncStatusAnimation(context, context.state.status);
        context.invalidate();
        const text = resultText(result);
        if (options.expanded) return createExpandedToolText(Text, text);
        return new Text(theme.fg("dim", text), 0, 0);
      },
    };
  };
}

function resultText(result: any): string {
  const raw = Array.isArray(result?.content)
    ? result.content.filter((item: any) => item?.type === "text").map((item: any) => item.text ?? "").join("\n")
    : String(result?.content ?? "");
  const seen = new Set<string>();
  return raw.split(/\r?\n/).filter((line: string) => {
    const key = line.trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join("\n");
}
