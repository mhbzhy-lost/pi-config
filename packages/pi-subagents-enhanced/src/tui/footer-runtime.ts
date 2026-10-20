// footer runtime（统一执行计划 F2a/F2b / footer 子计划 T2a/T2b）。
// 本模块由 extensions/custom-footer.ts 薄入口机械迁移而来，承载全部实际 footer 职责：
// cwd/context/provider/model/thinking/selector/scheduler 回退布局、500ms reconcile 轮询、
// plain roster 分区延续（F2b/F2b-v：manager 弱引用 × 逻辑 sessionID 分区，分区容器
// 经 package 自有 process-global Symbol 槽跨 SDK 模块重载存活）、native/trusted
// 渲染回退，以及 Alt+O overlay 的 editor/draft 恢复、静态 margin.bottom=4、滚动与输入控制。
// 唯一 setFooter 安装在本 runtime 内；薄 entry 只注入 SDK/TUI 依赖并注册唯一 Alt+O
// 快捷键（handler 委托 FooterRuntime.openBrowser）。F2b 增补：事件按 F0 §4 当前
// session 身份门禁（sessionFile/UUID 双形态，缺/异身份拒绝且不写 roster）；当代
// subagent ActivitySource（provider）经 FooterRuntime.getActivitySource 合法暴露，
// F6 起由本 runtime 作为唯一 owner 直接注册进当代 registry（不经 bus）。
// 依赖边界：本模块只直接 import package 自有 tui/subagent-dispatch 实现与 node 内建；
// 宿主 SDK（pi-coding-agent）与 pi-tui 的值依赖一律经 dependencies 注入，不反向依赖
// 根源码、不 import scripts。
// F6（统一执行计划 F6 / footer 子计划 T6a）增补：本 runtime 是统一后台活动的**唯一
// owner**——每个 tui session_start 创建当代 registry 与 HostScope（token=本次 start 的
// 新对象、sessionId=manager 逻辑 UUID、hostKey=sessionManager 对象身份），先监听
// owner-request/source-register/source-unregister/presenter-register/presenter-unregister
// 再 emit owner-ready，因此 owner-first 与 publisher-first 两种加载顺序都能握手；
// 自有 subagent source 由 getActivitySource 直接注册进 registry（不经 bus），bash/scheduler
// publisher 经 bus 按精确 scope+registrationId 注册；根 entry 只发布 presenter factory，
// 由本 runtime 调用并安装其 createFooter。唯一 setFooter 仍在本 runtime，唯一 Alt+O 仍由
// 薄 entry 注册并委托 openBrowser → 当代 mounted view（统一详情或 standalone browser）。
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { browserTrustedRoots, readBrowserRunStatus, renderBrowserTranscript } from "./browser-adapter.ts";
import { NativeChildConversationRenderer } from "./native-conversation.ts";
import { createChildConversationRenderers } from "./tool-renderers.ts";
import { formatChildModelLabel, projectSessionStatus, SubagentSessionBrowserState, type BrowserChild } from "./session-browser.ts";
import { createSubagentActivitySource } from "./subagent-activity.ts";
import { parseSgrWheelDirection, ReadOnlyBrowserEditor, SubagentTranscriptViewport } from "./session-viewport.ts";
import { layoutFooter } from "./footer-layout.ts";
import { getTitleRegistry } from "../subagent-dispatch/title-registry.ts";
import {
  BACKGROUND_ACTIVITY_CHANNELS,
  createActivityRegistry,
  createBackgroundActivityRegistrationId,
  isHostScope,
  isSameHostScope,
  isSameHostScopeIdentity,
} from "./background-activity.ts";
import type {
  ActivityKind,
  ActivityPresenterFactory,
  ActivityRegistry,
  ActivitySource,
  FooterBindings,
  HostScope,
  HostScopeIdentity,
  MountedActivityView,
  OwnerReadyPayload,
} from "./background-activity.ts";

/** Host 内存 bus 的最小投影（`pi.events` 的 on/emit 形状；on 返回 unsubscribe）。 */
type ActivityBus = Readonly<{
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
}>;

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** registrationId 必须是非空 string；缺字段 fail closed，不猜测、不补默认值。 */
function isRegistrationIdValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isActivityKindValue(value: unknown): value is ActivityKind {
  return value === "subagent" || value === "bash_async" || value === "scheduler";
}

/** bus 载荷里的 source 形状校验：不合协议即拒绝注册，不把异常抛回发送方。 */
function isActivitySourceValue(value: unknown): value is ActivitySource {
  if (!isRecordValue(value)) return false;
  const candidate = value as unknown as ActivitySource;
  return (
    isActivityKindValue(candidate.kind) &&
    typeof candidate.snapshot === "function" &&
    typeof candidate.subscribe === "function" &&
    typeof candidate.detail === "function"
  );
}

/** mounted view 形状校验：factory 返回值不合协议时按 fallback/standalone 处理。 */
function isMountedActivityView(value: unknown): value is MountedActivityView {
  return (
    isRecordValue(value) &&
    typeof (value as MountedActivityView).createFooter === "function" &&
    typeof (value as MountedActivityView).openDetails === "function" &&
    typeof (value as MountedActivityView).dispose === "function"
  );
}

/** owner-request 载荷（三要素身份，不含 token）：缺字段/异类型一律拒绝。 */
function isOwnerRequestPayload(value: unknown): value is HostScopeIdentity {
  if (!isRecordValue(value)) return false;
  return (
    isRecordValue(value.sessionManager) &&
    isRegistrationIdValue(value.sessionId) &&
    isRecordValue(value.hostKey)
  );
}

/** 当代 owner 的一条 source 注册：registrationId + source + handle-fenced dispose。 */
interface ActivityOwnerRegistration {
  readonly registrationId: string;
  readonly source: ActivitySource;
  readonly dispose: () => void;
}

/**
 * 当代 owner epoch。scope.token 是本次 session_start 新建的对象（闭包世代，不是
 * process-global Symbol）；`closed`/`activityOwner !== epoch` 双重 fence 使 reload/
 * new/resume/fork 之后的 late register/unregister/detail/poll 全部无效。
 */
interface ActivityOwnerEpoch {
  readonly scope: HostScope;
  readonly ownerRegistrationId: string;
  readonly registry: ActivityRegistry;
  readonly sources: Map<ActivityKind, ActivityOwnerRegistration>;
  readonly busUnsubscribes: Array<() => void>;
  /** package 自有 subagent source（subagent kind 的展示权威），不经 bus 注册。 */
  readonly ownSource: ActivitySource | undefined;
  presenter: { readonly registrationId: string; readonly view: MountedActivityView } | undefined;
  subagentDispose: (() => void) | undefined;
  closed: boolean;
}

/** 薄入口注入的 pi-tui 显示/输入工具；runtime 不直接 import 宿主 TUI 库实现。 */
export type FooterTuiBindings = Pick<
  typeof import("@earendil-works/pi-tui"),
  "Key" | "isKeyRelease" | "isKeyRepeat" | "matchesKey" | "truncateToWidth" | "visibleWidth"
>;

