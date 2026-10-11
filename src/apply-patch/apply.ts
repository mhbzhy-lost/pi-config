import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { parsePatch, ParseError } from "./parser.ts";
import { seekSequence } from "./seek-sequence.ts";

export { ParseError };

// 可注入的单文件 mutation queue 依赖；签名与 Host 包根公开导出的 withFileMutationQueue
// 一致（同文件串行、不同文件并行；路径 canonical 化由原生实现负责）。
// 生产入口从 @earendil-works/pi-coding-agent 包根传入；本 feature 模块不 import Host 入口。
export type WithFileMutationQueue = <T>(
  filePath: string,
  fn: () => Promise<T>
) => Promise<T>;

export type ApplyPatchDeps = {
  withFileMutationQueue: WithFileMutationQueue;
};

export class ApplyError extends Error {
  applied: string[];

  constructor(message: string, { applied = [] }: { applied?: string[] } = {}) {
    super(message);
    this.name = "ApplyError";
    this.applied = applied;
  }
}

export async function applyPatch(patchText, cwd, deps?: ApplyPatchDeps) {
  const { hunks } = parsePatch(patchText);
  if (hunks.length === 0) throw new ApplyError("No files were modified.");

  const withFileMutationQueue = deps?.withFileMutationQueue;

  const added = [];
  const modified = [];
  const deleted = [];

  for (const hunk of hunks) {
    const absPath = resolve(cwd, hunk.path);

    if (hunk.type === "add") {
      const createFile = async () => {
        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, hunk.contents, "utf8");
      };
      if (withFileMutationQueue) {
        // add 的 mkdir/write 完整进入该 hunk 的单路径 queue 回调，不能只锁 write。
        await withFileMutationQueue(absPath, createFile);
      } else {
        await createFile();
      }
      added.push(hunk.path);
    } else if (hunk.type === "delete") {
      const removeFile = async () => {
        await rm(absPath);
      };
      if (withFileMutationQueue) {
        // delete 的 rm 完整进入该 hunk 的单路径 queue 回调。
        await withFileMutationQueue(absPath, removeFile);
      } else {
        await removeFile();
      }
      deleted.push(hunk.path);
    } else if (hunk.movePath) {
      // move 保持既有行为：read source、写 destination、rm source 均不进入单路径 queue，
      // 不嵌套 source/target 双路径 queue，不用 sequential 或新全局锁替代；
      // move、整 patch 原子性、跨进程与真实并发均不在已验证保证内。
      let original;
      try {
        original = await readFile(absPath, "utf8");
      } catch (e) {
        throw new ApplyError(
          `Failed to read file to update ${hunk.path}: ${e.message}`
        );
      }
      const newContent = computeNewContent(original, hunk.chunks, hunk.path);
      const absDest = resolve(cwd, hunk.movePath);
      await mkdir(dirname(absDest), { recursive: true });
      await writeFile(absDest, newContent, "utf8");
      await rm(absPath);
      modified.push(hunk.path);
    } else {
      const updateFile = async () => {
        let original;
        try {
          original = await readFile(absPath, "utf8");
        } catch (e) {
          throw new ApplyError(
            `Failed to read file to update ${hunk.path}: ${e.message}`
          );
        }
        const newContent = computeNewContent(original, hunk.chunks, hunk.path);
        await writeFile(absPath, newContent, "utf8");
      };
      if (withFileMutationQueue) {
        // 非 move 的 update：完整 read-modify-write 放入同一 hunk 的单路径 queue 回调，
        // 路径 key 交原生 API canonicalize；hunk 顺序保持。
        await withFileMutationQueue(absPath, updateFile);
      } else {
        await updateFile();
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
