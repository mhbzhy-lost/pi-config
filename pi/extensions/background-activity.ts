// 根后台活动 presenter 发布入口（统一执行计划 F6 / footer 子计划 T6a）。
//
// 职责边界（唯一 owner 合同）：
// - 本入口只在 Host 内存 bus 上发布根 presenter factory；`ctx.ui.setFooter` 与唯一
//   Alt+O 快捷键注册全部归 package（pi-subagents-enhanced）footer runtime，本入口
//   两者都不调用，也不构造 terminal overlay/editor，因此不存在扩展加载顺序 last-wins。
// - 握手与 F3/F4b 的 source publisher 同模式：先 listen owner-ready 再 emit
//   owner-request，只回答 manager/sessionId/hostKey 三要素同时匹配的 ready；重复 ready
//   复用同 registrationId（owner 侧幂等，不重复 setFooter、不关 overlay、不重置选中项）；
//   新 epoch 先按同 scope + 旧 registrationId exact 撤销旧注册再退订本地 ready。
// - owner-close 只用于丢弃当代 registered 标记（视图由 owner 自行 dispose），不撤销任务。
// - `ctx.mode === 'tui'` 门禁（hasUI 不足）：RPC/print/json 不发布 presenter，不为 RPC
//   构造 footer/overlay/editor；缺 session 身份时 fail closed 不发布，也不报错到 Host。
// - factory 由 F5b 的 `activityPresenterFactoryFor(uiDependencies)` curried 绑定 pi-tui
//   输入/宽度工具（Text/主题等依赖由各 source 与 SDK footer/overlay 渲染上下文提供），
//   根不反向依赖 package 内部实现，只经 feature 公开入口消费协议。
//
// 自动发现：本文件位于受控 `PI_CODING_AGENT_DIR/pi/extensions`，由 SDK 目录发现加载
// （F0 §8）；`--no-extensions` 下不加载，此时 package standalone footer 照常可用。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  BACKGROUND_ACTIVITY_CHANNELS,
  activityPresenterFactoryFor,
  createBackgroundActivityRegistrationId,
  defaultActivityPresenterUiDependencies,
  isHostScope,
  isSameHostScope,
  isSameHostScopeIdentity,
} from "../../src/background-activity/index.ts";
import type {
  ActivityPresenterFactory,
  HostScope,
  HostScopeIdentity,
  OwnerClosePayload,
  OwnerReadyPayload,
} from "../../src/background-activity/index.ts";

/** owner-ready 载荷校验：缺字段 fail closed，不猜测 payload、不补默认身份。 */
function isOwnerReadyPayload(value: unknown): value is OwnerReadyPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isHostScope(candidate.scope) && typeof candidate.ownerRegistrationId === "string" && candidate.ownerRegistrationId.length > 0;
}

/** owner-close 载荷校验：只接受携带合法 scope 的关闭通知。 */
function isOwnerClosePayload(value: unknown): value is OwnerClosePayload {
  return typeof value === "object" && value !== null && isHostScope((value as Record<string, unknown>).scope);
}

/** 单个发布 epoch：session_start 捕获的身份、当代 registrationId 与已注册 scope。 */
interface PresenterPublicationEpoch {
  readonly identity: HostScopeIdentity;
  readonly registrationId: string;
  readonly unsubscribeReady: () => void;
  readonly unsubscribeClose: () => void;
  registered: { scope: HostScope; registrationId: string } | undefined;
}

export default function backgroundActivity(pi: ExtensionAPI): void {
  // F5b 冻结签名：activityPresenterFactoryFor(uiDependencies) → ActivityPresenterFactory。
  // uiDependencies 绑定 pi-tui 公开输入/宽度工具（含 Text 场景所需的 stripTerminalSequences
  // 等显示能力）；SDK 主题与 footerData 由 owner 调用 createFooter 时的渲染上下文提供。
  const factory: ActivityPresenterFactory = activityPresenterFactoryFor(defaultActivityPresenterUiDependencies());
  let epoch: PresenterPublicationEpoch | undefined;

  const emitOrIgnore = (channel: string, data: unknown): void => {
    // owner 缺席或 bus 失效不是 Host 故障：不发布即保持 package standalone footer。
    try { pi.events.emit(channel, data); } catch { /* 展示握手失败不向 Host/任务链路传播 */ }
  };

  const teardown = (): void => {
    const current = epoch;
    epoch = undefined; // 旧 ctx/闭包先失效：此后 late ready/close 都不匹配当代
    if (!current) return;
    try { current.unsubscribeReady(); } catch { /* 退订异常不阻断清理 */ }
    try { current.unsubscribeClose(); } catch { /* 同上 */ }
    if (current.registered) {
      // exact 撤销：只携带同 scope（含 owner token）+ 同 registrationId；owner 侧
      // 过期 ID 撤销无效，不会误删新注册。
      emitOrIgnore(BACKGROUND_ACTIVITY_CHANNELS.presenterUnregister, {
        scope: current.registered.scope,
        registrationId: current.registered.registrationId,
      });
    }
  };

  pi.on("session_start", (_event, ctx) => {
    teardown(); // 新 epoch 先 exact 撤销旧注册，避免双 presenter
    if (ctx.mode !== "tui") return; // RPC/print/json：不发布 presenter，不构造 terminal UI
    const manager: unknown = ctx.sessionManager;
    if (typeof manager !== "object" || manager === null) return;
    let sessionId: string;
    try {
      sessionId = (manager as { getSessionId(): string }).getSessionId();
    } catch {
      return; // 缺 session 身份：fail closed 不发布，不猜测 scope
    }
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    const identity: HostScopeIdentity = { sessionManager: manager, sessionId, hostKey: manager };
    const registrationId = createBackgroundActivityRegistrationId();

    const handleReady = (data: unknown): void => {
      const current = epoch;
      if (!current || current.registrationId !== registrationId) return; // 旧 epoch 闭包守卫
      if (!isOwnerReadyPayload(data)) return;
      const { scope } = data;
      if (!isSameHostScopeIdentity(scope, identity)) return; // 只回答同 Host 身份的 owner
      current.registered = { scope, registrationId }; // 重复 ready 复用同 registrationId，owner 侧幂等
      emitOrIgnore(BACKGROUND_ACTIVITY_CHANNELS.presenterRegister, { scope, registrationId, factory });
    };

    const handleClose = (data: unknown): void => {
      const current = epoch;
      if (!current || !isOwnerClosePayload(data)) return;
      const registered = current.registered;
      if (!registered || !isSameHostScope(registered.scope, data.scope)) return;
      // owner 已清理当代整体（视图由其 dispose）：丢弃标记，避免 shutdown 再发过期撤销。
      current.registered = undefined;
    };

    let unsubscribeReady: () => void = () => undefined;
    let unsubscribeClose: () => void = () => undefined;
    try {
      unsubscribeReady = pi.events.on(BACKGROUND_ACTIVITY_CHANNELS.ownerReady, handleReady); // 先 listen ready
      unsubscribeClose = pi.events.on(BACKGROUND_ACTIVITY_CHANNELS.ownerClose, handleClose);
    } catch { /* 订阅失败保持未发布；package standalone footer 不受影响 */ }
    epoch = { identity, registrationId, unsubscribeReady, unsubscribeClose, registered: undefined };
    emitOrIgnore(BACKGROUND_ACTIVITY_CHANNELS.ownerRequest, identity); // 再 request：请匹配 owner 重发 ready
  });

  pi.on("session_shutdown", () => {
    teardown();
  });
}