/** 薄入口注入的 SDK/TUI 依赖（SDK markdown theme 读取 + pi-tui 工具）。 */
export type FooterRuntimeDependencies = Readonly<{
  tui: FooterTuiBindings;
  getMarkdownTheme(): MarkdownTheme;
}>;

/**
 * runtime 句柄。唯一 Alt+O 快捷键由薄 entry 注册（SDK 无 unregister，故按当代闭包
 * 委托）：handler 调 openBrowser，仅当快捷键上下文命中当前 sessionManager 时进入；
 * F6 当代挂载了统一 presenter 时委托其 `openDetails()`（统一详情 overlay），否则保持
 * 迁移前的 standalone browser 语义（未激活时进入）。
 */
export interface FooterRuntime {
  openBrowser(shortcutCtx: unknown): void;
  /**
   * F2b：当前 session 代际的 subagent ActivitySource（provider）。
   * F6：本 runtime 作为唯一 owner 在 session_start（tui）直接把它注册进当代 registry；
   * session_start（tui）前与 teardown 后为 undefined。唯一 setFooter 与 Alt+O 仍归
   * 本 runtime/薄 entry，此处不新增安装。
   */
  getActivitySource(): ActivitySource | undefined;
}

/**
 * F2b plain roster 分区存储：manager 弱引用 → 逻辑 sessionID → plain children rows。
 * 分区只保存 browser.serialize() 的 plain 行（BrowserChild 字段），不存
 * ctx/pi/callback/组件等闭包引用。同 manager 同 session（reload）恢复本分区；
 * new/fork/switch/resume 产生新 SessionManager（F0 §6）天然取空分区，同 ID 异
 * manager 也不继承他人 roster；共享 bus 多 Host 不在支持范围（F0 §9）。
 *
 * F2b-v 补修：分区容器经 package 自有的 process-global Symbol 槽持有。SDK 扩展
 * 加载器对源 TS 使用 `createJitiImpl(..., { moduleCache: false })`
 * （loader.js:477-481），且 session reload 链路（agent-session reload →
 * oldRunner.invalidate → resourceLoader.reload）会 `clearExtensionCache()`
 * （loader.js:87-92）后重新 import 扩展模块——模块重求值会重建 module 内的
 * `const new WeakMap()`，same-session 跨 factory reload 将丢失分区。Symbol.for
 * 注册表与 globalThis 为进程级，跨模块重求值存活（jiti moduleCache:false 重求值
 * 与 Symbol 槽存活均已用探针实测）。槽内仅持有 WeakMap 容器，数据仍按
 * manager×session 分区互不共享；不读私有 upstream owner global，不恢复未分区
 * v2 旧槽（Symbol.for("pi-config.custom-footer.subagents.v2")）迁移，槽形状
 * 不符时 fail closed 直接重建容器。
 */
const ROSTER_PARTITIONS_SLOT = Symbol.for("pi-subagents-enhanced.footer-runtime.roster-partitions.v1");

function rosterPartitions(): WeakMap<object, Map<string, BrowserChild[]>> {
  const root = globalThis as Record<symbol, unknown>;
  const existing = root[ROSTER_PARTITIONS_SLOT];
  if (existing instanceof WeakMap) return existing as WeakMap<object, Map<string, BrowserChild[]>>;
  const created = new WeakMap<object, Map<string, BrowserChild[]>>();
  root[ROSTER_PARTITIONS_SLOT] = created;
  return created;
}

/**
 * 事件到达/分区定位时刻实测的 manager 身份（F0 §4：不缓存派发时快照）。探针
 * 异常按无身份处理（fail closed：事件拒绝、分区定位失败）。
 */
function managerSessionIdentity(manager: unknown): { sessionFile: string | null; sessionId: string | undefined } {
  const readValue = (method: "getSessionFile" | "getSessionId"): unknown => {
    const probe = (manager as { getSessionFile?: unknown; getSessionId?: unknown } | null | undefined)?.[method];
    if (typeof probe !== "function") return undefined;
    try { return (probe as () => unknown).call(manager); } catch { return undefined; }
  };
  const file = readValue("getSessionFile");
  const id = readValue("getSessionId");
  return {
    sessionFile: typeof file === "string" && file.length > 0 ? file : null,
    sessionId: typeof id === "string" && id.length > 0 ? id : undefined,
  };
}

/**
 * provider 详情组件在尚未观察到 TUI theme（首个 footer/overlay 渲染前）时的显示
 * 回退：仅影响渲染样式，不触碰 raw 数据；native 主路径本就不依赖 theme。
 */
const FALLBACK_DETAIL_THEME = { fg: (_color: unknown, value: string) => value, bold: (value: string) => value };

function lifecycleGlyph(state: string | undefined, presentation?: string): string {
  switch (presentation) {
    case "completed": return "✓";
    case "reported": return "◇";
    case "needs-context": return "?";
    case "limited": return "!";
    case "paused": return "Ⅱ";
    case "stopped": return "■";
    case "runtime-failed": return "✗";
  }
  if (projectSessionStatus(undefined, state).classification === "active") return "●";
  switch (state?.toLowerCase()) {
    case "queued":
    case "running":
    case "pending": return "●";
    case "complete":
    case "completed": return "✓";
    // Legacy persistence has no structured completion metadata: never infer a runtime fault.
    case "failed": return "◇";
    case "timed-out": return "!";
    case "paused": return "Ⅱ";
    case "stopped":
    case "detached": return "■";
    default: return "?";
  }
}

function selectorChild(child: { key: string; runId?: string; agent: string; state?: string; presentation?: string; label?: string }, selectedKey: string | undefined): string {
  const title = (child.runId ? getTitleRegistry().titleFor(child.runId) : undefined) ?? child.label;
  const label = title ? `${title} (${child.agent})` : child.agent;
  return `${selectedKey === child.key ? "›" : " "} ${lifecycleGlyph(child.state, child.presentation)} ${label}`;
}

function wrapSelectorItem(item: string, width: number, tui: FooterTuiBindings): string {
  if (width <= 1) return item.startsWith("›") ? "›" : item.slice(0, 1);
  const prefixLength = item.startsWith("›") || item.startsWith("  ") ? 4 : 2;
  const prefix = item.slice(0, prefixLength);
  const content = item.slice(prefixLength).trimStart();
  const available = width - prefixLength;
  if (available <= 0) return prefix;
  const lines: string[] = [];
  let line = "";
  for (const word of content.split(/\s+/).filter(Boolean)) {
    if (tui.visibleWidth(word) > available) {
      if (line) { lines.push(line); line = ""; }
      let remainder = word;
      while (tui.visibleWidth(remainder) > available) {
        let cut = 0;
        let used = 0;
        for (const character of Array.from(remainder)) {
          const characterWidth = tui.visibleWidth(character);
          if (used + characterWidth > available) break;
          used += characterWidth;
          cut += character.length;
        }
        lines.push(remainder.slice(0, cut));
        remainder = remainder.slice(cut);
      }
      line = remainder;
      continue;
    }
    const candidate = line ? `${line} ${word}` : word;
    if (line && tui.visibleWidth(candidate) > available) { lines.push(line); line = word; }
    else line = candidate;
  }
  if (line) lines.push(line);
  return lines.map((value, index) => `${index === 0 ? prefix : " ".repeat(prefixLength)}${value}`).join("\n");
}

