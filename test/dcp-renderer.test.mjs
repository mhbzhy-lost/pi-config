import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { setRenderStatus } from "../src/compact-tools/index.ts";
import { createDcpRenderer } from "../src/dcp/renderer.ts";

// 直接消费 resolver 产物：compress 渲染只依赖 pi-tui 与 compact-tools 公开入口，
// 不初始化 Host/session；PI_EXPERIMENTAL 与 jiti 运行时均与本渲染契约无关。
const compress = createDcpRenderer()("compress", () => undefined);
assert.ok(compress, "compress resolver 应认领 compress 工具");
assert.equal(compress.renderShell, "self");
assert.equal(createDcpRenderer()("read", () => undefined), undefined, "非 compress 工具应原样交还 next()");

// stub theme：fg/bold 返回原文，保持断言可读（参考 test/compact-tools-renderer.test.mjs）。
const theme = { bold: (text) => text, fg: (_color, text) => text };
const plain = (lines) => stripVTControlCharacters(lines.join("\n"));

function context(args, overrides = {}) {
  return {
    args,
    isError: false,
    expanded: false,
    isPartial: false,
    state: {},
    toolCallId: "fixture-compress",
    cwd: "/tmp",
    executionStarted: true,
    argsComplete: true,
    showImages: false,
    lastComponent: undefined,
    invalidate() {},
    ...overrides,
  };
}

const successResult = { content: [{ type: "text", text: "已压缩 12 条消息（m0001-m0012）" }], details: {} };
const failureResult = {
  content: [{ type: "text", text: "compress 失败：范围边界 m0012 不存在\n第二行堆栈\n最后错误" }],
  details: {},
  isError: true,
};

test("折叠成功：renderCall 单行含 compress 与 topic，renderResult 空体且吞点击", () => {
  const args = { topic: "Auth System Exploration", content: [{ startId: "m0001", endId: "m0012", summary: "auth 调研摘要" }] };
  const ctx = context(args);
  const call = compress.renderCall(args, theme, ctx);
  const before = structuredClone(args);
  const lines = call.render(120);

  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.match(plain(lines), /compress Auth System Exploration/);
  assert.deepEqual(args, before);

  // 成功结果到达后 Host 会重跑 renderCall（updateDisplay），此时 glyph 为终态 ✓ 且仍吞左键点击。
  const output = compress.renderResult(successResult, { expanded: false, isPartial: false }, theme, ctx);
  assert.deepEqual(output.render(120), [], "成功折叠结果体应收空");
  const settled = compress.renderCall(args, theme, ctx).render(120);
  assert.match(plain(settled), /^✓ compress Auth System Exploration$/);
  assert.deepEqual(compress.renderResult(successResult, { expanded: false, isPartial: false }, theme, ctx).handleMouse({ type: "click", button: "left" }), { handled: true }, "成功结果体应吞掉左键展开点击");
  assert.equal(call.handleMouse({ type: "click", button: "left" }).handled, true, "成功 call 头应吞掉左键展开点击");
  assert.equal(ctx.state.status, "success");
});

test("partial 成功同样收空结果体", () => {
  const ctx = context({ topic: "Auth System Exploration" });
  const output = compress.renderResult({ content: [{ type: "text", text: "压缩中" }] }, { expanded: false, isPartial: true }, theme, ctx);
  assert.deepEqual(output.render(120), []);
  assert.equal(ctx.state.status, "loading");
});

