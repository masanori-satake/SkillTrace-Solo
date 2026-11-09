// HTML レポート（自己完結、外部依存なし）。拡張のサマリ Webview と共用する。
// サマリは二層: セッション全体のサマリ（利用者視点: このチャットで何が起きたか）と
// スキル呼び出しのサマリ（提供者視点: このスキルが適切に動いたか）。
// どちらも同じ SessionTrace データに対するビューであり、計算は1つだけ。
import type { Graph } from "./graph";
import type { SessionTrace, SkillPart, Trace, TraceNode } from "./trace";
import { formatLocalDateTime } from "./sessions";
import type { SkillTotal } from "./aggregate";
import { esc, fmt, fmtCredits, countTools, toolColumns, toolGroupsPresent, toolGroupLabel, inputSplit, cacheWriteObservation, firstContextUsageRatio, undiscoveredSkillsNote, glossaryFor, type Lang } from "./common";
import { renderSessionMarkdown, renderSessionHtmlFragment, renderSkillMarkdown, renderSkillHtmlFragment } from "./document";
export { esc, fmt };

export function gradeBadge(grade: string | null, lang: Lang = "ja"): string {
  const cls = grade === "A" ? "bA" : grade === "B" ? "bB" : grade === "C" ? "bC" : "bN";
  const label = lang === "en"
    ? (grade === "A" ? "High" : grade === "B" ? "Medium" : grade === "C" ? "Low" : "—")
    : (grade === "A" ? "確度高" : grade === "B" ? "確度中" : grade === "C" ? "確度低" : "—");
  return `<span class="badge ${cls}">${label}</span>`;
}

export function fillZone(ratio: number | null, lang: Lang = "ja"): { label: string; color: string } {
  const en = lang === "en";
  if (ratio === null) return { label: en ? "Limit unknown" : "上限不明", color: "#8a8a8a" };
  if (ratio < 0.5) return { label: en ? "Comfortable" : "余裕", color: "#3d9970" };
  if (ratio < 0.8) return { label: en ? "Caution" : "注意", color: "#d4a017" };
  return { label: en ? "Tight" : "圧迫", color: "#c0392b" };
}

const STYLE = `:root{--bg:#ffffff;--fg:#222222;--muted:#888888;--line:#dddddd;--panel:#f7f7f5;--note:#f4f6f8;--warn-bg:#fdf3e3;--warn-line:#e5c07b;--accent:#3a6ea5;--bnd:#7a4fa3}
@media (prefers-color-scheme: dark){:root{--bg:#1e1e1e;--fg:#e8e8e8;--muted:#9a9a9a;--line:#444444;--panel:#2a2a2a;--note:#2a2f36;--warn-bg:#3a2f1a;--warn-line:#8a6d2f;--accent:#6cb2f5;--bnd:#c39bd8}}
body.vscode-dark{--bg:transparent;--fg:#e8e8e8;--muted:#9a9a9a;--line:#444444;--panel:#2a2a2a;--note:#2a2f36;--warn-bg:#3a2f1a;--warn-line:#8a6d2f;--accent:#6cb2f5;--bnd:#c39bd8}
body{font-family:system-ui,"Segoe UI",sans-serif;margin:24px;background:var(--bg);color:var(--fg);line-height:1.55}h1{font-size:19px}h2{font-size:15px;margin-top:26px}
table{border-collapse:collapse;font-size:13px}td,th{border:1px solid var(--line);padding:3px 8px}
table.tokens td,table.tokens th{text-align:right}table.tokens td:first-child,table.tokens th:first-child{text-align:center}
table.nodes td,table.nodes th{text-align:left}
table.nodes td:nth-child(2),table.nodes th:nth-child(2),table.nodes td:nth-child(3),table.nodes th:nth-child(3){text-align:center}
table.nodes td:nth-child(6),table.nodes th:nth-child(6){text-align:right}
table.skills td:nth-child(2),table.skills td:nth-child(3),table.skills td:nth-child(4),table.skills td:nth-child(5),table.skills td:nth-child(6),table.skills td:nth-child(7){text-align:right}
.badge{display:inline-block;padding:0 7px;height:20px;line-height:20px;text-align:center;border-radius:10px;color:#fff;font-weight:700;font-size:11px;vertical-align:-4px;white-space:nowrap}
.bA{background:#3d9970}.bB{background:#3a6ea5}.bC{background:#d4a017}.bN{background:#8a8a8a}
ul.tree{list-style:none;padding-left:18px}
.ord{color:var(--accent);font-weight:600}.tok{color:var(--muted);font-size:12px}.tit{color:var(--muted);font-size:12px}.bnd{color:var(--bnd);font-size:12px}.miss{color:#e05a4e;font-size:12px}
.warn{background:var(--warn-bg);border:1px solid var(--warn-line);padding:8px 12px;border-radius:6px}.note{background:var(--note);padding:10px 14px;border-radius:6px;font-size:13px}
.prompt{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 14px;font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:13px;white-space:pre-wrap;word-break:break-word;margin:6px 0 16px}
.dim{opacity:.28}.zone{font-weight:700}
.termnav{background:var(--note);border:1px solid var(--line);border-radius:6px;padding:6px 10px}
.meta div{margin:1px 0}.meta .k{color:var(--muted)}
table.gloss td:first-child{font-weight:700;white-space:nowrap;vertical-align:top}
table.tmatrix td.n,table.tmatrix th.n{text-align:right}
table.tmatrix th.tg{color:#222;font-weight:600;white-space:nowrap}
.tg-legend{font-size:12px;color:var(--muted);margin:4px 0 0}
.tg-chip{display:inline-block;width:10px;height:10px;border:1px solid var(--line);border-radius:2px;margin:0 4px 0 12px;vertical-align:-1px}
.tg-chip:first-child{margin-left:0}
svg text{fill:var(--muted);font-size:11px}
.bar-legend{font-size:12px;color:var(--muted)}
.tbar{display:inline-block;width:64px;height:8px;background:var(--line);border-radius:4px;vertical-align:middle;margin-left:6px;overflow:hidden}.tbar i{display:block;height:100%;background:var(--accent);border-radius:4px}
table.totals td:not(:first-child),table.totals th:not(:first-child){text-align:right}`;

