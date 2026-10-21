// 统一后台活动 presenter（统一执行计划 F5b / footer 子计划 T5b）。
//
// `createActivityPresenter(bindings, uiDependencies): MountedActivityView` 是根 feature 的
// presenter 工厂：只返回 createFooter/openDetails/dispose 三个成员，不调用
// `ctx.ui.setFooter`、不注册快捷键（Alt+O 唯一注册由 package entry 后续委托本视图的
// openDetails，见 F6）。对协议 `ActivityPresenterFactory = (bindings) => MountedActivityView`
// 通过 `activityPresenterFactoryFor(uiDependencies)` 的 curried closure 绑定 DI。
//
// 职责与边界：
// - footer 组件：main mode 调用 `renderActivityLayout`（meta 从 ctx.cwd/model/
//   getContextUsage()/thinkingLevel 投影；source availability 经 registry.sourceSnapshot
//   出独立状态行），detail mode 固定最多 3 行导航；不改写任何 raw 行对象。
//   detail mode 首行承载选中项身份（`n/N glyph label · state`），并把行上的
//   只读展示投影 `metaLabel`（如 subagent 的模型/thinking）追加在同一行（详情面
//   首行已不再渲染身份行，信息搬到 footer）；超宽由 renderActivityDetailTextLine
//   按终端列截断，不挤掉后两行（位置行 + 键位提示）。
// - openDetails：terminalRows<=4 不挂 overlay、不改 editor/draft（shell 标记 too-small，
//   恢复尺寸后可重开）；否则保存 editor/draft（错误隔离，任一获取/替换失败保持关闭并
//   固定文案 notify 一次），经 `ctx.ui.custom` 以静态 overlay options（margin.bottom=4、
//   maxHeight 100%）挂载详情壳，每 render 按 terminalRows 实时计算正文行数，不使用
//   动态 options 函数、不常规 remount。
// - registry 订阅：source 失效/同 kind 注册替换时刷新 footer 并让 shell 重取详情。
// - 主题身份变化（footer factory 以新 theme 对象重入）→ shell 重取详情保 anchor。
//
// 依赖边界：协议与 registry 经 bare specifier `pi-subagents-enhanced/tui/background-activity`
// 消费；不深引 package src（browser/renderer/session-viewport），也不反向依赖宿主入口。

import {
  Key,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import type {
  ActivityPresenterFactory,
  ActivityRegistry,
  ActivityRow,
  ActivitySnapshot,
  FooterBindings,
  MountedActivityView,
} from "pi-subagents-enhanced/tui/background-activity";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  ACTIVITY_KIND_GLYPHS,
  ACTIVITY_KIND_ORDER,
  DETAIL_FOOTER_MAX_ROWS,
  DETAIL_RESERVED_BOTTOM_ROWS,
  TOO_SMALL_TERMINAL_ROWS,
  renderActivityLayout,
} from "./layout.ts";
import type { ActivityFooterMeta, ActivitySourceStatus, ActivityTheme } from "./layout.ts";
import {
  createActivityDetailShell,
  createReadOnlyActivityEditorFactory,
  renderActivityDetailTextLine,
} from "./detail-controller.ts";
import type { ActivityDetailShell, ActivityTuiBindings } from "./detail-controller.ts";

/** presenter 的 UI 依赖注入端口（pi-tui 输入/宽度工具），与 package FooterRuntimeDependencies 同构。 */
export type ActivityPresenterUiDependencies = Readonly<{
  tui: ActivityTuiBindings;
}>;

/** 默认 UI 依赖：直接绑定 pi-tui 公开工具（根 src 允许直接 import 宿主 TUI 库值）。 */
export function defaultActivityPresenterUiDependencies(): ActivityPresenterUiDependencies {
  return {
    tui: {
      Key,
      isKeyRelease,
      isKeyRepeat,
      matchesKey,
      visibleWidth,
      truncateToWidth,
      stripTerminalSequences,
    },
  };
}

/**
 * curried closure：绑定 uiDependencies 后返回协议形状的
 * `ActivityPresenterFactory`，供 F6 的根 entry/bus 握手直接注册。
 */
