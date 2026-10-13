import { validateDeclaredBashCwd } from "./policy.ts";

const cwdDescription = "可选；命令在此目录执行";

export function createBashCwdToolDefinition({
  workspaceRoot = process.cwd(),
  createBashToolDefinition,
  getBashOptions = () => ({}),
}: { workspaceRoot?: string; createBashToolDefinition?: (...args: any[]) => any; getBashOptions?: (...args: any[]) => any } = {}) {
  if (typeof createBashToolDefinition !== "function") {
    throw new Error("bash cwd extension requires createBashToolDefinition");
  }

  // 初始化只读取 definition 的 schema/metadata；shell 配置必须在真实 execute context 中解析。
  const baseDefinition = createBashToolDefinition(workspaceRoot, {});
  const baseGuidelines = baseDefinition.promptGuidelines ?? [];
  const baseParameters = baseDefinition.parameters;

  return {
    ...baseDefinition,
    name: "bash",
    parameters: {
      ...baseParameters,
      properties: {
        ...baseParameters.properties,
        cwd: { type: "string", description: cwdDescription },
      },
    },
    promptGuidelines: [...baseGuidelines, cwdDescription],
    async execute(id, { cwd, ...rest }, signal, onUpdate, ctx) {
      const { definition } = await prepareBashCwdExecution({
        workspaceRoot, createBashToolDefinition, getBashOptions,
      }, { cwd }, ctx);
      return definition.execute(id, rest, signal, onUpdate, ctx);
    },
  };
}

/** 只解析一次 cwd 和 options，供同步执行与异步 launch 共用。 */
export async function prepareBashCwdExecution({ workspaceRoot = process.cwd(), createBashToolDefinition, getBashOptions = () => ({}) }: { workspaceRoot?: string; createBashToolDefinition?: (...args: any[]) => any; getBashOptions?: (...args: any[]) => any }, { cwd }: { cwd?: string }, ctx, transformOptions = (options) => options) {
  const validatedCwd = cwd === undefined ? undefined : await validateDeclaredBashCwd({ cwd, workspaceRoot });
  const options = transformOptions(getBashOptions(ctx));
  const executionOptions = validatedCwd === undefined ? options : {
    ...options,
    spawnHook: (spawnContext) => {
      const next = options.spawnHook?.(spawnContext) ?? spawnContext;
      return { ...next, cwd: validatedCwd };
    },
  };
  return { definition: createBashToolDefinition(workspaceRoot, executionOptions), cwd: validatedCwd ?? ctx?.cwd ?? workspaceRoot };
}

export function createBashCwdExtension(pi, options = {}) {
  pi.registerTool(createBashCwdToolDefinition(options));
}

export default createBashCwdExtension;
