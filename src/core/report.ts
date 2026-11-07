// HTML レポート（自己完結、外部依存なし）。拡張のサマリ Webview と共用する。
// サマリは二層: セッション全体のサマリ（利用者視点: このチャットで何が起きたか）と
// スキル呼び出しのサマリ（提供者視点: このスキルが適切に動いたか）。
// どちらも同じ SessionTrace データに対するビューであり、計算は1つだけ。
import type { Graph } from "./graph";
import type { SessionTrace, SkillPart, Trace, TraceNode } from "./trace";
import { formatLocalDateTime } from "./sessions";
import { esc, fmt, fmtCredits, usedToolsSummary, GLOSSARY } from "./common";
import { renderSessionMarkdown, renderSessionHtmlFragment, renderSkillMarkdown, renderSkillHtmlFragment } from "./document";
export { esc, fmt };

export function gradeBadge(grade: string | null): string {
  const cls = grade === "A" ? "bA" : grade === "B" ? "bB" : grade === "C" ? "bC" : "bN";
  const label = grade === "A" ? "確度高" : grade === "B" ? "確度中" : grade === "C" ? "確度低" : "—";
  return `<span class="badge ${cls}">${label}</span>`;
}

export function fillZone(ratio: number | null): { label: string; color: string } {
  if (ratio === null) return { label: "上限不明", color: "#8a8a8a" };
  if (ratio < 0.5) return { label: "余裕", color: "#3d9970" };
  if (ratio < 0.8) return { label: "注意", color: "#d4a017" };
  return { label: "圧迫", color: "#c0392b" };
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
svg text{fill:var(--muted);font-size:11px}
.bar-legend{font-size:12px;color:var(--muted)}`;

function pageShell(title: string, body: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>${esc(title)}</title>
<style>${STYLE}</style></head><body>
${body}</body></html>`;
}

function renderTreeHtml(nodes: TraceNode[], graph: Graph): string {
  const byRel = new Map(nodes.map(n => [n.relToSkill, n]));
  const root = graph.order[0];
  const walk = (id: string, seen: Set<string>): string => {
    const gn = graph.nodes.get(id)!;
    const tn = byRel.get(gn.relToSkill);
    const grade = tn?.grade ?? null;
    const orderBadge = tn?.order !== null && tn?.order !== undefined ? `<span class="ord">#${tn!.order}</span>` : "";
    const bnd = gn.boundary ? ' <span class="bnd">スキル外</span>' : "";
    const miss = gn.missing ? ' <span class="miss">参照先なし</span>' : "";
    const cyc = gn.cycle ? ' <span class="bnd">循環（ここまで）</span>' : "";
    const ev = tn ? ` title="${esc(tn.evidence)}${tn.firstAt ? " ／ " + esc(tn.firstAt) : ""}"` : "";
    let children = "";
    if (!seen.has(id) && !gn.cycle) {
      seen.add(id);
      if (gn.children.length) children = `<ul>${gn.children.map(c => walk(c, seen)).join("")}</ul>`;
    }
    return `<li><span class="node" data-order="${tn?.order ?? ""}"${ev}>${gradeBadge(grade)} ${esc(gn.relToSkill)}${gn.title ? ` <span class="tit">${esc(gn.title)}</span>` : ""}${bnd}${miss}${cyc} ${orderBadge} <span class="tok">~${fmt(gn.estTokens)} トークン</span></span>${children}</li>`;
  };
  return `<ul class="tree">${walk(root.id, new Set())}</ul>`;
}