export function activityPresenterFactoryFor(
  uiDependencies: ActivityPresenterUiDependencies,
): ActivityPresenterFactory {
  return (bindings: FooterBindings): MountedActivityView =>
    createActivityPresenter(bindings, uiDependencies);
}

/**
 * 详情 overlay 静态挂载参数：row 0/col 0/全宽/maxHeight 100%/margin.bottom=4。
 * margin.bottom=4 已为 overlay 下方详情 footer（最多 3 行）+ separator 预留；
 * 不使用动态 options 函数，resize 由每 render 实时按 terminalRows 适应。
 */
const DETAIL_OVERLAY_MOUNT_OPTIONS: {
  overlay: boolean;
  overlayOptions: {
    row: number;
    col: number;
    width: "100%";
    maxHeight: "100%";
    margin: { bottom: number };
  };
  onHandle: (handle: OverlayHandle) => void;
} = {
  overlay: true,
  overlayOptions: {
    row: 0,
    col: 0,
    width: "100%",
    maxHeight: "100%",
    margin: { bottom: DETAIL_RESERVED_BOTTOM_ROWS },
  },
  onHandle: (handle) => {
    try {
      handle?.focus?.();
    } catch {
      // focus 失败不阻断挂载。
    }
  },
};

/** 每次 open 的壳 Component 包装（tui.md：custom 组件实例属于一次交互；壳 controller 跨交互复用）。 */
function createOpenShellComponent(shell: ActivityDetailShell): {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
  dispose?(): void;
} {
  return {
    render: (width: number) => shell.render(width),
    handleInput: (data: string) => {
      shell.handleInput(data);
    },
    invalidate: () => {
      shell.invalidate();
    },
    dispose: () => {
      // SDK 在 done() 后 dispose 本组件；若壳仍挂载（异常路径）则触发一次幂等关闭。
      shell.close();
    },
  };
}