function pageShell(title: string, body: string, lang: Lang = "ja"): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>${esc(title)}</title>
<style>${STYLE}</style></head><body>
${body}</body></html>`;
}

function renderTreeHtml(nodes: TraceNode[], graph: Graph, lang: Lang = "ja"): string {
  const en = lang === "en";
  const totalEst = nodes.reduce((a, n) => a + n.estTokens, 0);
  const byRel = new Map(nodes.map(n => [n.relToSkill, n]));
  const root = graph.order[0];
  const walk = (id: string, seen: Set<string>): string => {
    const gn = graph.nodes.get(id)!;
    const tn = byRel.get(gn.relToSkill);
    const grade = tn?.grade ?? null;
    const orderBadge = tn?.order !== null && tn?.order !== undefined ? `<span class="ord">#${tn!.order}</span>` : "";
    const bnd = gn.boundary ? ` <span class="bnd">${en ? "outside skill" : "スキル外"}</span>` : "";
    const miss = gn.missing ? ` <span class="miss">${en ? "missing target" : "参照先なし"}</span>` : "";
    const cyc = gn.cycle ? ` <span class="bnd">${en ? "cycle (stops here)" : "循環（ここまで）"}</span>` : "";
    const ev = tn ? ` title="${esc(tn.evidence)}${tn.firstAt ? " ／ " + esc(tn.firstAt) : ""}"` : "";
    let children = "";
    if (!seen.has(id) && !gn.cycle) {
      seen.add(id);
      if (gn.children.length) children = `<ul>${gn.children.map(c => walk(c, seen)).join("")}</ul>`;
    }
    return `<li><span class="node" data-order="${tn?.order ?? ""}"${ev}>${gradeBadge(grade, lang)} ${esc(gn.relToSkill)}${gn.title ? ` <span class="tit">${esc(gn.title)}</span>` : ""}${bnd}${miss}${cyc} ${orderBadge} <span class="tok">~${fmt(gn.estTokens)} ${en ? "tokens" : "トークン"}</span>${gn.estTokens > 0 && totalEst > 0 ? `<span class="tbar"><i style="width:${Math.round((gn.estTokens / totalEst) * 100)}%"></i></span>` : ""}</span>${children}</li>`;
  };
  const legend = totalEst > 0 ? `<p class="bar-legend">${en ? "Bar length: share of this skill's total estimated tokens across all its files" : "バーの長さは、このスキルの全ファイルの推定トークン合計に対する割合です"}</p>` : "";
  return `<ul class="tree">${walk(root.id, new Set())}</ul>${legend}`;
}

type FillSource = Pick<Trace, "contextCurrentSeries" | "lastContextCurrentTokens" | "contextTokenLimit" | "contextFillRatio">;
function renderFillChart(src: FillSource, lang: Lang = "ja"): string {
  const en = lang === "en";
  const series = src.contextCurrentSeries;
  if (!series.length) return "";
  const max = src.contextTokenLimit ?? Math.max(...series.map(p => p.tokens));
  // 軸と目盛りのある図にする（0.6.0）: 縦軸は上限に対する割合、横軸はターン
  const W = 680, H = 200, mL = 46, mR = 12, mT = 16, mB = 26;
  const iw = W - mL - mR, ih = H - mT - mB;
  const X = (i: number) => mL + (series.length === 1 ? iw / 2 : (iw * i) / (series.length - 1));
  const Y = (v: number) => mT + ih * (1 - v / max);
  const grid = [0, 0.25, 0.5, 0.75, 1].map(r => {
    const y = Y(max * r);
    const dash = r === 1 ? ` stroke-dasharray="4 3"` : "";
    const cap = r === 1 ? `<text x="${mL + 4}" y="${y - 4}">${en ? "Limit" : "上限"} ${fmt(max)} ${en ? "tokens" : "トークン"}</text>` : "";
    return `<line x1="${mL}" y1="${y}" x2="${W - mR}" y2="${y}" style="stroke:var(--line)"${dash}/>`
      + `<text x="${mL - 6}" y="${y + 4}" text-anchor="end">${Math.round(r * 100)}%</text>${cap}`;
  }).join("");
  const pts = series.map((p, i) => `${X(i).toFixed(1)},${Y(p.tokens).toFixed(1)}`).join(" ");
  const dots = series.map((p, i) =>
    `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.tokens).toFixed(1)}" r="${i === series.length - 1 ? 3.5 : 2.2}" fill="#6cb2f5"/>`).join("");
  const xLabels = `<text x="${X(0)}" y="${H - 6}" text-anchor="middle">${en ? "Turn" : "ターン"} 1</text>`
    + (series.length > 1 ? `<text x="${X(series.length - 1)}" y="${H - 6}" text-anchor="middle">${en ? "Turn" : "ターン"} ${series.length}</text>` : "");
  const zone = fillZone(src.contextFillRatio, lang);
  return `<h2>${en ? "Context window usage" : "コンテキストウィンドウ使用量"}</h2>
<p>${en ? "Final usage" : "最終使用量"} ${fmt(src.lastContextCurrentTokens)} / ${en ? "limit" : "上限"} ${fmt(src.contextTokenLimit)} ${en ? "tokens" : "トークン"}
（${src.contextFillRatio !== null ? (src.contextFillRatio * 100).toFixed(1) + "%" : "—"}）
<span class="zone" style="color:${zone.color}">● ${zone.label}</span></p>
<svg width="${W}" height="${H}" style="background:var(--panel);border:1px solid var(--line);border-radius:6px">
${grid}<polyline points="${pts}" fill="none" stroke="#6cb2f5" stroke-width="2"/>${dots}${xLabels}</svg>
<p class="bar-legend">${en ? "Vertical: context window usage (share of the limit) / Horizontal: turn" : "縦軸: コンテキストウィンドウ使用量（上限に対する割合）／ 横軸: ターン"}</p>`;
}