export function formatBrowserSelector(snapshot: ReturnType<SubagentSessionBrowserState["snapshot"]>, width: number, tui: FooterTuiBindings): string {
  const childMode = snapshot.active;
  const historyCount = new Set(snapshot.recentChildren.map((child) => child.runId || child.key)).size;
  const items = [
    ...(childMode
      ? snapshot.children.map((child) => selectorChild(child, snapshot.selectedKey))
      : snapshot.activeChildren.map((child) => selectorChild(child, undefined).trimStart())),
    ...(!childMode && snapshot.activeChildren.length > 0 && historyCount > 0 ? [`◯ history ${historyCount}`] : []),
  ];
  if (items.length === 0) return "";
  if (!childMode) return items.map((item) => wrapSelectorItem(item, Math.max(0, width), tui)).join("\n");
  const selected = childMode && snapshot.selectedKey
    ? Math.max(0, snapshot.children.findIndex((child) => child.key === snapshot.selectedKey))
    : 0;
  const safeWidth = Math.max(0, width);
  let start = selected;
  let end = selected + 1;
  const render = () => {
    const left = start > 0 ? `+${start} ` : "";
    const right = end < items.length ? ` +${items.length - end}` : "";
    return `${left}${items.slice(start, end).join("  ")}${right}`;
  };
  while (true) {
    const nextStart = start > 0 ? start - 1 : start;
    const nextEnd = end < items.length ? end + 1 : end;
    const addLeft = nextStart !== start ? `${start > 1 ? `+${start - 1} ` : ""}${items.slice(nextStart, end).join("  ")}${end < items.length ? ` +${items.length - end}` : ""}` : "";
    const addRight = nextEnd !== end ? `${start > 0 ? `+${start} ` : ""}${items.slice(start, nextEnd).join("  ")}${nextEnd < items.length ? ` +${items.length - nextEnd}` : ""}` : "";
    if (addLeft && tui.visibleWidth(addLeft) <= safeWidth && (!addRight || tui.visibleWidth(addLeft) <= tui.visibleWidth(addRight))) { start = nextStart; continue; }
    if (addRight && tui.visibleWidth(addRight) <= safeWidth) { end = nextEnd; continue; }
    break;
  }
  if (safeWidth <= tui.visibleWidth("›")) return items[selected].slice(0, 1);
  const rendered = render();
  // Prefix counters are optional; the selected marker is not.
  if (tui.visibleWidth(rendered) <= safeWidth) return rendered;
  const wrappedItems = items.slice(start, end);
  if (!childMode && end < items.length) wrappedItems.push(...items.slice(end));
  return wrappedItems.map((item) => wrapSelectorItem(item, safeWidth, tui)).join(childMode ? "  " : "\n");
}

function browserTrustedSessionRoots(parentSessionFile: string | null): string[] {
  const roots: string[] = [];
  const addDirectory = (candidate: string | undefined) => {
    if (!candidate) return;
    try { if (fs.statSync(candidate).isDirectory()) roots.push(path.resolve(candidate)); } catch {}
  };
  if (parentSessionFile) addDirectory(path.dirname(parentSessionFile));
  addDirectory(process.env.PI_CODING_AGENT_SESSION_DIR);
  return [...new Set(roots)];
}

function resolveChildSessionFile(child: { sessionFile?: string; asyncDir: string }): string | undefined {
  if (!child.sessionFile) return undefined;
  return path.isAbsolute(child.sessionFile) ? child.sessionFile : path.resolve(child.asyncDir, child.sessionFile);
}

function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined) return "? tokens";
  if (tokens < 1_000) return `${tokens} tokens`;
  const compact = (value: number, suffix: string) => `${value.toFixed(1).replace(/\.0$/, "")}${suffix} tokens`;
  if (tokens < 1_000_000) return compact(tokens / 1_000, "k");
  return compact(tokens / 1_000_000, "M");
}

export function createBrowserInputController(options: {
  browser: SubagentSessionBrowserState;
  enterBrowser: () => void;
  exitBrowser: () => void;
  shouldPropagateEscape?: () => boolean;
  moveChild: (direction: -1 | 1) => void;
  scrollLines: (direction: -1 | 1) => void;
  scrollPage: (direction: -1 | 1) => void;
  scrollHome: () => void;
  scrollEnd: () => void;
  toggleTools: () => void;
  tui: FooterTuiBindings;
}) {
  const handleInput = (data: string) => {
    if (options.tui.matchesKey(data, options.tui.Key.alt("o"))) {
      if (options.tui.isKeyRepeat(data) || options.tui.isKeyRelease(data)) return { consume: true };
      options.browser.snapshot().active ? options.exitBrowser() : options.enterBrowser();
      return { consume: true };
    }
    if (!options.browser.snapshot().active) return undefined;
    if (options.tui.isKeyRelease(data)) return { consume: true };
    if (options.tui.matchesKey(data, options.tui.Key.escape)) { options.exitBrowser(); return options.shouldPropagateEscape?.() ? undefined : { consume: true }; }
    if (options.tui.matchesKey(data, options.tui.Key.left)) { options.moveChild(-1); return { consume: true }; }
    if (options.tui.matchesKey(data, options.tui.Key.right)) { options.moveChild(1); return { consume: true }; }
    if (options.tui.matchesKey(data, options.tui.Key.up) || options.tui.matchesKey(data, "k")) { options.scrollLines(-1); return { consume: true }; }
    if (options.tui.matchesKey(data, options.tui.Key.down) || options.tui.matchesKey(data, "j")) { options.scrollLines(1); return { consume: true }; }
    if (options.tui.matchesKey(data, options.tui.Key.pageUp)) { options.scrollPage(-1); return { consume: true }; }
    if (options.tui.matchesKey(data, options.tui.Key.pageDown)) { options.scrollPage(1); return { consume: true }; }
    if (options.tui.matchesKey(data, options.tui.Key.home)) { options.scrollHome(); return { consume: true }; }
    if (options.tui.matchesKey(data, options.tui.Key.end)) { options.scrollEnd(); return { consume: true }; }
    if (options.tui.matchesKey(data, "x")) { options.toggleTools(); return { consume: true }; }
    return { consume: true };
  };
  return { handleTerminalInput: handleInput, handleOverlayInput: handleInput };
}

function formatChildContext(tokens: number | undefined, position: { start: number; end: number; total: number } | undefined, width: number, tui: FooterTuiBindings): string {
  const tokenLabel = formatTokens(tokens);
  if (!position) return tokenLabel;
  const positionLabel = position.total === 0 ? "0/0" : `${position.start}-${position.end}/${position.total}`;
  const tokenWidth = Math.max(0, width - tui.visibleWidth(positionLabel) - tui.visibleWidth(" · "));
  if (tokenWidth === 0) return positionLabel;
  return `${tui.truncateToWidth(tokenLabel, tokenWidth, "…")} · ${positionLabel}`;
}

