// subagent activity source（统一执行计划 F2b / footer 子计划 T2b）。
//
// 本模块实现 package 公开的 subagent ActivitySource 工厂
// createSubagentActivitySource({browser, renderDetail, subscribe})：
// - snapshot 为 browser 的纯投影：active→main、terminal→recent；root/leaf 按
//   browser 既有 canonical 折叠不重复，recent 历史沿用 browser 的 20 条 run 上限；
// - 行 key = kind + browser canonical id（runId:childIndex），身份只认 key，不按
//   label 去重；label 沿用 footer 标题合同（title registry 优先，回退 label/agent）；
// - stateLabel 由既有 presentation/lifecycle 状态解释：reported/needs-context 与
//   未知/待处置状态不得显示为已完成，只有结构化完成证据才显示已完成；
// - detail 委托 footer runtime 注入的 renderDetail（trusted native 优先 / Fleet
//   回退 / trusted roots 文件安全防线），根层只获得组件投影，不读取 sessionFile
//   正文；subscribe 只宣告失效，订阅闭包由 runtime 代际（token）保护，teardown 后
//   旧 source 不再收到失效、snapshot 反映其被清空的旧 browser。
//
// 边界：本模块不订阅 pi.events（事件身份门禁在 footer runtime 的 F0 §4 层）、
// 不调度任务、不改写 raw lifecycle/title registry/presentation、不成为第二
// roster 权威；共享 bus 多 Host 不在支持范围（F0 §9）。

import type { ActivityPlacement, ActivityRow, ActivitySnapshot, ActivitySource, DetailComponent, DetailRequest } from "./background-activity.ts";
import { getTitleRegistry } from "../subagent-dispatch/title-registry.ts";
import { formatChildModelLabel, projectSessionStatus, type BrowserChild, type BrowserSnapshot } from "./session-browser.ts";

/** provider 消费的 browser 投影面：footer runtime 持有的当代 browser 实例。 */
export interface SubagentActivityBrowser {
  snapshot(): BrowserSnapshot;
}

/**
 * 详情行渲染依赖：由 footer runtime 提供，内部沿用 trusted native 优先 / Fleet
 * 回退与 trusted roots 文件安全防线；本模块不直接读取任何 session 文件。
 */
export type SubagentActivityDetailRenderer = (childKey: string, width: number, expandedTools: boolean) => string[];

/** browser 变化失效订阅依赖（当代 runtime 代际内有效；teardown 后不再触发）。 */
export type SubagentActivitySubscription = (invalidate: () => void) => () => void;

/** createSubagentActivitySource 依赖。 */
export type SubagentActivitySourceDependencies = Readonly<{
  browser: SubagentActivityBrowser;
  renderDetail: SubagentActivityDetailRenderer;
  subscribe: SubagentActivitySubscription;
}>;

/** 行 key：kind + browser canonical id（runId:childIndex），稳定且不按 label 去重。 */
export function subagentActivityRowKey(child: Pick<BrowserChild, "key">): string {
  return `subagent:${child.key}`;
}

/** 行 label：与 footer selector 同合同（title registry 优先，回退 label/agent）。 */
export function subagentActivityLabel(child: Pick<BrowserChild, "runId" | "label" | "agent">): string {
  const title = (child.runId ? getTitleRegistry().titleFor(child.runId) : undefined) ?? child.label;
  return title ? `${title} (${child.agent})` : child.agent;
}

/**
 * 行 metaLabel：该 subagent 实际使用的模型与 thinking（纯展示投影）。
 * 详情面首行身份行已删除，此字段供**详情 footer**（presenter.renderDetailFooterLines）
 * 在 `n/N glyph label · state` 后追加模型段；不改写 raw status，不参与行身份，
 * 也不进入 session/tool result/event payload。模型与 thinking 都未知时不设该字段，
 * 避免 footer 堆 “no-model” 噪声或尾巴悬空的 `·`。
 */
export function subagentActivityMetaLabel(child: Pick<BrowserChild, "model" | "thinking">): string | undefined {
  const thinking = typeof child.thinking === "string" && child.thinking.trim() ? child.thinking.trim() : undefined;
  const model = typeof child.model === "string" && child.model.trim() ? formatChildModelLabel(child.model, child.thinking) : undefined;
  if (model === undefined && thinking === undefined) return undefined;
  return [model === undefined ? undefined : `模型 ${model}`, thinking === undefined ? undefined : `thinking: ${thinking}`]
    .filter(Boolean).join(" · ");
}