// --- Kiro の実測表示: トークンではなくクレジットと使用率（%）で記録される ---
type CreditSource = Pick<SessionTrace, "creditsTotal" | "creditTurns">;
function creditsBlock(src: CreditSource, lang: Lang = "ja", note?: { ja: string; en: string }): string {
  const en = lang === "en";
  const turns = src.creditTurns ?? [];
  const cols = toolColumns(turns);
  const defaultNote = en ? " (summed from usage_summary; Kiro records credits, not tokens)" : "（usage_summary の積算。Kiro の実測はトークンではなくクレジットで記録されます）";
  const head = `<h2>${en ? "Credit usage" : "クレジット実測"}</h2>
<p>${en ? "Total" : "合計"} <b>${fmtCredits(src.creditsTotal)}</b> credits${note ? (en ? note.en : note.ja) : defaultNote}</p>`;
  if (!cols.length) {
    const rows = turns.map(t => `<tr><td>${t.turn + 1}</td><td>${fmtCredits(t.credits)}</td><td></td></tr>`).join("");
    return `${head}
<table class="nodes"><tr><th>${en ? "Turn" : "ターン"}</th><th>${en ? "Credits" : "クレジット"}</th><th>${en ? "Tools used" : "使用したツール"}</th></tr>${rows}</table>`;
  }
  // ツールごとの列を持つマトリクス: セルはそのターンの呼び出し回数だけ。
  // 列順はグループ→合計の多い順で全行共通にし、行同士を比べられるようにする
  const headRows = `<tr><th rowspan="2">${en ? "Turn" : "ターン"}</th><th rowspan="2">${en ? "Credits" : "クレジット"}</th><th colspan="${cols.length}">${en ? "Tools used" : "使用したツール"}</th></tr>
<tr>${cols.map(c => `<th class="tg" style="background:${c.group.color}">${esc(c.name)}</th>`).join("")}</tr>`;
  const rows = turns.map(t => {
    const counts = countTools(t.usedTools);
    return `<tr><td>${t.turn + 1}</td><td class="n">${fmtCredits(t.credits)}</td>${cols.map(c => `<td class="n">${counts.get(c.name) ?? ""}</td>`).join("")}</tr>`;
  }).join("");
  const totalRow = `<tr><th>${en ? "Total" : "合計"}</th><th class="n">${fmtCredits(src.creditsTotal)}</th>${cols.map(c => `<th class="n">${c.total}</th>`).join("")}</tr>`;
  const legend = `<p class="tg-legend">${en ? "Legend (tool groups): " : "凡例（ツールのグループ）: "}${toolGroupsPresent(cols).map(g => `<span class="tg-chip" style="background:${g.color}"></span>${esc(toolGroupLabel(g, lang))}`).join("")}</p>`;
  return `${head}
<div style="overflow-x:auto"><table class="nodes tmatrix">${headRows}${rows}
${totalRow}</table></div>
${legend}`;
}

type UsageRatioSource = Pick<SessionTrace, "contextUsageSeries" | "lastContextUsageRatio">;
function renderKiroUsageChart(src: UsageRatioSource, lang: Lang = "ja"): string {
  const en = lang === "en";
  const series = src.contextUsageSeries ?? [];
  if (!series.length) return "";
  const W = 680, H = 200, mL = 46, mR = 12, mT = 16, mB = 26;
  const iw = W - mL - mR, ih = H - mT - mB;
  const X = (i: number) => mL + (series.length === 1 ? iw / 2 : (iw * i) / (series.length - 1));
  const Y = (v: number) => mT + ih * (1 - v);
  const grid = [0, 0.25, 0.5, 0.75, 1].map(r => {
    const y = Y(r);
    const dash = r === 1 ? ` stroke-dasharray="4 3"` : "";
    const cap = r === 1 ? `<text x="${mL + 4}" y="${y - 4}">${en ? "Limit" : "上限"} 100%</text>` : "";
    return `<line x1="${mL}" y1="${y}" x2="${W - mR}" y2="${y}" style="stroke:var(--line)"${dash}/>`
      + `<text x="${mL - 6}" y="${y + 4}" text-anchor="end">${Math.round(r * 100)}%</text>${cap}`;
  }).join("");
  const pts = series.map((p, i) => `${X(i).toFixed(1)},${Y(p.ratio).toFixed(1)}`).join(" ");
  const dots = series.map((p, i) =>
    `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.ratio).toFixed(1)}" r="${i === series.length - 1 ? 3.5 : 2.2}" fill="#6cb2f5"/>`).join("");
  const xLabels = `<text x="${X(0)}" y="${H - 6}" text-anchor="middle">${en ? "Snapshot" : "記録"} 1</text>`
    + (series.length > 1 ? `<text x="${X(series.length - 1)}" y="${H - 6}" text-anchor="middle">${en ? "Snapshot" : "記録"} ${series.length}</text>` : "");
  const zone = fillZone(src.lastContextUsageRatio ?? null, lang);
  const pct = src.lastContextUsageRatio !== null && src.lastContextUsageRatio !== undefined ? (src.lastContextUsageRatio * 100).toFixed(1) + "%" : "—";
  return `<h2>${en ? "Context window usage" : "コンテキストウィンドウ使用量"}</h2>
<p>${en ? "Final usage ratio" : "最終使用率"} ${pct} <span class="zone" style="color:${zone.color}">● ${zone.label}</span></p>
<svg width="${W}" height="${H}" style="background:var(--panel);border:1px solid var(--line);border-radius:6px">
${grid}<polyline points="${pts}" fill="none" stroke="#6cb2f5" stroke-width="2"/>${dots}${xLabels}</svg>
<p class="bar-legend">${en ? "Vertical: context window usage ratio / Horizontal: order of recorded snapshots" : "縦軸: コンテキストウィンドウ使用率 ／ 横軸: 記録された時点の順序"}</p>
<p class="tok">${en ? "Kiro records only the usage ratio (%); absolute token counts and the limit are not recorded." : "Kiro の記録には使用率（%）だけが残ります。トークンの絶対量と上限は記録されません。"}</p>`;
}

