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
// - 高度模型：overlay 下方详情 footer 的 reserve 由 footer 实际行数动态推导（状态行 +
//   metaLabel 组合行的换行行数 + 首行/提示行固定 2 行 chrome + separator），正文不再使用
//   固定 terminalRows-4 预算；overlay 内公共标题行整块删除（位置事实改由 footer 首行右侧
//   的 `行 start-end/total` 承载），正文预算不再扣标题行；根自有 viewport 支持 bodyRows 0
//   （terminalRows<=4 时正文为空、位置读作 `0-0/total`、关闭输入仍可用、不产生负高度），
//   不改 package 既有 session-viewport 的至少 1 行合同。
// - 输入全部消费在壳内：Alt+O/Esc 只关闭且不向恢复后的 editor 传播；left/right 选项导航；
//   up/down/j/k/page/home/end/wheel 正文滚动；release 忽略、repeat 仅重复导航、未知键吞掉。
//   editor/draft 的获取与恢复归 presenter（错误隔离），壳本身不触碰 editor。
// - navigation 覆盖 registry.snapshot() 的 main+recent（含 recent 全量，不受主视图历史
//   折叠上限影响）并追加 stale 观察独立分组；身份只认稳定 key，key 消失选择相邻项或
//   空状态，不按标题复活；同 kind source 对象替换后即使同 key 也按新 source 发起新请求。

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type {
  ActivityRegistry,
  ActivityRow,
  ActivitySnapshot,
  ActivitySource,
  DetailComponent,
  HostScope,
} from "pi-subagents-enhanced/tui/background-activity";
import { ACTIVITY_KIND_GLYPHS, ACTIVITY_KIND_ORDER } from "./layout.ts";
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
  /** 详情 footer 的同源换行结果；presenter 与 overlay reserve 共用该事实。 */
  renderFooter(width: number, theme?: ActivityTheme): string[];
  /** 当前 footer 实际行数 + separator 的动态 overlay/body reserve。 */
  footerReservedBottomRows(): number;
  handleInput(data: string): { consume: boolean } | undefined;
  /** Pi 1.3 fullscreen：`TuiAltScreen` 只对 overlay 调 `handleMouse`，滚轮不再走 raw 输入。 */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
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

/**
 * 详情 footer 固定 chrome 行数：首行（条目身份 + 右对齐位置事实）与提示行（x 展开/收起 +
 * 导航关闭说明）。两行均恒为单行、不参与换行展开，因此 footer 行数只由状态行与 metaLabel
 * 组合行的换行行数决定，位置事实不会反向影响行数（无需迭代求解）。
 */
const DETAIL_FOOTER_CHROME_ROWS = 2;

/**
 * 运行态显示判定：中文「运行中」与 bash_async 行自报的 raw `running` 都算运行态。
 * 只用于显示投影（footer 状态行隐藏 + 正文状态行过滤），不改 raw 行对象/快照。
 */
function isRunningStateLabel(stateLabel: unknown): boolean {
  if (typeof stateLabel !== "string") return false;
  const normalized = stateLabel.trim().toLowerCase();
  return normalized === "运行中" || normalized === "running";
}

/**
 * 正文运行态状态行的显示层判定：`[kind · ]运行中`（可带 `状态：` 前缀与括号注释）或
 * `running` 开头的行，含运行态说明行（provider 只提供原文，清理后才做匹配）。
 * 仅当选中行本身是运行态时应用（见 visibleBodyLines）；其它状态行保留。
 */
const RUNNING_STATUS_LINE_PATTERN = /^(?:[^\s·]{1,32}\s*·\s*)?(?:状态\s*[:：]\s*)?(?:运行中|running)/i;

/**
 * 详情 footer 组合元数据的段模式：只承认已证实的 `formatChildModelLabel` 输出形态
 * （`模型 (provider) model` 与 `thinking: value`），以及已经处于 `provider/model` 的
 * 模型段。不做广泛猜测，未命中的段原样显示。
 */
