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

// 独立 system tag：与 <pi_shared_instructions>、<pi_child_execution_boundaries>
// 并列的另一块，互不包含、互不解析；正文是规则本身，不含角色判定文字。
const GLOBAL_BLOCK_OPEN =
  '<pi_global_instructions source="PI_CODING_AGENT_DIR/AGENTS_GLOBAL.md">';
const GLOBAL_BLOCK_CLOSE = "</pi_global_instructions>";

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

function globalBlock(instructions) {
  return [GLOBAL_BLOCK_OPEN, instructions, GLOBAL_BLOCK_CLOSE].join("\n");
}

// 在 base 中定位自有块的精确区间；块被其它内容包裹时只认完整 open+close 对，
// 格式不完整（缺 close）时不动 base，避免误伤其它 feature 的内容。
function findOwnBlock(base) {
  const start = base.indexOf(GLOBAL_BLOCK_OPEN);
  if (start === -1) return undefined;
  const closeIndex = base.indexOf(GLOBAL_BLOCK_CLOSE, start);
  if (closeIndex === -1) return undefined;
  return { start, end: closeIndex + GLOBAL_BLOCK_CLOSE.length };
}

// main 专属注入工厂：每次 input 读取一次快照，before_agent_start 以独立
// <pi_global_instructions> 块追加到 system（与 shared 各自独立成块）。自有块
// 去重且只在内容变化时最小替换自有区间，不 strip 其它 feature 的 tag，不改写
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
    const base = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
    const ownBlock = findOwnBlock(base);

    if (ownBlock !== undefined) {
      // 自有块已存在（Host 每轮由原始 base 重建 system，此情形来自重复 hook/
      // 双重加载或跨轮残留）：不静默丢弃本轮新快照，仅当存在 pending 且内容
      // 不同时最小替换自有区间；其余情况不动 base。
      if (pendingInstructions === undefined) return undefined;
      const fresh = globalBlock(pendingInstructions);
      pendingInstructions = undefined;
      if (base.slice(ownBlock.start, ownBlock.end) === fresh) return undefined;
      return {
        systemPrompt:
          base.slice(0, ownBlock.start) + fresh + base.slice(ownBlock.end),
      };
    }

    // 未经过 input 的 startup before hook 仍可加载。此处读取失败只说明输入门禁
    // 覆盖不到该路径：不改写 system prompt 冒充 provider 错误，也不在 before hook
    // throw 声称 fail-closed（Host 会 catch before hook 异常，throw 不构成拦截）。
    const loaded = pendingInstructions === undefined
      ? await loadInstructions(agentsGlobalPath, readFile)
      : { instructions: pendingInstructions };
    pendingInstructions = undefined;
    if (loaded.instructions === undefined) return undefined;
    return {
      systemPrompt: [base, globalBlock(loaded.instructions)].join("\n\n"),
    };
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
