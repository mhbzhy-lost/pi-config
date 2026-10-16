// 统一后台活动区纯布局（统一执行计划 F5a / footer 子计划 T5a；显示合同按
// docs/plans/2026-10-15-runtime-closeout.md §2 于 F1 冻结修订）。
//
// 本模块只做纯显示投影，供 F5b 详情壳/presenter 消费，精确公开签名：
// - renderActivityRows(rows, width, selection?, theme?): string[]
//     通用 activity 条目渲染：单选择 cell + 公共 glyph cell + 1 列 gap 的统一左基线，
//     标题列 = 3 + 公共 glyph 宽（1-indexed）；状态是本帧公共右列（右边界 = width），
//     按 visibleWidth 词边界优先换行（续行对齐标题列、不保留断点空格），width 0/1
//     不越界；输入行先按类型固定顺序稳定排序（同类型内保持给定顺序）。
// - renderActivityLayout(input): ActivityLayoutResult
//     主视图 footer 工厂：元数据先连续渲染（第一行 cwd 左/context 右；第二元数据行
//     provider/model 左 + thinking 右，放不下时分别换行且均从 col1 共同左基线开始，
//     不留空 activity 槽），活动区全部在元数据之后连续绘制；recent 只折叠为单行
//     `◯ recent N` 提示；stale/unavailable source 显示独立状态行，旧行不进入主视图、
//     不计入 main/recent 数量；主视图物理行预算 max(0, terminalRows-6)，预算紧时按
//     每 kind 首个完整 block 的公平策略填充，超出时最后一行显示「还有 N 项 · Alt+O」。
// - computeActivityGeometry(input): ActivityGeometry
//     宽高预算元数据：主视图预算 terminalRows-6、详情静态 viewport reserve 4、
//     详情 bodyRows=max(0, terminalRows-4)、tooSmall（terminalRows<=4，F5b 不得挂载
//     详情 overlay，保留 footer 入口与 draft）。
//
// 边界：不调用 setFooter、不注册快捷键、不读取 session/store/settings，不产生任务
// 语义；空 main 不虚构任务。所有清理/截断/换行只生成新显示串，绝不写回 ActivityRow、
// ActivityFooterMeta 等 raw 输入。宽高测量一律使用 pi-tui 公开工具
// visibleWidth/wrapTextWithAnsi/truncateToWidth（字素 segmenter 仅用于单字素宽于极小
// budget 的明确降级边界），禁止用字符串 length 计算终端列，不另造 ANSI parser。
// 所有定义集中在本文件，未经批准不新建 module。

import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
  ActivityAvailability,
  ActivityKind,
  ActivityPlacement,
  ActivityRow,
} from "pi-subagents-enhanced/tui/background-activity";

/** 显示主题最小端口；SDK Theme（fg(color: ThemeColor, text)）结构兼容，测试可用 fixture 替身。 */
export type ActivityTheme = Readonly<{
  fg(color: string, text: string): string;
}>;

/**
 * 类型图标映射：图标只表类型，不表成功/失败事实；状态是独立文字列。
 * 图标列宽度一律按 visibleWidth 计算，不写死列宽。
 */
export const ACTIVITY_KIND_GLYPHS: Readonly<Record<ActivityKind, string>> = Object.freeze({
  subagent: "●",
  bash_async: "⌘",
  scheduler: "⏱",
});

/** 类型固定顺序：subagent → bash_async → scheduler；同类型内保持 source 稳定顺序。 */
export const ACTIVITY_KIND_ORDER: readonly ActivityKind[] = Object.freeze([
  "subagent",
  "bash_async",
  "scheduler",
]);

/** recent 汇总行图标（不是任务类型，也不可选）。 */
export const RECENT_GLYPH = "◯";

/** 主视图物理行预算 = max(0, terminalRows - MAIN_VIEW_RESERVED_BOTTOM_ROWS)。 */
export const MAIN_VIEW_RESERVED_BOTTOM_ROWS = 6;

/** 详情模式静态 viewport reserve（overlay margin.bottom=4），恒为 4，不依赖每帧函数。 */
export const DETAIL_RESERVED_BOTTOM_ROWS = 4;

/** 详情模式 footer 导航行上限（详情壳 footer 固定最多 3 行）。 */
export const DETAIL_FOOTER_MAX_ROWS = 3;

/** terminalRows <= 该值时详情 overlay 不挂载（F5b 负责保留 footer 入口与 draft）。 */
export const TOO_SMALL_TERMINAL_ROWS = 4;

