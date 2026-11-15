import type { ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { createCompactFallbackRenderers, createCompactToolRenderers } from "./renderer.ts";

export { createCompactFallbackRenderers, createCompactToolRenderers, failedResultLine, installCompactSkillRenderer } from "./renderer.ts";
export { COMPACT_STATUS_KEY, resultStatus, setRenderStatus, statusGlyph, syncStatusAnimation, type CompactRenderStatus } from "./status.ts";
export { createExpandedToolText } from "./expanded-content.ts";

type Dependencies = Parameters<typeof createCompactToolRenderers>[0];

/**
 * 拥有 read/bash/bash_async/edit/write/find/grep/ls 的显示字段，不注册、执行或激活工具。
 * Host 按注册顺序解析 next 链；前置 resolver 不调用 next 即可截断本 owner，非 last-wins。
 */
export function createCompactToolRendererResolver(dependencies: Dependencies): ToolRendererResolver {
  // next() 取得的 remaining/registered native edit renderers 经此槽注入 edit renderer；
  // 是否委托（expanded/failed/partial/native.renderResult 存在）由 edit renderResult 内部判断，
  // resolver 不做失败判断以免丢错误语义。空 next 时槽为空，edit 保持 compact，不崩且不改 raw。
  const nativeEditRenderers: { current?: ToolRenderers } = {};
  const renderers = createCompactToolRenderers({ ...dependencies, nativeEditRenderers });
  const owned = new Map<string, ToolRenderers>(Object.entries(renderers));
  const fallbackRenderers = createCompactFallbackRenderers(dependencies);
  return (name, next) => {
    const mine = owned.get(name);
    const base = next();
    if (mine) {
      // 槽位随最新 resolve 更新：edit 委托消费的是 remaining/registered 链的当前渲染器（当前仅 edit 需要）。
      if (name === "edit") nativeEditRenderers.current = base;
      // 有意覆盖本 owner 的显示字段，保留 base 其余字段；空 next 同样合法。
      return { ...(base ?? {}), ...mine };
    }
    // 链语义：本 resolver 注册于链中段，next() 只会取得其后注册的 resolver 与内置渲染器合并后的产物；
    // 下面的兜底仅对其中渲染字段无人认领的工具生效。先于本扩展注册的 resolver 位于链外层，
    // 会用自身渲染字段覆盖兜底产物，不受此处补齐影响。
    if (!base) return { renderShell: "self", ...fallbackRenderers(name) };
    const hasCall = typeof base.renderCall === "function";
    const hasResult = typeof base.renderResult === "function";
    // a：完整原生渲染（如 powershell）同时具备两字段，原样放行。
    if (hasCall && hasResult) return base;
    const patch = fallbackRenderers(name);
    // b：仅缺 renderResult，只补该字段，保留 base 原 renderShell 与其余字段。
    if (hasCall) return { ...base, renderResult: patch.renderResult };
    // c：缺 renderCall 则没有可用的原生调用头，统一走单行 self 外壳；连带补齐缺失的 renderResult。
    return {
      ...base,
      renderShell: "self",
      renderCall: patch.renderCall,
      renderResult: hasResult ? base.renderResult : patch.renderResult,
    };
  };
}
