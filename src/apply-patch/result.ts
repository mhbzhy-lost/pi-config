import { Type } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export type ApplyPatchOutput = {
  added: string[];
  modified: string[];
  deleted: string[];
};

export const ApplyPatchOutputSchema = Type.Object({
  added: Type.Array(Type.String()),
  modified: Type.Array(Type.String()),
  deleted: Type.Array(Type.String()),
});

// 仅装配成功结果；补丁可能逐文件生效，不承诺整个补丁事务。
export function createApplyPatchToolResult(result: ApplyPatchOutput): AgentToolResult<ApplyPatchOutput> & {
  structuredContent: ApplyPatchOutput;
} {
  const lines: string[] = [];
  for (const p of result.added) lines.push(`A ${p}`);
  for (const p of result.modified) lines.push(`M ${p}`);
  for (const p of result.deleted) lines.push(`D ${p}`);
  const details: ApplyPatchOutput = {
    added: result.added,
    modified: result.modified,
    deleted: result.deleted,
  };
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details,
    structuredContent: details,
  };
}