// 列布局常量（§2 冻结网格）：选择标记占 col1 单 cell（选中 `›`、未选中空格），类型图标
// 从 col2 开始并补空格到公共 glyph cell，随后 1 列 gap；标题列 = 3 + 公共 glyph 宽。
// 续行/状态挂行只补前缀宽（选择 cell + glyph cell + gap），不保留断点空格。
const SELECTION_COLUMNS = 1;
const COLUMN_GAP_COLUMNS = 1;
/** 首行标题与状态列之间的最小间隔（§2：至少 2 列空格）。 */
const STATE_GAP_COLUMNS = 2;
/** 内联状态右列所需的最小标题列数（§2：至少 2 列标题）。 */
const MIN_TITLE_COLUMNS = 2;
const SELECTED_MARKER = "›";
/** 未知 kind 的兜底图标（只表「未识别类型」，不表事实）。 */
const FALLBACK_GLYPH = "◇";

/**
 * 公共 glyph cell 宽：同帧三种类型 glyph 的最大 visibleWidth（并纳入 recent/兜底图标，
 * 保证信息行与条目同网格）；短 glyph 补空格，避免 ⏱/● 不同宽导致标题列跳动。
 */
const COMMON_GLYPH_WIDTH = Math.max(
  ...ACTIVITY_KIND_ORDER.map((kind) => visibleWidth(ACTIVITY_KIND_GLYPHS[kind] ?? FALLBACK_GLYPH)),
  visibleWidth(RECENT_GLYPH),
  visibleWidth(FALLBACK_GLYPH),
);

/** 条目前缀宽 = 选择 cell 1 + 公共 glyph cell + gap 1；标题列（1-indexed）= 前缀宽 + 1。 */
const PREFIX_WIDTH = SELECTION_COLUMNS + COMMON_GLYPH_WIDTH + COLUMN_GAP_COLUMNS;

/** 单个渲染片段；color 为语义 token，仅在有 theme 时经 theme.fg 上色。 */
interface DisplaySegment {
  text: string;
  color?: string;
}

/** 一个物理行的片段序列；块 = 连续物理行（条目/信息行/元数据行）。 */
type DisplayLine = DisplaySegment[];

/** geometry 计算模式：main 主视图 footer / detail 详情 overlay。 */
export type ActivityGeometryMode = "main" | "detail";

/**
 * 宽高预算元数据。冻结三元组 {footerRows,reservedBottomRows,bodyRows} 之外，
 * 额外暴露 F5b 决策所需派生字段（预算上限、溢出数、too-small）。
 *
 * F5b 组合方式：详情 overlay 静态 margin.bottom = DETAIL_RESERVED_BOTTOM_ROWS(4)，
 * 详情 footer 导航行 <= DETAIL_FOOTER_MAX_ROWS(3)，正文 viewport 行数在 bodyRows
 * （= max(0, terminalRows-4)）内扣除 footer 后使用；terminalRows <= TOO_SMALL_TERMINAL_ROWS
 * （tooSmall=true）时不挂载 overlay，保留 footer 入口与 draft，恢复尺寸后可重开。
 */
export type ActivityGeometry = Readonly<{
  /** 本次实际占用/计划的 footer 物理行数（已被对应预算上限钳制）。 */
  footerRows: number;
  /** 当前模式下方保留的物理行数：main=6，detail=4（静态 viewport reserve）。 */
  reservedBottomRows: number;
  /** 详情正文最大物理行数 max(0, terminalRows-4)；主视图模式恒为 0。 */
  bodyRows: number;
  mode: ActivityGeometryMode;
  /** 主视图物理行预算 max(0, terminalRows-6)。 */
  mainBudgetRows: number;
  /** 详情 footer 导航行上限（3）。 */
  detailFooterMaxRows: number;
  /** 详情静态 viewport 保留行数（4）。 */
  detailReservedBottomRows: number;
  /** terminalRows<=4：详情 overlay 不可挂载；F5b 保留 footer 入口与 draft，不虚构内容。 */
  tooSmall: boolean;
  /** 主视图预算外被折叠的 activity 条目数（0=无折叠；不含 recent 汇总行与状态行）。 */
  overflowCount: number;
}>;

/**
 * 纯布局所需 footer 元数据（display 输入投影）。F5b presenter 从既有 getter
 * （getCwd/getHome/getModel/getContextUsage/getThinkingLevel）投影出本接口；
 * layout 不读取 session/settings/模型上下文，也不写回任何 raw 数据。
 */
export type ActivityFooterMeta = Readonly<{
  /** 当前工作目录原文；提供 home 时由 layout 做纯显示的 ~ 缩写（生成新串，不写回）。 */
  cwd: string;
  /** 可选 home 前缀，用于 cwd → ~/… 缩写。 */
  home?: string;
  /** 第一行右侧 context 标签（如 "12.3%/1.0M"）。 */
  contextLabel: string;
  /** 第二元数据行左侧 provider/model 标签（如 "(anthropic) claude-…"）。 */
  providerModelLabel: string;
  /** 第二元数据行右侧 thinking 标签（如 "thinking: medium"）。 */
  thinkingLabel: string;
}>;

