import type { ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { createCompactToolRenderers } from "./renderer.ts";

export { createCompactToolRenderers, installCompactSkillRenderer } from "./renderer.ts";
export { COMPACT_STATUS_KEY, statusGlyph, syncStatusAnimation, type CompactRenderStatus } from "./status.ts";
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
  return (name, next) => {
    const mine = owned.get(name);
    if (!mine) return next();
    const base = next();
    // 槽位随最新 resolve 更新：edit 委托消费的是 remaining/registered 链的当前渲染器（当前仅 edit 需要）。
    if (name === "edit") nativeEditRenderers.current = base;
    // 有意覆盖本 owner 的显示字段，保留 base 其余字段；空 next 同样合法。
    return { ...(base ?? {}), ...mine };
  };
}