type FillSource = Pick<Trace, "contextCurrentSeries" | "lastContextCurrentTokens" | "contextTokenLimit" | "contextFillRatio">;
function renderFillChart(src: FillSource): string {
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
    const cap = r === 1 ? `<text x="${mL + 4}" y="${y - 4}">上限 ${fmt(max)} トークン</text>` : "";
    return `<line x1="${mL}" y1="${y}" x2="${W - mR}" y2="${y}" style="stroke:var(--line)"${dash}/>`
      + `<text x="${mL - 6}" y="${y + 4}" text-anchor="end">${Math.round(r * 100)}%</text>${cap}`;
  }).join("");
  const pts = series.map((p, i) => `${X(i).toFixed(1)},${Y(p.tokens).toFixed(1)}`).join(" ");
  const dots = series.map((p, i) =>
    `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.tokens).toFixed(1)}" r="${i === series.length - 1 ? 3.5 : 2.2}" fill="#6cb2f5"/>`).join("");
  const xLabels = `<text x="${X(0)}" y="${H - 6}" text-anchor="middle">ターン 1</text>`
    + (series.length > 1 ? `<text x="${X(series.length - 1)}" y="${H - 6}" text-anchor="middle">ターン ${series.length}</text>` : "");
  const zone = fillZone(src.contextFillRatio);
  return `<h2>コンテキストウィンドウ使用量</h2>
<p>最終使用量 ${fmt(src.lastContextCurrentTokens)} / 上限 ${fmt(src.contextTokenLimit)} トークン
（${src.contextFillRatio !== null ? (src.contextFillRatio * 100).toFixed(1) + "%" : "—"}）
<span class="zone" style="color:${zone.color}">● ${zone.label}</span></p>
<svg width="${W}" height="${H}" style="background:var(--panel);border:1px solid var(--line);border-radius:6px">
${grid}<polyline points="${pts}" fill="none" stroke="#6cb2f5" stroke-width="2"/>${dots}${xLabels}</svg>
<p class="bar-legend">縦軸: コンテキストウィンドウ使用量（上限に対する割合）／ 横軸: ターン</p>`;
}

// --- Kiro の実測表示: トークンではなくクレジットと使用率（%）で記録される ---
type CreditSource = Pick<SessionTrace, "creditsTotal" | "creditTurns">;
function creditsBlock(src: CreditSource): string {
  const rows = (src.creditTurns ?? []).map(t =>
    `<tr><td>${t.turn + 1}</td><td>${fmtCredits(t.credits)}</td><td>${esc(usedToolsSummary(t.usedTools))}</td></tr>`).join("");
  return `<h2>クレジット実測</h2>
<p>合計 <b>${fmtCredits(src.creditsTotal)}</b> credits（usage_summary の積算。Kiro の実測はトークンではなくクレジットで記録されます）</p>
<table class="nodes"><tr><th>ターン</th><th>クレジット</th><th>使用したツール</th></tr>${rows}</table>`;
}

type UsageRatioSource = Pick<SessionTrace, "contextUsageSeries" | "lastContextUsageRatio">;
function renderKiroUsageChart(src: UsageRatioSource): string {
  const series = src.contextUsageSeries ?? [];
  if (!series.length) return "";
  const W = 680, H = 200, mL = 46, mR = 12, mT = 16, mB = 26;
  const iw = W - mL - mR, ih = H - mT - mB;
  const X = (i: number) => mL + (series.length === 1 ? iw / 2 : (iw * i) / (series.length - 1));
  const Y = (v: number) => mT + ih * (1 - v);
  const grid = [0, 0.25, 0.5, 0.75, 1].map(r => {
    const y = Y(r);
    const dash = r === 1 ? ` stroke-dasharray="4 3"` : "";
    const cap = r === 1 ? `<text x="${mL + 4}" y="${y - 4}">上限 100%</text>` : "";
    return `<line x1="${mL}" y1="${y}" x2="${W - mR}" y2="${y}" style="stroke:var(--line)"${dash}/>`
      + `<text x="${mL - 6}" y="${y + 4}" text-anchor="end">${Math.round(r * 100)}%</text>${cap}`;
  }).join("");
  const pts = series.map((p, i) => `${X(i).toFixed(1)},${Y(p.ratio).toFixed(1)}`).join(" ");
  const dots = series.map((p, i) =>
    `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.ratio).toFixed(1)}" r="${i === series.length - 1 ? 3.5 : 2.2}" fill="#6cb2f5"/>`).join("");
  const xLabels = `<text x="${X(0)}" y="${H - 6}" text-anchor="middle">記録 1</text>`
    + (series.length > 1 ? `<text x="${X(series.length - 1)}" y="${H - 6}" text-anchor="middle">記録 ${series.length}</text>` : "");
  const zone = fillZone(src.lastContextUsageRatio ?? null);
  const pct = src.lastContextUsageRatio !== null && src.lastContextUsageRatio !== undefined ? (src.lastContextUsageRatio * 100).toFixed(1) + "%" : "—";
  return `<h2>コンテキストウィンドウ使用量</h2>
<p>最終使用率 ${pct} <span class="zone" style="color:${zone.color}">● ${zone.label}</span></p>
<svg width="${W}" height="${H}" style="background:var(--panel);border:1px solid var(--line);border-radius:6px">
${grid}<polyline points="${pts}" fill="none" stroke="#6cb2f5" stroke-width="2"/>${dots}${xLabels}</svg>
<p class="bar-legend">縦軸: コンテキストウィンドウ使用率 ／ 横軸: 記録された時点の順序</p>
<p class="tok">Kiro の記録には使用率（%）だけが残ります。トークンの絶対量と上限は記録されません。</p>`;
}

