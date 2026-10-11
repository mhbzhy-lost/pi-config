import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  withFileMutationQueue,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { ApplyPatchOutputSchema, createApplyPatchToolResult, type ApplyPatchOutput } from "../../src/apply-patch/index.ts";

const TOOL_DESCRIPTION = `Apply a structured patch to create, update, or delete files.
The patch uses a file-oriented diff format:

*** Begin Patch
*** Add File: <path>       — create file (+ lines = contents)
*** Delete File: <path>    — remove file
*** Update File: <path>    — modify file (optionally *** Move to: <new path>)
  @@ [context]             — optional class/function locator
  context line             — unchanged (space prefix)
- removed line             — line to remove
+ added line               — line to add
  *** End of File           — anchor to file end
*** End Patch

Matching is fuzzy: trailing/leading whitespace and Unicode punctuation variants are tolerated.
Paths are relative to the working directory. Multiple file operations can be combined in one patch.`;

export default function applyPatchTool(pi: ExtensionAPI) {
  const parameters = Type.Object({
    patch: Type.String({ description: "The complete patch text (*** Begin Patch ... *** End Patch)" }),
  });
  pi.registerTool(defineTool<typeof parameters, ApplyPatchOutput | undefined>({
    name: "apply_patch",
    label: "apply_patch",
    description: TOOL_DESCRIPTION,
    promptSnippet: "通过结构化补丁创建、修改或删除多个文件。",
    promptGuidelines: ["需要表达多文件增删改时使用 apply_patch；单文件精确文本替换可使用 edit。", "按描述中的补丁格式提交完整 patch；成功文件列表不代表整个补丁具备事务原子性。"],
    parameters,
    outputSchema: ApplyPatchOutputSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { applyPatch } = await import(
        "../../src/apply-patch/index.ts"
      );
      try {
        // add/delete/非 move update 的完整单路径操作消费 Host 包根公开 queue；
        // move 保持既有行为，不纳入 queue 事务保证。
        const result = await applyPatch(params.patch, ctx.cwd, {
          withFileMutationQueue,
        });
        return createApplyPatchToolResult(result);
      } catch (err: unknown) {
        return {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          isError: true,
          details: undefined,
        };
      }
    },
  }));
}