/** 実測ブロック: 供給源で出し分ける（Copilot=トークン実測、Kiro=クレジット実測） */
function usageBlock(trace: Trace | SessionTrace, lang: Lang = "ja"): string {
  if (trace.source === "kiro") return `${creditsBlock(trace, lang)}\n${renderKiroUsageChart(trace, lang)}`;
  const tokenBlock = `<h2>${lang === "en" ? "Token usage" : "トークン実測"}</h2>\n${tokenTable(trace.turns, trace.totals, lang)}\n${renderFillChart(trace, lang)}`;
  // VS Code の記録にはトークン実測とクレジット実測の両方が残るため併記する
  if (trace.source === "vscode" && (trace.creditsTotal ?? 0) > 0) {
    const note = {
      ja: "（各リクエストの copilotCredits の積算。Copilot Chat の記録にはトークン実測も残ります）",
      en: " (summed from each request's copilotCredits; Copilot Chat records token usage as well)",
    };
    return `${tokenBlock}\n${creditsBlock(trace, lang, note)}`;
  }
  return tokenBlock;
}

// 先頭の用語導線: 「困ったらこの文書の中に用語集がある」と認知させることが目的
// （出現箇所ごとに注釈を付けると、改訂のたびに付け忘れの不整合が出るため一本化する）
function termNav(lang: Lang = "ja"): string {
  return lang === "en"
    ? `<p class="termnav">Unfamiliar terms are collected in the <a href="#glossary">Glossary</a> at the end of this page.</p>`
    : `<p class="termnav">分からない用語は、このページの末尾にある <a href="#glossary">用語の説明</a> にまとめています。</p>`;
}