/**
 * 行状态文案：由既有 presentation/lifecycle 状态解释。reported/needs-context 与
 * 未知/待处置状态不得显示为已完成；仅结构化完成证据（presentation completed 或
 * classic complete/completed 终态）显示已完成。legacy failed/rejected 无结构化
 * 完成元数据，不推断为故障，也不推断为完成。
 */
export function subagentStateLabel(child: Pick<BrowserChild, "state" | "presentation">): string {
  switch (child.presentation) {
    case "running": return "运行中";
    case "completed": return "已完成";
    case "reported": return "待处置";
    case "needs-context": return "待处置";
    case "limited": return "受限";
    case "paused": return "已暂停";
    case "stopped": return "已停止";
    case "runtime-failed": return "运行失败";
  }
  const state = typeof child.state === "string" ? child.state.toLowerCase() : undefined;
  const classification = projectSessionStatus(undefined, child.state).classification;
  if (classification === "active") return "运行中";
  if (classification === "terminal") {
    if (state === "complete" || state === "completed") return "已完成";
    if (state === "failed" || state === "rejected") return "待处置";
    if (state === "timed-out") return "受限";
    if (state === "paused") return "已暂停";
    if (state === "stopped" || state === "detached") return "已停止";
    return "待处置";
  }
  return "待处置";
}

function activityRow(child: BrowserChild, placement: ActivityPlacement): ActivityRow {
  const metaLabel = subagentActivityMetaLabel(child);
  return {
    key: subagentActivityRowKey(child),
    kind: "subagent",
    label: subagentActivityLabel(child),
    stateLabel: subagentStateLabel(child),
    placement,
    ...(metaLabel === undefined ? {} : { metaLabel }),
  };
}

/** browser snapshot → ActivityRows 纯投影（active→main，terminal→recent）。 */
export function projectSubagentActivityRows(snapshot: BrowserSnapshot): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const child of snapshot.activeChildren) rows.push(activityRow(child, "main"));
  for (const child of snapshot.recentChildren) rows.push(activityRow(child, "recent"));
  return rows;
}

/**
 * 创建 subagent ActivitySource。browser 为 footer runtime 持有的当代 browser 实例
 * （值捕获：runtime teardown 后旧 source 的 snapshot 反映被清空的旧 browser，不读
 * 新代数据）；renderDetail 为 trusted native 详情渲染；subscribe 为 runtime 代际
 * 内的 browser 变化失效订阅（teardown 清空监听集，late 转发无效果）。
 */
export function createSubagentActivitySource(dependencies: SubagentActivitySourceDependencies): ActivitySource {
  const listeners = new Set<() => void>();
  // runtime 变化转发：单次订阅、逐监听隔离；ActivitySource 协议无 dispose，
  // 代际失效由 runtime teardown 清空监听集承担。
  dependencies.subscribe(() => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* 展示回调彼此隔离，不向 runtime 传播 */ }
    }
  });

  const snapshot = (): ActivitySnapshot => ({
    availability: "available",
    rows: projectSubagentActivityRows(dependencies.browser.snapshot()),
  });

  const subscribe = (invalidate: () => void): (() => void) => {
    if (typeof invalidate !== "function") return () => undefined;
    listeners.add(invalidate);
    return () => { listeners.delete(invalidate); };
  };

  const detail = async (key: string, request: DetailRequest): Promise<DetailComponent | undefined> => {
    if (typeof key !== "string") return undefined;
    const child = dependencies.browser.snapshot().children.find((candidate) => subagentActivityRowKey(candidate) === key);
    if (child === undefined) return undefined;
    const childKey = child.key;
    const expandedTools = request?.expanded === true;
    const requestRender = typeof request?.requestRender === "function" ? request.requestRender : () => undefined;
    let cache: { width: number; lines: string[] } | undefined;
    return {
      render(width: number) {
        const safeWidth = Math.max(0, width);
        if (cache?.width !== safeWidth) {
          cache = { width: safeWidth, lines: dependencies.renderDetail(childKey, safeWidth, expandedTools) };
        }
        return cache.lines;
      },
      invalidate() {
        cache = undefined;
        try { requestRender(); } catch { /* 请求重绘失败不向 source 传播 */ }
      },
      dispose() { cache = undefined; },
    };
  };

  return { kind: "subagent", snapshot, subscribe, detail };
}
