import { readFile as readTextFile } from "node:fs/promises";
import { join } from "node:path";

// 默认路径锚定本 feature 模块所在仓库的 pi/AGENTS_GLOBAL.md：以 import.meta 定位
// 物理仓库根，不随进程 cwd 或 HOME 漂移，worktree 进程也不用 cwd 识别角色。
// GLOBAL 仅由 main 会话经 Host binding 显式加载；child 不读取本文件（见
// pi/extensions/agents-global.ts 的 child guard）。
const DEFAULT_AGENTS_GLOBAL_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "pi",
  "AGENTS_GLOBAL.md",
);

const UNREADABLE_DIAGNOSTIC =
  "Required Pi global AGENTS_GLOBAL.md is missing or unreadable";
const EMPTY_DIAGNOSTIC = "Required Pi global AGENTS_GLOBAL.md is empty";

// SDK 以 section key 自动包裹外层 XML；来源说明留在正文，不重复外层 tag。
const GLOBAL_INSTRUCTIONS_SOURCE = "来源：PI_CODING_AGENT_DIR/AGENTS_GLOBAL.md";

async function loadInstructions(agentsGlobalPath, readFile) {
  let content;
  try {
    content = await readFile(agentsGlobalPath, "utf8");
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

// main 专属注入工厂：每次 input 读取一次快照，before_agent_start 每轮声明
// 自有 section。只更新/撤回自己的 key，不解析其它 section，不改写
// user/tool/session 内容。缺失/空文件在输入门禁通知并短路（handled），不得把
// 错误 prompt 当成 provider 硬拦截。
export function createAgentsGlobalExtension(pi, {
  agentsGlobalPath = DEFAULT_AGENTS_GLOBAL_PATH,
  readFile = readTextFile,
} = {}) {
  let pendingInstructions;

  pi.on("input", async (_event, ctx) => {
    pendingInstructions = undefined;
    const loaded = await loadInstructions(agentsGlobalPath, readFile);
    if (loaded.error) {
      notifyConfigurationError(ctx, loaded.error);
      return { action: "handled" };
    }
    pendingInstructions = loaded.instructions;
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event) => {
    // 未经过 input 的 startup before hook 仍可加载。此处读取失败只说明输入门禁
    // 覆盖不到该路径：不改写 system prompt 冒充 provider 错误，也不在 before hook
    // throw 声称 fail-closed（Host 会 catch before hook 异常，throw 不构成拦截）。
    const loaded = pendingInstructions === undefined
      ? await loadInstructions(agentsGlobalPath, readFile)
      : { instructions: pendingInstructions };
    pendingInstructions = undefined;
    if (loaded.instructions === undefined) {
      delete event.systemPromptOptions.sections.pi_global_instructions;
    } else {
      event.systemPromptOptions.sections.pi_global_instructions =
        [GLOBAL_INSTRUCTIONS_SOURCE, loaded.instructions].join("\n");
    }
  });

  pi.on("session_start", async () => {
    // startup 校验：读取失败即抛扩展错误（main Host 记录为非 fatal extension
    // error），不伪 provider 硬拦截。不发 ACK：GLOBAL 不参与 child required 注册，
    // child 进程根本不会加载本入口。
    const loaded = await loadInstructions(agentsGlobalPath, readFile);
    if (loaded.error) {
      throw new Error(`${loaded.error}: ${agentsGlobalPath}`);
    }
  });
}

export default createAgentsGlobalExtension;
