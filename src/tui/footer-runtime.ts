import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createActivityRegistry, activitySources, subscribeActivitySources, subscribeRemoteActivitySources } from "./background-activity.ts";
import { createFooterComponent } from "./footer-layout.ts";
import { createSubagentActivitySource } from "./subagent-activity.ts";
import { createSubagentBrowser } from "./session-browser.ts";
import { ReadOnlyBrowserEditor } from "./session-viewport.ts";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function createFooterRuntime(pi: ExtensionAPI): { openBrowser(ctx: { sessionManager?: unknown }): void } {
  let current: ExtensionContext | undefined;
  let registry: ReturnType<typeof createActivityRegistry> | undefined;
  let source: ReturnType<typeof createSubagentActivitySource> | undefined;
  let sourceUnsubscribe: (() => void) | undefined;
  let remoteSourceUnsubscribe: (() => void) | undefined;
  let activityUnsubscribe: (() => void) | undefined;
  let closeOverlay: (() => void) | undefined;
  let restoreEditor: (() => void) | undefined;
  let requestFooterRender = () => undefined;

  const teardown = () => {
    try { closeOverlay?.(); } catch { /* stale UI context */ }
    closeOverlay = undefined;
    try { restoreEditor?.(); } catch { /* stale UI context */ }
    restoreEditor = undefined;
    sourceUnsubscribe?.();
    remoteSourceUnsubscribe?.();
    activityUnsubscribe?.();
    sourceUnsubscribe = undefined;
    remoteSourceUnsubscribe = undefined;
    activityUnsubscribe = undefined;
    registry?.dispose();
    registry = undefined;
    source = undefined;
    current = undefined;
    requestFooterRender = () => undefined;
  };

  const openBrowser = (shortcutCtx: { sessionManager?: unknown }) => {
    if (!registry || !current || shortcutCtx?.sessionManager !== current.sessionManager) return;
    const owner = current;
    const previousEditor = owner.ui.getEditorComponent?.();
    const previousDraft = owner.ui.getEditorText?.();
    let restored = false;
    restoreEditor = () => {
      if (restored) return;
      restored = true;
      try { owner.ui.setEditorComponent?.(previousEditor); } catch { /* stale UI context */ }
      try { if (previousDraft !== undefined) owner.ui.setEditorText?.(previousDraft); } catch { /* stale UI context */ }
    };
    owner.ui.setEditorComponent?.((tui, theme, keybindings) => new ReadOnlyBrowserEditor(tui, theme, keybindings));
    void owner.ui.custom((tui, theme, _keybindings, done) => {
      closeOverlay = () => {
        try { done(undefined); } finally {
          closeOverlay = undefined;
          restoreEditor?.();
          restoreEditor = undefined;
        }
      };
      return createSubagentBrowser({
        model: registry!,
        theme,
        requestRender: () => tui.requestRender(),
        close: () => closeOverlay?.(),
        getTerminalRows: () => tui.terminal.rows,
      });
    }, {
      overlay: true,
      overlayOptions: { row: 0, col: 0, width: "100%", maxHeight: "100%", margin: { bottom: 4 } },
      onHandle: (handle) => handle.focus(),
    }).catch(() => {
      closeOverlay = undefined;
      restoreEditor?.();
      restoreEditor = undefined;
    });
  };

  pi.on("session_start", (_event, ctx) => {
    teardown();
    if (ctx.mode !== "tui") return;
    current = ctx;
    source = createSubagentActivitySource(pi);
    registry = createActivityRegistry([...activitySources(pi), source]);
    const remoteSources = new Map<string, { registrationId: string; source: import("./background-activity.ts").ActivitySource }>();
    const refreshAllSources = () => {
      if (!registry || !source) return;
      const allSources = [
        ...activitySources(pi),
        ...[...remoteSources.values()].map((entry) => entry.source),
        source,
      ];
      registry.setSources([...new Set(allSources)]);
    };
    sourceUnsubscribe = subscribeActivitySources(pi, refreshAllSources);
    remoteSourceUnsubscribe = subscribeRemoteActivitySources(pi, (registration) => {
      const existing = remoteSources.get(registration.id);
      if (existing?.registrationId === registration.registrationId && existing.source === registration.source) return;
      remoteSources.set(registration.id, { registrationId: registration.registrationId, source: registration.source });
      refreshAllSources();
    }, (registration) => {
      const existing = remoteSources.get(registration.id);
      if (!existing || existing.registrationId !== registration.registrationId) return;
      remoteSources.delete(registration.id);
      refreshAllSources();
    });

    const footerFactory = (tui: { requestRender(): void }, theme: any, _footerData: unknown) => createFooterComponent({
      getCwd: () => ctx.cwd,
      getModel: () => ctx.model,
      getThinking: () => ctx.thinkingLevel,
      getContextUsage: () => ctx.getContextUsage?.(),
      getSnapshot: () => registry!.snapshot(),
      requestRender: () => tui.requestRender(),
      theme,
      visibleWidth,
      truncateToWidth,
    });

    let footerRequestRender: (() => void) | undefined;
    // The factory is evaluated by Pi when the footer is mounted. Keep its current
    // TUI requestRender callback; source invalidation never reinstalls the footer.
    requestFooterRender = () => {
      try { footerRequestRender?.(); } catch { /* stale TUI context */ }
    };
    const mountedFooterFactory = (tui: { requestRender(): void }, theme: any, footerData: unknown) => {
      footerRequestRender = () => tui.requestRender();
      return footerFactory(tui, theme, footerData);
    };
    activityUnsubscribe = registry.subscribe(() => requestFooterRender());
    ctx.ui.setFooter(mountedFooterFactory);
  });

  pi.on("session_shutdown", teardown);
  return { openBrowser };
}
