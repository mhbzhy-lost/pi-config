import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { parsePatch, ParseError } from "./parser.mjs";
import { seekSequence } from "./seek-sequence.mjs";

export { ParseError };

export class ApplyError extends Error {
  constructor(message, { applied = [] } = {}) {
    super(message);
    this.name = "ApplyError";
    this.applied = applied;
  }
}

export async function applyPatch(patchText, cwd) {
  const { hunks } = parsePatch(patchText);
  if (hunks.length === 0) throw new ApplyError("No files were modified.");

  const added = [];
  const modified = [];
  const deleted = [];

  for (const hunk of hunks) {
    const absPath = resolve(cwd, hunk.path);

    if (hunk.type === "add") {
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, hunk.contents, "utf8");
      added.push(hunk.path);
    } else if (hunk.type === "delete") {
      await rm(absPath);
      deleted.push(hunk.path);
    } else {
      let original;
      try {
        original = await readFile(absPath, "utf8");
      } catch (e) {
        throw new ApplyError(
          `Failed to read file to update ${hunk.path}: ${e.message}`
        );
      }
      const newContent = computeNewContent(original, hunk.chunks, hunk.path);
      if (hunk.movePath) {
        const absDest = resolve(cwd, hunk.movePath);
        await mkdir(dirname(absDest), { recursive: true });
        await writeFile(absDest, newContent, "utf8");
        await rm(absPath);
      } else {
        await writeFile(absPath, newContent, "utf8");
      }
      modified.push(hunk.path);
    }
  }

  return { added, modified, deleted };
}

function computeNewContent(original, chunks, pathLabel) {
  let lines = original.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const replacements = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const idx = seekSequence(lines, [chunk.changeContext], lineIndex, false);
      if (idx === null) {
        throw new ApplyError(
          `Failed to find context '${chunk.changeContext}' in ${pathLabel}`
        );
      }
      lineIndex = idx + 1;
    }

    if (chunk.oldLines.length === 0) {
      const insertIdx =
        lines.length > 0 && lines[lines.length - 1] === ""
          ? lines.length - 1
          : lines.length;
      replacements.push([insertIdx, 0, chunk.newLines]);
      continue;
    }

    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile);

    if (
      found === null &&
      pattern.length > 0 &&
      pattern[pattern.length - 1] === ""
    ) {
      pattern = pattern.slice(0, -1);
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") {
        newSlice = newSlice.slice(0, -1);
      }
      found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile);
    }

    if (found === null) {
      throw new ApplyError(
        `Failed to find expected lines in ${pathLabel}:\n${chunk.oldLines.join("\n")}`
      );
    }

    replacements.push([found, pattern.length, newSlice]);
    lineIndex = found + pattern.length;
  }

  replacements.sort((a, b) => a[0] - b[0]);
  for (let i = replacements.length - 1; i >= 0; i--) {
    const [start, oldLen, newLines] = replacements[i];
    lines.splice(start, oldLen, ...newLines);
  }

  if (lines.length === 0 || lines[lines.length - 1] !== "") {
    lines.push("");
  }
  return lines.join("\n");
}