// 文書コピー（0.7.0）: 議論の場（Loop / PowerPoint / GitHub 等）へ貼るための
// Markdown / HTML 形式を、このページから直接コピーできるようにする。
// HTML は ClipboardItem を優先し、ダメなら画面外要素の選択コピーに落とす
function docCopyBlock(md: string, frag: string, lang: Lang = "ja"): string {
  const en = lang === "en";
  const mdJson = JSON.stringify(md).replace(/<\//g, "<\\/");
  const fragJson = JSON.stringify(frag).replace(/<\//g, "<\\/");
  return `<p><button id="copyMd" type="button">${en ? "Copy as Markdown" : "Markdown でコピー"}</button> <button id="copyHtml" type="button">${en ? "Copy as HTML" : "HTML でコピー"}</button> <span id="copyMsg" class="tok"></span></p>
<script>
const MD_TEXT=${mdJson};
const FRAG_TEXT=${fragJson};
const copyMsg=document.getElementById('copyMsg');
function copyDone(t){ if(copyMsg){ copyMsg.textContent=t; setTimeout(()=>{copyMsg.textContent='';},2500);} }
function fallbackText(t){
  const ta=document.createElement('textarea'); ta.value=t;
  ta.style.cssText='position:fixed;opacity:0'; document.body.appendChild(ta); ta.select();
  try{ document.execCommand('copy'); }catch(e){}
  ta.remove();
}
document.getElementById('copyMd').addEventListener('click', async ()=>{
  try{ await navigator.clipboard.writeText(MD_TEXT); copyDone('${en ? "Copied as Markdown" : "Markdown をコピーしました"}'); }
  catch(e){ fallbackText(MD_TEXT); copyDone('${en ? "Copied as Markdown" : "Markdown をコピーしました"}'); }
});
document.getElementById('copyHtml').addEventListener('click', async ()=>{
  try{
    const item=new ClipboardItem({
      'text/html': new Blob([FRAG_TEXT],{type:'text/html'}),
      'text/plain': new Blob([MD_TEXT],{type:'text/plain'})
    });
    await navigator.clipboard.write([item]);
    copyDone('${en ? "Copied as HTML" : "HTML をコピーしました"}');
    return;
  }catch(e){}
  const tmp=document.createElement('div');
  tmp.style.cssText='position:absolute;left:-9999px;top:0';
  tmp.innerHTML=FRAG_TEXT; document.body.appendChild(tmp);
  const range=document.createRange(); range.selectNodeContents(tmp);
  const sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  try{ document.execCommand('copy'); copyDone('${en ? "Copied as HTML" : "HTML をコピーしました"}'); }
  catch(e){ copyDone('${en ? "Copy failed" : "コピーできませんでした"}'); }
  sel.removeAllRanges(); tmp.remove();
});
</script>`;
}

// セッションの基本情報: ワークスペース／開始（ローカル時刻）／セッション の順に1行ずつ
function metaBlock(workspace: string, startedAt: string | null, sessionId: string, lang: Lang = "ja"): string {
  const en = lang === "en";
  return `<div class="meta">
<div><span class="k">${en ? "Workspace" : "ワークスペース"}:</span> ${esc(workspace)}</div>
<div><span class="k">${en ? "Started" : "開始"}:</span> ${esc(formatLocalDateTime(startedAt, lang))}</div>
<div><span class="k">${en ? "Session" : "セッション"}:</span> ${esc(sessionId)}</div>
</div>`;
}

// 用語の説明（末尾セクション、表形式）。用語集 v0.1（Step 3）の短文をそのまま使う。
// 用語が増えたら、ここだけをメンテする
function glossarySection(lang: Lang = "ja"): string {
  const rows = glossaryFor(lang);
  const en = lang === "en";
  return `<h2 id="glossary">${en ? "Glossary" : "用語の説明"}</h2>
<table class="gloss"><tr><th>${en ? "Term" : "用語"}</th><th>${en ? "Description" : "説明"}</th></tr>${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join("")}</table>`;
}

function healthWarn(health: Trace["health"], lang: Lang = "ja"): string {
  if (!(health.unknownRatio > 0.2)) return "";
  return lang === "en"
    ? `<div class="warn">⚠ Unknown event types account for ${(health.unknownRatio * 100).toFixed(0)}% of the record. Copilot's log format may have changed, and the results may be incomplete.</div>`
    : `<div class="warn">⚠ 未知のイベント種別が ${(health.unknownRatio * 100).toFixed(0)}% を占めています。Copilot のログ形式が変わった可能性があり、結果が不完全かもしれません。</div>`;
}

function promptBlock(preview: string, truncated: boolean, lang: Lang = "ja"): string {
  const en = lang === "en";
  return `<div>${en ? "Prompt" : "プロンプト"}${truncated ? (en ? " (first part only, truncated)" : "（先頭のみ表示・省略あり）") : ""}</div>
<pre class="prompt">${esc(preview)}${truncated ? " …" : ""}</pre>`;
}

function tokenTable(turns: Trace["turns"], totals: Trace["totals"], lang: Lang = "ja"): string {
  const en = lang === "en";
  const turnRows = turns.map(r =>
    `<tr><td>${r.turn + 1}</td><td>${fmt(r.inputTokens)}</td><td>${fmt(r.cacheReadTokens)}</td><td>${fmt(r.cacheWriteTokens)}</td><td>${fmt(r.outputTokens)}</td><td>${fmt(r.reasoningTokens)}</td></tr>`).join("");
  const obs = cacheWriteObservation(turns, lang);
  return `<table class="tokens"><tr><th>${en ? "Turn" : "ターン"}</th><th>${en ? "Input" : "入力"}</th><th>${en ? "Cache read" : "キャッシュ読取"}</th><th>${en ? "Cache write" : "キャッシュ書込"}</th><th>${en ? "Output" : "出力"}</th><th>${en ? "Reasoning" : "推論"}</th></tr>${turnRows}
<tr><th>${en ? "Total" : "合計"}</th><th>${fmt(totals.inputTokens)}</th><th>${fmt(totals.cacheReadTokens)}</th><th>${fmt(totals.cacheWriteTokens)}</th><th>${fmt(totals.outputTokens)}</th><th>${fmt(totals.reasoningTokens)}</th></tr></table>
${inputBreakdown(totals, lang)}${obs ? `\n<p class="tok">${esc(obs)}</p>` : ""}`;
}

// 入力トークンの内訳（新規入力 / キャッシュ読取 / キャッシュ書込の3分解）を帯グラフで示す。
// 「入力」はキャッシュ分を含む総数なので、書込を新規入力に埋もれさせない（Issue #9）。
// コンテキスト（上限のある器）とは別物であることが見て分かるようにする
function inputBreakdown(totals: Trace["totals"], lang: Lang = "ja"): string {
  const en = lang === "en";
  const input = totals.inputTokens;
  if (!input) return "";
  const split = inputSplit(totals);
  if (!split) {
    return `<p style="margin:12px 0 4px">${en ? "Input token breakdown" : "入力トークンの内訳"} (${en ? "total" : "合計"} ${fmt(input)})</p>
<p class="tok">${en ? "Cache reads and writes together exceed the total input, so the three-way breakdown is unavailable (inconsistent record). The totals table shows the measured values." : "キャッシュ読取と書込の合計が入力の合計を超えているため、内訳を3分解できません（記録の不整合）。合計表の値が実測です。"}</p>`;
  }
  const { fresh, cacheRead, cacheWrite } = split;
  const W = 520;
  const rw = Math.round((W * cacheRead) / input);
  const ww = Math.round((W * cacheWrite) / input);
  return `<p style="margin:12px 0 4px">${en ? "Input token breakdown" : "入力トークンの内訳"} (${en ? "total" : "合計"} ${fmt(input)})</p>
<svg width="${W}" height="16"><rect x="0" y="0" width="${rw}" height="16" fill="#3a6ea5"/><rect x="${rw}" y="0" width="${ww}" height="16" fill="#d97b29"/><rect x="${rw + ww}" y="0" width="${W - rw - ww}" height="16" fill="#b9c0c7"/></svg>
<p class="bar-legend">${en
    ? `<span style="color:#3a6ea5">■</span> Cache read (reuse of input shared with previous turns) ${fmt(cacheRead)} / <span style="color:#d97b29">■</span> Cache write (stored for future reuse) ${fmt(cacheWrite)} / <span style="color:#9aa3ab">■</span> New input ${fmt(fresh)}. Caching is separate from the size of the context (see "Cache" in the Glossary).`
    : `<span style="color:#3a6ea5">■</span> キャッシュ読取（前のターンと共通する入力の再利用） ${fmt(cacheRead)} ／ <span style="color:#d97b29">■</span> キャッシュ書込（将来の再利用のための保存） ${fmt(cacheWrite)} ／ <span style="color:#9aa3ab">■</span> 新規入力 ${fmt(fresh)}。キャッシュはコンテキストの大きさとは別の話です（用語の説明の「キャッシュ」参照）。`}</p>`;
}

function gradeCounts(nodes: TraceNode[]): Record<string, number> {
  const counts = { A: 0, B: 0, C: 0, N: 0 } as Record<string, number>;
  for (const n of nodes) counts[n.grade ?? "N"]++;
  return counts;
}

const PLAY_SCRIPT = `<script>
const nodes=[...document.querySelectorAll('.node[data-order]')].filter(n=>n.dataset.order!=="");
nodes.sort((a,b)=>Number(a.dataset.order)-Number(b.dataset.order));
document.getElementById('play').addEventListener('click',()=>{
  document.querySelectorAll('.node').forEach(n=>n.classList.add('dim'));
  const step=nodes.length>40?120:350;
  nodes.forEach((n,i)=>setTimeout(()=>{n.classList.remove('dim');n.scrollIntoView({block:'nearest'});}, step*(i+1)));
});
</script>`;

// --- スキル呼び出しのサマリ（提供者視点）: 従来レポートの範囲を1スキルに絞ったもの ---
export function renderHtml(trace: Trace, graph: Graph, opts: { title?: string; scopeNote?: string; doc?: { md: string; frag: string }; lang?: Lang } = {}): string {
  const lang = opts.lang ?? "ja";
  const en = lang === "en";
  const counts = gradeCounts(trace.nodes);
  const nodeRows = [...trace.nodes].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9)).map((n: TraceNode) =>
    `<tr><td>${esc(n.relToSkill)}${n.boundary ? (en ? " (outside skill)" : " （スキル外）") : ""}${n.title ? `<br><span class="tok">${esc(n.title)}</span>` : ""}</td><td>${n.grade ? gradeBadge(n.grade, lang) : (en ? "No record" : "記録なし")}</td><td>${n.order ?? ""}</td><td>${esc(n.firstAt ? formatLocalDateTime(n.firstAt, lang) : "")}</td><td>${esc(n.evidence)}</td><td>${fmt(n.estTokens)}</td></tr>`).join("");
  const outside = trace.outsideReads.length
    ? `<h2>${en ? "Files read outside the skill" : "スキル外で読まれたファイル"}</h2><ul>${trace.outsideReads.map(r => `<li>${esc(r.path)}${en ? ` (${esc(r.tool)} / ${esc(r.at ?? "")})` : `（${esc(r.tool)} ／ ${esc(r.at ?? "")}）`}${r.failed ? (en ? " (read failed)" : "（読取失敗）") : ""}${r.title ? ` — ${esc(r.title)}` : ""}</li>`).join("")}</ul>` : "";
  const defaultTitle = en ? `Skill summary — ${trace.session.skillName}` : `スキルサマリ — ${trace.session.skillName}`;
  const body = `
<h1>${esc(opts.title ?? defaultTitle)}</h1>
${termNav(lang)}
${opts.doc ? docCopyBlock(opts.doc.md, opts.doc.frag, lang) : ""}
${metaBlock(trace.session.workspace, trace.session.startedAt, trace.session.id, lang)}
${opts.scopeNote ? `<div class="note">${esc(opts.scopeNote)}</div>` : ""}
${promptBlock(trace.session.userMessagePreview, trace.session.userMessageTruncated, lang)}
${healthWarn(trace.health, lang)}
<p>${en ? "Arrivals" : "到達"}: ${gradeBadge("A", lang)} <b>${counts.A}</b>${en ? " (loading into context confirmed)" : "（コンテキストへの読み込みを確認）"} / ${gradeBadge("B", lang)} <b>${counts.B}</b>${en ? " (read)" : "（読み取り）"} / ${gradeBadge("C", lang)} <b>${counts.C}</b>${en ? " (mention only)" : "（言及のみ）"} / ${gradeBadge(null, lang)} <b>${counts.N}</b>${en ? " (no record)" : "（記録なし）"} / ${en ? `${trace.nodes.length} files in total` : `全 ${trace.nodes.length} ファイル`}</p>
${renderTreeHtml(trace.nodes, graph, lang)}
<button id="play" type="button">▶ ${en ? "Play in arrival order" : "到達順に再生"}</button>
${usageBlock(trace, lang)}
<h2>${en ? "Node details" : "ノード明細"}</h2>
<table class="nodes"><tr><th>${en ? "File" : "ファイル"}</th><th>${en ? "Certainty" : "確度"}</th><th>${en ? "Order" : "順"}</th><th>${en ? "First seen" : "初出"}</th><th>${en ? "Evidence" : "根拠"}</th><th>${en ? "Est. tokens" : "推定トークン"}</th></tr>${nodeRows}</table>
${outside}
<h2>${en ? "How to read this" : "読み方の注意"}</h2>
<div class="note"><ul style="margin:0;padding-left:18px">
${en ? `<li>"No record" is not proof that a file was not read. If the record format changes, matching may miss entries.</li>
<li>Certainty is how sure we can be that the file arrived. ${gradeBadge("A", lang)} = a record of loading into context / ${gradeBadge("B", lang)} = a record of a successful read / ${gradeBadge("C", lang)} = mention only.</li>
<li>${gradeBadge("B", lang)} does not mean "unused". Loading may simply not have been recorded as a separate event.</li>
<li>Token estimates (shown with ~) are approximations. Read them separately from measured usage.</li>`
: `<li>「記録なし」は「読まれていない」ことの証明ではありません。記録の形式が変われば、対応付けに漏れが出ます。</li>
<li>確度は「到達したことの確かさ」です。${gradeBadge("A", lang)} = コンテキストへの読み込みの記録あり ／ ${gradeBadge("B", lang)} = 読み取り成功の記録あり ／ ${gradeBadge("C", lang)} = 言及のみ。</li>
<li>${gradeBadge("B", lang)} は「使われていない」という意味ではありません。読み込みの記録が別イベントとして残らなかっただけのことがあります。</li>
<li>トークン推定（~表示）は概算です。実測（usage の集計）とは別物として読んでください。</li>`}
</ul></div>
${glossarySection(lang)}
${PLAY_SCRIPT}`;
  return pageShell(opts.title ?? defaultTitle, body, lang);
}

