#!/usr/bin/env node

/**
 * Render Graphviz diagrams from a skill's SKILL.md to SVG files.
 *
 * Usage:
 *   node render-graphs.mjs <skill-directory>           # Render each diagram separately
 *   node render-graphs.mjs <skill-directory> --combine # Combine all into one diagram
 *
 * Graphviz's optional `dot` executable is required only when rendering.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function extractDotBlocks(markdown) {
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

function extractGraphBody(dotContent) {
  const match = dotContent.match(/digraph\s+\w+\s*\{([\s\S]*)\}/);
  if (!match) return "";
  return match[1].replace(/^\s*rankdir\s*=\s*\w+\s*;?\s*$/gm, "").trim();
}

function combineGraphs(blocks, skillName) {
  const bodies = blocks.map((block, index) => {
    const body = extractGraphBody(block.content);
    return `  subgraph cluster_${index} {
    label="${block.name}";
${body.split("\n").map((line) => `  ${line}`).join("\n")}
  }`;
  });

  return `digraph ${skillName}_combined {
  rankdir=TB;
  compound=true;
  newrank=true;

${bodies.join("\n\n")}
}`;
}

function renderToSvg(dotContent) {
  const result = spawnSync("dot", ["-Tsvg"], {
    input: dotContent,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) {
    console.error("Error: Graphviz 'dot' is not available. Install it with:");
    console.error("  brew install graphviz    # macOS");
    console.error("  apt install graphviz     # Debian/Ubuntu");
    return null;
  }
  if (result.status !== 0) {
    console.error("Error running Graphviz 'dot':", result.stderr || "unknown error");
    return null;
  }
  return result.stdout;
}

function printUsage() {
  console.error("Usage: node render-graphs.mjs <skill-directory> [--combine]");
  console.error("\nOptions:");
  console.error("  --combine    Combine all diagrams into one SVG");
  console.error("\nExample:");
  console.error("  node render-graphs.mjs ../some-skill");
  console.error("  node render-graphs.mjs ../some-skill --combine");
}

function main() {
  const args = process.argv.slice(2);
  const combine = args.includes("--combine");
  const skillDirArg = args.find((arg) => !arg.startsWith("-"));

  if (!skillDirArg) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const skillDir = resolve(skillDirArg);
  const skillFile = join(skillDir, "SKILL.md");
  const skillName = basename(skillDir).replace(/-/g, "_");
  if (!existsSync(skillFile)) {
    console.error(`Error: ${skillFile} not found`);
    process.exitCode = 1;
    return;
  }

  const blocks = extractDotBlocks(readFileSync(skillFile, "utf8"));
  if (blocks.length === 0) {
    console.log("No ```dot blocks found in", skillFile);
    return;
  }

  console.log(`Found ${blocks.length} diagram(s) in ${basename(skillDir)}/SKILL.md`);
  const outputDir = join(skillDir, "diagrams");
  if (!existsSync(outputDir)) mkdirSync(outputDir);

  if (combine) {
    const combined = combineGraphs(blocks, skillName);
    const svg = renderToSvg(combined);
    if (!svg) {
      process.exitCode = 1;
      return;
    }
    writeFileSync(join(outputDir, `${skillName}_combined.svg`), svg);
    writeFileSync(join(outputDir, `${skillName}_combined.dot`), combined);
    console.log(`  Rendered: ${skillName}_combined.svg`);
    console.log(`  Source: ${skillName}_combined.dot`);
  } else {
    let failures = 0;
    for (const block of blocks) {
      const svg = renderToSvg(block.content);
      if (!svg) {
        failures += 1;
        console.error(`  Failed: ${block.name}`);
        continue;
      }
      writeFileSync(join(outputDir, `${block.name}.svg`), svg);
      console.log(`  Rendered: ${block.name}.svg`);
    }
    if (failures) {
      process.exitCode = 1;
      return;
    }
  }

  console.log(`\nOutput: ${outputDir}/`);
}

main();
