import * as fs from "node:fs";
import * as path from "node:path";
import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, isKeyRelease, isKeyRepeat, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { loadConfig } from "../npm/node_modules/pi-subagents/src/extension/config.ts";
import { browserTrustedRoots, readBrowserRunStatus, renderBrowserTranscript } from "./lib/pi-subagents-browser-adapter.ts";
import { NativeChildConversationRenderer } from "./lib/subagent-native-conversation.ts";
import { SubagentSessionBrowserState } from "./lib/subagent-session-browser.ts";
import { ReadOnlyBrowserEditor, SubagentTranscriptViewport } from "./lib/subagent-session-viewport.ts";
import { layoutFooter } from "../../scripts/lib/custom-footer-layout.mjs";

type SubagentStatusStore = { version: 1; children: unknown[] };
const SUBAGENT_STATUS_STORE = Symbol.for("pi-config.custom-footer.subagents.v2");
const MAX_SELECTOR_TITLE_WIDTH = 32;

function store(): SubagentStatusStore {
  const root = globalThis as any;
  const existing = root[SUBAGENT_STATUS_STORE];
  if (existing?.version === 1 && Array.isArray(existing.children)) return existing;
  // Migrate the short-lived v2 class-instance cache once, then retain data only.
  const children = existing?.browser?.snapshot?.().children;
  return root[SUBAGENT_STATUS_STORE] = { version: 1, children: Array.isArray(children) ? children : [] };
}

function lifecycleGlyph(state: string | undefined): string {
  switch (state?.toLowerCase()) {
    case "queued":
    case "running":
    case "pending": return "●";
    case "complete":
    case "completed": return "✓";
    case "failed":
    case "timed-out": return "✗";
    case "paused": return "Ⅱ";
    case "stopped":
    case "detached": return "■";
    default: return "?";
  }
}

function selectorChild(child: { key: string; agent: string; state?: string; label?: string }, selectedKey: string | undefined): string {
  const title = child.label ? truncateToWidth(child.label, MAX_SELECTOR_TITLE_WIDTH, "…") : undefined;
  const label = title ? `${title} (${child.agent})` : child.agent;
  return `${selectedKey === child.key ? "›" : " "} ${lifecycleGlyph(child.state)} ${label}`;
}

export function formatBrowserSelector(snapshot: ReturnType<SubagentSessionBrowserState["snapshot"]>, width: number): string {
  const childMode = snapshot.active;
  const historyCount = new Set(snapshot.recentChildren.map((child) => child.runId || child.key)).size;
  const items = [
    ...(childMode
      ? snapshot.children.map((child) => selectorChild(child, snapshot.selectedKey))
      : snapshot.activeChildren.map((child) => selectorChild(child, undefined).trimStart())),
    ...(!childMode && snapshot.activeChildren.length > 0 && historyCount > 0 ? [`◯ history ${historyCount}`] : []),
  ];
  if (items.length === 0) return "";
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
    if (addLeft && visibleWidth(addLeft) <= safeWidth && (!addRight || visibleWidth(addLeft) <= visibleWidth(addRight))) { start = nextStart; continue; }
    if (addRight && visibleWidth(addRight) <= safeWidth) { end = nextEnd; continue; }
    break;
  }
  if (safeWidth <= visibleWidth("›")) return items[selected].slice(0, 1);
  const rendered = render();
  // Prefix counters are optional; the selected marker is not.
  if (visibleWidth(rendered) <= safeWidth) return rendered;
  const selectedItem = items[selected];
  if (selectedItem.startsWith("›")) {
    return `›${truncateToWidth(selectedItem.slice(1), Math.max(0, safeWidth - visibleWidth("›")))}`;
  }
  return truncateToWidth(selectedItem, safeWidth);
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