export function renderSkillHtml(st: SessionTrace, part: SkillPart, docOpts?: { includeNotes?: boolean; lang?: Lang }): string {
  const lang = docOpts?.lang ?? "ja";
  const en = lang === "en";
  const shim: Trace = {
    source: st.source,
    creditsTotal: st.creditsTotal,
    creditTurns: st.creditTurns,
    contextUsageSeries: st.contextUsageSeries,
    lastContextUsageRatio: st.lastContextUsageRatio,
    session: {
      id: st.session.id, startedAt: st.session.startedAt, workspace: st.session.workspace,
      skillDir: part.skillDir, skillName: part.skillName,
      userMessagePreview: st.session.userMessagePreview, userMessageTruncated: st.session.userMessageTruncated,
    },
    health: st.health,
    contextCurrentSeries: st.contextCurrentSeries,
    lastContextCurrentTokens: st.lastContextCurrentTokens,
    contextTokenLimit: st.contextTokenLimit,
    contextFillRatio: st.contextFillRatio,
    turns: st.turns, totals: st.totals, toolExecutions: st.toolExecutions,
    nodes: part.nodes,
    outsideReads: [],
  };
  return renderHtml(shim, part.graph, {
    title: en ? `Skill summary — ${part.skillName}` : `スキルサマリ — ${part.skillName}`,
    scopeNote: en
      ? `Showing only this skill's scope. ${st.source === "kiro" ? "Credit usage" : "Token usage"} and context window usage are session-wide values (not measurements of this skill alone). Arrival order numbers run across the whole session.`
      : st.source === "kiro"
        ? "このスキルの範囲だけを表示しています。クレジット実測とコンテキストウィンドウ使用量はセッション全体の値です（このスキル単独の実測ではありません）。到達順の番号はセッション全体の通し番号です。"
        : "このスキルの範囲だけを表示しています。トークン実測とコンテキストウィンドウ使用量はセッション全体の値です（このスキル単独の実測ではありません）。到達順の番号はセッション全体の通し番号です。",
    doc: { md: renderSkillMarkdown(st, part, docOpts), frag: renderSkillHtmlFragment(st, part, docOpts) },
    lang,
  });
}