const DETAIL_META_SEPARATOR = " · ";
const DETAIL_META_MODEL_PAREN_PATTERN = /^模型\s+\(([^()\s]+)\)\s+(\S.*)$/;
const DETAIL_META_MODEL_SLASH_PATTERN = /^模型\s+(\S*\/\S*)$/;
const DETAIL_META_THINKING_PATTERN = /^thinking\s*[:：]\s*(\S.*)$/i;

/**
 * 详情层显示投影：`模型 (codex-pool) gpt-6-astra · thinking: xhigh` →
 * `codex-pool/gpt-6-astra · xhigh`。仅转换首个模型段与 `thinking:` 段的标签，其余段
 * （如 context usage）原样保留，分隔符与换行行为不变；不改 `ActivityRow.metaLabel`、
 * 不改 raw/session 数据，也不影响主 footer。
 */
export function projectActivityDetailMetaText(metaLabel: string): string {
  if (typeof metaLabel !== "string" || metaLabel === "") return metaLabel;
  let modelProjected = false;
  return metaLabel
    .split(DETAIL_META_SEPARATOR)
    .map((segment) => {
      if (!modelProjected) {
        const paren = DETAIL_META_MODEL_PAREN_PATTERN.exec(segment);
        if (paren) {
          modelProjected = true;
          return `${paren[1]}/${paren[2]}`;
        }
        const slashed = DETAIL_META_MODEL_SLASH_PATTERN.exec(segment);
        if (slashed) {
          modelProjected = true;
          return slashed[1];
        }
      }
      const thinking = DETAIL_META_THINKING_PATTERN.exec(segment);
      return thinking ? thinking[1] : segment;
    })
    .join(DETAIL_META_SEPARATOR);
}

const DETAIL_GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function clipDetailGraphemes(text: string, width: number): string {
  let result = "";
  let used = 0;
  for (const { segment } of DETAIL_GRAPHEME_SEGMENTER.segment(text)) {
    const segmentWidth = visibleWidth(segment);
    if (used + segmentWidth > width) break;
    result += segment;
    used += segmentWidth;
  }
  return result;
}

