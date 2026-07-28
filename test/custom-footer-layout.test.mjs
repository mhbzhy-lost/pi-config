import assert from "node:assert/strict";
import test from "node:test";

const layoutModule = await import("../scripts/lib/custom-footer-layout.mjs").catch(() => undefined);

const visibleWidth = (text) => text.length;
const truncateToWidth = (text, width, ellipsis = "...") => {
  if (text.length <= width) return text;
  if (width <= ellipsis.length) return ellipsis.slice(0, width);
  return text.slice(0, width - ellipsis.length) + ellipsis;
};

test("footer component uses the current model and requests a rerender when invalidated", () => {
  assert.equal(
    typeof layoutModule.createFooterComponent,
    "function",
    "custom footer component factory should exist",
  );

  let renderRequests = 0;
  let currentModel = {
    provider: "anthropic-idealab",
    id: "claude-opus-4-6",
    contextWindow: 200_000,
  };
  const component = layoutModule.createFooterComponent({
    getCwd: () => "/Users/test/workspace",
    getHome: () => "/Users/test",
    getModel: () => currentModel,
    getContextUsage: () => ({ tokens: 10_000, contextWindow: currentModel.contextWindow, percent: 5 }),
    getThinkingLevel: () => "medium",
    getBranch: () => [{
      type: "message",
      message: {
        role: "assistant",
        provider: "codex-pool",
        model: "gpt-5.6-sol",
        usage: { input: 10_000, cacheRead: 0, cacheWrite: 0 },
      },
    }],
    requestRender: () => { renderRequests += 1; },
    theme: { fg: (_color, text) => text },
    visibleWidth,
    truncateToWidth,
  });

  assert.match(component.render(100)[1], /\(anthropic-idealab\) claude-opus-4-6$/);

  currentModel = {
    provider: "codex-pool",
    id: "gpt-5.6-sol",
    contextWindow: 272_000,
  };
  component.invalidate();

  assert.equal(renderRequests, 1);
  assert.match(component.render(100)[1], /\(codex-pool\) gpt-5.6-sol$/);
});

test("footer renders subagents below cwd while keeping context, provider/model, and thinking right-aligned", () => {
  const component = layoutModule.createFooterComponent({
    getCwd: () => "/Users/test/workspace",
    getHome: () => "/Users/test",
    getModel: () => ({
      provider: "codex-pool",
      id: "gpt-5.6-sol",
      contextWindow: 272_000,
    }),
    getContextUsage: () => ({ tokens: 207_000, contextWindow: 272_000, percent: 76.1 }),
    getThinkingLevel: () => "high",
    getSubagentStatus: () => "executor, reviewer",
    requestRender: () => {},
    theme: { fg: (_color, text) => text },
    visibleWidth,
    truncateToWidth,
  });

  const lines = component.render(58);
  const providerModel = "(codex-pool) gpt-5.6-sol";
  const subagentStatus = "executor, reviewer";
  assert.deepEqual(lines, [
    `~/workspace${"76.1%/272k".padStart(47)}`,
    `${subagentStatus}${providerModel.padStart(58 - subagentStatus.length)}`,
    "thinking: high".padStart(58),
  ]);
});

test("footer clears stale assistant usage when compaction makes context usage unknown", () => {
  let contextUsage = { tokens: 160_000, contextWindow: 200_000, percent: 80 };
  const component = layoutModule.createFooterComponent({
    getCwd: () => "/Users/test/workspace",
    getHome: () => "/Users/test",
    getModel: () => ({
      provider: "anthropic-idealab",
      id: "claude-opus-4-6",
      contextWindow: 200_000,
    }),
    getContextUsage: () => contextUsage,
    getBranch: () => [{
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 160_000, cacheRead: 0, cacheWrite: 0 },
      },
    }],
    requestRender: () => {},
    theme: { fg: (_color, text) => text },
    visibleWidth,
    truncateToWidth,
  });

  assert.match(component.render(100)[0], /80\.0%\/200k/);

  contextUsage = { tokens: null, contextWindow: 200_000, percent: null };
  component.invalidate();

  const compacted = component.render(100)[0];
  assert.match(compacted, /\?\/200k/);
  assert.doesNotMatch(compacted, /80\.0%/);
});

test("footer truncates a long cwd to fit a 58-column terminal", () => {
  assert.ok(layoutModule, "custom footer layout module should exist");

  const line = layoutModule.layoutFooter({
    width: 58,
    left: "~/new-api-account-pool",
    right: "76.1%/272k  (codex-pool) gpt-5.6-sol",
    visibleWidth,
    truncateToWidth,
  });

  assert.ok(visibleWidth(line) <= 58);
  assert.ok(line.endsWith("76.1%/272k  (codex-pool) gpt-5.6-sol"));
  assert.match(line, /^~\/new-api-account/);
});

test("footer truncates the right status when it alone exceeds terminal width", () => {
  assert.ok(layoutModule, "custom footer layout module should exist");

  const line = layoutModule.layoutFooter({
    width: 12,
    left: "~/workspace",
    right: "context provider model",
    visibleWidth,
    truncateToWidth,
  });

  assert.equal(visibleWidth(line), 12);
});
