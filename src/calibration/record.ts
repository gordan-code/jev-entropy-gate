import { readFile, appendFile } from "node:fs/promises";
import type { Verdict } from "./types.ts";

/** Append one labeled verdict as a JSONL line. */
export async function appendVerdict(path: string, verdict: Verdict): Promise<void> {
  await appendFile(path, JSON.stringify(verdict) + "\n", "utf8");
}

/** Load all verdicts from a JSONL file (one JSON object per line). */
export async function loadVerdicts(path: string): Promise<Verdict[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: Verdict[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as Verdict);
    } catch {
      // Skip malformed lines rather than crashing the whole calibration.
    }
  }
  return out;
}