test("失败：折叠单行含错误首行，展开渲染完整 content 全文", () => {
  const args = { topic: "Auth System Exploration" };
  const ctx = context(args, { isError: true });
  const before = structuredClone(failureResult);
  const collapsed = compress.renderResult(failureResult, { expanded: false, isPartial: false }, theme, ctx);

  const lines = collapsed.render(80);
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.ok(lines.every((line) => visibleWidth(line) <= 80), JSON.stringify(lines));
  assert.match(plain(lines), /compress 失败：范围边界 m0012 不存在/);
  assert.doesNotMatch(plain(lines), /第二行堆栈|最后错误/);
  // 失败结果不吞点击：无 handleMouse，交还 Host 的展开 MouseRegion。
  assert.equal(typeof collapsed.handleMouse, "undefined");

  const expandedCtx = context(args, { isError: true, expanded: true });
  const expanded = compress.renderResult(failureResult, { expanded: true, isPartial: false }, theme, expandedCtx);
  const full = expanded.render(120);
  assert.match(plain(full), /compress 失败：范围边界 m0012 不存在/);
  assert.match(plain(full), /第二行堆栈/);
  assert.match(plain(full), /最后错误/);
  assert.ok(full.every((line) => visibleWidth(line) <= 120), JSON.stringify(full));
  assert.deepEqual(failureResult, before);

  // 失败后 Host 重跑 renderCall：glyph 为 ✗；call 头恒为 MouseRegion，
  // 但 onMouse 运行时读 state.status，失败态放行点击（可展开看完整错误）。
  const failedCall = compress.renderCall(args, theme, ctx);
  assert.match(plain(failedCall.render(120)), /^✗ compress Auth System Exploration$/);
  assert.equal(failedCall.handleMouse({ type: "click", button: "left" }), undefined, "失败态 call 头应放行点击");
  assert.equal(ctx.state.status, "failure");

  // 当帧时序：updateDisplay 先跑 renderCall 后跑 renderResult，失败状态由 renderResult 写入。
  // 同一 call 组件实例在状态翻转前后行为应立即切换（修复构造时判定的滞后一拍）。
  const liveCtx = context({ topic: "Auth" }, {});
  const liveCall = compress.renderCall({ topic: "Auth" }, theme, liveCtx);
  assert.equal(liveCall.handleMouse({ type: "click", button: "left" }).handled, true, "运行中 call 头应吞点击");
  setRenderStatus(liveCtx, "failure");
  assert.equal(liveCall.handleMouse({ type: "click", button: "left" }), undefined, "同一实例状态翻转为失败后应立即放行");
  assert.equal(liveCall.handleMouse({ type: "click", button: "right" }), undefined, "非左键 click 不处理");
});

test("失败空文本：折叠回退占位、展开 dim 占位不崩", () => {
  const empty = { content: [], details: {}, isError: true };
  const ctx = context({ topic: "Auth" }, { isError: true });
  const collapsed = compress.renderResult(empty, { expanded: false, isPartial: false }, theme, ctx);
  assert.equal(collapsed.render(80).length, 1);
  assert.match(plain(collapsed.render(80)), /工具执行失败/);
  const expanded = compress.renderResult(empty, { expanded: true, isPartial: false }, theme, context({ topic: "Auth" }, { isError: true, expanded: true }));
  assert.match(plain(expanded.render(80)), /压缩失败/);
});

test("topic 缺失/非 string：renderCall 仅显示 compress 且不崩", () => {
  for (const args of [undefined, {}, { topic: 42 }, { topic: null }, { content: [{ startId: "m1", endId: "m2", summary: "s" }] }]) {
    const call = compress.renderCall(args, theme, context(args));
    const lines = call.render(120);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.match(plain(lines), /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] compress$/);
  }
});

test("超长 topic 按宽度截断：glyph 计入预算且保持单行不超宽", () => {
  const args = { topic: "A very long compression topic label that must be truncated".repeat(2) };
  const call = compress.renderCall(args, theme, context(args));
  for (const width of [20, 40, 120]) {
    const lines = call.render(width);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `width=${width}: ${JSON.stringify(lines)}`);
    assert.match(plain(lines), /^.{0,2} compress/);
  }
  // 中文宽字符 topic 也不超宽。
  const cjk = compress.renderCall({ topic: "认证系统调研与压缩".repeat(6) }, theme, context({}));
  assert.equal(cjk.render(24).length, 1);
  assert.ok(visibleWidth(cjk.render(24)[0]) <= 24);
});
