// 统一后台活动详情壳 controller（统一执行计划 F5b / footer 子计划 T5b）。
//
// 职责：只读详情壳的导航状态、详情请求生命周期、自有 viewport 与输入处理。
//
// 边界（任务合同精确模型）：
// - 只读：不执行/取消任务、不发送消息、不读取 session/store/settings；provider 组件的
//   render/invalidate 仅做 display 消费（切片/补空/截断都生成新数组/新串），不改 raw。
// - 详情请求严格 fence：scope token + selection key + source 对象 + request sequence，
//   晚回旧组件只 dispose 一次并丢弃；x 展开重取、registry invalidate/主题变化重取均
//   保留可保持的 scroll anchor（manual 只把 startIndex 钳制到新内容上界，autoFollow 语义不变）。
// - 高度模型：terminalRows-4 已为 overlay 下方详情 footer（最多 3 行）+ separator 预留，
//   正文不得再扣同一 footer；overlay 内公共标题仅按其实际行数扣减；根自有 viewport 支持
//   bodyRows 0（terminalRows<=4 时正文为空、关闭输入仍可用、不产生负高度），不改 package
//   既有 session-viewport 的至少 1 行合同。
// - 输入全部消费在壳内：Alt+O/Esc 只关闭且不向恢复后的 editor 传播；left/right 选项导航；
//   up/down/j/k/page/home/end/wheel 正文滚动；release 忽略、repeat 仅重复导航、未知键吞掉。
//   editor/draft 的获取与恢复归 presenter（错误隔离），壳本身不触碰 editor。
// - navigation 覆盖 registry.snapshot() 的 main+recent（含 recent 全量，不受主视图历史
//   折叠上限影响）并追加 stale 观察独立分组；身份只认稳定 key，key 消失选择相邻项或
//   空状态，不按标题复活；同 kind source 对象替换后即使同 key 也按新 source 发起新请求。

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type {
  ActivityRegistry,
  ActivityRow,
  ActivitySnapshot,
  ActivitySource,
  DetailComponent,
  HostScope,
} from "pi-subagents-enhanced/tui/background-activity";
import { ACTIVITY_KIND_ORDER, DETAIL_RESERVED_BOTTOM_ROWS } from "./layout.ts";
import type { ActivityTheme } from "./layout.ts";

/** 详情壳注入的 pi-tui 输入/宽度工具（与 package FooterTuiBindings 同源的 DI 端口）。 */
export type ActivityTuiBindings = Pick<
  typeof import("@earendil-works/pi-tui"),
  | "Key"
  | "isKeyRelease"
  | "isKeyRepeat"
  | "matchesKey"
  | "visibleWidth"
  | "truncateToWidth"
  | "stripTerminalSequences"
>;

/** 详情壳生命周期状态：closed 未挂载；loading 挂载且首请求在途；open 挂载展示；too-small 开启请求因终端过小被拒。 */
export type ActivityDetailState = "closed" | "open" | "loading" | "too-small";

/** presenter 在 ctx.ui.custom factory 内注入的当代运行面。 */
export interface ActivityDetailSurface {
  /** overlay tui 的当前物理行数（每 render 实时读取）。 */
  getTerminalRows(): number;
  requestRender(): void;
  /** 当前主题端口（SDK Theme 结构兼容）；缺省时输出无色纯文本。 */
  theme?: ActivityTheme;
  /** 结束本次 overlay 交互（custom() promise resolve + SDK dispose 壳组件）。 */
  done(): void;
}

export interface ActivityDetailShellDeps {
  readonly registry: ActivityRegistry;
  readonly scope: HostScope;
  readonly tui: ActivityTuiBindings;
  /** 每次 open 周期 close 后回调（presenter 恢复 editor/draft 并刷新 footer），至多触发一次。 */
  onClosed?(): void;
}

