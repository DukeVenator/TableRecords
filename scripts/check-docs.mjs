#!/usr/bin/env node
/**
 * Gate the project's prose with the avoid-ai-writing detector.
 *
 * Every Markdown file that a reader can land on is scored. A file fails when it
 * goes over the threshold. Findings are a writing signal, not a verdict: read
 * what it flagged before changing a sentence.
 *
 * Exit codes: 0 pass, 1 threshold failure, 2 tool error.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import AIDetector from "avoid-ai-writing-detector";

const THRESHOLD = 6;
const root = process.cwd();

function markdownFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) found.push(full);
  }
  return found;
}

const files = ["README.md", "FEATURES.md", "ROADMAP.md", "PLAN.md", "foundry-module/README.md"];
for (const file of markdownFiles(join(root, "docs"))) {
  files.push(relative(root, file).split(sep).join("/"));
}

let failed = 0;
const rows = [];

for (const file of files) {
  let result;
  try {
    const text = readFileSync(join(root, file), "utf8");
    result = AIDetector.analyzeText(text, { contextMode: "technical", sourceMode: "rendered-markdown" });
  } catch (error) {
    console.error(`Could not score ${file}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const findings = Array.isArray(result.issues) ? result.issues.length : 0;
  const score = typeof result.score === "number" ? Math.round(result.score) : 0;
  const pass = findings <= THRESHOLD;
  if (!pass) failed += 1;
  rows.push({ file, score, findings, pass });
}

const width = Math.max(...rows.map((row) => row.file.length));
for (const row of rows) {
  const mark = row.pass ? "pass" : "FAIL";
  console.log(`${mark}  ${row.file.padEnd(width)}  score ${String(row.score).padStart(3)}  ${row.findings} finding${row.findings === 1 ? "" : "s"}`);
}

if (failed > 0) {
  console.error(`\n${failed} file${failed === 1 ? "" : "s"} over the ${THRESHOLD}-finding budget. Read the findings, then revise.`);
  process.exit(1);
}

console.log(`\nAll ${rows.length} files under the ${THRESHOLD}-finding budget.`);
