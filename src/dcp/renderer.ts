import { MouseRegion, Text, type Component } from "@earendil-works/pi-tui";
import type { ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { resultStatus, setRenderStatus, statusGlyph, syncStatusAnimation } from "../compact-tools/index.ts";

export function createDcpRenderer(): ToolRendererResolver {
  return (name, next) => {
    if (name !== "compress") return next();
    const base = next();
    return {
      ...(base ?? {}),
      renderShell: "self",
      renderCall(_args, theme, context) {
        syncStatusAnimation(context, context?.state?.status);
        return swallowExpandClick({ render: () => [`${statusGlyph(theme, context?.state?.status)} ${theme.bold(name)}`], invalidate() {} });
      },
      renderResult(result, options, theme, context) {
        const status = resultStatus(result, options, context);
        setRenderStatus(context, status);
        const text = resultText(result);
        const preview = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? (status === "failure" ? "压缩失败" : "压缩完成");
        return swallowExpandClick(new Text(theme.fg(status === "failure" ? "error" : "dim", preview.length > 120 ? `${preview.slice(0, 117)}...` : preview), 0, 0));
      },
    };
  };
}

// compress 结果仅一句状态，无展开价值。Host 的 ToolExecutionComponent 会给所有工具结果强制包一层
// 点击展开的 MouseRegion；其 handleMouse 先派发给子组件，子组件返回 handled 即短路展开 toggle。
// 故这里吞掉左键点击，使 compress 不再响应点击展开。
function swallowExpandClick(component: Component): MouseRegion {
  return new MouseRegion(component, (event) => (event.type === "click" && event.button === "left" ? { handled: true } : undefined));
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