/**
 * stale/unavailable source 的独立状态提示输入。旧行不进入主视图（由详情的过期分组
 * 保留），此处只携带提示所需字段；lastObservedCount 仅作提示，不计入 main/recent 数量。
 */
export type ActivitySourceStatus = Readonly<{
  kind: ActivityKind;
  availability: Exclude<ActivityAvailability, "available">;
  /** source 自报错误提示（registry 已按协议透传）；layout 仅做显示清理，不写回。 */
  errorLabel?: string;
  /** 上次观察到的行数（仅提示文案，不渲染旧行）。 */
  lastObservedCount?: number;
}>;

/** renderActivityLayout 输入：registry.snapshot() 的行 + 终端尺寸 + footer 元数据。 */
export type ActivityLayoutInput = Readonly<{
  /** registry 当前事实（available 行）；layout 内部稳定排序，不写回、不按 label 去重。 */
  rows: readonly ActivityRow[];
  /** 终端宽度（列）。 */
  width: number;
  /** 终端高度（行）。 */
  terminalRows: number;
  meta: ActivityFooterMeta;
  /** 当前选中行 key（精确匹配，不按 label 推断）。 */
  selection?: string;
  theme?: ActivityTheme;
  /** stale/unavailable source 独立状态提示；缺省视为无。 */
  sourceStatuses?: readonly ActivitySourceStatus[];
}>;

/** renderActivityLayout 输出：主视图 footer 物理行 + geometry 元数据。 */
export type ActivityLayoutResult = Readonly<{
  lines: readonly string[];
  geometry: ActivityGeometry;
}>;

function normalizeCount(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(Number(value))) : 0;
}

function clampRowCount(value: unknown, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.floor(Number(value))), Math.max(0, max));
}

// ---------------------------------------------------------------------------
// 显示文本清理：ANSI/OSC/APC 序列剥离 + C0/C1 控制符清理，只生成新显示串。
// 中文/emoji 等宽字符不清理，由 visibleWidth 按终端列测量。
// ---------------------------------------------------------------------------

// C0 控制符（除 \t 外，含 LF/CR）与 DEL/C1；\t 单独替换为单个空格保证列宽一致。
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F]/g;

function toDisplayText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const withoutSequences = stripTerminalSequences(raw);
  return withoutSequences.replace(/\t/g, " ").replace(CONTROL_CHAR_PATTERN, "");
}

/** cwd → ~/… 纯显示缩写（与既有 footer 行为一致）；不修改入参。 */
function abbreviateHomePath(cwd: string, home: string | undefined): string {
  if (home === undefined || home === "" || !cwd.startsWith(home)) return cwd;
  return `~${cwd.slice(home.length)}`;
}

// ---------------------------------------------------------------------------
// 宽度计算与换行（词边界优先，公开 wrapTextWithAnsi；字素仅做极窄降级）
// ---------------------------------------------------------------------------

// pi-tui index 未再导出共享 segmenter；字素簇分割仅用于单字素超宽降级边界，
// 常规换行/宽度测量仍全部交给公开 wrapTextWithAnsi/visibleWidth。
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * 单字素宽于 budget 的明确降级：按字素簇裁剪前缀，宁可丢字不越界。
 * 仅用于 wrapTextWithAnsi 对超宽单字素无法再拆的边界（§2.4），不做常规换行。
 */
function clipToWidth(text: string, maxWidth: number): string {
  let out = "";
  let width = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
    const segmentWidth = visibleWidth(segment);
    if (width + segmentWidth > maxWidth) break;
    out += segment;
    width += segmentWidth;
  }
  return out;
}

/**
 * 显示副本换行：优先复用 pi-tui 公开 wrapTextWithAnsi（ASCII/空白分词优先、CJK 逐字
 * 兜底、超宽长 token 字素兜底、消费换行边界空白、不保留断点空格）；对单字素宽于极小
 * budget 的行做 clipToWidth 明确降级；空文本返回 [""] 保证至少一行。
 */
function wrapDisplayText(text: string, maxWidth: number): string[] {
  if (!(maxWidth > 0) || text === "") return [""];
  const lines: string[] = [];
  for (const line of wrapTextWithAnsi(text, maxWidth)) {
    const fitted = visibleWidth(line) <= maxWidth ? line : clipToWidth(line, maxWidth);
    if (fitted !== "") lines.push(fitted);
  }
  return lines.length > 0 ? lines : [""];
}