/** 持久详情壳 controller（跨 open/close 复用；每次 open 的 Component 由 presenter 另行包装）。 */
export interface ActivityDetailShell {
  readonly state: ActivityDetailState;
  isMounted(): boolean;
  expanded(): boolean;
  selectedKey(): string | undefined;
  entries(): readonly ActivityRow[];
  position(): { start: number; end: number; total: number; autoFollow: boolean };
  /** 挂载运行面并请求当前选择的详情；重复调用无效果。 */
  open(surface: ActivityDetailSurface): void;
  /** 开启请求因终端过小被拒：不挂载、不触碰 editor/draft；恢复尺寸后可重开。 */
  markTooSmall(): void;
  /** 关闭本次交互：dispose 当前组件一次、done 一次、触发 onClosed 一次；幂等。 */
  close(): void;
  /** 永久关闭（presenter dispose）：此后 open/markTooSmall 无效果；幂等。 */
  dispose(): void;
  /** registry 失效（source 数据变化或同 kind 注册替换）：刷新条目并重取当前详情（保 anchor）。 */
  handleRegistryInvalidated(): void;
  /** 主题身份变化：转发 provider invalidate 并重取当前详情（保 anchor）。 */
  handleThemeChange(): void;
  render(width: number): string[];
  handleInput(data: string): { consume: boolean } | undefined;
  invalidate(): void;
}

/** 只读 editor 替身：渲染空行、不处理输入；保留 CustomEditor 基类的应用快捷键合同。 */
export class ReadOnlyActivityEditor extends CustomEditor {
  override render(_width: number): string[] {
    return [];
  }

  override handleInput(_data: string): void {}
}

/** SDK 公开 `ExtensionUIContext['setEditorComponent']` 的 factory 参数类型（pi 根入口未导出 EditorFactory 名字，按签名推导）。 */
export type ActivityReadOnlyEditorFactory = NonNullable<
  Parameters<ExtensionUIContext["setEditorComponent"]>[0]
>;

/** 创建只读 editor factory（presenter 在打开详情时替换主 editor 用）。 */
export function createReadOnlyActivityEditorFactory(): ActivityReadOnlyEditorFactory {
  return (tui, theme, keybindings) => new ReadOnlyActivityEditor(tui, theme, keybindings);
}

const CONSUME_INPUT: { consume: boolean } = Object.freeze({ consume: true });

// C0 控制符（除 \t 外，含 LF/CR）与 DEL/C1；\t 单独替换为单个空格保证列宽一致。
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F]/g;