function safeRegistrySnapshot(registry: ActivityRegistry): readonly ActivityRow[] {
  try {
    const rows = registry.snapshot();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/** main footer 的 stale/unavailable 独立状态行输入；旧行不进主视图、不推断删除/完成。 */
function collectSourceStatuses(registry: ActivityRegistry): ActivitySourceStatus[] {
  const statuses: ActivitySourceStatus[] = [];
  for (const kind of ACTIVITY_KIND_ORDER) {
    let snapshot: ActivitySnapshot | undefined;
    try {
      snapshot = registry.sourceSnapshot(kind);
    } catch {
      snapshot = undefined;
    }
    if (!snapshot || snapshot.availability === "available") continue;
    statuses.push({
      kind,
      availability: snapshot.availability,
      errorLabel: snapshot.errorLabel,
      lastObservedCount: snapshot.rows.length,
    });
  }
  return statuses;
}

/** footer 元数据投影：只读 ctx.model/usage/thinkingLevel/cwd，不读 settings/private 字段。 */
function projectActivityFooterMeta(ctx: ExtensionContext): ActivityFooterMeta {
  let usage: { contextWindow?: number; percent?: number | null } | undefined;
  try {
    usage = ctx.getContextUsage();
  } catch {
    usage = undefined;
  }
  const model = ctx.model;
  const contextWindow = usage?.contextWindow || model?.contextWindow || 1_000_000;
  const windowLabel =
    contextWindow >= 1_000_000
      ? `${(contextWindow / 1_000_000).toFixed(1)}M`
      : `${Math.round(contextWindow / 1000)}k`;
  const percent = usage?.percent;
  const contextLabel =
    percent === null || percent === undefined
      ? `?/${windowLabel}`
      : `${percent.toFixed(1)}%/${windowLabel}`;
  const provider = model?.provider ?? "no-provider";
  const modelId = model?.id ?? "no-model";
  const providerModelLabel = `${provider}/${modelId}`;
  return {
    cwd: typeof ctx.cwd === "string" ? ctx.cwd : "",
    home: typeof process.env.HOME === "string" ? process.env.HOME : undefined,
    contextLabel,
    providerModelLabel,
    thinkingLabel: `${ctx.thinkingLevel ?? "off"}`,
  };
}

/**
 * 根统一后台活动 presenter 工厂。返回的 MountedActivityView 由 package footer runtime
 * （唯一 setFooter owner）安装；本函数不得调用 setFooter/registerShortcut。
 */
export function createActivityPresenter(
  bindings: FooterBindings,
  uiDependencies: ActivityPresenterUiDependencies,
): MountedActivityView {
  const { scope, registry, ctx } = bindings;
  const tui = uiDependencies.tui;

  let disposed = false;
  let openEpoch = 0;
  let footerTui: TUI | undefined;
  let footerTheme: ActivityTheme | undefined;
  let previousEditor: ReturnType<typeof ctx.ui.getEditorComponent> | undefined;
  let previousDraft: string | undefined;
  let editorWasSaved = false;

  const invalidateFooter = (): void => {
    try {
      footerTui?.requestRender?.();
    } catch {
      // footer 重绘请求异常隔离。
    }
  };

  const restoreEditor = (): void => {
    if (!editorWasSaved) return;
    editorWasSaved = false;
    const editor = previousEditor;
    const draft = previousDraft;
    previousEditor = undefined;
    previousDraft = undefined;
    try {
      ctx.ui.setEditorComponent(editor);
    } catch {
      // editor 恢复异常隔离：保持现状，不阻断关闭流程。
    }
    try {
      if (draft !== undefined) ctx.ui.setEditorText(draft);
    } catch {
      // 草稿回填异常隔离。
    }
  };

  const notifyOpenFailure = (): void => {
    try {
      ctx.ui.notify?.("后台活动详情打开失败", "error");
    } catch {
      // notify 异常隔离。
    }
  };

  const shell: ActivityDetailShell = createActivityDetailShell({
    registry,
    scope,
    tui,
    onClosed: () => {
      restoreEditor();
      invalidateFooter();
    },
  });

  let unsubscribeRegistry: (() => void) | undefined;
  try {
    unsubscribeRegistry = registry.subscribe(() => {
      if (disposed) return;
      shell.handleRegistryInvalidated();
      invalidateFooter();
    });
  } catch {
    unsubscribeRegistry = undefined;
  }

  const readFooterTerminalRows = (): number | undefined => {
    const rows = footerTui?.terminal?.rows;
    return typeof rows === "number" && Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : undefined;
  };

  const renderMainFooterLines = (width: number, theme: ActivityTheme | undefined): string[] => {
    const result = renderActivityLayout({
      rows: safeRegistrySnapshot(registry),
      width,
      terminalRows: readFooterTerminalRows() ?? 0,
      meta: projectActivityFooterMeta(ctx),
      selection: shell.selectedKey(),
      theme,
      sourceStatuses: collectSourceStatuses(registry),
    });
    return [...result.lines];
  };

  const renderDetailFooterLines = (width: number, theme: ActivityTheme | undefined): string[] => {
    const entries = shell.entries();
    const selected = shell.selectedKey();
    const index = entries.findIndex((entry) => entry.key === selected);
    const lines: string[] = [];
    if (index === -1) {
      lines.push("当前无后台活动");
    } else {
      const entry = entries[index];
      // `metaLabel` 是行上的只读展示投影（如 subagent 的模型/thinking）；只有存在时
      // 才追加 ` · <meta>`，避免尾部悬空分隔符。
      const metaLabel =
        typeof entry.metaLabel === "string" && entry.metaLabel !== "" ? ` · ${entry.metaLabel}` : "";
      lines.push(
        `${index + 1}/${entries.length} ${ACTIVITY_KIND_GLYPHS[entry.kind] ?? "◇"} ${
          entry.label
        } · ${entry.stateLabel}${metaLabel}`,
      );
    }
    const position = shell.position();
    lines.push(
      `行 ${position.start}-${position.end}/${position.total} · ${
        position.autoFollow ? "跟随底部" : "手动滚动"
      } · x ${shell.expanded() ? "收起" : "展开"}`,
    );
    lines.push("‹ › 切换任务 · ↑↓ jk 滚动 · PgUp/PgDn/Home/End 翻页 · Esc/Alt+O 关闭");
    return lines
      .slice(0, DETAIL_FOOTER_MAX_ROWS)
      .map((line) => renderActivityDetailTextLine(line, width, theme, tui));
  };

  const createFooter: MountedActivityView["createFooter"] = (tui, theme, footerData) => {
    footerTui = tui;
    if (theme !== footerTheme) {
      footerTheme = theme;
      if (!disposed) {
        // 主题身份变化：shell 按新主题重取当前详情（保 scroll anchor）。
        shell.handleThemeChange();
      }
    }
    return {
      dispose() {},
      invalidate() {
        invalidateFooter();
      },
      render(width: number): string[] {
        if (shell.isMounted()) {
          return renderDetailFooterLines(width, theme);
        }
        return renderMainFooterLines(width, theme);
      },
    };
  };

  const rollbackMount = (epoch: number): void => {
    if (disposed || epoch !== openEpoch) return;
    shell.close(); // 已挂载时经 onClosed 恢复 editor/draft 并刷新 footer
    restoreEditor(); // 未挂载时的兜底（幂等）
    notifyOpenFailure();
    invalidateFooter();
  };

  const openDetails = (): Promise<void> => {
    const open = new Promise<void>((resolve) => {
      if (disposed || shell.isMounted()) {
        resolve();
        return;
      }
      if (ctx.mode !== "tui") {
        // RPC/JSON/print 无 terminal overlay；不构造 footer/overlay。
        resolve();
        return;
      }
      const terminalRows = readFooterTerminalRows();
      if (terminalRows === undefined || terminalRows <= TOO_SMALL_TERMINAL_ROWS) {
        // 终端过小（或尺寸未知）：不挂 overlay、不改 editor/draft；恢复尺寸后可重开。
        shell.markTooSmall();
        invalidateFooter();
        resolve();
        return;
      }
      try {
        previousEditor = ctx.ui.getEditorComponent();
        previousDraft = ctx.ui.getEditorText();
        ctx.ui.setEditorComponent(createReadOnlyActivityEditorFactory());
        editorWasSaved = true;
      } catch {
        // editor/draft 获取或替换失败：保持关闭并固定文案 notify 一次，不透传异常正文。
        previousEditor = undefined;
        previousDraft = undefined;
        editorWasSaved = false;
        notifyOpenFailure();
        resolve();
        return;
      }
      const epoch = ++openEpoch;
      const factory = (
        overlayTui: TUI,
        overlayTheme: Theme,
        _keybindings: KeybindingsManager,
        done: () => void,
      ) => {
        if (disposed || epoch !== openEpoch) {
          done();
          return { render: (): string[] => [], invalidate() {}, dispose() {} };
        }
        shell.open({
          getTerminalRows: () => {
            const rows = overlayTui?.terminal?.rows;
            return typeof rows === "number" && Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
          },
          requestRender: () => {
            try {
              overlayTui?.requestRender?.();
            } catch {
              // 渲染请求异常隔离。
            }
          },
          theme: overlayTheme,
          done,
        });
        return createOpenShellComponent(shell);
      };
      try {
        const result = ctx.ui.custom<void>(factory, DETAIL_OVERLAY_MOUNT_OPTIONS);
        if (result && typeof result.then === "function") {
          result.then(
            () => undefined,
            () => {
              rollbackMount(epoch);
            },
          );
        }
      } catch {
        rollbackMount(epoch);
      }
      invalidateFooter();
      resolve();
    });
    return open;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    openEpoch += 1; // 让晚到的 custom factory 立即 done 且不再挂载
    const unsubscribe = unsubscribeRegistry;
    unsubscribeRegistry = undefined;
    try {
      unsubscribe?.();
    } catch {
      // 退订异常隔离。
    }
    shell.close(); // 已挂载时经 onClosed 恢复 editor/draft 并刷新 footer
    restoreEditor(); // 幂等兜底
    footerTui = undefined;
  };

  return { createFooter, openDetails, dispose };
}