function formatChildModel(model: string | undefined, thinking: string | undefined): string {
  if (!model) return "no-model";
  const suffix = thinking && model.endsWith(`:${thinking}`) ? `:${thinking}` : "";
  const normalized = suffix ? model.slice(0, -suffix.length) : model;
  const slash = normalized.indexOf("/");
  return slash > 0 ? `(${normalized.slice(0, slash)}) ${normalized.slice(slash + 1)}` : normalized;
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
}) {
  return { handleTerminalInput(data: string) {
    if (matchesKey(data, Key.alt("o"))) {
      if (isKeyRepeat(data) || isKeyRelease(data)) return { consume: true };
      options.browser.snapshot().active ? options.exitBrowser() : options.enterBrowser();
      return { consume: true };
    }
    if (!options.browser.snapshot().active) return undefined;
    if (isKeyRelease(data)) return { consume: true };
    if (matchesKey(data, Key.escape)) { options.exitBrowser(); return options.shouldPropagateEscape?.() ? undefined : { consume: true }; }
    if (matchesKey(data, Key.left)) { options.moveChild(-1); return { consume: true }; }
    if (matchesKey(data, Key.right)) { options.moveChild(1); return { consume: true }; }
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) { options.scrollLines(-1); return { consume: true }; }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) { options.scrollLines(1); return { consume: true }; }
    if (matchesKey(data, Key.pageUp)) { options.scrollPage(-1); return { consume: true }; }
    if (matchesKey(data, Key.pageDown)) { options.scrollPage(1); return { consume: true }; }
    if (matchesKey(data, Key.home)) { options.scrollHome(); return { consume: true }; }
    if (matchesKey(data, Key.end)) { options.scrollEnd(); return { consume: true }; }
    if (matchesKey(data, "x")) { options.toggleTools(); return { consume: true }; }
    return { consume: true };
  } };
}

function formatChildContext(tokens: number | undefined, position: { start: number; end: number; total: number } | undefined, width: number): string {
  const tokenLabel = formatTokens(tokens);
  if (!position) return tokenLabel;
  const positionLabel = position.total === 0 ? "0/0" : `${position.start}-${position.end}/${position.total}`;
  const tokenWidth = Math.max(0, width - visibleWidth(positionLabel) - visibleWidth(" · "));
  if (tokenWidth === 0) return positionLabel;
  return `${truncateToWidth(tokenLabel, tokenWidth, "…")} · ${positionLabel}`;
}

export function createFooterComponent({ getCwd, getHome, getModel, getContextUsage, getThinkingLevel, getSnapshot, getViewportPosition, requestRender, theme }: any) {
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
      ? formatChildContext(child.tokens, getViewportPosition?.(), width)
      : usage?.percent === null ? `?/${windowLabel}` : `${(usage?.percent ?? 0).toFixed(1)}%/${windowLabel}`;
    const model = child ? formatChildModel(child.model, child.thinking) : currentModel?.id ?? "no-model";
    const provider = !child && currentModel?.provider ? `(${currentModel.provider}) ` : "";
    const thinking = child?.thinking ?? getThinkingLevel?.() ?? "off";
    const rightLabel = `${provider}${model}`;
    // In child mode the selected marker is navigation state, so it outranks a long model label.
    const childRightLabel = child ? truncateToWidth(rightLabel, Math.max(0, width - 2), "…") : rightLabel;
    return [
      layoutFooter({ width, left: displayedCwd, right: contextLabel, visibleWidth, truncateToWidth }),
      layoutFooter({ width, left: formatBrowserSelector(snapshot, Math.max(1, width - visibleWidth(childRightLabel) - 1)), right: childRightLabel, visibleWidth, truncateToWidth }),
      layoutFooter({ width, left: "", right: `thinking: ${thinking}`, visibleWidth, truncateToWidth }),
    ].map((line) => theme.fg("dim", line));
  } };
}

