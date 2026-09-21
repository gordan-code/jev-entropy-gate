import type { ScanResult, SiteResult, EntropyBand } from "../types.ts";
import { BAND_LABELS } from "../entropy.ts";

/** Render the terminal table for a ScanResult. */
export function renderTable(result: ScanResult): string {
  const header = `${result.ruleId} · ${result.ruleDescription}`;
  const meta =
    `找到 ${result.totalLocated} 个候选点，粗过滤后 ${result.evaluated} 个` +
    `（丢弃 ${result.prefilteredOut} 个）`;

  const lines: string[] = [header, meta, ""];

  lines.push(...renderSites(result.sites));
  lines.push("");
  lines.push(renderSummary(result));

  return lines.join("\n");
}

function renderSites(sites: SiteResult[]): string[] {
  if (sites.length === 0) return ["（没有候选点）"];

  const headers = ["location", "档位", "置信度", "处置"];
  const rows = sites.map((s) => [
    `${s.candidate.file}:${s.candidate.line}`,
    s.band,
    String(s.automateConfidence),
    BAND_LABELS[s.band]
  ]);
  return alignTable(headers, rows);
}

function renderSummary(result: ScanResult): string {
  const parts = (Object.keys(BAND_LABELS) as EntropyBand[]).map(
    (band) => `${BAND_LABELS[band]} ${result.summaryPct[band]}%`
  );
  return `汇总：${parts.join(" · ")}`;
}

/** Minimal fixed-ish alignment: pad each column to the widest cell. */
function alignTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))
  );

  const padRow = (cells: string[]) =>
    "│ " + cells.map((c, i) => c.padEnd(widths[i]!)).join(" │ ") + " │";
  const sep =
    "├" + widths.map((w) => "─".repeat(w + 2)).join("┼") + "┤";
  const top = "┌" + widths.map((w) => "─".repeat(w + 2)).join("┬") + "┐";
  const bottom = "└" + widths.map((w) => "─".repeat(w + 2)).join("┴") + "┘";

  return [top, padRow(headers), sep, ...rows.map(padRow), bottom];
}