export function createFooterComponent({ getCwd, getHome, getModel, getContextUsage, getThinkingLevel, getSnapshot, getViewportPosition, getExtensionStatuses, requestRender, theme, tui }: any) {
  return { dispose() {}, invalidate() { requestRender(); }, render(width: number) {
    const snapshot = getSnapshot();
    const child = snapshot.selected;
    const cwd = child?.cwd ?? getCwd();
    const home = getHome();
    const displayedCwd = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
    const currentModel = getModel();
    let usage: any; try { usage = getContextUsage(); } catch {}
    const contextWindow = usage?.contextWindow || currentModel?.contextWindow || 1_000_000;
    const windowLabel = contextWindow >= 1_000_000 ? `${(contextWindow / 1_000_000).toFixed(1)}M` : `${(contextWindow / 1000).toFixed(0)}k`;
    const contextLabel = child
      ? formatChildContext(child.tokens, getViewportPosition?.(), width, tui)
      : usage?.percent === null ? `?/${windowLabel}` : `${(usage?.percent ?? 0).toFixed(1)}%/${windowLabel}`;
    const model = child ? formatChildModelLabel(child.model, child.thinking) : currentModel?.id ?? "no-model";
    const provider = !child && currentModel?.provider ? `(${currentModel.provider}) ` : "";
    const thinking = child?.thinking ?? getThinkingLevel?.() ?? "off";
    const extensionStatuses = getExtensionStatuses?.();
    const schedulerStatus = typeof extensionStatuses?.get("pi-scheduler") === "string" && extensionStatuses.get("pi-scheduler").startsWith("⏱ ") ? extensionStatuses.get("pi-scheduler") : "";
    const rightLabel = `${provider}${model}`;
    // In child mode the selected marker is navigation state, so it outranks a long model label.
    const childRightLabel = child ? tui.truncateToWidth(rightLabel, Math.max(0, width - 2), "…") : rightLabel;
    const selectorLines = formatBrowserSelector(snapshot, Math.max(1, width - tui.visibleWidth(childRightLabel) - 1), tui).split("\n");
    const selectorFirstLine = selectorLines.shift() ?? "";
    const selectorThirdLine = snapshot.active ? selectorLines.join("  ") : selectorLines.shift() ?? "";
    const firstRows = [
      layoutFooter({ width, left: displayedCwd, right: contextLabel, visibleWidth: tui.visibleWidth, truncateToWidth: tui.truncateToWidth }),
      layoutFooter({ width, left: selectorFirstLine, right: childRightLabel, visibleWidth: tui.visibleWidth, truncateToWidth: tui.truncateToWidth }),
      layoutFooter({ width, left: selectorThirdLine || schedulerStatus, right: `thinking: ${thinking}`, visibleWidth: tui.visibleWidth, truncateToWidth: tui.truncateToWidth }),
    ];
    return [...firstRows, ...(snapshot.active ? [] : selectorLines)].map((line) => theme.fg("dim", line));
  } };
}

