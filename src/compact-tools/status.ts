export type CompactRenderStatus = "loading" | "success" | "failure";
export const COMPACT_STATUS_KEY = "compactToolsStatus";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const loadingTimers = new WeakMap<object, ReturnType<typeof setInterval>>();

type ThemeLike = { fg(color: string, text: string): string };
type RenderContextLike = { state?: object; invalidate?: () => void } | undefined;

/**
 * loading 状态需要主动触发 TUI 重绘；终态到达后立即清理，不把 timer 写入 renderer state。
 * 无 invalidate 的纯单元测试/离线投影不会启动 timer。
 */
export function syncStatusAnimation(context: RenderContextLike, status: CompactRenderStatus | undefined): void {
  const state = context?.state;
  if (!state) return;
  const current = loadingTimers.get(state);
  const loading = status === undefined || status === "loading";
  if (!loading) {
    if (current) {
      clearInterval(current);
      loadingTimers.delete(state);
    }
    return;
  }
  if (current || typeof context?.invalidate !== "function") return;
  const timer = setInterval(() => {
    try {
      context.invalidate!();
    } catch {
      clearInterval(timer);
      loadingTimers.delete(state);
    }
  }, 120);
  timer.unref?.();
  loadingTimers.set(state, timer);
}

export function statusGlyph(theme: ThemeLike, status: CompactRenderStatus | undefined, now = Date.now()): string {
  if (status === "success") return theme.fg("success", "✓");
  if (status === "loading" || status === undefined) {
    return theme.fg("dim", SPINNER_FRAMES[Math.floor(now / 120) % SPINNER_FRAMES.length]!);
  }
  return theme.fg("error", "✗");
}
