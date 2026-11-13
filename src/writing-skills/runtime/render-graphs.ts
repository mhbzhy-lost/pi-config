/**
 * Render Graphviz diagrams from a Markdown file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function extractDotBlocks(markdown: string) {
  const blocks = [];
  const regex = /```dot\n([\s\S]*?)```/g;
  let match;

  while ((match = regex.exec(markdown)) !== null) {
    const content = match[1].trim();
    const nameMatch = content.match(/digraph\s+(\w+)/);
    blocks.push({ name: nameMatch ? nameMatch[1] : `graph_${blocks.length + 1}`, content });
  }

  return blocks;
}

function extractGraphBody(dotContent: string) {
  const match = dotContent.match(/digraph\s+\w+\s*\{([\s\S]*)\}/);
  if (!match) return "";
  return match[1].replace(/^\s*rankdir\s*=\s*\w+\s*;?\s*$/gm, "").trim();
}

function combineGraphs(blocks: Array<{ name: string; content: string }>, guideName: string) {
  const bodies = blocks.map((block, index) => {
    const body = extractGraphBody(block.content);
    return `  subgraph cluster_${index} {
    label="${block.name}";
${body.split("\n").map((line) => `  ${line}`).join("\n")}
  }`;
  });

  return `digraph ${guideName}_combined {
  rankdir=TB;
  compound=true;
  newrank=true;

${bodies.join("\n\n")}
}`;
}

function renderToSvg(dotContent: string): string {
  const result = spawnSync("dot", ["-Tsvg"], {
    input: dotContent,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error("Graphviz 'dot' is not available");
  }
  if (result.status !== 0) {
    throw new Error(`Graphviz 'dot' failed: ${result.stderr || "unknown error"}`);
  }
  return result.stdout;
}

export function renderGraphs(markdownFile: string, combine = false): { files: string[]; outputDir: string } {
  const guideFile = resolve(markdownFile);
  if (!existsSync(guideFile)) {
    throw new Error(`Markdown file not found: ${guideFile}`);
  }

  const blocks = extractDotBlocks(readFileSync(guideFile, "utf8"));
  if (blocks.length === 0) return { files: [], outputDir: join(resolve(guideFile, ".."), "diagrams") };

  const outputDir = join(resolve(guideFile, ".."), "diagrams");
  if (!existsSync(outputDir)) mkdirSync(outputDir);
  const guideName = basename(guideFile).replace(/\.[^.]+$/, "").replace(/-/g, "_");
  const files: string[] = [];

  if (combine) {
    const combined = combineGraphs(blocks, guideName);
    const svg = renderToSvg(combined);
    const svgPath = join(outputDir, `${guideName}_combined.svg`);
    const dotPath = join(outputDir, `${guideName}_combined.dot`);
    writeFileSync(svgPath, svg);
    writeFileSync(dotPath, combined);
    files.push(svgPath, dotPath);
  } else {
    for (const block of blocks) {
      const svg = renderToSvg(block.content);
      const svgPath = join(outputDir, `${block.name}.svg`);
      writeFileSync(svgPath, svg);
      files.push(svgPath);
    }
  }
  return { files, outputDir };
}