/** 実測ブロック: 供給源で出し分ける（Copilot=トークン実測、Kiro=クレジット実測） */
function usageBlock(trace: Trace | SessionTrace): string {
  if (trace.source === "kiro") return `${creditsBlock(trace)}\n${renderKiroUsageChart(trace)}`;
  return `<h2>トークン実測</h2>\n${tokenTable(trace.turns, trace.totals)}\n${renderFillChart(trace)}`;
}

// 先頭の用語導線: 「困ったらこの文書の中に用語集がある」と認知させることが目的
// （出現箇所ごとに注釈を付けると、改訂のたびに付け忘れの不整合が出るため一本化する）
function termNav(): string {
  return `<p class="termnav">分からない用語は、このページの末尾にある <a href="#glossary">用語の説明</a> にまとめています。</p>`;
}

// 文書コピー（0.7.0）: 議論の場（Loop / PowerPoint / GitHub 等）へ貼るための
// Markdown / HTML 形式を、このページから直接コピーできるようにする。
// HTML は ClipboardItem を優先し、ダメなら画面外要素の選択コピーに落とす
function docCopyBlock(md: string, frag: string): string {
  const mdJson = JSON.stringify(md).replace(/<\//g, "<\\/");
  const fragJson = JSON.stringify(frag).replace(/<\//g, "<\\/");
  return `<p><button id="copyMd" type="button">Markdown でコピー</button> <button id="copyHtml" type="button">HTML でコピー</button> <span id="copyMsg" class="tok"></span></p>
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
  try{ await navigator.clipboard.writeText(MD_TEXT); copyDone('Markdown をコピーしました'); }
  catch(e){ fallbackText(MD_TEXT); copyDone('Markdown をコピーしました'); }
});
document.getElementById('copyHtml').addEventListener('click', async ()=>{
  try{
    const item=new ClipboardItem({
      'text/html': new Blob([FRAG_TEXT],{type:'text/html'}),
      'text/plain': new Blob([MD_TEXT],{type:'text/plain'})
    });
    await navigator.clipboard.write([item]);
    copyDone('HTML をコピーしました');
    return;
  }catch(e){}
  const tmp=document.createElement('div');
  tmp.style.cssText='position:absolute;left:-9999px;top:0';
  tmp.innerHTML=FRAG_TEXT; document.body.appendChild(tmp);
  const range=document.createRange(); range.selectNodeContents(tmp);
  const sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  try{ document.execCommand('copy'); copyDone('HTML をコピーしました'); }
  catch(e){ copyDone('コピーできませんでした'); }
  sel.removeAllRanges(); tmp.remove();
});
</script>`;
}

// セッションの基本情報: ワークスペース／開始（ローカル時刻）／セッション の順に1行ずつ
function metaBlock(workspace: string, startedAt: string | null, sessionId: string): string {
  return `<div class="meta">
<div><span class="k">ワークスペース:</span> ${esc(workspace)}</div>
<div><span class="k">開始:</span> ${esc(formatLocalDateTime(startedAt))}</div>
<div><span class="k">セッション:</span> ${esc(sessionId)}</div>
</div>`;
}

// 用語の説明（末尾セクション、表形式）。用語集 v0.1（Step 3）の短文をそのまま使う。
// 用語が増えたら、ここだけをメンテする
function glossarySection(): string {
  const rows = GLOSSARY;
  return `<h2 id="glossary">用語の説明</h2>
<table class="gloss"><tr><th>用語</th><th>説明</th></tr>${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join("")}</table>`;
}

function healthWarn(health: Trace["health"]): string {
  return health.unknownRatio > 0.2
    ? `<div class="warn">⚠ 未知のイベント種別が ${(health.unknownRatio * 100).toFixed(0)}% を占めています。Copilot のログ形式が変わった可能性があり、結果が不完全かもしれません。</div>` : "";
}

function promptBlock(preview: string, truncated: boolean): string {
  return `<div>プロンプト${truncated ? "（先頭のみ表示・省略あり）" : ""}</div>
<pre class="prompt">${esc(preview)}${truncated ? " …" : ""}</pre>`;
}

function tokenTable(turns: Trace["turns"], totals: Trace["totals"]): string {
  const turnRows = turns.map(r =>
    `<tr><td>${r.turn + 1}</td><td>${fmt(r.inputTokens)}</td><td>${fmt(r.cacheReadTokens)}</td><td>${fmt(r.cacheWriteTokens)}</td><td>${fmt(r.outputTokens)}</td><td>${fmt(r.reasoningTokens)}</td></tr>`).join("");
  return `<table class="tokens"><tr><th>ターン</th><th>入力</th><th>キャッシュ読取</th><th>キャッシュ書込</th><th>出力</th><th>推論</th></tr>${turnRows}
<tr><th>合計</th><th>${fmt(totals.inputTokens)}</th><th>${fmt(totals.cacheReadTokens)}</th><th>${fmt(totals.cacheWriteTokens)}</th><th>${fmt(totals.outputTokens)}</th><th>${fmt(totals.reasoningTokens)}</th></tr></table>
${inputBreakdown(totals)}`;
}

// 入力トークンの内訳（キャッシュ再利用分と新規分）を帯グラフで示す。
// コンテキスト（上限のある器）とは別物であることが見て分かるようにする
function inputBreakdown(totals: Trace["totals"]): string {
  const input = totals.inputTokens;
  if (!input) return "";
  const cache = Math.min(totals.cacheReadTokens, input);
  const fresh = input - cache;
  const W = 520;
  const cw = Math.round((W * cache) / input);
  return `<p style="margin:12px 0 4px">入力トークンの内訳（合計 ${fmt(input)}）</p>
<svg width="${W}" height="16"><rect x="0" y="0" width="${cw}" height="16" fill="#3a6ea5"/><rect x="${cw}" y="0" width="${W - cw}" height="16" fill="#b9c0c7"/></svg>
<p class="bar-legend"><span style="color:#3a6ea5">■</span> キャッシュ読取（前のターンと共通する入力の再利用） ${fmt(cache)} ／ <span style="color:#9aa3ab">■</span> 新規入力 ${fmt(fresh)}。キャッシュはコンテキストの大きさとは別の話です（用語の説明の「キャッシュ」参照）。</p>`;
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
export function renderHtml(trace: Trace, graph: Graph, opts: { title?: string; scopeNote?: string; doc?: { md: string; frag: string } } = {}): string {
  const counts = gradeCounts(trace.nodes);
  const nodeRows = [...trace.nodes].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9)).map((n: TraceNode) =>
    `<tr><td>${esc(n.relToSkill)}${n.boundary ? " （スキル外）" : ""}${n.title ? `<br><span class="tok">${esc(n.title)}</span>` : ""}</td><td>${n.grade ? gradeBadge(n.grade) : "記録なし"}</td><td>${n.order ?? ""}</td><td>${esc(n.firstAt ? formatLocalDateTime(n.firstAt) : "")}</td><td>${esc(n.evidence)}</td><td>${fmt(n.estTokens)}</td></tr>`).join("");
  const outside = trace.outsideReads.length
    ? `<h2>スキル外で読まれたファイル</h2><ul>${trace.outsideReads.map(r => `<li>${esc(r.path)}（${esc(r.tool)} ／ ${esc(r.at ?? "")}）${r.failed ? "（読取失敗）" : ""}${r.title ? ` — ${esc(r.title)}` : ""}</li>`).join("")}</ul>` : "";
  const body = `
<h1>${esc(opts.title ?? `スキルサマリ — ${trace.session.skillName}`)}</h1>
${termNav()}
${opts.doc ? docCopyBlock(opts.doc.md, opts.doc.frag) : ""}
${metaBlock(trace.session.workspace, trace.session.startedAt, trace.session.id)}
${opts.scopeNote ? `<div class="note">${esc(opts.scopeNote)}</div>` : ""}
${promptBlock(trace.session.userMessagePreview, trace.session.userMessageTruncated)}
${healthWarn(trace.health)}
<p>到達: ${gradeBadge("A")} <b>${counts.A}</b>（コンテキストへの読み込みを確認）／ ${gradeBadge("B")} <b>${counts.B}</b>（読み取り）／ ${gradeBadge("C")} <b>${counts.C}</b>（言及のみ）／ ${gradeBadge(null)} <b>${counts.N}</b>（記録なし）／ 全 ${trace.nodes.length} ファイル</p>
${renderTreeHtml(trace.nodes, graph)}
<button id="play" type="button">▶ 到達順に再生</button>
${usageBlock(trace)}
<h2>ノード明細</h2>
<table class="nodes"><tr><th>ファイル</th><th>確度</th><th>順</th><th>初出</th><th>根拠</th><th>推定トークン</th></tr>${nodeRows}</table>
${outside}
<h2>読み方の注意</h2>
<div class="note"><ul style="margin:0;padding-left:18px">
<li>「記録なし」は「読まれていない」ことの証明ではありません。記録の形式が変われば、対応付けに漏れが出ます。</li>
<li>確度は「到達したことの確かさ」です。${gradeBadge("A")} = コンテキストへの読み込みの記録あり ／ ${gradeBadge("B")} = 読み取り成功の記録あり ／ ${gradeBadge("C")} = 言及のみ。</li>
<li>${gradeBadge("B")} は「使われていない」という意味ではありません。読み込みの記録が別イベントとして残らなかっただけのことがあります。</li>
<li>トークン推定（~表示）は概算です。実測（usage の集計）とは別物として読んでください。</li>
</ul></div>
${glossarySection()}
${PLAY_SCRIPT}`;
  return pageShell(opts.title ?? `スキルサマリ — ${trace.session.skillName}`, body);
}

export function renderSkillHtml(st: SessionTrace, part: SkillPart, docOpts?: { includeNotes?: boolean }): string {
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
    title: `スキルサマリ — ${part.skillName}`,
    scopeNote: st.source === "kiro"
      ? "このスキルの範囲だけを表示しています。クレジット実測とコンテキストウィンドウ使用量はセッション全体の値です（このスキル単独の実測ではありません）。到達順の番号はセッション全体の通し番号です。"
      : "このスキルの範囲だけを表示しています。トークン実測とコンテキストウィンドウ使用量はセッション全体の値です（このスキル単独の実測ではありません）。到達順の番号はセッション全体の通し番号です。",
    doc: { md: renderSkillMarkdown(st, part, docOpts), frag: renderSkillHtmlFragment(st, part, docOpts) },
  });
}

