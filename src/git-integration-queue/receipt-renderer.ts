import { Text } from "@earendil-works/pi-tui";
import type { MessageRenderer } from "@earendil-works/pi-coding-agent";

export const GIT_INTEGRATION_MESSAGE = "git-worktree-integration";

export function createGitIntegrationReceiptRenderer(): MessageRenderer {
  return (message: any, options: any, theme: any) => {
    const receipts = Array.isArray(message?.details?.receipts) ? message.details.receipts : [];
    if (!receipts.length) return undefined;
    const lines = receipts.map((receipt: any) => {
      const failed = receipt.outcome === "preserved" || receipt.outcome === "failed-closed";
      const mark = failed ? "✗" : "✓";
      const detail = receipt.reasonCode ?? receipt.queueRequestId ?? receipt.outcome;
      return `${mark} git integration · ${receipt.outcome} · ${detail}`;
    });
    const content = options.expanded
      ? `${lines.join("\n")}\n\ndetails:\n${JSON.stringify(message.details, null, 2)}`
      : lines.join("\n");
    const failed = receipts.some((receipt: any) => receipt.outcome === "preserved" || receipt.outcome === "failed-closed");
    return new Text(theme.fg(failed ? "error" : "dim", content), Math.max(0, Math.floor(options.outputPad ?? 1)), 0);
  };
}