function renderSegments(segments: readonly DisplaySegment[], theme?: ActivityTheme): string {
  let out = "";
  for (const segment of segments) {
    if (theme && segment.color) {
      out += theme.fg(segment.color, segment.text);
    } else {
      out += segment.text;
    }
  }
  return out;
}

interface EntryDisplay {
  glyph: string;
  glyphWidth: number;
  label: string;
  state: string;
}

/** 行 → 显示投影：图标 + 清理后的 label/state 新串；raw 行对象与字符串不写回。 */
function toEntryDisplay(row: ActivityRow): EntryDisplay {
  const glyph = ACTIVITY_KIND_GLYPHS[row?.kind] ?? FALLBACK_GLYPH;
  return {
    glyph,
    glyphWidth: visibleWidth(glyph),
    label: toDisplayText(row?.label),
    state: toDisplayText(row?.stateLabel),
  };
}

/** 选择 cell 片段：选中 `›`（accent）、未选中单空格（dim）。 */
function selectionSegment(selected: boolean): DisplaySegment {
  return { text: selected ? SELECTED_MARKER : " ", color: selected ? "accent" : "dim" };
}

/** 条目前缀片段：选择 cell + glyph（补空格到公共 glyph cell）+ 1 列 gap。 */
function entryPrefixSegments(selected: boolean, display: EntryDisplay): DisplaySegment[] {
  const glyphPad = " ".repeat(Math.max(0, COMMON_GLYPH_WIDTH - display.glyphWidth));
  return [
    selectionSegment(selected),
    { text: display.glyph + glyphPad, color: "dim" },
    { text: " ".repeat(COLUMN_GAP_COLUMNS), color: "dim" },
  ];
}

const PREFIX_SPACES = " ".repeat(PREFIX_WIDTH);

/**
 * 组装单条 activity 的物理行（§2 冻结网格）：
 * - 正常宽度：首行 = 前缀 + 标题首段 + 补空格 + 状态右列（状态右边界 = width，标题与
 *   状态间 >= 2 列）；续行 = 前缀宽空格 + 标题段（保留空状态列，不接进拆开的标题中间）；
 * - 宽度不足「前缀 + 2 列标题 + 2 列间隔 + 完整状态」时转 stacked：标题按区域可用宽
 *   逐行，最后独立 `状态：<state>` 行挂到标题列并换行，不静默隐藏状态；
 * - 极小宽度逐级降级：无标题列 → 选择 cell + glyph；连选择 cell 都放不下 → glyph-only；
 *   连 glyph 都放不下 → 空行。完整内容仍可在详情看，不宣称窄宽展示全部身份。
 */
function composeEntryBlock(
  display: EntryDisplay,
  width: number,
  selected: boolean,
  frameStateWidth: number,
): DisplayLine[] {
  if (width < display.glyphWidth) return [[]]; // 连图标都放不下：空行，不越界
  if (width < SELECTION_COLUMNS + COMMON_GLYPH_WIDTH) {
    return [[{ text: display.glyph, color: "dim" }]]; // glyph-only 降级
  }
  const glyphPad = " ".repeat(Math.max(0, COMMON_GLYPH_WIDTH - display.glyphWidth));
  if (width < PREFIX_WIDTH + 1) {
    // 无标题列：选择 cell + glyph（图标身份最后消失），状态留详情可见
    return [[selectionSegment(selected), { text: display.glyph + glyphPad, color: "dim" }]];
  }
  const titleColumns = width - PREFIX_WIDTH;
  const prefix = entryPrefixSegments(selected, display);
  const ownStateWidth = visibleWidth(display.state);
  // 公共状态预算（本帧全部参与行先于预算裁剪的最大状态宽）：标题换行宽与 stacked 判定
  // 用它而非本行状态宽，保证标题列/右边界不随本帧 overflow 选择变化。
  const stateBudget = Math.max(frameStateWidth, ownStateWidth);
  const lines: DisplayLine[] = [];
  const pushContinuation = (chunk: string): void => {
    lines.push([{ text: PREFIX_SPACES, color: "dim" }, { text: chunk, color: "dim" }]);
  };
  if (stateBudget > 0 && titleColumns >= MIN_TITLE_COLUMNS + STATE_GAP_COLUMNS + stateBudget) {
    // 状态真右列：标题换行宽预留「>=2 间隔 + 公共状态预算」，首行补空格右对齐本行状态
    const wrapWidth = titleColumns - STATE_GAP_COLUMNS - stateBudget;
    const chunks = wrapDisplayText(display.label, wrapWidth);
    const firstWidth = visibleWidth(chunks[0] ?? "");
    if (ownStateWidth > 0) {
      const pad = " ".repeat(Math.max(STATE_GAP_COLUMNS, titleColumns - ownStateWidth - firstWidth));
      lines.push([
        ...prefix,
        { text: chunks[0] ?? "", color: "dim" },
        { text: pad, color: "dim" },
        { text: display.state, color: "dim" },
      ]);
    } else {
      lines.push([...prefix, { text: chunks[0] ?? "", color: "dim" }]);
    }
    for (const chunk of chunks.slice(1)) pushContinuation(chunk);
    return lines;
  }
  const chunks = wrapDisplayText(display.label, titleColumns);
  chunks.forEach((chunk, index) => {
    if (index === 0) lines.push([...prefix, { text: chunk, color: "dim" }]);
    else pushContinuation(chunk);
  });
  if (ownStateWidth > 0) {
    // stacked：独立状态行挂标题列，超宽继续换行，不静默隐藏
    for (const chunk of wrapDisplayText(`状态：${display.state}`, titleColumns)) {
      pushContinuation(chunk);
    }
  }
  return lines;
}

