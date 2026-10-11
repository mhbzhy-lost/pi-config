import { validateDeclaredBashCwd } from "./policy.ts";

const cwdDescription = "可选；命令在此目录执行";

export function createBashCwdExtension(pi, {
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

  pi.registerTool({
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
      const validatedCwd = cwd === undefined
        ? undefined
        : await validateDeclaredBashCwd({ cwd, workspaceRoot });
      const options = getBashOptions(ctx);
      const executionOptions = validatedCwd === undefined
        ? options
        : {
            ...options,
            spawnHook: (spawnContext) => {
              const next = options.spawnHook?.(spawnContext) ?? spawnContext;
              return { ...next, cwd: validatedCwd };
            },
          };
      const definition = createBashToolDefinition(workspaceRoot, executionOptions);
      return definition.execute(id, rest, signal, onUpdate, ctx);
    },
  });
}

export default createBashCwdExtension;
