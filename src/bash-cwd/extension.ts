export function createBashCwdToolDefinition({
  workspaceRoot = process.cwd(),
  createBashToolDefinition,
  getBashOptions = () => ({}),
}: { workspaceRoot?: string; createBashToolDefinition?: (...args: any[]) => any; getBashOptions?: (...args: any[]) => any } = {}) {
  if (typeof createBashToolDefinition !== "function") {
    throw new Error("bash settings extension requires createBashToolDefinition");
  }

  // 初始化只读取 definition 的 schema/metadata；shell 配置必须在真实 execute context 中解析。
  const baseDefinition = createBashToolDefinition(workspaceRoot, {});
  return {
    ...baseDefinition,
    name: "bash",
    async execute(id, input, signal, onUpdate, ctx) {
      const { definition } = await prepareBashCwdExecution({
        workspaceRoot, createBashToolDefinition, getBashOptions,
      }, ctx);
      return definition.execute(id, input, signal, onUpdate, ctx);
    },
  };
}

/** 只解析一次 shell options，供同步与异步 Bash 执行共用。 */
export async function prepareBashCwdExecution({ workspaceRoot = process.cwd(), createBashToolDefinition, getBashOptions = () => ({}) }: { workspaceRoot?: string; createBashToolDefinition?: (...args: any[]) => any; getBashOptions?: (...args: any[]) => any }, ctx, transformOptions = (options) => options) {
  const options = transformOptions(getBashOptions(ctx));
  return { definition: createBashToolDefinition(workspaceRoot, options), cwd: ctx?.cwd ?? workspaceRoot };
}

export function createBashCwdExtension(pi, options = {}) {
  pi.registerTool(createBashCwdToolDefinition(options));
}

export default createBashCwdExtension;