export function createFooterRuntime(pi: ExtensionAPI, dependencies: FooterRuntimeDependencies): FooterRuntime {
  const { tui: tuiBindings, getMarkdownTheme } = dependencies;
  // F2b：browser/controller 按 session 代际重建；plain roster 经 rosterPartitions()
  //（manager 弱引用 × 逻辑 sessionID，Symbol 槽容器）延续。
  let browser = SubagentSessionBrowserState.hydrate(undefined);
  let controller: ReturnType<typeof createBrowserInputController>;
  // 当代 roster 分区定位；teardown 末尾置空，使 shutdown 后紧接 session_start 的
  // 幂等二次 teardown 不会用空 roster 覆盖已持久化分区。
  let rosterManager: object | undefined;
  let rosterSessionKey: string | undefined;
  // F2b：当代 subagent ActivitySource（provider）与失效监听（F6 owner 接线消费）。
  let activitySource: ActivitySource | undefined;
  let activityListeners = new Set<() => void>();
  // 详情组件渲染 theme：由 footer/overlay 工厂调用捕获（TUI render context 提供）。
  let detailTheme: any;
  let ctx: any;
  let invalidateFooter: (() => void) | undefined;
  let eventUnsubscribes: (() => void)[] = [];
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let closeOverlay: (() => void) | undefined;
  let viewport: SubagentTranscriptViewport | undefined;
  let previousEditor: any;
  let previousDraft: string | undefined;
  let editorWasSaved = false;
  let generation = 0;
  let sessionEpoch = 0;
  let cachedArtifactDir: "project" | "session" | "temp" = "project";
  let cachedMarkdownTheme: ReturnType<typeof getMarkdownTheme> | undefined;
  let nativeRenderer: NativeChildConversationRenderer | undefined;
  let overlayTui: { requestRender(): void } | undefined;
  let toolsExpanded = false;
  // F6：统一后台活动 owner 当代世代（scope/registry/bus 订阅/presenter）与当前已安装
  // 的 footer 标记（standalone 工厂函数或 presenter view，按身份幂等，不重复 setFooter）。
  let ownerEpoch: ActivityOwnerEpoch | undefined;
  let standaloneFooterFactory: MountedActivityView["createFooter"] | undefined;
  let installedFooterMarker: unknown;
  // 展示握手用的 Host 内存 bus（pi.events 的 on/emit 公开形状）。缺失/异常一律隔离：
  // 握手失败只损失统一展示，绝不影响 footer 自身、事件订阅或任务执行链路。
  const activityBus: ActivityBus | undefined = isRecordValue((pi as { events?: unknown }).events)
    ? (pi.events as unknown as ActivityBus)
    : undefined;
  const busEmit = (channel: string, data: unknown): void => {
    try { activityBus?.emit(channel, data); } catch { /* owner/参与者缺席或 bus 失效不是执行失败 */ }
  };
  const busOn = (channel: string, handler: (data: unknown) => void): (() => void) => {
    try {
      const unsubscribe = activityBus?.on(channel, handler);
      return typeof unsubscribe === "function" ? unsubscribe : () => undefined;
    } catch { return () => undefined; }
  };

  const notifyActivity = () => {
    for (const listener of [...activityListeners]) {
      try { listener(); } catch { /* 展示回调彼此隔离，不向 runtime 传播 */ }
    }
  };
  const persist = () => {
    if (rosterManager !== undefined && rosterSessionKey !== undefined) {
      const rosterStore = rosterPartitions();
      let perManager = rosterStore.get(rosterManager);
      if (perManager === undefined) {
        perManager = new Map();
        rosterStore.set(rosterManager, perManager);
      }
      perManager.set(rosterSessionKey, browser.serialize().children);
    }
    notifyActivity();
  };
  // F0 §4 当前 session 事件接受表：事件 sessionId 必须为非空 string，且等于事件
  // 到达时刻实测的当前 manager.getSessionFile() 或 getSessionId()（同一 session
  // 落盘前后会在这两种合法形态间翻转）；缺失/空/非 string 或异 session 一律拒绝
  // 且不写 roster。事件 payload 无 generation 字段，不做代际过滤（F0 §2.4）。
  const isCurrentSessionEvent = (eventSessionId: unknown): boolean => {
    if (typeof eventSessionId !== "string" || eventSessionId.length === 0) return false;
    const identity = managerSessionIdentity(ctx?.sessionManager);
    return eventSessionId === identity.sessionFile || eventSessionId === identity.sessionId;
  };

  const refresh = () => { invalidateFooter?.(); viewport?.refresh(); };
  const invalidateNative = () => { nativeRenderer?.invalidate(); };
  const syncMarkdownTheme = () => {
    try {
      const nextTheme = getMarkdownTheme();
      if (cachedMarkdownTheme !== nextTheme) {
        cachedMarkdownTheme = nextTheme;
        invalidateNative();
      }
    } catch {}
  };
  const notifyError = (error: unknown) => {
    const message = error instanceof Error ? error.message : "unable to open subagent browser";
    try { ctx?.ui.notify?.(`Subagent browser: ${message}`, "error"); } catch {}
  };
  const reconcile = (owner = ctx, epoch = sessionEpoch) => {
    if (!owner || owner !== ctx || epoch !== sessionEpoch) return;
    const wasActive = browser.snapshot().active;
    // 可见 facade 已折叠，但原始 root 仍需轮询以发现后续 workflow step。
    for (const run of browser.trackedRuns()) {
      if (owner !== ctx || epoch !== sessionEpoch) return;
      browser.reconcileRun(run.id, readBrowserRunStatus(run.asyncDir));
    }
    persist();
    if (wasActive && !browser.snapshot().active) exitBrowser();
    else refresh();
  };
  const renderChild = (child: BrowserChild | undefined, width: number, theme: any, expandedTools: boolean): string[] => {
    if (!child) return ["[Waiting for child output]"];
    if (!ctx) return ["[Warning: browser session is unavailable]"];
    const sessionFile = resolveChildSessionFile(child);
    if (sessionFile && nativeRenderer) {
      const native = nativeRenderer.render({
        sessionFile,
        trustedRoots: browserTrustedSessionRoots(ctx.sessionManager?.getSessionFile?.() ?? null),
        width,
        cwd: child.cwd,
        markdownTheme: cachedMarkdownTheme ?? getMarkdownTheme(),
        theme,
        ui: overlayTui ?? { requestRender() {} },
        expandedTools,
        hideThinking: false,
        outputPad: 1,
      });
      if (native.lines.length || !native.warning) return native.lines.length ? native.lines : ["[Waiting for child output]"];
    }
    if (!child.transcriptPath) return ["[Waiting for child output]"];
    try {
      const rendered = renderBrowserTranscript({ transcriptPath: child.transcriptPath, trustedRoots: browserTrustedRoots({ asyncDir: child.asyncDir, runCwd: child.cwd, parentCwd: ctx.cwd, parentSessionFile: ctx.sessionManager?.getSessionFile?.() ?? null, artifactDirPreference: cachedArtifactDir }), width, theme, markdownTheme: cachedMarkdownTheme ?? getMarkdownTheme(), expandedTools });
      if (rendered.lines.length) return rendered.lines;
      return rendered.warning ? [`[Warning: ${rendered.warning}]`] : ["[Waiting for child output]"];
    } catch (error) {
      const message = error instanceof Error ? error.message : "unable to render child transcript";
      return [`[Warning: ${message}]`];
    }
  };
  const renderSelected = (width: number, theme: any): string[] => renderChild(browser.snapshot().selected, width, theme, toolsExpanded);
  // F2b provider 详情渲染：按 browser child key 解析并沿用 trusted native 优先 /
  // Fleet 回退与 trusted roots 文件安全防线；根层只获得组件投影，不读取 sessionFile
  // 正文。sourceBrowser 为当代 browser 实例（值捕获，旧代闭包不读新代数据）。
  const renderChildByKey = (sourceBrowser: SubagentSessionBrowserState, childKey: string, width: number, expandedTools: boolean): string[] => {
    const child = sourceBrowser.snapshot().children.find((candidate) => candidate.key === childKey);
    if (child === undefined) return ["[Waiting for child output]"];
    return renderChild(child, width, detailTheme ?? FALLBACK_DETAIL_THEME, expandedTools);
  };
  const exitBrowser = () => {
    generation += 1;
    browser.exit();
    persist();
    const close = closeOverlay; closeOverlay = undefined;
    try { close?.(); } catch {}
    try { viewport?.dispose(); } catch {}
    viewport = undefined;
    overlayTui = undefined;
    if (ctx && editorWasSaved) {
      try { ctx.ui.setEditorComponent(previousEditor); } catch {}
      try { if (previousDraft !== undefined) ctx.ui.setEditorText?.(previousDraft); } catch {}
    }
    previousEditor = undefined;
    previousDraft = undefined;
    editorWasSaved = false;
    refresh();
  };
  const teardown = () => {
    sessionEpoch += 1;
    // F6：token 先失效再清理展示层（bus 退订/source dispose/视图 dispose/owner-close）；
    // 不取消实际任务、不重置 controller，任务生命周期仍由其各自 owner 掌握。
    teardownOwner();
    // F2b-v：先使旧 provider/监听者失效（公开合同：teardown 先失效再清理）。
    // exitBrowser/persist 在后续清理阶段仍会触发 roster 失效通知，但旧 source
    // 的订阅已在此处拆除，late 清理事件被 fence，不投递给已关闭的旧 source；
    // 旧 source 的 snapshot/detail 只读其值捕获的旧 browser（下方 clear），
    // 不读新世代。roster 分区保存顺序与正常变化的 notify 路径均不变。
    activitySource = undefined;
    activityListeners.clear();
    invalidateNative();
    exitBrowser();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    eventUnsubscribes.forEach((unsubscribe) => unsubscribe());
    eventUnsubscribes = [];
    // F2b：先把当前 roster plain rows 写入 (manager, 逻辑 sessionID) 分区，再清空
    // 内存 browser；分区引用随后置空，紧随其后的二次 teardown（shutdown 后紧接
    // start 的幂等重入）不会用空 roster 覆盖分区。闭包 token（epoch）已在上方失效，
    // pi.events 退订幂等（SDK 追踪句柄重复退订安全，F0 §6）。
    persist();
    browser.clear();
    rosterManager = undefined;
    rosterSessionKey = undefined;
    invalidateFooter = undefined;
    overlayTui = undefined;
    cachedMarkdownTheme = undefined;
    nativeRenderer = undefined;
    toolsExpanded = false;
    ctx = undefined;
  };
  const enterBrowser = () => {
    if (!ctx || ctx.mode !== "tui" || !browser.enter()) return;
    const owner = ctx;
    const epoch = sessionEpoch;
    const rollback = (error: unknown) => {
      if (owner !== ctx || epoch !== sessionEpoch) return;
      exitBrowser();
      notifyError(error);
    };
    try {
      previousEditor = owner.ui.getEditorComponent();
      previousDraft = owner.ui.getEditorText?.();
      editorWasSaved = true;
      owner.ui.setEditorComponent((tui: any, theme: any, keybindings: any) => new ReadOnlyBrowserEditor(tui, theme, keybindings));
      const token = ++generation;
      const result = owner.ui.custom((tui: any, theme: any, _keybindings: any, done: () => void) => {
        if (token !== generation || owner !== ctx || epoch !== sessionEpoch || !browser.snapshot().active) { done(); return { render: () => [] }; }
        detailTheme = theme;
        closeOverlay = () => done();
        overlayTui = tui;
        viewport = new SubagentTranscriptViewport({
          getTerminalRows: () => tui.terminal.rows,
          reservedBottomRows: 4,
          getLines: (width) => renderSelected(width, theme),
          requestRender: () => tui.requestRender(),
          onInput: (data) => {
            const wheel = parseSgrWheelDirection(data);
            if (wheel !== undefined) viewport?.scrollLines(wheel);
            else controller.handleOverlayInput(data);
          },
          onInvalidate: invalidateNative,
        });
        return viewport;
      }, {
        overlay: true,
        overlayOptions: { row: 0, col: 0, width: "100%", maxHeight: "100%", margin: { bottom: 4 } },
        onHandle: (handle) => handle.focus(),
      });
      Promise.resolve(result).catch(rollback);
      persist();
      refresh();
    } catch (error) { rollback(error); }
  };
  controller = createBrowserInputController({
    browser,
    enterBrowser,
    exitBrowser,
    moveChild(direction) { browser.move(direction); viewport?.resetScroll(); invalidateNative(); refresh(); },
    scrollLines(direction) { viewport?.scrollLines(direction); },
    scrollPage(direction) { viewport?.scrollPage(direction); },
    scrollHome() { viewport?.scrollHome(); },
    scrollEnd() { viewport?.scrollEnd(); },
    toggleTools() { toolsExpanded = !toolsExpanded; invalidateNative(); refresh(); },
    tui: tuiBindings,
  });

  // ---------------------------------------------------------------------
  // F6：统一后台活动 owner（唯一 setFooter owner + bus 握手）
  // ---------------------------------------------------------------------

  /**
   * 当代 standalone footer 工厂（F6 前为 session_start 内联安装，现提取为命名工厂）：
   * 行为与迁移前一致——按当代 ctx（owner）投影 cwd/context/model/thinking 与
   * selector/scheduler 回退布局，并捕获 detailTheme/markdown theme 供 package 自有
   * trusted native 详情渲染使用。它同时是协议 `MountedActivityView['createFooter']`
   * 形状，因此可作为 fallback 视图的 footer 直接交给 setFooter。
   */
  const createStandaloneFooterFactory = (owner: any): MountedActivityView["createFooter"] =>
    ((tui: any, theme: any, footerData: any) => {
      detailTheme = theme;
      syncMarkdownTheme();
      const component = createFooterComponent({ getCwd: () => owner.cwd, getHome: () => process.env.HOME, getModel: () => owner.model, getContextUsage: () => owner.getContextUsage(), getThinkingLevel: () => pi.getThinkingLevel(), getSnapshot: () => browser.snapshot(), getViewportPosition: () => viewport?.position(), getExtensionStatuses: () => footerData?.getExtensionStatuses?.(), requestRender: () => tui.requestRender(), theme, tui: tuiBindings });
      invalidateFooter = () => component.invalidate();
      return component;
    }) as MountedActivityView["createFooter"];

  /**
   * 安装当代 footer：只有本 runtime 调用 `ctx.ui.setFooter`，且只在当代视图变化时
   * 安装一次（同视图幂等，不重复 setFooter）；`ctx.mode === 'tui'` 门禁（hasUI 不足），
   * RPC/print/json 不安装任何 terminal footer。presenter 路径用一个只捕获 theme/
   * invalidate 句柄的薄壳包装当代 `view.createFooter`：不改写视图渲染语义，也不引入
   * 第二个 footer 安装者；捕获 theme 是为了 package 自有 subagent 详情渲染
   * （trusted native）在统一详情内仍沿用当代 SDK 主题。
   */
  const installFooter = (): void => {
    const ownerCtx = ctx;
    if (!ownerCtx || ownerCtx.mode !== "tui") return;
    const view = ownerEpoch?.presenter?.view;
    const standalone = standaloneFooterFactory;
    const marker = view ?? standalone;
    if (!marker || marker === installedFooterMarker) return;
    installedFooterMarker = marker;
    if (!view) {
      ownerCtx.ui.setFooter(standalone);
      return;
    }
    ownerCtx.ui.setFooter((tui: any, theme: any, footerData: any) => {
      detailTheme = theme;
      syncMarkdownTheme();
      const component = view.createFooter(tui, theme, footerData);
      invalidateFooter = () => { try { component?.invalidate?.(); } catch { /* 重绘请求异常隔离 */ } };
      return component;
    });
  };

  /** bus 触发的重安装：异常不得回注到发送方 extension 的 emit 调用栈。 */
  const reinstallFooter = (): void => {
    try { installFooter(); } catch { /* 展示安装失败不影响任务与事件链路 */ }
  };

  /**
   * fallback 视图：既有 standalone（package 自有 subagent footer + Alt+O browser）。
   * 不是业务失败兼容，也不加载根源码；只包装当代 standalone 工厂与浏览器开关。
   */
  const standaloneActivityView = (): MountedActivityView => ({
    createFooter: ((tui: any, theme: any, footerData: any) =>
      (standaloneFooterFactory as (tui: any, theme: any, footerData: any) => any)?.(tui, theme, footerData)) as MountedActivityView["createFooter"],
    openDetails: async () => { enterBrowser(); },
    dispose: () => { if (browser.snapshot().active) exitBrowser(); },
  });

  /** 详情打开委托：失败不向快捷键/事件路径传播。 */
  const openViewDetails = (view: MountedActivityView): void => {
    try {
      const result = view.openDetails() as Promise<void> | undefined;
      if (result && typeof result.then === "function") result.catch(() => { /* 展示异常隔离 */ });
    } catch { /* 同上 */ }
  };

  /**
   * 挂载根 presenter：不同 registrationId 才换视图，换视图前先关闭旧 overlay、恢复
   * draft/editor 并 dispose 旧组件（standalone browser overlay 同样先收束），再安装新
   * 视图的 createFooter。同 registrationId 由调用方幂等短路（不重置选中项）。
   */
  const mountPresenter = (epoch: ActivityOwnerEpoch, registrationId: string, factory: ActivityPresenterFactory): void => {
    const previous = epoch.presenter;
    epoch.presenter = undefined;
    if (previous) { try { previous.view.dispose(); } catch { /* dispose 异常不阻断换视图 */ } }
    if (browser.snapshot().active) exitBrowser();
    const bindings: FooterBindings = {
      scope: epoch.scope,
      registry: epoch.registry,
      ctx,
      fallback: standaloneActivityView,
    };
    let view: MountedActivityView | undefined;
    try {
      const candidate: unknown = factory(bindings);
      view = isMountedActivityView(candidate) ? candidate : undefined;
    } catch { view = undefined; }
    if (!view) {
      // 根 factory 失败/形状不合协议：回退既有 standalone 视图，不双安装、不报错到 bus。
      try {
        const fallbackView: unknown = bindings.fallback();
        if (isMountedActivityView(fallbackView)) view = fallbackView;
      } catch { view = undefined; }
    }
    if (!view) { reinstallFooter(); return; } // 无可用视图：保持当代 standalone footer
    epoch.presenter = { registrationId, view };
    reinstallFooter();
  };

  /**
   * 创建当代 owner：registry + scope（token 为本次 start 新建对象、sessionId 为 manager
   * 逻辑 UUID、hostKey 为 sessionManager 对象身份），注册 package 自有 subagent source，
   * **先**监听 request/register/unregister/presenter 通道，**再** emit owner-ready；
   * 因此 owner-first 与 publisher-first 两种加载顺序都能完成握手。缺逻辑 sessionID
   * 时 fail closed：不握手（仅 standalone），不猜测 scope。
   */
  const startOwnerEpoch = (): void => {
    const ownerCtx = ctx;
    if (!ownerCtx || ownerCtx.mode !== "tui") return;
    const manager: unknown = ownerCtx.sessionManager;
    if (!isRecordValue(manager)) return;
    const logicalSessionId = managerSessionIdentity(manager).sessionId;
    if (logicalSessionId === undefined) return;
    const scope: HostScope = { sessionManager: manager, sessionId: logicalSessionId, token: {}, hostKey: manager };
    const epoch: ActivityOwnerEpoch = {
      scope,
      ownerRegistrationId: createBackgroundActivityRegistrationId(),
      registry: createActivityRegistry(),
      sources: new Map(),
      busUnsubscribes: [],
      ownSource: activitySource,
      presenter: undefined,
      subagentDispose: undefined,
      closed: false,
    };
    ownerEpoch = epoch;
    const readyPayload: OwnerReadyPayload = { scope, ownerRegistrationId: epoch.ownerRegistrationId };
    const isCurrent = (): boolean => ownerEpoch === epoch && !epoch.closed;
    // package 自有 subagent source（provider）直接注册进 registry，不经 bus。
    const ownSource = epoch.ownSource;
    if (ownSource) {
      try { epoch.subagentDispose = epoch.registry.register(ownSource); } catch { /* 协议不符：不握手失败 */ }
    }

    const handleOwnerRequest = (data: unknown): void => {
      if (!isCurrent() || !isOwnerRequestPayload(data)) return;
      // 只回答 manager/sessionId/hostKey 三要素同时匹配的 request：重发当代 ready
      //（publisher 重复 ready 幂等，复用同 registrationId）。
      if (!isSameHostScopeIdentity(epoch.scope, data)) return;
      busEmit(BACKGROUND_ACTIVITY_CHANNELS.ownerReady, readyPayload);
    };

    const handleSourceRegister = (data: unknown): void => {
      if (!isCurrent() || !isRecordValue(data)) return;
      // 精确 scope（含 token 世代）：reload/new/resume/fork 后的旧 scope 一律忽略。
      if (!isHostScope(data.scope) || !isSameHostScope(epoch.scope, data.scope)) return;
      const registrationId: unknown = data.registrationId;
      const source: unknown = data.source;
      if (!isRegistrationIdValue(registrationId) || !isActivitySourceValue(source)) return;
      const kind = source.kind;
      const existing = epoch.sources.get(kind);
      // 重复 ready 触发的同 registrationId + 同 source 重发：幂等，不重建订阅。
      if (existing && existing.registrationId === registrationId && existing.source === source) return;
      if (existing) {
        epoch.sources.delete(kind);
        try { existing.dispose(); } catch { /* 退订异常不阻断新注册 */ }
      }
      let dispose: () => void = () => undefined;
      try { dispose = epoch.registry.register(source); } catch { return; }
      epoch.sources.set(kind, { registrationId, source, dispose });
    };

    const handleSourceUnregister = (data: unknown): void => {
      if (!isCurrent() || !isRecordValue(data)) return;
      if (!isHostScope(data.scope) || !isSameHostScope(epoch.scope, data.scope)) return;
      const registrationId: unknown = data.registrationId;
      const kind: unknown = data.kind;
      if (!isRegistrationIdValue(registrationId) || !isActivityKindValue(kind)) return;
      const existing = epoch.sources.get(kind);
      // 只撤销同 scope 同 registrationId 的注册；旧 ID 撤销不得移除同 kind 的新 source。
      if (!existing || existing.registrationId !== registrationId) return;
      epoch.sources.delete(kind);
      try { existing.dispose(); } catch { /* 退订异常不阻断注销 */ }
      // subagent kind 的展示权威始终是 package 自有 source：第三方同 kind 注册撤销后恢复。
      if (kind === "subagent" && epoch.ownSource !== undefined) {
        try { epoch.subagentDispose = epoch.registry.register(epoch.ownSource); } catch { /* 同上 */ }
      }
    };

    const handlePresenterRegister = (data: unknown): void => {
      if (!isCurrent() || !isRecordValue(data)) return;
      if (!isHostScope(data.scope) || !isSameHostScope(epoch.scope, data.scope)) return;
      const registrationId: unknown = data.registrationId;
      const factory: unknown = data.factory;
      if (!isRegistrationIdValue(registrationId) || typeof factory !== "function") return;
      // 同 registrationId 幂等：不重复 setFooter、不关旧 overlay、不重置选中项。
      if (epoch.presenter?.registrationId === registrationId) return;
      mountPresenter(epoch, registrationId, factory as ActivityPresenterFactory);
    };

    const handlePresenterUnregister = (data: unknown): void => {
      if (!isCurrent() || !isRecordValue(data)) return;
      if (!isHostScope(data.scope) || !isSameHostScope(epoch.scope, data.scope)) return;
      const registrationId: unknown = data.registrationId;
      if (!isRegistrationIdValue(registrationId)) return;
      const current = epoch.presenter;
      // 过期 ID 撤销无效；匹配 ID 才恢复 standalone（不销毁 owner 整体）。
      if (!current || current.registrationId !== registrationId) return;
      epoch.presenter = undefined;
      try { current.view.dispose(); } catch { /* dispose 异常不阻断恢复 */ }
      reinstallFooter();
    };

    // 先监听后宣布：publisher 无论先于或后于 owner 加载，都能以同 Host 身份完成握手。
    epoch.busUnsubscribes.push(
      busOn(BACKGROUND_ACTIVITY_CHANNELS.ownerRequest, handleOwnerRequest),
      busOn(BACKGROUND_ACTIVITY_CHANNELS.sourceRegister, handleSourceRegister),
      busOn(BACKGROUND_ACTIVITY_CHANNELS.sourceUnregister, handleSourceUnregister),
      busOn(BACKGROUND_ACTIVITY_CHANNELS.presenterRegister, handlePresenterRegister),
      busOn(BACKGROUND_ACTIVITY_CHANNELS.presenterUnregister, handlePresenterUnregister),
    );
    busEmit(BACKGROUND_ACTIVITY_CHANNELS.ownerReady, readyPayload);
  };

  /**
   * owner 清理：token 先失效（ownerEpoch 置空 + closed）再逐个退订 bus、dispose
   * presenter 视图（关闭 overlay、恢复 draft/editor）、dispose source 注册与 registry，
   * 最后 emit owner-close 通知当代参与者。全程只清展示层：不取消实际任务、不重置
   * controller、不发消息。幂等：重复 teardown 无副作用。
   */
  const teardownOwner = (): void => {
    const epoch = ownerEpoch;
    ownerEpoch = undefined; // token 先失效：此后任何 late register/detail/poll 都不匹配当代
    installedFooterMarker = undefined;
    standaloneFooterFactory = undefined;
    if (!epoch) return;
    epoch.closed = true;
    const { scope } = epoch;
    for (const unsubscribe of epoch.busUnsubscribes.splice(0)) {
      try { unsubscribe(); } catch { /* 退订异常逐个隔离 */ }
    }
    const presenter = epoch.presenter;
    epoch.presenter = undefined;
    if (presenter) { try { presenter.view.dispose(); } catch { /* dispose 异常不阻断清理 */ } }
    for (const registration of epoch.sources.values()) {
      try { registration.dispose(); } catch { /* 同上 */ }
    }
    epoch.sources.clear();
    const subagentDispose = epoch.subagentDispose;
    epoch.subagentDispose = undefined;
    if (subagentDispose) { try { subagentDispose(); } catch { /* 同上 */ } }
    try { epoch.registry.dispose(); } catch { /* 同上 */ }
    busEmit(BACKGROUND_ACTIVITY_CHANNELS.ownerClose, { scope });
  };

  // 唯一 Alt+O 快捷键注册留在薄 entry（无 unregister，故按当代闭包委托）：handler 委托
  // 本方法。守卫语义与迁移前一致（仅当前 sessionManager 匹配）；当代挂载了统一
  // presenter 时委托其 openDetails，否则保持 standalone browser 行为。
  const openBrowser = (shortcutCtx: unknown) => {
    if (!ctx) return;
    if ((shortcutCtx as { sessionManager?: unknown } | undefined)?.sessionManager !== ctx.sessionManager) return;
    const view = ownerEpoch?.presenter?.view;
    if (view) { openViewDetails(view); return; }
    if (!browser.snapshot().active) enterBrowser();
  };

  pi.on("session_start", (_event: any, nextCtx) => {
    // A reload may issue another start without a preceding shutdown.
    teardown();
    if (nextCtx.mode !== "tui") return;
    ctx = nextCtx;
    // 0.71 config has no public read surface (contract §2.2, §4); keep the
    // display projection on the package-owned project root by default.
    cachedArtifactDir = "project";
    try { cachedMarkdownTheme = getMarkdownTheme(); } catch { cachedMarkdownTheme = undefined; }
    nativeRenderer = new NativeChildConversationRenderer(createChildConversationRenderers(ctx.cwd));
    // F2b：按 (manager, 逻辑 sessionID) 恢复 plain roster 分区。同 manager 同
    // session（reload，含 SDK 模块重求值后的新 factory，F2b-v）延续本分区；
    // new/fork/switch/resume 的新 manager 天然取空分区，同 ID 异 manager 也不
    // 继承他人 roster。逻辑 sessionID 只取 manager UUID（原合同：真实 manager
    // 必有 UUID；同一 session 落盘前后 sessionFile 形态会翻转，F0 §3）；缺 UUID
    // 不回退 file 伪 UUID——fail closed（仅失去跨 reload 持久化，当前内存 roster
    // 照常），不扩大 fallback；事件侧 sessionFile/UUID 双形态过滤保持不变。
    const identity = managerSessionIdentity(ctx.sessionManager);
    rosterManager = typeof ctx.sessionManager === "object" && ctx.sessionManager !== null ? ctx.sessionManager : undefined;
    rosterSessionKey = identity.sessionId;
    const persistedChildren = rosterManager !== undefined && rosterSessionKey !== undefined
      ? rosterPartitions().get(rosterManager)?.get(rosterSessionKey)
      : undefined;
    browser = SubagentSessionBrowserState.hydrate({ version: 1, children: Array.isArray(persistedChildren) ? persistedChildren : [] });
    controller = createBrowserInputController({
      browser,
      enterBrowser,
      exitBrowser,
      moveChild(direction) { browser.move(direction); viewport?.resetScroll(); invalidateNative(); refresh(); },
      scrollLines(direction) { viewport?.scrollLines(direction); },
      scrollPage(direction) { viewport?.scrollPage(direction); },
      scrollHome() { viewport?.scrollHome(); },
      scrollEnd() { viewport?.scrollEnd(); },
      toggleTools() { toolsExpanded = !toolsExpanded; invalidateNative(); refresh(); },
      tui: tuiBindings,
    });
    const owner = ctx;
    const epoch = sessionEpoch;
    const epochBrowser = browser;
    // F2b：创建当代 subagent ActivitySource（provider）。F6：本 runtime 作为唯一 owner
    // 直接把它注册进当代 registry（不经 bus）；仍不新增 setFooter/shortcut，句柄经
    // FooterRuntime.getActivitySource 合法暴露。值捕获当代 browser 与监听集：teardown 后
    // 旧 source 不再收到失效、snapshot 只反映被清空的旧 browser，不读新代数据。
    const epochActivityListeners = new Set<() => void>();
    activityListeners = epochActivityListeners;
    activitySource = createSubagentActivitySource({
      browser: epochBrowser,
      renderDetail: (childKey, width, expandedTools) => renderChildByKey(epochBrowser, childKey, width, expandedTools),
      subscribe: (invalidate) => {
        epochActivityListeners.add(invalidate);
        return () => { epochActivityListeners.delete(invalidate); };
      },
    });
    eventUnsubscribes = [
      pi.events.on("subagent:async-started", (event: any) => {
        if (owner !== ctx || epoch !== sessionEpoch) return;
        if (!isCurrentSessionEvent(event?.sessionId)) return;
        const eventTitle = typeof event?.title === "string" && event.title.trim() ? event.title : undefined;
        const fallbackTitle = eventTitle ? undefined : getTitleRegistry().started(event);
        epochBrowser.trackStarted(fallbackTitle ? { ...event, title: fallbackTitle } : event);
        invalidateNative(); persist(); refresh();
      }),
      pi.events.on("subagent:async-complete", (event: any) => {
        if (owner !== ctx || epoch !== sessionEpoch) return;
        if (!isCurrentSessionEvent(event?.sessionId)) return;
        epochBrowser.trackCompleted(event); persist(); reconcile(owner, epoch);
      }),
    ];
    pollTimer = setInterval(() => reconcile(owner, epoch), 500);
    (pollTimer as any)?.unref?.();
    // F6：先备当代 standalone footer 工厂（唯一 setFooter owner 基线），再建 owner 世代并
    // 宣布 ready：若根 presenter 在 ready 的同步链上注册，当代视图已为 presenter，
    // 下方 installFooter 只安装一次（同视图幂等，不重复 setFooter）。
    standaloneFooterFactory = createStandaloneFooterFactory(owner);
    installedFooterMarker = undefined;
    startOwnerEpoch();
    installFooter();
    reconcile(owner, epoch);
  });
  pi.on("model_select", refresh);
  pi.on("thinking_level_select", refresh);
  pi.on("session_shutdown", (_event: any) => {
    teardown();
  });
  return { openBrowser, getActivitySource: () => activitySource };
}
