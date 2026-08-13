import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
  pi.registerTool({
    name: "apply_patch",
    label: "apply_patch",
    description: TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description:
            "The complete patch text (*** Begin Patch ... *** End Patch)",
        },
      },
      required: ["patch"],
    },
    async execute(
      _toolCallId: string,
      params: { patch: string },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      const { applyPatch } = await import(
        "../../scripts/lib/apply-patch/index.mjs"
      );
      try {
        const result = await applyPatch(params.patch, ctx.cwd);
        const lines: string[] = [];
        for (const p of result.added) lines.push(`A ${p}`);
        for (const p of result.modified) lines.push(`M ${p}`);
        for (const p of result.deleted) lines.push(`D ${p}`);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            added: result.added,
            modified: result.modified,
            deleted: result.deleted,
          },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  } as any);
}
