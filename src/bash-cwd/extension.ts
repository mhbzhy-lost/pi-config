import { validateDeclaredBashCwd } from "./policy.ts";

const cwdDescription = "可选；命令在此目录执行；必须在工作区内";

export function createBashCwdExtension(pi, {
  workspaceRoot = process.cwd(),
  createBashToolDefinition,
  getBashOptions = () => undefined,
}: { workspaceRoot?: string; createBashToolDefinition?: (...args: any[]) => any; getBashOptions?: (...args: any[]) => any } = {}) {
  if (typeof createBashToolDefinition !== "function") {
    throw new Error("bash cwd extension requires createBashToolDefinition");
  }

  const baseOptions = getBashOptions({ cwd: workspaceRoot });
  const baseDefinition = createBashToolDefinition(workspaceRoot, baseOptions);
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
      if (cwd === undefined) return baseDefinition.execute(id, rest, signal, onUpdate, ctx);

      const validatedCwd = await validateDeclaredBashCwd({ cwd, workspaceRoot });
      const options = getBashOptions(ctx);
      const definition = createBashToolDefinition(validatedCwd, options);
      return definition.execute(id, rest, signal, onUpdate, ctx);
    },
  });
}

export default createBashCwdExtension;