export default function customFooter(pi: ExtensionAPI) {
  const persistent = store();
  const browser = SubagentSessionBrowserState.hydrate(persistent);
  const persist = () => { persistent.children = browser.serialize().children; };
  let ctx: any;
  let invalidateFooter: (() => void) | undefined;
  let unsubscribeInput: (() => void) | undefined;
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

  const refresh = () => { invalidateFooter?.(); viewport?.invalidate(); };
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
    const seen = new Set<string>();
    for (const child of browser.snapshot().children) {
      if (owner !== ctx || epoch !== sessionEpoch) return;
      if (seen.has(child.runId)) continue;
      seen.add(child.runId);
      browser.reconcileRun(child.runId, readBrowserRunStatus(child.asyncDir));
    }
    persist();
    if (wasActive && !browser.snapshot().active) exitBrowser();
    else refresh();
  };
  const renderSelected = (width: number, theme: any): string[] => {
    const child = browser.snapshot().selected;
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
        ui: overlayTui ?? { requestRender() {} },
        expandedTools: toolsExpanded,
        hideThinking: false,
        outputPad: 1,
      });
      if (native.lines.length || !native.warning) return native.lines.length ? native.lines : ["[Waiting for child output]"];
    }
    if (!child.transcriptPath) return ["[Waiting for child output]"];
    try {
      const rendered = renderBrowserTranscript({ transcriptPath: child.transcriptPath, trustedRoots: browserTrustedRoots({ asyncDir: child.asyncDir, runCwd: child.cwd, parentCwd: ctx.cwd, parentSessionFile: ctx.sessionManager?.getSessionFile?.() ?? null, artifactDirPreference: cachedArtifactDir }), width, theme, markdownTheme: cachedMarkdownTheme ?? getMarkdownTheme(), expandedTools: toolsExpanded });
      if (rendered.lines.length) return rendered.lines;
      return rendered.warning ? [`[Warning: ${rendered.warning}]`] : ["[Waiting for child output]"];
    } catch (error) {
      const message = error instanceof Error ? error.message : "unable to render child transcript";
      return [`[Warning: ${message}]`];
    }
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
  const teardown = (preserveRoster = false) => {
    sessionEpoch += 1;
    invalidateNative();
    exitBrowser();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    eventUnsubscribes.forEach((unsubscribe) => unsubscribe());
    eventUnsubscribes = [];
    browser.clear({ preserveRuns: preserveRoster });
    persist();
    invalidateFooter = undefined;
    overlayTui = undefined;
    cachedMarkdownTheme = undefined;
    nativeRenderer = undefined;
    toolsExpanded = false;
    ctx = undefined;
  };
  const enterBrowser = () => {
    if (!ctx || !browser.enter()) return;
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
        closeOverlay = () => done();
        overlayTui = tui;
        viewport = new SubagentTranscriptViewport({ getTerminalRows: () => tui.terminal.rows, reservedBottomRows: 4, getLines: (width) => renderSelected(width, theme), requestRender: () => tui.requestRender() });
        return viewport;
      }, { overlay: true, overlayOptions: { row: 0, col: 0, width: "100%", maxHeight: "100%", margin: { bottom: 4 }, nonCapturing: true } });
      Promise.resolve(result).catch(rollback);
      persist();
      refresh();
    } catch (error) { rollback(error); }
  };
  const controller = createBrowserInputController({
    browser,
    enterBrowser,
    exitBrowser,
    moveChild(direction) { browser.move(direction); viewport?.resetScroll(); invalidateNative(); refresh(); },
    scrollLines(direction) { viewport?.scrollLines(direction); },
    scrollPage(direction) { viewport?.scrollPage(direction); },
    scrollHome() { viewport?.scrollHome(); },
    scrollEnd() { viewport?.scrollEnd(); },
    toggleTools() { toolsExpanded = !toolsExpanded; invalidateNative(); refresh(); },
  });

  pi.on("session_start", (event: any, nextCtx) => {
    // A reload may issue another start without a preceding shutdown.
    teardown(event?.reason === "reload");
    if (!nextCtx.hasUI) return;
    ctx = nextCtx;
    cachedArtifactDir = "project";
    try {
      const artifactDir = loadConfig().artifactDir;
      if (artifactDir === "project" || artifactDir === "session" || artifactDir === "temp") cachedArtifactDir = artifactDir;
    } catch {}
    try { cachedMarkdownTheme = getMarkdownTheme(); } catch { cachedMarkdownTheme = undefined; }
    nativeRenderer = new NativeChildConversationRenderer();
    const owner = ctx;
    const epoch = sessionEpoch;
    unsubscribeInput = ctx.ui.onTerminalInput((data: string) => controller.handleTerminalInput(data));
    eventUnsubscribes = [
      pi.events.on("subagent:async-started", (event: any) => { if (owner !== ctx || epoch !== sessionEpoch) return; browser.trackStarted(event); invalidateNative(); persist(); refresh(); }),
      pi.events.on("subagent:async-complete", (event: any) => { if (owner !== ctx || epoch !== sessionEpoch) return; browser.trackCompleted(event); persist(); reconcile(owner, epoch); }),
    ];
    pollTimer = setInterval(() => reconcile(owner, epoch), 500);
    (pollTimer as any)?.unref?.();
    ctx.ui.setFooter((tui: any, theme: any) => {
      syncMarkdownTheme();
      const component = createFooterComponent({ getCwd: () => owner.cwd, getHome: () => process.env.HOME, getModel: () => owner.model, getContextUsage: () => owner.getContextUsage(), getThinkingLevel: () => pi.getThinkingLevel(), getSnapshot: () => browser.snapshot(), getViewportPosition: () => viewport?.position(), requestRender: () => tui.requestRender(), theme });
      invalidateFooter = () => component.invalidate();
      return component;
    });
    reconcile(owner, epoch);
  });
  pi.on("model_select", refresh);
  pi.on("thinking_level_select", refresh);
  pi.on("session_shutdown", (event: any) => {
    teardown(event.reason === "reload");
  });
}
