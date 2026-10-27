import { readFile as readTextFile } from "node:fs/promises";
import { join } from "node:path";

// 默认路径锚定本 feature 模块所在仓库的 pi/AGENTS_SHARED.md：以 import.meta 定位
// 物理仓库根，child（含 worktree child，经绝对路径加载同一物理入口文件）与 main Host
// 解析到同一共享文件，不随 child cwd 或 HOME 漂移。
const DEFAULT_AGENTS_SHARED_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "pi",
  "AGENTS_SHARED.md",
);

const UNREADABLE_DIAGNOSTIC =
  "Required Pi shared AGENTS_SHARED.md is missing or unreadable";
const EMPTY_DIAGNOSTIC = "Required Pi shared AGENTS_SHARED.md is empty";

// AGENTS_SHARED 本体必须完全角色中立；角色区别由 runtime 以 scope 显式选择，
// 不让模型自行判断角色。共享块对 main/child 注入同一份源文字。
// SDK 以 section key 自动包裹外层 XML；来源说明留在正文。
const SHARED_INSTRUCTIONS_SOURCE = "来源：PI_CODING_AGENT_DIR/AGENTS_SHARED.md";

// child 专属的子执行边界块由 runtime 独立追加（不来自 AGENTS_SHARED，不按标题
// 解析抽取），只复用既有规范：既有 contact_supervisor need_decision 门禁、dispatch
// 合同的 writePaths/criteria、工单需用户确认；不发明新 authority/工具/权限。
const CHILD_EXECUTION_BOUNDARIES = [
  "来源：runtime",
  "- 不得新增委派（不得派生新的 subagent），不得接管或重排主计划 DAG；只推进当前任务范围。",
  "- 关键前提矛盾、将超出 writePaths、acceptance criteria 客观不可能，或权限/产品决策阻塞时：停止相关操作，经 contact_supervisor（reason: \"need_decision\"）上报并等待决定；不得自行推断安全开关或新增 fallback。",
  "- 工单/申请流程未经用户确认不得提交；需要时经主管代询。",
].join("\n");

// child 运行时 ACK 沿用 installed public 机制（pi-subagents runtime-acknowledged-extensions
// 的 RUNTIME_EXTENSION_ACK_EVENT / isRuntimeAcknowledgedExtensionId 形状）；
// 仅在成功读取共享文件且 handler 已安装后发出，ACK 观测不是 model 消费证明。
const RUNTIME_EXTENSION_ACK_EVENT = "subagent:acknowledge-extension";
const SHARED_EXTENSION_ACK_ID = "agents-shared";

async function loadInstructions(agentsSharedPath, readFile) {
  let content;
  try {
    content = await readFile(agentsSharedPath, "utf8");
  } catch {
    return { error: UNREADABLE_DIAGNOSTIC };
  }

  const instructions = content.trim();
  if (!instructions) return { error: EMPTY_DIAGNOSTIC };
  return { instructions };
}

function notifyConfigurationError(ctx, message) {
  try {
    ctx.ui?.notify?.(message, "error");
  } catch {
    // 通知失败不得重新打开 provider 路径。
  }
}

export function createAgentsSharedExtension(pi, {
  agentsSharedPath = DEFAULT_AGENTS_SHARED_PATH,
  readFile = readTextFile,
  // scope 由 Host binding 依据可靠环境事实（既有 child 标记）显式传入；
  // 缺省 main：共享注入是这段代码的默认职责，child 专属行为必须显式声明。
  scope = "main",
} = {}) {
  if (scope !== "main" && scope !== "child") {
    throw new TypeError("scope must be 'main' or 'child'");
  }

  let pendingInstructions;

  // 每次 input 读取一次快照，before_agent_start 消费。缺失/空文件在输入门禁
  // 通知并短路（handled）：这是输入门禁的覆盖边界，不得用错误 system prompt
  // 冒充 provider 硬阻断。
  pi.on("input", async (_event, ctx) => {
    pendingInstructions = undefined;
    const loaded = await loadInstructions(agentsSharedPath, readFile);
    if (loaded.error) {
      notifyConfigurationError(ctx, loaded.error);
      return { action: "handled" };
    }
    pendingInstructions = loaded.instructions;
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event) => {
    // 每轮持续声明自有 sections；只更新/撤回自己的 key，不解析其它 owner 的正文。
    // 未经过 input 的 startup before hook 仍可加载。此处读取失败只说明输入门禁
    // 覆盖不到该路径：不改写 system prompt 冒充 provider 错误，也不在 before hook
    // throw 声称 fail-closed（Host 会 catch before hook 异常，throw 不构成拦截）。
    const loaded = pendingInstructions === undefined
      ? await loadInstructions(agentsSharedPath, readFile)
      : { instructions: pendingInstructions };
    pendingInstructions = undefined;
    if (loaded.instructions === undefined) {
      delete event.systemPromptOptions.sections.pi_shared_instructions;
    } else {
      event.systemPromptOptions.sections.pi_shared_instructions =
        [SHARED_INSTRUCTIONS_SOURCE, loaded.instructions].join("\n");
    }

    if (scope === "child") {
      event.systemPromptOptions.sections.pi_child_execution_boundaries = CHILD_EXECUTION_BOUNDARIES;
    } else {
      delete event.systemPromptOptions.sections.pi_child_execution_boundaries;
    }
  });

  pi.on("session_start", async () => {
    // 必要 startup 校验：读取失败即抛错。child 侧由现有 required extension 的
    // startup 校验收集并使启动失败；main Host 只记录扩展错误（非 fatal），
    // 不另设 broker/authority/provider 拦截。
    const loaded = await loadInstructions(agentsSharedPath, readFile);
    if (loaded.error) {
      throw new Error(`${loaded.error}: ${agentsSharedPath}`);
    }
    pi.events?.emit?.(RUNTIME_EXTENSION_ACK_EVENT, { id: SHARED_EXTENSION_ACK_ID });
  });
}

export default createAgentsSharedExtension;