// --- セッション全体のサマリ（利用者視点） ---
export function renderSessionHtml(st: SessionTrace, docOpts?: { includeNotes?: boolean; lang?: Lang }): string {
  const lang = docOpts?.lang ?? "ja";
  const en = lang === "en";
  const skillRows = st.skills.map(part => {
    const counts = gradeCounts(part.nodes);
    const reached = part.nodes.filter(n => n.grade);
    const firstOrder = reached.length ? Math.min(...reached.map(n => n.order ?? Number.MAX_SAFE_INTEGER)) : null;
    const reachedTok = reached.reduce((sum, n) => sum + n.estTokens, 0);
    const totalTok = part.nodes.reduce((sum, n) => sum + n.estTokens, 0);
    return `<tr><td>${esc(part.skillName)}</td><td>${firstOrder !== null && firstOrder !== Number.MAX_SAFE_INTEGER ? "#" + firstOrder : "—"}</td>`
      + (en ? `<td>High ${counts.A} · Medium ${counts.B} · Low ${counts.C}</td>` : `<td>高 ${counts.A} ・ 中 ${counts.B} ・ 低 ${counts.C}</td>`) + `<td>${counts.N}</td><td>${part.nodes.length}</td>`
      + `<td>${fmt(reachedTok)}</td><td>${fmt(totalTok)}</td></tr>`;
  }).join("");

  // 到達の流れは、スキル別サマリと同じ「スキル見出し＋ネストした参照ツリー」の見た目に統一する。
  // 到達順の番号がセッション全体の通し番号なので、再生はスキルの境界を越えて流れる。
  const treesHtml = st.skills.map(part =>
    `<h3>${esc(part.skillName)}</h3>${renderTreeHtml(part.nodes, part.graph, lang)}`).join("");

  const outside = st.outsideReads.length
    ? `<h2>${en ? "Files read outside the skill" : "スキル外で読まれたファイル"}</h2><ul>${st.outsideReads.map(r => `<li>${esc(r.path)}${en ? ` (${esc(r.tool)} / ${esc(r.at ?? "")})` : `（${esc(r.tool)} ／ ${esc(r.at ?? "")}）`}${r.failed ? (en ? " (read failed)" : "（読取失敗）") : ""}${r.title ? ` — ${esc(r.title)}` : ""}</li>`).join("")}</ul>` : "";

  const body = `
<h1>${en ? "Session summary" : "セッションサマリ"}</h1>
${termNav(lang)}
${docCopyBlock(renderSessionMarkdown(st, docOpts), renderSessionHtmlFragment(st, docOpts), lang)}
${metaBlock(st.session.workspace, st.session.startedAt, st.session.id, lang)}
${promptBlock(st.session.userMessagePreview, st.session.userMessageTruncated, lang)}
${healthWarn(st.health, lang)}
<h2>${en ? "Activated skills" : "起動したスキル"}</h2>
<table class="skills"><tr><th>${en ? "Skill" : "スキル"}</th><th>${en ? "First arrival" : "最初の到達順"}</th><th>${en ? "Arrivals by certainty" : "到達の内訳（確度別）"}</th><th>${en ? "No record" : "記録なし"}</th><th>${en ? "All files" : "全ファイル"}</th><th>${en ? "Est. tokens (arrived)" : "到達分の推定トークン合計"}</th><th>${en ? "Est. tokens (whole skill)" : "スキル全体の推定トークン合計"}</th></tr>${skillRows}</table>
${st.skills.length ? `<p class="tok">${en ? "For a per-skill breakdown, select the skill in the tree and open \"This skill's summary\"." : "スキルごとの詳しい内訳は、ツリーでスキルを選んで「このスキルのサマリ」を開いてください。"}</p>${undiscoveredSkillsNote(st.undiscoveredSkills, lang, st.session.workspace) ? `\n<p class="tok">${esc(undiscoveredSkillsNote(st.undiscoveredSkills, lang, st.session.workspace))}</p>` : ""}` : undiscoveredSkillsNote(st.undiscoveredSkills, lang, st.session.workspace) ? `<p>${esc(undiscoveredSkillsNote(st.undiscoveredSkills, lang, st.session.workspace))}${en ? " The reference tree for this skill cannot be shown." : " そのため、このスキルについては参照ツリーを表示できません。"}</p>` : `<p>${en ? "No skill activation was detected in this session." : "このセッションではスキル起動は検出されませんでした。"}</p>`}
${st.contextLoads?.length ? `<h2>${en ? "Always-loaded context (loaded into context)" : "常時文脈（コンテキストへの読み込み）"}</h2>
<ul>${st.contextLoads.map(l => `<li>${esc(l.path)}${l.at ? ` (${esc(formatLocalDateTime(l.at, lang))})` : ""}</li>`).join("")}</ul>${firstContextUsageRatio(st.contextUsageSeries) !== null ? `
<p class="tok">${en ? `First recorded context window usage: ${(firstContextUsageRatio(st.contextUsageSeries)! * 100).toFixed(1)}% (recorded early in the session. It includes the prompt and loaded files, so it is not the usage of the always-loaded context alone — but it is a guide to how heavy that context is)` : `最初に記録されたコンテキストウィンドウ使用率: ${(firstContextUsageRatio(st.contextUsageSeries)! * 100).toFixed(1)}%（セッションの早い段階の記録です。プロンプトや読み込まれたファイルも含まれるため常時文脈だけの使用率は分かりませんが、常時文脈の重さを見る手がかりになります）`}</p>` : ""}
<p class="tok">${en ? "Documents that are always loaded as the session's context, apart from skill activation (such as steering)." : "スキル起動とは別に、セッションの文脈として常に読み込まれる文書（steering など）です。"}</p>` : ""}
${usageBlock(st, lang)}
<h2>${en ? "Arrival flow" : "到達の流れ"}</h2>
${treesHtml}
<button id="play" type="button">▶ ${en ? "Play in arrival order" : "到達順に再生"}</button>
${outside}
<h2>${en ? "How to read this" : "読み方の注意"}</h2>
<div class="note"><ul style="margin:0;padding-left:18px">
${en ? `<li>Arrival order numbers run across the whole session. If the same file is reached from several skills, the number is the same for all of them.</li>
<li>"No record" is not proof that a file was not read. If the record format changes, matching may miss entries.</li>
<li>Certainty is how sure we can be that the file arrived. ${gradeBadge("A", lang)} = a record of loading into context / ${gradeBadge("B", lang)} = a record of a successful read / ${gradeBadge("C", lang)} = mention only.</li>
<li>Token estimates (shown with ~) are approximations. Read them separately from measured usage.</li>`
: `<li>到達順の番号はセッション全体の通し番号です。同じファイルが複数スキルから到達した場合、番号は全スキルで同じになります。</li>
<li>「記録なし」は「読まれていない」ことの証明ではありません。記録の形式が変われば、対応付けに漏れが出ます。</li>
<li>確度は「到達したことの確かさ」です。${gradeBadge("A", lang)} = コンテキストへの読み込みの記録あり ／ ${gradeBadge("B", lang)} = 読み取り成功の記録あり ／ ${gradeBadge("C", lang)} = 言及のみ。</li>
<li>トークン推定（~表示）は概算です。実測（usage の集計）とは別物として読んでください。</li>`}
</ul></div>
${glossarySection(lang)}
${PLAY_SCRIPT}`;
  return pageShell(en ? "Session summary" : "セッションサマリ", body, lang);
}