const SGR_WHEEL_PATTERN = /^\x1b\[<(\d+);\d+;\d+M$/;

/** 解析 SGR 轨球方向：64 上滚 -1、65 下滚 +1、其余 undefined。 */
export function parseSgrWheelDirection(data: string): -1 | 1 | undefined {
  if (typeof data !== "string") return undefined;
  const match = SGR_WHEEL_PATTERN.exec(data);
  if (!match) return undefined;
  const button = Number(match[1]) & ~(4 | 8 | 16);
  if (button === 64) return -1;
  if (button === 65) return 1;
  return undefined;
}

/** 显示文本清理：剥离 ANSI/OSC 序列与控制符，只生成新串，不写回 raw。 */
export function toActivityDisplayText(raw: unknown, tui: ActivityTuiBindings): string {
  if (typeof raw !== "string") return "";
  try {
    const withoutSequences = tui.stripTerminalSequences(raw);
    return withoutSequences.replace(/\t/g, " ").replace(CONTROL_CHAR_PATTERN, "");
  } catch {
    return "";
  }
}

/** 渲染一行详情壳 chrome 文本：清理 → 按终端列截断 → dim 主题色。 */
export function renderActivityDetailTextLine(
  text: string,
  width: number,
  theme: ActivityTheme | undefined,
  tui: ActivityTuiBindings,
): string {
  const cleaned = toActivityDisplayText(text, tui);
  const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (safeWidth <= 0) return "";
  const truncated = tui.truncateToWidth(cleaned, safeWidth, "…");
  return theme ? theme.fg("dim", truncated) : truncated;
}

function normalizeWidth(width: number): number {
  const value = Number(width);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function safeSourceFor(registry: ActivityRegistry, key: string): ActivitySource | undefined {
  try {
    return registry.sourceFor(key);
  } catch {
    return undefined;
  }
}

/** 单次详情请求的 fence 记录：scope token + selection key + source 对象 + sequence。 */
interface DetailRequestRecord {
  readonly scopeToken: object;
  readonly source: ActivitySource | undefined;
  readonly key: string;
  readonly expanded: boolean;
  readonly sequence: number;
}

class ActivityDetailShellController implements ActivityDetailShell {
  private readonly registry: ActivityRegistry;
  private readonly scope: HostScope;
  private readonly tui: ActivityTuiBindings;
  private readonly closedCallback: (() => void) | undefined;

  private surface: ActivityDetailSurface | undefined;
  private mounted = false;
  private tooSmallPending = false;
  private disposed = false;

  private shellEntries: ActivityRow[] = [];
  private staleKeys = new Set<string>();
  private selected: string | undefined;
  private selectionIndex = 0;
  private expandedState = false;

  private requestSequence = 0;
  private currentRequest: DetailRequestRecord | undefined;
  private component: DetailComponent | undefined;
  private requestInFlight = false;
  private requestFailed = false;
  private lastBodyLines: string[] = [];
  private lastRenderWidth = 0;

  private viewportStart = 0;
  private autoFollowState = true;

  constructor(deps: ActivityDetailShellDeps) {
    this.registry = deps.registry;
    this.scope = deps.scope;
    this.tui = deps.tui;
    this.closedCallback = deps.onClosed;
  }

  get state(): ActivityDetailState {
    if (this.mounted) {
      return this.requestInFlight && !this.component ? "loading" : "open";
    }
    return this.tooSmallPending ? "too-small" : "closed";
  }

  isMounted(): boolean {
    return this.mounted;
  }

  expanded(): boolean {
    return this.expandedState;
  }

  selectedKey(): string | undefined {
    return this.selected;
  }

  entries(): readonly ActivityRow[] {
    return this.shellEntries;
  }

  open(surface: ActivityDetailSurface): void {
    if (this.disposed || this.mounted) return;
    this.mounted = true;
    this.tooSmallPending = false;
    this.surface = surface;
    this.refreshEntries();
    this.reconcileSelection();
    this.requestDetail();
    this.requestRenderNow();
  }

  markTooSmall(): void {
    if (this.disposed || this.mounted) return;
    this.tooSmallPending = true;
  }

  close(): void {
    if (!this.mounted) return;
    this.mounted = false;
    const surface = this.surface;
    this.surface = undefined;
    // fence 后置：关闭后仍在途的请求 resolve 时按 record !== currentRequest 丢弃。
    this.currentRequest = undefined;
    this.requestInFlight = false;
    this.requestFailed = false;
    this.disposeCurrentComponent();
    this.lastBodyLines = [];
    try {
      surface?.done();
    } catch {
      // done 异常不向调用方传播。
    }
    const callback = this.closedCallback;
    if (callback) {
      try {
        callback();
      } catch {
        // 关闭回调异常隔离，不向输入路径传播。
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.close();
  }

  handleRegistryInvalidated(): void {
    this.refreshEntries();
    this.reconcileSelection();
    if (!this.mounted) return;
    // source 数据变化或同 kind source 对象替换：即使 key 不变也按当前 source 重新请求。
    this.requestDetail();
    this.requestRenderNow();
  }

  handleThemeChange(): void {
    // 主题/全局缓存变化：先让 provider 组件清理自身 display 缓存，再重取详情；
    // 重取与替换期间保留 scroll anchor。
    try {
      this.component?.invalidate?.();
    } catch {
      // provider invalidate 异常隔离。
    }
    if (!this.mounted) return;
    this.requestDetail();
    this.requestRenderNow();
  }

  invalidate(): void {
    // TUI Component 契约：主题变化等全局失效会调用本方法，按主题变化路径处理。
    this.handleThemeChange();
  }

  position(): { start: number; end: number; total: number; autoFollow: boolean } {
    const { height, lineCount } = this.scrollBounds();
    const maxStart = Math.max(0, lineCount - height);
    const start = this.autoFollowState
      ? maxStart
      : Math.max(0, Math.min(this.viewportStart, maxStart));
    const end = Math.min(lineCount, start + height);
    return {
      start: lineCount === 0 ? 0 : start + 1,
      end,
      total: lineCount,
      autoFollow: this.autoFollowState,
    };
  }

  render(width: number): string[] {
    const safeWidth = normalizeWidth(width);
    this.lastRenderWidth = safeWidth;
    const rows = this.readTerminalRows();
    // terminalRows-4 已为 overlay 下方详情 footer（最多 3 行 + separator）预留，
    // 正文不得再扣同一 footer；标题行只按实际输出行数扣减。
    const bodyBudget = Math.max(0, rows - DETAIL_RESERVED_BOTTOM_ROWS);
    if (bodyBudget <= 0) {
      // 打开中终端过小：正文 0 行（不产生负高度），关闭输入仍由 handleInput 处理。
      return [];
    }
    const theme = this.surface?.theme;
    const headerLines = this.renderHeaderLines(safeWidth, bodyBudget, theme);
    const bodyHeight = Math.max(0, bodyBudget - headerLines.length);
    const bodyLines = this.renderBodyLines(safeWidth, bodyHeight);
    return [...headerLines, ...bodyLines];
  }

  handleInput(data: string): { consume: boolean } | undefined {
    if (!this.mounted) return undefined;
    const tui = this.tui;
    const wheel = parseSgrWheelDirection(data);
    if (wheel !== undefined) {
      this.scrollLines(wheel);
      return CONSUME_INPUT;
    }
    const repeat = tui.isKeyRepeat(data);
    if (tui.isKeyRelease(data)) return CONSUME_INPUT; // release 一律忽略（consume 但无动作）
    if (tui.matchesKey(data, tui.Key.alt("o"))) {
      if (!repeat) this.close();
      return CONSUME_INPUT;
    }
    if (tui.matchesKey(data, tui.Key.escape)) {
      // Esc 只关闭且恒 consume，不向恢复后的 editor 传播；repeat 仅重复导航，不重复关闭。
      if (!repeat) this.close();
      return CONSUME_INPUT;
    }
    if (tui.matchesKey(data, tui.Key.left)) {
      this.navigate(-1);
      return CONSUME_INPUT;
    }
    if (tui.matchesKey(data, tui.Key.right)) {
      this.navigate(1);
      return CONSUME_INPUT;
    }
    if (tui.matchesKey(data, tui.Key.up) || tui.matchesKey(data, "k")) {
      this.scrollLines(-1);
      return CONSUME_INPUT;
    }
    if (tui.matchesKey(data, tui.Key.down) || tui.matchesKey(data, "j")) {
      this.scrollLines(1);
      return CONSUME_INPUT;
    }
    if (tui.matchesKey(data, tui.Key.pageUp)) {
      this.scrollPage(-1);
      return CONSUME_INPUT;
    }
    if (tui.matchesKey(data, tui.Key.pageDown)) {
      this.scrollPage(1);
      return CONSUME_INPUT;
    }
    if (tui.matchesKey(data, tui.Key.home)) {
      this.scrollHome();
      return CONSUME_INPUT;
    }
    if (tui.matchesKey(data, tui.Key.end)) {
      this.scrollEnd();
      return CONSUME_INPUT;
    }
    if (tui.matchesKey(data, "x")) {
      // repeat 仅重复导航：按住 x 不应连续切换展开状态。
      if (!repeat) this.toggleExpanded();
      return CONSUME_INPUT;
    }
    return CONSUME_INPUT; // 未知键吞掉
  }

  // —— 内部：条目与选择 ——

  private refreshEntries(): void {
    const entries: ActivityRow[] = [];
    const seen = new Set<string>();
    const staleKeys = new Set<string>();
    let rows: unknown;
    try {
      rows = this.registry.snapshot();
    } catch {
      rows = [];
    }
    if (Array.isArray(rows)) {
      for (const row of rows as ActivityRow[]) {
        if (!row || typeof row.key !== "string" || seen.has(row.key)) continue;
        seen.add(row.key);
        entries.push(row);
      }
    }
    // stale 观察独立分组：registry.snapshot() 已排除非 available 行，这里按 kind 顺序
    // 从 sourceSnapshot 补回 stale 的上次观察行（身份仍是稳定 key，可导航进详情）。
    for (const kind of ACTIVITY_KIND_ORDER) {
      let snapshot: ActivitySnapshot | undefined;
      try {
        snapshot = this.registry.sourceSnapshot(kind);
      } catch {
        snapshot = undefined;
      }
      if (!snapshot || snapshot.availability !== "stale") continue;
      for (const row of snapshot.rows) {
        if (!row || typeof row.key !== "string" || seen.has(row.key)) continue;
        seen.add(row.key);
        staleKeys.add(row.key);
        entries.push(row);
      }
    }
    this.shellEntries = entries;
    this.staleKeys = staleKeys;
  }

  private reconcileSelection(): void {
    const entries = this.shellEntries;
    const index = entries.findIndex((entry) => entry.key === this.selected);
    if (index !== -1) {
      this.selectionIndex = index;
      return;
    }
    if (entries.length === 0) {
      if (this.selected !== undefined) {
        this.selected = undefined;
        this.disposeCurrentComponent();
        this.resetScroll();
      }
      this.selectionIndex = 0;
      return;
    }
    // stable key 消失：按上次索引钳制选择相邻项，不按标题复活。
    const nextIndex = Math.max(0, Math.min(this.selectionIndex, entries.length - 1));
    const next = entries[nextIndex];
    this.selectionIndex = nextIndex;
    if (next.key !== this.selected) {
      this.selected = next.key;
      this.disposeCurrentComponent();
      this.requestFailed = false;
      this.resetScroll();
    }
  }

  private currentEntry(): ActivityRow | undefined {
    const key = this.selected;
    if (!key) return undefined;
    return this.shellEntries.find((entry) => entry.key === key);
  }

  private navigate(direction: -1 | 1): void {
    const entries = this.shellEntries;
    if (entries.length === 0) {
      this.requestRenderNow();
      return;
    }
    let index = entries.findIndex((entry) => entry.key === this.selected);
    if (index === -1) index = 0;
    index = Math.max(0, Math.min(entries.length - 1, index + direction));
    this.selectEntry(entries[index].key);
  }

  private selectEntry(key: string): void {
    if (key === this.selected) {
      this.requestRenderNow();
      return;
    }
    this.selected = key;
    const index = this.shellEntries.findIndex((entry) => entry.key === key);
    this.selectionIndex = Math.max(0, index);
    // 跨条目切换：旧组件立即 dispose 一次，滚动回到跟随底部。
    this.disposeCurrentComponent();
    this.requestFailed = false;
    this.resetScroll();
    this.requestDetail();
    this.requestRenderNow();
  }

  private toggleExpanded(): void {
    this.expandedState = !this.expandedState;
    // x 改变 expanded：同 key 新 request 重取；旧组件保留到新组件到达，anchor 保持。
    this.requestDetail();
    this.requestRenderNow();
  }

  // —— 内部：详情请求生命周期 ——

  private requestDetail(): void {
    this.requestSequence += 1;
    const key = this.selected;
    const source = key ? safeSourceFor(this.registry, key) : undefined;
    const record: DetailRequestRecord = {
      scopeToken: this.scope.token,
      source,
      key: key ?? "",
      expanded: this.expandedState,
      sequence: this.requestSequence,
    };
    this.currentRequest = record;
    if (!key || !source) {
      this.requestInFlight = false;
      this.requestFailed = false;
      return;
    }
    this.requestInFlight = true;
    this.requestFailed = false;
    let promise: Promise<DetailComponent | undefined>;
    try {
      const request = Object.freeze({
        expanded: this.expandedState,
        requestRender: () => {
          this.requestRenderNow();
        },
      });
      promise = Promise.resolve(source.detail(key, request));
    } catch {
      this.settleFailure(record);
      return;
    }
    promise.then(
      (component) => {
        this.settleSuccess(record, component);
      },
      () => {
        this.settleFailure(record);
      },
    );
  }

  private settleSuccess(record: DetailRequestRecord, component: DetailComponent | undefined): void {
    if (
      this.disposed ||
      !this.mounted ||
      record !== this.currentRequest ||
      record.scopeToken !== this.scope.token
    ) {
      // 晚回/过期请求（selection/source/sequence/token 任一不匹配）：组件只 dispose
      // 一次并丢弃，不覆盖当前选择。
      this.disposeComponentOnce(component);
      return;
    }
    if (component !== this.component) {
      // 新组件替换旧组件（含 source 合法返回 undefined：不保留过期展示），旧组件
      // dispose 一次；同一对象重复 resolve 不重复 dispose。
      this.disposeComponentOnce(this.component);
      this.component = component;
      this.lastBodyLines = [];
    }
    this.requestInFlight = false;
    this.requestFailed = false;
    this.clampViewport();
    this.requestRenderNow();
  }

  private settleFailure(record: DetailRequestRecord): void {
    if (
      this.disposed ||
      !this.mounted ||
      record !== this.currentRequest ||
      record.scopeToken !== this.scope.token
    ) {
      return;
    }
    this.requestInFlight = false;
    // 失败时保留已确认组件继续展示；无可展示组件时正文显示固定类别失败文案。
    this.requestFailed = true;
    this.requestRenderNow();
  }

  private disposeComponentOnce(component: DetailComponent | undefined): void {
    if (!component) return;
    try {
      component.dispose?.();
    } catch {
      // dispose 异常隔离。
    }
  }

  private disposeCurrentComponent(): void {
    this.disposeComponentOnce(this.component);
    this.component = undefined;
    this.lastBodyLines = [];
  }

  // —— 内部：viewport（根自有，支持 bodyRows 0）——

  private readTerminalRows(): number {
    // surface 由 presenter 注入的 TUI 端口提供；读取异常/缺省按 0 行处理（不产生负高度）。
    let rows: number | undefined;
    try {
      rows = this.surface?.getTerminalRows?.();
    } catch {
      rows = undefined;
    }
    return typeof rows === "number" && Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
  }

  private scrollBounds(): { height: number; lineCount: number } {
    const rows = this.readTerminalRows();
    const bodyBudget = Math.max(0, rows - DETAIL_RESERVED_BOTTOM_ROWS);
    // 标题只剩滚动信息 1 行，且无条目时不留行（与 renderHeaderLines 的实际行数一致）。
    const headerRows = bodyBudget >= 1 && this.shellEntries.length > 0 ? 1 : 0;
    const height = Math.max(0, bodyBudget - headerRows);
    const lineCount = Math.max(0, this.bodyContent(this.lastRenderWidth).length);
    return { height, lineCount };
  }

  private clampViewport(): void {
    const { height, lineCount } = this.scrollBounds();
    const maxStart = Math.max(0, lineCount - height);
    this.viewportStart = Math.max(0, Math.min(this.viewportStart, maxStart));
  }

  private resetScroll(): void {
    this.viewportStart = 0;
    this.autoFollowState = true;
  }

  private scrollLines(delta: number): void {
    const { height, lineCount } = this.scrollBounds();
    const maxStart = Math.max(0, lineCount - height);
    if (height <= 0) {
      this.requestRenderNow();
      return;
    }
    const start = this.autoFollowState ? maxStart : this.viewportStart;
    this.viewportStart = Math.max(0, Math.min(maxStart, start + delta));
    this.autoFollowState = this.viewportStart === maxStart;
    this.requestRenderNow();
  }

  private scrollPage(direction: -1 | 1): void {
    const { height, lineCount } = this.scrollBounds();
    const maxStart = Math.max(0, lineCount - height);
    if (height <= 0) {
      this.requestRenderNow();
      return;
    }
    const start = this.autoFollowState ? maxStart : this.viewportStart;
    this.viewportStart = Math.max(0, Math.min(maxStart, start + direction * height));
    this.autoFollowState = this.viewportStart === maxStart;
    this.requestRenderNow();
  }

  private scrollHome(): void {
    const { height, lineCount } = this.scrollBounds();
    const maxStart = Math.max(0, lineCount - height);
    this.viewportStart = 0;
    this.autoFollowState = maxStart === 0;
    this.requestRenderNow();
  }

  private scrollEnd(): void {
    const { height, lineCount } = this.scrollBounds();
    const maxStart = Math.max(0, lineCount - height);
    this.viewportStart = maxStart;
    this.autoFollowState = true;
    this.requestRenderNow();
  }

  private requestRenderNow(): void {
    if (!this.mounted) return;
    try {
      this.surface?.requestRender?.();
    } catch {
      // 渲染请求异常隔离。
    }
  }

  // —— 内部：渲染 ——

  /**
   * overlay 内公共标题：只有滚动信息 1 行。
   * 身份行（`› glyph label · state · metaLabel`）整条删除（展示层精简）：同一事实搬到
   * footer——glyph/label/state 由活动 footer 的 entry 块（layout.ts）与详情 footer 首行
   * （presenter.renderDetailFooterLines）承载，模型/thinking 也由该首行追加 `· metaLabel`
   * 承载（行字段只作只读展示投影，不进 raw/session）。
   * 空态（无条目）不给标题留行，把整块预算让给正文的「当前无后台活动」（footer 另有一行
   * 空态提示），因此小终端下正文预算不被标题侵占。
   * `过期观察` 仍保留在本行：footer 的 stale/unavailable 独立状态行只在主视图 footer 出现，
   * 详情 overlay 打开时 footer 切换为详情模式，故该事实必须在 overlay 内可见。
   */
  private renderHeaderLines(width: number, bodyBudget: number, theme: ActivityTheme | undefined): string[] {
    if (bodyBudget < 1 || this.shellEntries.length === 0) return [];
    const position = this.position();
    const follow = position.autoFollow ? "跟随底部" : "手动滚动";
    const entry = this.currentEntry();
    const stale = entry !== undefined && this.staleKeys.has(entry.key) ? " · 过期观察" : "";
    return [
      renderActivityDetailTextLine(
        `行 ${position.start}-${position.end}/${position.total} · ${follow} · x ${
          this.expandedState ? "收起" : "展开"
        }${stale}`,
        width,
        theme,
        this.tui,
      ),
    ];
  }

  private renderBodyLines(width: number, height: number): string[] {
    if (height <= 0) return [];
    const content = this.bodyContent(width);
    const maxStart = Math.max(0, content.length - height);
    const start = this.autoFollowState
      ? maxStart
      : Math.max(0, Math.min(this.viewportStart, maxStart));
    this.viewportStart = start;
    const visible = content.slice(start, start + height);
    const padded = visible.map((line) => this.padBodyLine(line, width));
    // 顶部对齐：正文不足高度时在下方补空行，保持 overlay 面板完整覆盖。
    while (padded.length < height) padded.push(this.padBodyLine("", width));
    return padded;
  }

  private bodyContent(width: number): string[] {
    if (!this.selected) {
      return this.shellEntries.length ? ["该任务暂无详情"] : ["当前无后台活动"];
    }
    const component = this.component;
    if (component) {
      try {
        const lines = component.render(width);
        if (Array.isArray(lines)) {
          if (lines.length > 0) {
            this.lastBodyLines = lines;
            return lines;
          }
          return ["该任务暂无详情"];
        }
      } catch {
        // provider render 瞬态失败：保留上次确认行，不改 raw。
      }
      return this.lastBodyLines;
    }
    if (this.requestInFlight) return ["加载中…"];
    if (this.requestFailed) return ["详情读取失败"];
    return ["该任务暂无详情"];
  }

  private padBodyLine(line: string, width: number): string {
    const safeLine = typeof line === "string" ? line : "";
    try {
      const truncated = width > 0 ? this.tui.truncateToWidth(safeLine, width) : "";
      const padding = Math.max(0, width - this.tui.visibleWidth(truncated));
      return `${truncated}${" ".repeat(padding)}`;
    } catch {
      return safeLine;
    }
  }
}

/** 创建持久详情壳 controller；presenter 负责挂载 Component 包装与 editor/draft 恢复。 */
export function createActivityDetailShell(deps: ActivityDetailShellDeps): ActivityDetailShell {
  return new ActivityDetailShellController(deps);
}
