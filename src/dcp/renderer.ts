import { MouseRegion, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { failedResultLine, resultStatus, setRenderStatus, statusGlyph, syncStatusAnimation, type CompactRenderStatus } from "../compact-tools/index.ts";

export function createDcpRenderer(): ToolRendererResolver {
  return (name, next) => {
    if (name !== "compress") return next();
    const base = next();
    return {
      ...(base ?? {}),
      renderShell: "self",
      renderCall(args, theme, context) {
        // topic 是 compress 参数 schema 中的 3-5 词显示短标签；仅接受 string，缺失/异型时不猜语义、只显示工具名。
        const callArgs = args as { topic?: unknown } | undefined;
        const topic = typeof callArgs?.topic === "string" ? callArgs.topic : "";
        const body = topic ? `compress ${theme.fg("accent", topic)}` : "compress";
        const call: Component = {
          render(width) {
            // 每帧重读 state.status：Host 的 updateDisplay 会周期性调用 render，spinner/终态 glyph 由这里驱动。
            const status = context?.state?.status as CompactRenderStatus | undefined;
            syncStatusAnimation(context, status);
            const glyph = statusGlyph(theme, status);
            // 单行收口：glyph 宽度以 visibleWidth 计入预算（模式同 compact-tools 的 createSingleLine），正文交给 truncateToWidth 截断。
            const budget = Math.max(0, width - visibleWidth(glyph) - 1);
            return [`${glyph} ${truncateToWidth(body, budget, "…")}`];
          },
          invalidate() {},
        };
        // 成功/加载态点击展开无增量内容，吞掉保持交互自洽；失败态不吞，点击可展开查看完整错误。
        const status = context?.state?.status as CompactRenderStatus | undefined;
        return status === "failure" ? call : swallowExpandClick(call);
      },
      renderResult(result, options, theme, context) {
        const status = resultStatus(result, options, context);
        setRenderStatus(context, status);
        // 成功（含 partial）结果体收空：compress 成功回执仅一句状态，折叠/展开均无增量内容，吞掉点击。
        if (status !== "failure") return swallowExpandClick(new Text("", 0, 0));
        const text = contentText(result);
        // 失败折叠态：failedResultLine 单行收口（错误首行 + 按宽度截断），不吞点击以便 Host 展开全文。
        if (!options.expanded) return failedResultLine({ truncateToWidth, text, theme });
        // 失败展开态：content 全文多行渲染，error 色保留错误语义；空文本回退 dim 占位。
        return new Text(text ? theme.fg("error", text) : theme.fg("dim", "压缩失败"), 0, 0);
      },
    };
  };
}

// compress 结果正文：仅拼接 content 的 text 块（原始行序、不去重、不截断）；
// 折叠预览提取/120 字符截断已退役，全文只交由失败展开态消费。
function contentText(result: any): string {
  return Array.isArray(result?.content)
    ? result.content.filter((item: any) => item?.type === "text").map((item: any) => item.text ?? "").join("\n")
    : String(result?.content ?? "");
}

// compress 结果无展开增量。Host 的 ToolExecutionComponent 会给所有工具结果强制包一层
// 点击展开的 MouseRegion；其 handleMouse 先派发给子组件，子组件返回 handled 即短路展开 toggle。
// 故这里吞掉左键点击，使 compress 不再响应点击展开。
function swallowExpandClick(component: Component): MouseRegion {
  return new MouseRegion(component, (event) => (event.type === "click" && event.button === "left" ? { handled: true } : undefined));
}
