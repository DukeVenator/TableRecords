import path from "node:path";
import type { LlmSummaryRecord } from "../core/types.js";
import { appendJsonl, readJsonl } from "../core/paths.js";

export function llmSummaryFile(sessionDir: string): string {
  return path.join(sessionDir, "llm", "summaries.jsonl");
}

export async function listLlmSummaries(sessionDir: string): Promise<LlmSummaryRecord[]> {
  const { items } = await readJsonl<LlmSummaryRecord>(llmSummaryFile(sessionDir));
  return items
    .filter((item) => item?.schema === "tablerecords.llm-summary/v2" && typeof item.summaryId === "string")
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
}

export async function appendLlmSummary(sessionDir: string, record: LlmSummaryRecord): Promise<void> {
  await appendJsonl(llmSummaryFile(sessionDir), record);
}