/**
 * 信息行（source 状态 / recent 汇总）：保留空选择列 + 图标（补空格到公共 glyph cell），
 * 文本对齐标题列；超宽按词/字素换行（续行同标题列），不中段截断。
 * 宽度连图标都放不下时返回 []（调用方跳过该块）。
 */
function composeInfoBlock(glyph: string, text: string, width: number): DisplayLine[] {
  const glyphWidth = visibleWidth(glyph);
  if (width < glyphWidth) return [];
  if (width < SELECTION_COLUMNS + COMMON_GLYPH_WIDTH) {
    return [[{ text: glyph, color: "dim" }]];
  }
  const glyphPad = " ".repeat(Math.max(0, COMMON_GLYPH_WIDTH - glyphWidth));
  if (width < PREFIX_WIDTH + 1) {
    return [[{ text: " ", color: "dim" }, { text: glyph + glyphPad, color: "dim" }]];
  }
  const titleColumns = width - PREFIX_WIDTH;
  return wrapDisplayText(text, titleColumns).map((chunk, index): DisplayLine =>
    index === 0
      ? [
          { text: " ", color: "dim" },
          { text: glyph + glyphPad, color: "dim" },
          { text: " ".repeat(COLUMN_GAP_COLUMNS), color: "dim" },
          { text: chunk, color: "dim" },
        ]
      : [{ text: PREFIX_SPACES, color: "dim" }, { text: chunk, color: "dim" }],
  );
}

/** 主视图溢出提示行：预算外条目数 + Alt+O 详情入口；col1 起，不伪装成任务行。 */
function composeOverflowHintLine(count: number, width: number): DisplayLine[] {
  const text = truncateToWidth(`还有 ${count} 项 · Alt+O`, Math.max(0, width), "…");
  return [[{ text, color: "dim" }]];
}

/**
 * 元数据行（§2.5）：左/右同放得下时左基线 + 右对齐到 width；放不下时分别换行，均从
 * col1 共同左基线开始；单侧缺席时另一侧保持原列语义（左=col1、右=右对齐）；不截断。
 */
function composeMetaPair(left: string, right: string, width: number): DisplayLine[] {
  const asLeft = (text: string): DisplayLine[] =>
    wrapDisplayText(text, width).map((chunk): DisplayLine => [{ text: chunk, color: "dim" }]);
  if (left === "" && right === "") return [];
  if (left === "") {
    const rightWidth = visibleWidth(right);
    if (rightWidth <= width) {
      return [[{ text: " ".repeat(width - rightWidth) + right, color: "dim" }]];
    }
    return asLeft(right);
  }
  if (right === "") return asLeft(left);
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  if (leftWidth + COLUMN_GAP_COLUMNS + rightWidth <= width) {
    const pad = " ".repeat(width - leftWidth - rightWidth);
    return [[{ text: left + pad + right, color: "dim" }]];
  }
  return [...asLeft(left), ...asLeft(right)];
}

// ---------------------------------------------------------------------------
// 排序与聚合
// ---------------------------------------------------------------------------

function kindOrderIndex(kind: unknown): number {
  const index = ACTIVITY_KIND_ORDER.indexOf(kind as ActivityKind);
  return index === -1 ? ACTIVITY_KIND_ORDER.length : index;
}

/** 类型固定顺序 + 同类型内稳定顺序（保持给定次序，不按 label 去重）。 */
function orderRows(rows: readonly ActivityRow[]): ActivityRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => kindOrderIndex(a.row.kind) - kindOrderIndex(b.row.kind) || a.index - b.index)
    .map((entry) => entry.row);
}

