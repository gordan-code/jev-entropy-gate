import type { ScanResult, SiteResult, EntropyBand } from "../types.ts";
import { BAND_LABELS } from "../entropy.ts";

/** 每个档位对应的颜色，HTML 报告里用它做视觉区分。 */
const BAND_COLORS: Record<EntropyBand, string> = {
  auto: "#16a34a", // 绿：可以放心自动
  assisted: "#d97706", // 琥珀：AI 改 + 人复核
  manual: "#dc2626" // 红：必须人看
};

/** 概率分布里三个选项的显示顺序和颜色。 */
const CHOICE_ORDER = ["deterministic", "judgment", "manual"] as const;
const CHOICE_COLORS: Record<string, string> = {
  deterministic: "#2563eb", // 蓝
  judgment: "#7c3aed", // 紫
  manual: "#dc2626" // 红
};
const CHOICE_LABELS: Record<string, string> = {
  deterministic: "机械",
  judgment: "需理解",
  manual: "危险"
};

/**
 * 把 scan 结果渲染成一个自包含的 HTML 文件。
 * 内联所有 CSS，不依赖任何外部资源，离线双击就能打开看。
 */
export function toHtml(result: ScanResult): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>jev-entropy-gate · ${esc(result.ruleId)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    color: #1f2937; background: #f9fafb; line-height: 1.5;
  }
  .wrap { max-width: 960px; margin: 0 auto; }
  header h1 { margin: 0 0 4px; font-size: 22px; }
  header .desc { margin: 0 0 4px; color: #6b7280; }
  header .meta { margin: 0; font-size: 13px; color: #9ca3af; }
  .summary { display: flex; gap: 12px; margin: 20px 0; }
  .card {
    flex: 1; border-radius: 10px; padding: 14px 16px; color: #fff;
  }
  .card .num { font-size: 28px; font-weight: 700; line-height: 1.2; }
  .card .label { font-size: 13px; opacity: 0.92; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  th, td { padding: 10px 12px; text-align: left; font-size: 13px; border-bottom: 1px solid #f1f5f9; }
  th { background: #f8fafc; font-weight: 600; color: #475569; }
  tr:last-child td { border-bottom: none; }
  .loc { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12px; }
  .band { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; color: #fff; }
  .bar-stack { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: #e5e7eb; }
  .bar-stack span { height: 100%; }
  .legend { display: flex; gap: 12px; margin-top: 6px; font-size: 11px; color: #6b7280; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
  .empty { padding: 40px; text-align: center; color: #9ca3af; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${esc(result.ruleId)}</h1>
    <p class="desc">${esc(result.ruleDescription)}</p>
    <p class="meta">扫描于 ${esc(result.scannedAt)} · 找到 ${result.totalLocated} 个候选点，粗过滤后 ${result.evaluated} 个</p>
  </header>

  <div class="summary">
    ${summaryCard("auto", result)}
    ${summaryCard("assisted", result)}
    ${summaryCard("manual", result)}
  </div>

  ${sitesTable(result.sites)}
</div>
</body>
</html>`;
}

/** 生成一个汇总卡片。 */
function summaryCard(band: EntropyBand, result: ScanResult): string {
  const n = result.summary[band];
  const pct = result.summaryPct[band];
  return `<div class="card" style="background:${BAND_COLORS[band]}">
    <div class="num">${n}</div>
    <div class="label">${BAND_LABELS[band]} · ${pct}%</div>
  </div>`;
}

/** 生成所有点的明细表。 */
function sitesTable(sites: SiteResult[]): string {
  if (sites.length === 0) {
    return `<div class="empty">没有候选点</div>`;
  }
  const rows = sites
    .map((s) => {
      const probBar = stackedBar(s.probabilities);
      const legend = choiceLegend(s);
      return `<tr>
        <td class="loc">${esc(s.candidate.file)}:${s.candidate.line}</td>
        <td><span class="band" style="background:${BAND_COLORS[s.band]}">${BAND_LABELS[s.band]}</span></td>
        <td>${CHOICE_LABELS[s.choice] ?? esc(s.choice)}</td>
        <td>${s.entropy}</td>
        <td>${s.automateConfidence}</td>
        <td>${probBar}${legend}</td>
      </tr>`;
    })
    .join("\n");
  return `<table>
  <thead><tr><th>位置</th><th>档位</th><th>Jev 选择</th><th>熵</th><th>置信度</th><th>概率分布</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

/** 把一个概率分布画成横向堆叠条形图。 */
function stackedBar(probs: Record<string, number>): string {
  const segs = CHOICE_ORDER.map((k) => {
    const p = probs[k];
    if (p === undefined) return "";
    const width = Math.round(p * 100);
    return `<span style="width:${width}%;background:${CHOICE_COLORS[k]}"></span>`;
  }).join("");
  return `<div class="bar-stack">${segs}</div>`;
}

/** 概率分布下方的图例，标出每个颜色对应的选项。 */
function choiceLegend(s: SiteResult): string {
  const items = CHOICE_ORDER.filter((k) => s.probabilities[k] !== undefined)
    .map((k) => `<span><i style="background:${CHOICE_COLORS[k]}"></i>${CHOICE_LABELS[k]} ${s.probabilities[k]!.toFixed(2)}</span>`)
    .join("");
  return `<div class="legend">${items}</div>`;
}

/** 转义 HTML 特殊字符，防止文件路径或代码片段里的 <>& 破坏页面。 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