/** スキル別集計（Issue #31）の HTML。消費はセッション全体の実測で、
 *  スキルへの按分をしていないことを注記で明示する */
export function renderSkillTotalsHtml(rows: SkillTotal[], meta: { scanned: number; skipped: number }, lang: Lang = "ja"): string {
  const en = lang === "en";
  const dash = "—";
  const num = (v: number, has: boolean): string => (has ? fmt(v) : dash);
  const cred = (v: number, has: boolean): string => (has ? fmtCredits(v) : dash);
  const body: string[] = [];
  body.push(`<h1>${en ? "Skill totals" : "スキル別集計"}</h1>`);
  body.push(`<div class="note">${en
    ? `Aggregated from the sessions shown in the history (up to 30 most recent sessions per source). Scanned ${meta.scanned} sessions${meta.skipped ? `; ${meta.skipped} could not be read and were skipped` : ""}.`
    : `履歴に表示中のセッション（供給源ごとに新しい順30件まで）から集計しました。対象は ${meta.scanned} セッション${meta.skipped ? `（読み取れなかった ${meta.skipped} 件は除く）` : ""}。`}</div>`);
  if (!rows.length) {
    body.push(`<p>${en ? "No skill activations were found in these sessions." : "対象セッションにスキル起動がありませんでした。"}</p>`);
    return pageShell(en ? "Skill totals" : "スキル別集計", body.join("\n"), lang);
  }
  body.push(`<table class="totals"><thead><tr><th>${en ? "Skill" : "スキル"}</th><th>${en ? "Sessions" : "セッション数"}</th><th>${en ? "Activations" : "起動回数"}</th><th>${en ? "Credits (Kiro)" : "クレジット（Kiro）"}</th><th>${en ? "Credits (Copilot Chat)" : "クレジット（Copilot Chat）"}</th><th>${en ? "Input tokens (Copilot)" : "入力トークン（Copilot）"}</th><th>${en ? "Output tokens (Copilot)" : "出力トークン（Copilot）"}</th><th>${en ? "Last used" : "最終利用"}</th></tr></thead><tbody>`);
  for (const r of rows) {
    body.push(`<tr><td>${esc(r.name)}</td><td>${fmt(r.sessions)}</td><td>${fmt(r.activations)}</td>`
      + `<td>${cred(r.kiroCredits, r.kiroSessions > 0)}</td><td>${cred(r.chatCredits, r.chatSessions > 0)}</td>`
      + `<td>${num(r.copilotInputTokens, r.copilotSessions > 0)}</td><td>${num(r.copilotOutputTokens, r.copilotSessions > 0)}</td>`
      + `<td>${esc(r.lastUsedAt ? formatLocalDateTime(r.lastUsedAt, lang) : dash)}</td></tr>`);
  }
  body.push("</tbody></table>");
  body.push(`<div class="note">${en
    ? "Credits and tokens are measured per session as a whole, not apportioned per skill: when several skills were activated in one session, the same session total counts toward each of them. Values in different units are never added together. For Copilot Chat, activations are counted per session (the record does not distinguish repeated activations within a session)."
    : "クレジットとトークンはセッション全体の実測で、スキルへの按分はしていません。複数のスキルが起動したセッションでは、同じセッション合計が各スキルに入ります。単位の異なる値は合算していません。Copilot Chat の起動回数は、記録の性質上セッション単位の有無で数えています。"}</div>`);
  return pageShell(en ? "Skill totals" : "スキル別集計", body.join("\n"), lang);
}