/** 清理后按终端列换行；不可容纳的单字素在极窄宽度下安全省略。 */
export function renderActivityDetailTextLines(
  text: string,
  width: number,
  theme: ActivityTheme | undefined,
  tui: ActivityTuiBindings,
): string[] {
  const cleaned = toActivityDisplayText(text, tui);
  const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (safeWidth <= 0) return [];
  const wrapped = wrapTextWithAnsi(cleaned, safeWidth).map((line) =>
    visibleWidth(line) <= safeWidth ? line : clipDetailGraphemes(line, safeWidth),
  );
  const lines = wrapped.length > 0 ? wrapped : [""];
  return theme ? lines.map((line) => theme.fg("dim", line)) : lines;
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
  private lastFooterWidth = 0;
  /**
   * 上次实际渲染的 footer 行数（固定 chrome 2 行 + 状态行/metaLabel 组合行的换行行数）；
   * 首帧前按「chrome 2 行 + 1 行动态内容」保守预留。
   */
  private lastFooterRows = DETAIL_FOOTER_CHROME_ROWS + 1;

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
    // 关闭态未选择时不提前设置默认值：session_start 当帧/500ms reconcile/事件刷新
    // 都会走到这里，若此时播种 entries[0]，而列表顺序随后变化（run 完成转 recent
    // 段尾部等）会把该默认项推到末位。首次打开按当时顺序取首项（open 内仍会对齐）。
    if (!this.mounted && this.selected === undefined) {
      this.selectionIndex = 0;
      return;
    }
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

  footerReservedBottomRows(): number {
    return Math.max(1, this.lastFooterRows + 1);
  }

  renderFooter(width: number, theme?: ActivityTheme): string[] {
    const safeWidth = normalizeWidth(width);
    this.lastFooterWidth = safeWidth;
    if (safeWidth <= 0) {
      this.lastFooterRows = 0;
      return [];
    }
    const entries = this.shellEntries;
    const index = entries.findIndex((entry) => entry.key === this.selected);
    const entry = index === -1 ? undefined : entries[index];
    const stateLabel = typeof entry?.stateLabel === "string" ? entry.stateLabel.trim() : "";
    // 运行中在详情任何位置都不再重复；其它状态（失败、完成等）保留独立一行。
    const stateLines =
      stateLabel !== "" && !isRunningStateLabel(stateLabel)
        ? renderActivityDetailTextLines(stateLabel, safeWidth, theme, this.tui)
        : [];
    // 详情层只做显示转换（`模型 (provider) model · thinking: level` → `provider/model · level`），
    // ActivityRow.metaLabel 与主 footer 保持原样。
    const metaText = typeof entry?.metaLabel === "string" ? projectActivityDetailMetaText(entry.metaLabel.trim()) : "";
    // 组合元数据整段换行（`provider/model · level · contextUsage` 不按分隔符拆行）：
    // 窄终端按终端列完整换行，不省略模型信息。
    const metaLines = metaText !== ""
      ? renderActivityDetailTextLines(metaText, safeWidth, theme, this.tui)
      : [];
    // 动态部分只有状态行与 metaLabel 组合行，二者行数只由文本自身换行决定；首行与提示行
    // 恒为单行，所以 footer 总行数不依赖位置事实，无需迭代求解。
    this.lastFooterRows = DETAIL_FOOTER_CHROME_ROWS + stateLines.length + metaLines.length;
    const position = this.positionForFooterRows(safeWidth, this.lastFooterRows);
    // 顶部滚动信息行删除后，stale 事实仍须在 overlay 内可见：并入合并提示行（前移，窄宽
    // 截断时仍优先可见）。
    const stale = entry !== undefined && this.staleKeys.has(entry.key) ? " · 过期观察" : "";
    return [
      this.renderFooterIdentityLine(entries, index, safeWidth, theme, position),
      ...stateLines,
      ...metaLines,
      renderActivityDetailTextLine(
        `x ${this.expanded() ? "收起" : "展开"}${stale} · ‹ › 切换任务 · ↑↓ jk 滚动 · PgUp/PgDn/Home/End 翻页 · Esc/Alt+O 关闭`,
        safeWidth,
        theme,
        this.tui,
      ),
    ];
  }

  /**
   * footer 首行：左侧条目身份（`n/N glyph label`，空态为固定文案），右侧以可见列宽计算
   * 的右对齐位置事实 `行 start-end/total`（贴住终端右边界）。该行恒为 1 行：空间不足时
   * 只截断身份文本（位置事实优先保留），不换行，因此不改变 footer 行数。
   */
  private renderFooterIdentityLine(
    entries: readonly ActivityRow[],
    index: number,
    width: number,
    theme: ActivityTheme | undefined,
    position: { start: number; end: number; total: number },
  ): string {
    const positionText = toActivityDisplayText(
      `行 ${position.start}-${position.end}/${position.total}`,
      this.tui,
    );
    const positionWidth = this.tui.visibleWidth(positionText);
    // 极窄终端退化分支：位置事实独占该行（仍不另起一行），身份文本不占列。
    if (positionWidth + 1 >= width) {
      return renderActivityDetailTextLine(positionText, width, theme, this.tui);
    }
    const identity =
      index === -1
        ? "当前无后台活动"
        : `${index + 1}/${entries.length} ${ACTIVITY_KIND_GLYPHS[entries[index].kind] ?? "◇"} ${entries[index].label}`;
    const cleanedIdentity = toActivityDisplayText(identity, this.tui);
    const available = width - positionWidth - 1;
    const fitted =
      this.tui.visibleWidth(cleanedIdentity) <= available
        ? cleanedIdentity
        : this.tui.truncateToWidth(cleanedIdentity, available, "…");
    const gap = Math.max(1, width - this.tui.visibleWidth(fitted) - positionWidth);
    const line = `${fitted}${" ".repeat(gap)}${positionText}`;
    return theme ? theme.fg("dim", line) : line;
  }

  private positionForFooterRows(width: number, footerRows: number): { start: number; end: number; total: number; autoFollow: boolean } {
    const bodyBudget = Math.max(0, this.readTerminalRows() - Math.max(1, footerRows + 1));
    // 顶部滚动信息行已删除：正文预算不再扣标题行（空态/过小终端行为不变）。
    const height = bodyBudget;
    const lineCount = Math.max(0, this.bodyContent(width).length);
    if (height <= 0) {
      // 正文 0 行时不报越界样式（`5-4/4`）：位置恒读作 `0-0/total`。
      return { start: 0, end: 0, total: lineCount, autoFollow: this.autoFollowState };
    }
    const maxStart = Math.max(0, lineCount - height);
    const start = this.autoFollowState ? maxStart : Math.max(0, Math.min(this.viewportStart, maxStart));
    const end = Math.min(lineCount, start + height);
    return { start: lineCount === 0 ? 0 : start + 1, end, total: lineCount, autoFollow: this.autoFollowState };
  }

  position(): { start: number; end: number; total: number; autoFollow: boolean } {
    return this.positionForFooterRows(this.lastRenderWidth || this.lastFooterWidth, this.lastFooterRows);
  }

  render(width: number): string[] {
    const safeWidth = normalizeWidth(width);
    this.lastRenderWidth = safeWidth;
    const rows = this.readTerminalRows();
    const theme = this.surface?.theme;
    this.renderFooter(safeWidth, theme);
    // overlay 下方的详情 footer 与 separator 使用同一动态 reserve；正文不得再扣第二套固定预算。
    const bodyBudget = Math.max(0, rows - this.footerReservedBottomRows());
    if (bodyBudget <= 0) {
      // 打开中终端过小：正文 0 行（不产生负高度），关闭输入仍由 handleInput 处理。
      return [];
    }
    // 顶部滚动信息行已删除：正文独占整个 bodyBudget，位置事实由 footer 首行右侧承载。
    return this.renderBodyLines(safeWidth, bodyBudget);
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

  /**
   * Pi 1.3 fullscreen 滚轮入口：`TuiAltScreen` 把 SGR 滚轮解析成归一化 mouse wheel 事件后
   * 只调用 overlay 组件的 `handleMouse`（raw SGR 不会进入 `handleInput`）。按事件真实
   * `wheelDelta` 行数滚正文，返回 handled 阻止渲染器把同一滚轮再交给底层 primary ScrollView
   * （避免双滚）。非 wheel 事件不消费；MainScreen 的 raw SGR 分支仍在 handleInput 中保留。
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.mounted || event.type !== "wheel") return undefined;
    const delta = event.wheelDelta;
    if (typeof delta !== "number" || !Number.isFinite(delta)) return undefined;
    const lines = Math.trunc(delta);
    if (lines === 0) return undefined;
    this.scrollLines(lines);
    return { handled: true };
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
    if (this.lastRenderWidth > 0) this.renderFooter(this.lastRenderWidth, this.surface?.theme);
    const bodyBudget = Math.max(0, rows - this.footerReservedBottomRows());
    // 顶部滚动信息行已删除：正文高度 = bodyBudget（与 render/positionForFooterRows 同源）。
    const height = bodyBudget;
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
   * 正文显示投影：选中行处于运行态时过滤掉运行态状态行/说明行（`运行中`/`running`），
   * 其它状态（失败、完成等）与所有内容行原样保留；raw 行对象、provider 行数组、快照不变。
   */
  private visibleBodyLines(lines: readonly string[]): string[] {
    const entry = this.currentEntry();
    if (entry === undefined || !isRunningStateLabel(entry.stateLabel)) return [...lines];
    return lines.filter(
      (line) => !RUNNING_STATUS_LINE_PATTERN.test(toActivityDisplayText(line, this.tui).trim()),
    );
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
            return this.visibleBodyLines(lines);
          }
          return ["该任务暂无详情"];
        }
      } catch {
        // provider render 瞬态失败：保留上次确认行，不改 raw。
      }
      return this.visibleBodyLines(this.lastBodyLines);
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