// --- セッション全体のサマリ（利用者視点） ---
export function renderSessionHtml(st: SessionTrace, docOpts?: { includeNotes?: boolean }): string {
  const skillRows = st.skills.map(part => {
    const counts = gradeCounts(part.nodes);
    const reached = part.nodes.filter(n => n.grade);
    const firstOrder = reached.length ? Math.min(...reached.map(n => n.order ?? Number.MAX_SAFE_INTEGER)) : null;
    const reachedTok = reached.reduce((sum, n) => sum + n.estTokens, 0);
    const totalTok = part.nodes.reduce((sum, n) => sum + n.estTokens, 0);
    return `<tr><td>${esc(part.skillName)}</td><td>${firstOrder !== null && firstOrder !== Number.MAX_SAFE_INTEGER ? "#" + firstOrder : "—"}</td>`
      + `<td>高 ${counts.A} ・ 中 ${counts.B} ・ 低 ${counts.C}</td><td>${counts.N}</td><td>${part.nodes.length}</td>`
      + `<td>${fmt(reachedTok)}</td><td>${fmt(totalTok)}</td></tr>`;
  }).join("");

  // 到達の流れは、スキル別サマリと同じ「スキル見出し＋ネストした参照ツリー」の見た目に統一する。
  // 到達順の番号がセッション全体の通し番号なので、再生はスキルの境界を越えて流れる。
  const treesHtml = st.skills.map(part =>
    `<h3>${esc(part.skillName)}</h3>${renderTreeHtml(part.nodes, part.graph)}`).join("");

  const outside = st.outsideReads.length
    ? `<h2>スキル外で読まれたファイル</h2><ul>${st.outsideReads.map(r => `<li>${esc(r.path)}（${esc(r.tool)} ／ ${esc(r.at ?? "")}）${r.failed ? "（読取失敗）" : ""}${r.title ? ` — ${esc(r.title)}` : ""}</li>`).join("")}</ul>` : "";

  const body = `
<h1>セッションサマリ</h1>
${termNav()}
${docCopyBlock(renderSessionMarkdown(st, docOpts), renderSessionHtmlFragment(st, docOpts))}
${metaBlock(st.session.workspace, st.session.startedAt, st.session.id)}
${promptBlock(st.session.userMessagePreview, st.session.userMessageTruncated)}
${healthWarn(st.health)}
<h2>起動したスキル</h2>
<table class="skills"><tr><th>スキル</th><th>最初の到達順</th><th>到達の内訳（確度別）</th><th>記録なし</th><th>全ファイル</th><th>到達分の推定トークン合計</th><th>スキル全体の推定トークン合計</th></tr>${skillRows}</table>
${st.skills.length ? `<p class="tok">スキルごとの詳しい内訳は、ツリーでスキルを選んで「このスキルのサマリ」を開いてください。</p>` : `<p>このセッションではスキル起動は検出されませんでした。</p>`}
${st.contextLoads?.length ? `<h2>常時文脈（コンテキストへの読み込み）</h2>
<ul>${st.contextLoads.map(l => `<li>${esc(l.path)}${l.at ? `（${esc(formatLocalDateTime(l.at))}）` : ""}</li>`).join("")}</ul>
<p class="tok">スキル起動とは別に、セッションの文脈として常に読み込まれる文書（steering など）です。</p>` : ""}
${usageBlock(st)}
<h2>到達の流れ</h2>
${treesHtml}
<button id="play" type="button">▶ 到達順に再生</button>
${outside}
<h2>読み方の注意</h2>
<div class="note"><ul style="margin:0;padding-left:18px">
<li>到達順の番号はセッション全体の通し番号です。同じファイルが複数スキルから到達した場合、番号は全スキルで同じになります。</li>
<li>「記録なし」は「読まれていない」ことの証明ではありません。記録の形式が変われば、対応付けに漏れが出ます。</li>
<li>確度は「到達したことの確かさ」です。${gradeBadge("A")} = コンテキストへの読み込みの記録あり ／ ${gradeBadge("B")} = 読み取り成功の記録あり ／ ${gradeBadge("C")} = 言及のみ。</li>
<li>トークン推定（~表示）は概算です。実測（usage の集計）とは別物として読んでください。</li>
</ul></div>
${glossarySection()}
${PLAY_SCRIPT}`;
  return pageShell("セッションサマリ", body);
}