function collectPlacement(rows: unknown, placement: ActivityPlacement): ActivityRow[] {
  const collected: ActivityRow[] = [];
  if (Array.isArray(rows)) {
    for (const row of rows as ActivityRow[]) {
      if (row?.placement === placement) collected.push(row);
    }
  }
  return collected;
}

function orderSourceStatuses(
  statuses: readonly ActivitySourceStatus[] | undefined,
): ActivitySourceStatus[] {
  const valid = (Array.isArray(statuses) ? statuses : []).filter(
    (status): status is ActivitySourceStatus =>
      status?.availability === "stale" || status?.availability === "unavailable",
  );
  return valid
    .map((status, index) => ({ status, index }))
    .sort((a, b) => kindOrderIndex(a.status.kind) - kindOrderIndex(b.status.kind) || a.index - b.index)
    .map((entry) => entry.status);
}

/** 本帧公共状态宽：全部参与行的状态显示宽最大值（先于预算裁剪，右边界因此稳定）。 */
function frameStateWidth(displays: readonly EntryDisplay[]): number {
  let max = 0;
  for (const display of displays) {
    max = Math.max(max, visibleWidth(display.state));
  }
  return max;
}

/** 布局块：连续物理行 + 是否 activity 条目（溢出计数只统计条目）+ 类型（公平首项）。 */
interface LayoutBlock {
  lines: DisplayLine[];
  isEntry: boolean;
  kind?: ActivityKind;
}

/**
 * 公平填充顺序（§2.7）：先从每个非空 kind 取首个完整 block（按类型顺序），再追加剩余
 * 条目（稳定顺序），最后信息行（source 状态/recent）；整块取舍，不截 block。
 */
function fairFillOrder(blocks: readonly LayoutBlock[]): LayoutBlock[] {
  const entries = blocks.filter((block) => block.isEntry);
  const infos = blocks.filter((block) => !block.isEntry);
  const taken = new Set<LayoutBlock>();
  const ordered: LayoutBlock[] = [];
  const kindGroups = new Map<unknown, LayoutBlock[]>();
  for (const block of entries) {
    const group = kindGroups.get(block.kind);
    if (group) group.push(block);
    else kindGroups.set(block.kind, [block]);
  }
  const groupKeys = [...kindGroups.keys()].sort(
    (a, b) => kindOrderIndex(a) - kindOrderIndex(b),
  );
  for (const key of groupKeys) {
    const first = kindGroups.get(key)?.[0];
    if (first) {
      ordered.push(first);
      taken.add(first);
    }
  }
  for (const block of entries) {
    if (!taken.has(block)) ordered.push(block);
  }
  ordered.push(...infos);
  return ordered;
}

interface FillResult {
  chosen: LayoutBlock[];
  droppedEntries: number;
  droppedInfos: LayoutBlock[];
}

/** 按整块预算填充；放不下的条目计 overflow；条目让位后信息行不再插队（先被折叠）。 */
function fillBlocks(ordered: readonly LayoutBlock[], available: number): FillResult {
  const chosen: LayoutBlock[] = [];
  const droppedInfos: LayoutBlock[] = [];
  let used = 0;
  let droppedEntries = 0;
  for (const block of ordered) {
    if (!block.isEntry && droppedEntries > 0) {
      // 已有条目整块让位：信息行（source 状态/recent）优先级更低，先被折叠
      droppedInfos.push(block);
      continue;
    }
    if (used + block.lines.length <= available) {
      chosen.push(block);
      used += block.lines.length;
    } else if (block.isEntry) {
      droppedEntries += 1;
    } else {
      droppedInfos.push(block);
    }
  }
  return { chosen, droppedEntries, droppedInfos };
}

// ---------------------------------------------------------------------------
// 公开签名 1：通用条目行渲染
// ---------------------------------------------------------------------------

/**
 * 渲染 activity 条目行（通用入口，冻结签名）。
 * - 行先按类型固定顺序稳定排序（subagent → bash_async → scheduler，同类型保持给定次序）；
 * - 统一左基线：选择 cell(col1) + 公共 glyph cell(col2 起) + gap，标题列 = 3 + 公共 glyph 宽；
 * - 状态是本帧公共右列（右边界 = width）：首行标题补空格右对齐，标题/状态间隔 >= 2 列；
 *   窄宽转 stacked `状态：<state>` 挂标题列；极窄逐级 glyph-only 降级；
 * - 标题按 visibleWidth 词边界优先挂起换行，续行对齐标题列、不保留断点空格；
 * - selection 为精确 row key，命中行选择 cell 显示 `›`，其余留空；
 * - width<=0 返回 []，任何行可见宽度不越界；只生成新显示串，raw 行对象/label/state 不写回。
 */
