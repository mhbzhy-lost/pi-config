/**
 * Goal 能力设置隔离开关（Goal Runtime v1 / Task T0）。
 *
 * 契约：读取设置顶层 `goalEngine.enabled`，仅布尔 `true` 才算启用；字段缺失、`false`、
 * 非布尔值、`goalEngine` 非对象或设置快照不可读，一律 fail-closed 解析为关闭，并产出一行
 * 中文诊断说明解析来源。解析是纯函数：不读写文件、不抛错、不弹窗，便于单测与 Host 复用。
 *
 * 使用方（T7 Host 入口）负责提供设置快照并在 gate 关闭时把整个 goal 入口退化为 no-op；
 * 本模块不注册工具、不挂 hook、不做任何 Host 接线。
 */

/** 解析来源：`settings` 表示读到 `goalEngine` 字段；`default` 表示字段缺失/设置不可用而取默认。 */
export type GoalEngineGateSource = "settings" | "default";

export type GoalEngineGate = {
  /** 是否启用 Goal 能力；只有设置里显式写入布尔 `true` 才为 true。 */
  enabled: boolean;
  /** 解析来源，便于 Host 与验收区分“设置关闭”和“默认关闭”。 */
  source: GoalEngineGateSource;
  /** 单行中文诊断：说明解析来源与结论，可直接写入日志。 */
  diagnostic: string;
};

export type GoalEngineGateInput = {
  /**
   * 设置快照。可以是 Pi 1.4 `SettingsManager` 实例（duck-typed：调用其 `getSettings()`），
   * 也可以是通过 `getSettings()` 取好的设置对象；缺省按“无设置”处理。
   */
  settings?: unknown;
  /** 诊断中标注的设置文件来源，默认 `pi/settings.json`。 */
  settingsPath?: string;
  /** 可选诊断出口；仅在传入时输出单行诊断，保证解析本身无副作用。 */
  emit?: (line: string) => void;
};

const DEFAULT_SETTINGS_PATH = "pi/settings.json";
const DIAGNOSTIC_PREFIX = "[goal-engine]";
const VALUE_PREVIEW_LIMIT = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 把任意错误压成单行短文本，诊断不得换行。 */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim() || "未知错误";
}

/** 值预览：压成单行并截断，避免诊断被超长取值撑开。 */
function preview(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.replace(/\s+/g, " ").slice(0, VALUE_PREVIEW_LIMIT);
}

/**
 * 取得设置快照：支持 SettingsManager 实例与既有设置对象两种输入。
 * 读取异常按“设置不可用”返回，绝不向上抛出。
 */
function settingsSnapshot(settings: unknown): { snapshot?: Record<string, unknown>; reason?: string } {
  if (settings === undefined || settings === null) return { reason: "调用方未提供设置快照" };
  if (isRecord(settings) && typeof settings.getSettings === "function") {
    try {
      const resolved = (settings as { getSettings: () => unknown }).getSettings();
      return isRecord(resolved) ? { snapshot: resolved } : { reason: "SettingsManager 返回的设置不是对象" };
    } catch (error) {
      return { reason: `读取 SettingsManager 失败：${errorText(error)}` };
    }
  }
  return isRecord(settings) ? { snapshot: settings } : { reason: "设置快照不是对象" };
}

/** 组装 gate 结果：诊断固定为单行，可选输出到调用方传入的出口。 */
function conclude(
  enabled: boolean,
  source: GoalEngineGateSource,
  detail: string,
  emit?: (line: string) => void,
): GoalEngineGate {
  const diagnostic = `${DIAGNOSTIC_PREFIX} ${detail.replace(/\s+/g, " ").trim()}`;
  if (emit) {
    // 诊断出口由调用方提供；出口自身失败不影响解析结论，也不抛出。
    try {
      emit(diagnostic);
    } catch {
      // 输出失败只丢失可观测性，不改变 fail-closed 结论。
    }
  }
  return { enabled, source, diagnostic };
}

/**
 * 解析 Goal 能力总开关。
 *
 * 只有设置顶层 `goalEngine.enabled === true` 才返回 `enabled: true`；其余所有形态
 * （缺失、`false`、非布尔、`goalEngine` 非对象、设置快照不可用）都返回关闭。
 */
export function resolveGoalEngineGate(input: GoalEngineGateInput = {}): GoalEngineGate {
  const settingsPath = input.settingsPath?.trim() || DEFAULT_SETTINGS_PATH;
  const { snapshot, reason } = settingsSnapshot(input.settings);
  if (!snapshot) {
    return conclude(
      false,
      "default",
      `未读到 ${settingsPath} 的有效设置（${reason ?? "设置不可用"}），按 fail-closed 默认关闭 Goal 能力`,
      input.emit,
    );
  }

  const goalEngine = snapshot.goalEngine;
  if (goalEngine === undefined) {
    return conclude(
      false,
      "default",
      `${settingsPath} 顶层未设置 goalEngine，按 fail-closed 默认关闭 Goal 能力`,
      input.emit,
    );
  }
  if (!isRecord(goalEngine)) {
    return conclude(
      false,
      "settings",
      `${settingsPath} 顶层 goalEngine 不是对象（实际值 ${preview(goalEngine)}），按 fail-closed 关闭 Goal 能力`,
      input.emit,
    );
  }

  const enabled = goalEngine.enabled;
  if (enabled === true) {
    return conclude(true, "settings", `${settingsPath} 顶层 goalEngine.enabled=true，启用 Goal 能力`, input.emit);
  }
  if (enabled === false) {
    return conclude(false, "settings", `${settingsPath} 顶层 goalEngine.enabled=false，关闭 Goal 能力`, input.emit);
  }
  if (enabled === undefined) {
    return conclude(
      false,
      "settings",
      `${settingsPath} 顶层 goalEngine 缺少 enabled 字段，按 fail-closed 关闭 Goal 能力`,
      input.emit,
    );
  }
  return conclude(
    false,
    "settings",
    `${settingsPath} 顶层 goalEngine.enabled 不是布尔值（实际值 ${preview(enabled)}），按 fail-closed 关闭 Goal 能力`,
    input.emit,
  );
}
