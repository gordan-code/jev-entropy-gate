import type { ScanResult } from "../types.ts";

/** Serialize the ScanResult to stable JSON. */
export function toJson(result: ScanResult): string {
  return JSON.stringify(result, null, 2);
}