export function renderActivityRows(
  rows: readonly ActivityRow[],
  width: number,
  selection?: string,
  theme?: ActivityTheme,
): string[] {
  const columns = normalizeCount(width);
  if (columns <= 0 || !Array.isArray(rows)) return [];
  const ordered = orderRows(rows);
  const stateWidth = frameStateWidth(ordered.map((row) => toEntryDisplay(row)));
  const lines: string[] = [];
  for (const row of ordered) {
    const block = composeEntryBlock(toEntryDisplay(row), columns, row.key === selection, stateWidth);
    for (const line of block) lines.push(renderSegments(line, theme));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 公开签名 2：主视图 footer 布局工厂
// ---------------------------------------------------------------------------

/**
 * 主视图 footer 纯布局工厂（冻结签名）。
 *
 * 行结构（物理行预算 max(0, terminalRows-6)，顺序固定）：
 * 1. 元数据连续渲染：cwd（左）/ context（右）；provider/model（左）+ thinking（右），
 *    放不下时分别换行且均从 col1 共同左基线开始；不留空 activity 槽位；
 * 2. 活动区全部在元数据之后连续绘制：entry 块（统一左基线 + 状态公共右列）→
 *    stale/unavailable source 独立状态行（旧行不渲染、不计入 main/recent 数量）→
 *    recent 汇总单行 `◯ recent N`（N 按统一列表 key 去重；recent 不逐条进主视图）；
 * 3. 溢出提示行「还有 N 项 · Alt+O」（N=预算外 activity 条目数，预留最后一行，col1 起）。
 *
 * 预算策略（§2.6/§2.7）：全放得下时按稳定顺序整块渲染；放不下时优先保留第一元数据行、
 * 次要元数据整 block 让位、预留溢出提示行，再按「每 kind 首个完整 block → 剩余条目 →
 * 信息行」公平填充；放不下整 block 就计 overflow，不截 block、不中段截断身份。
 * 空 main 不虚构任务；width/预算为 0 不渲染物理行。
 */
export function renderActivityLayout(input: ActivityLayoutInput): ActivityLayoutResult {
  const width = normalizeCount(input?.width);
  const terminalRows = normalizeCount(input?.terminalRows);
  const theme = input?.theme;
  const selection = input?.selection;
  const meta = input?.meta;
  const budget = Math.max(0, terminalRows - MAIN_VIEW_RESERVED_BOTTOM_ROWS);
  const mainRows = orderRows(collectPlacement(input?.rows, "main"));
  const recentRows = collectPlacement(input?.rows, "recent");
  const recentCount = new Set(recentRows.map((row) => row.key)).size;

  if (width <= 0 || budget <= 0) {
    // 宽/高预算为 0：不渲染任何物理行、不虚构内容；geometry 报告被隐藏条目数。
    return {
      lines: [],
      geometry: computeActivityGeometry({
        terminalRows,
        mode: "main",
        renderedFooterRows: 0,
        overflowCount: mainRows.length,
      }),
    };
  }

  // —— 元数据（连续渲染，无空 activity 槽）——
  const cwdDisplay = abbreviateHomePath(
    toDisplayText(meta?.cwd),
    meta?.home === undefined ? undefined : toDisplayText(meta.home),
  );
  const meta1 = composeMetaPair(cwdDisplay, toDisplayText(meta?.contextLabel), width);
  const meta2 = composeMetaPair(
    toDisplayText(meta?.providerModelLabel),
    toDisplayText(meta?.thinkingLabel),
    width,
  );

  // —— 活动区块：entry（本帧公共状态宽先于预算裁剪）→ source 状态 → recent ——
  const stateWidth = frameStateWidth(mainRows.map((row) => toEntryDisplay(row)));
  const blocks: LayoutBlock[] = [];
  for (const row of mainRows) {
    blocks.push({
      lines: composeEntryBlock(toEntryDisplay(row), width, row.key === selection, stateWidth),
      isEntry: true,
      kind: row.kind,
    });
  }
  for (const status of orderSourceStatuses(input?.sourceStatuses)) {
    const glyph = ACTIVITY_KIND_GLYPHS[status?.kind] ?? FALLBACK_GLYPH;
    const parts = [status?.availability === "stale" ? "过期观察" : "暂不可用"];
    const errorLabel = toDisplayText(status?.errorLabel);
    if (errorLabel !== "") parts.push(errorLabel);
    const lastObserved = status?.lastObservedCount;
    if (Number.isFinite(lastObserved) && (lastObserved ?? 0) > 0) {
      parts.push(`上次观察 ${Math.floor(lastObserved ?? 0)} 项`);
    }
    const infoLines = composeInfoBlock(glyph, parts.join(" · "), width);
    if (infoLines.length > 0) blocks.push({ lines: infoLines, isEntry: false });
  }
  if (recentCount > 0) {
    const recentLines = composeInfoBlock(RECENT_GLYPH, `recent ${recentCount}`, width);
    if (recentLines.length > 0) blocks.push({ lines: recentLines, isEntry: false });
  }

  const toPlain = (line: DisplayLine): string => renderSegments(line, theme);
  const entryCount = mainRows.length;

  // —— 预算装配：全放得下 → 稳定整块；否则元数据让位 + 公平填充 + 溢出提示 ——
  const fullLines = [...meta1, ...meta2, ...blocks.flatMap((block) => block.lines)];
  let lines: DisplayLine[];
  let overflowCount = 0;
  if (fullLines.length <= budget) {
    lines = fullLines;
  } else if (blocks.length === 0) {
    // 无活动块：元数据自身超预算时按物理预算截断显示行（不虚构活动）
    lines = fullLines.slice(0, budget);
  } else {
    const metaLines = meta1.slice(0, budget); // 第一元数据行优先保留
    const remaining = budget - metaLines.length;
    if (remaining <= 0) {
      lines = metaLines;
      overflowCount = entryCount;
    } else {
      const available = remaining - 1; // 预留最后一行给溢出提示/被折叠信息行
      const { chosen, droppedEntries, droppedInfos } = fillBlocks(
        fairFillOrder(blocks),
        available,
      );
      lines = [...metaLines, ...chosen.flatMap((block) => block.lines)];
      overflowCount = droppedEntries;
      if (droppedEntries > 0) {
        lines.push(...composeOverflowHintLine(droppedEntries, width));
      } else if (droppedInfos.length > 0 && lines.length < budget) {
        // 只有信息行被折叠时，用预留槽位显示第一条被折叠的信息行
        lines.push(...droppedInfos[0].lines);
      }
    }
  }

  return {
    lines: lines.map(toPlain),
    geometry: computeActivityGeometry({
      terminalRows,
      mode: "main",
      renderedFooterRows: lines.length,
      overflowCount,
    }),
  };
}

// ---------------------------------------------------------------------------
// 公开签名 3：宽高预算 geometry
// ---------------------------------------------------------------------------

/**
 * 计算 ActivityGeometry（冻结签名）。
 * - main：footerRows 钳制在 max(0, terminalRows-6) 内，bodyRows=0，reservedBottomRows=6；
 * - detail：footerRows 钳制在 3 内，reservedBottomRows=4（静态 reserve），bodyRows=max(0, terminalRows-4)；
 * - tooSmall = terminalRows <= 4：F5b 不得挂载详情 overlay，保留 footer 入口与 draft。
 */
export function computeActivityGeometry(input: {
  terminalRows: number;
  mode?: ActivityGeometryMode;
  renderedFooterRows?: number;
  overflowCount?: number;
}): ActivityGeometry {
  const terminalRows = normalizeCount(input?.terminalRows);
  const mode: ActivityGeometryMode = input?.mode === "detail" ? "detail" : "main";
  const mainBudgetRows = Math.max(0, terminalRows - MAIN_VIEW_RESERVED_BOTTOM_ROWS);
  const bodyRows = Math.max(0, terminalRows - DETAIL_RESERVED_BOTTOM_ROWS);
  const tooSmall = terminalRows <= TOO_SMALL_TERMINAL_ROWS;
  const overflowCount =
    mode === "main" ? clampRowCount(input?.overflowCount ?? 0, Number.MAX_SAFE_INTEGER) : 0;
  if (mode === "detail") {
    return Object.freeze({
      footerRows: clampRowCount(
        input?.renderedFooterRows ?? DETAIL_FOOTER_MAX_ROWS,
        DETAIL_FOOTER_MAX_ROWS,
      ),
      reservedBottomRows: DETAIL_RESERVED_BOTTOM_ROWS,
      bodyRows,
      mode,
      mainBudgetRows,
      detailFooterMaxRows: DETAIL_FOOTER_MAX_ROWS,
      detailReservedBottomRows: DETAIL_RESERVED_BOTTOM_ROWS,
      tooSmall,
      overflowCount,
    });
  }
  return Object.freeze({
    footerRows: clampRowCount(input?.renderedFooterRows ?? mainBudgetRows, mainBudgetRows),
    reservedBottomRows: MAIN_VIEW_RESERVED_BOTTOM_ROWS,
    bodyRows: 0,
    mode,
    mainBudgetRows,
    detailFooterMaxRows: DETAIL_FOOTER_MAX_ROWS,
    detailReservedBottomRows: DETAIL_RESERVED_BOTTOM_ROWS,
    tooSmall,
    overflowCount,
  });
}
