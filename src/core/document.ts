// サマリの「文書版」ビルダー（0.7.0）。
// 画面のサマリは対話的（再生・展開）だが、議論の場（Microsoft Loop、PowerPoint、
// GitHub 等）へ貼るには自己完結な文書が要る。ここでは同じ SessionTrace から
// Markdown と HTML 断片（インラインスタイルのみ）の2形式を生成する。
// グラフは SVG ではなく、数値＋文字ブロックの帯で表す（貼り先で欠けないため）。
import type { Graph } from "./graph";
import type { SessionTrace, SkillPart, TraceNode } from "./trace";
import { gradeCertaintyLabel } from "./trace";
import { esc, fmt, fmtCredits, usedToolsSummary, inputSplit, cacheWriteObservation, firstContextUsageRatio, undiscoveredSkillsNote, GLOSSARY } from "./common";
import { formatLocalDateTime } from "./sessions";

function unicodeBar(ratio: number | null | undefined, width = 20): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "";
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function countsOf(nodes: TraceNode[]): Record<string, number> {
  const counts = { A: 0, B: 0, C: 0, N: 0 } as Record<string, number>;
  for (const n of nodes) counts[n.grade ?? "N"]++;
  return counts;
}

function reachedTok(nodes: TraceNode[]): number {
  return nodes.filter(n => n.grade).reduce((s, n) => s + n.estTokens, 0);
}
function totalTok(nodes: TraceNode[]): number {
  return nodes.reduce((s, n) => s + n.estTokens, 0);
}

function nodeSuffix(tn: TraceNode | undefined, gn: { boundary: boolean; missing: boolean }): string {
  const parts: string[] = [];
  parts.push(tn?.grade ? `[${gradeCertaintyLabel(tn.grade)}${tn.order ? ` #${tn.order}` : ""}]` : "[記録なし]");
  if (gn.boundary) parts.push("スキル外");
  if (gn.missing) parts.push("参照先なし");
  return parts.join(" ");
}

/** グラフを深さ付きの行リストに平らにする（共有参照は最初の出現だけ辿る。画面表示と同じ） */
function flattenTree(part: SkillPart): { depth: number; text: string; tn?: TraceNode }[] {
  const byId = new Map(part.nodes.map(n => [n.id, n]));
  const out: { depth: number; text: string; tn?: TraceNode }[] = [];
  const root = part.graph.order[0];
  if (!root) return out;
  const seen = new Set<string>();
  const walk = (id: string, depth: number): void => {
    const gn = part.graph.nodes.get(id);
    if (!gn) return;
    const tn = byId.get(gn.id);
    out.push({ depth, text: `${gn.relToSkill}${gn.title ? ` — ${gn.title}` : ""} ${nodeSuffix(tn, gn)} ~${fmt(gn.estTokens)} トークン`, tn });
    if (seen.has(id) || gn.cycle) return;
    seen.add(id);
    for (const c of gn.children) walk(c, depth + 1);
  };
  walk(root.id, 0);
  return out;
}

/** 文書コピーのオプション。includeNotes は「読み方の注意」と「用語の説明」を
 *  文書に含めるかどうか（製品既定は含めない: 設定 skilltrace.documentIncludeNotes） */
export interface DocumentOptions {
  includeNotes?: boolean;
}

function notesMd(sessionScope: boolean, opts?: DocumentOptions): string {
  if (!opts?.includeNotes) return "";
  return `\n\n## 読み方の注意\n\n${notesList(sessionScope).map(n => `- ${n}`).join("\n")}\n\n## 用語の説明\n\n${glossaryMd()}`;
}

function notesHtmlSections(sessionScope: boolean, opts?: DocumentOptions): string {
  if (!opts?.includeNotes) return "";
  return `\n<h2 style="${H.h2}">読み方の注意</h2>\n${notesHtml(sessionScope)}\n<h2 style="${H.h2}">用語の説明</h2>\n${glossaryHtml()}`;
}

function metaLines(st: SessionTrace): [string, string][] {
  return [
    ["ワークスペース", st.session.workspace],
    ["開始", formatLocalDateTime(st.session.startedAt)],
    ["セッション", st.session.id],
  ];
}

function notesList(sessionScope: boolean): string[] {
  const notes: string[] = [];
  if (sessionScope) notes.push("到達順の番号はセッション全体の通し番号です。同じファイルが複数スキルから到達した場合、番号は全スキルで同じになります。");
  notes.push("「記録なし」は「読まれていない」ことの証明ではありません。記録の形式が変われば、対応付けに漏れが出ます。");
  notes.push("確度中（読み取り成功）は「使われていない」という意味ではありません。コンテキストへの読み込みの記録が別イベントとして残らなかっただけのことがあります。");
  notes.push("推定トークンは概算です。実測（usage の集計）とは別物として読んでください。");
  return notes;
}

// ---------------- Markdown ----------------

function mdCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function measuredMd(st: SessionTrace): string {
  if (st.source === "kiro") {
    const rows = (st.creditTurns ?? []).map(t =>
      `| ${t.turn + 1} | ${fmtCredits(t.credits)} | ${mdCell(usedToolsSummary(t.usedTools))} |`).join("\n");
    return `| ターン | クレジット | 使用したツール |\n| --- | ---: | --- |\n${rows}\n| 合計 | ${fmtCredits(st.creditsTotal)} |  |\n\nKiro の実測はトークンではなくクレジットで記録されます（usage_summary の積算）。`;
  }
  const rows = st.turns.map(r =>
    `| ${r.turn + 1} | ${fmt(r.inputTokens)} | ${fmt(r.cacheReadTokens)} | ${fmt(r.cacheWriteTokens)} | ${fmt(r.outputTokens)} | ${fmt(r.reasoningTokens)} |`).join("\n");
  const t = st.totals;
  const split = inputSplit(t);
  const obs = cacheWriteObservation(st.turns);
  const breakdown = split
    ? `入力トークンの内訳（合計 ${fmt(t.inputTokens)}）: キャッシュ読取（前のターンと共通する入力の再利用） ${fmt(split.cacheRead)}${t.inputTokens ? ` ${unicodeBar(split.cacheRead / t.inputTokens)}` : ""} ／ キャッシュ書込（将来の再利用のための保存） ${fmt(split.cacheWrite)} ／ 新規入力 ${fmt(split.fresh)}`
    : `入力トークンの内訳: キャッシュ読取と書込の合計が入力の合計を超えているため、3分解できません（記録の不整合）。合計表の値が実測です。`;
  return `| ターン | 入力 | キャッシュ読取 | キャッシュ書込 | 出力 | 推論 |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${rows}\n| 合計 | ${fmt(t.inputTokens)} | ${fmt(t.cacheReadTokens)} | ${fmt(t.cacheWriteTokens)} | ${fmt(t.outputTokens)} | ${fmt(t.reasoningTokens)} |\n\n${breakdown}${obs ? `\n\n${obs}` : ""}`;
}

/** 常時文脈の節に併記する「最初に記録された使用率」（Kiro の最初の contextUsage） */
function startUsageText(st: SessionTrace): string {
  const r = firstContextUsageRatio(st.contextUsageSeries);
  return r === null ? "" : `最初に記録されたコンテキストウィンドウ使用率: ${(r * 100).toFixed(1)}%（セッションの早い段階の記録です。プロンプトや読み込まれたファイルも含まれるため常時文脈だけの使用率は分かりませんが、常時文脈の重さを見る手がかりになります）`;
}

function contextMd(st: SessionTrace): string {
  if (st.source === "kiro") {
    const r = st.lastContextUsageRatio;
    const pct = r !== null && r !== undefined ? `${(r * 100).toFixed(1)}%` : "—";
    return `最終使用率 ${pct} ${unicodeBar(r)}（記録は使用率のスナップショットのみで、トークンの絶対量と上限は記録されません）`;
  }
  const pct = st.contextFillRatio !== null ? `${(st.contextFillRatio * 100).toFixed(1)}%` : "—";
  return `最終使用量 ${fmt(st.lastContextCurrentTokens)} / 上限 ${fmt(st.contextTokenLimit)} トークン（${pct}） ${unicodeBar(st.contextFillRatio)}`;
}

function glossaryMd(): string {
  const rows = GLOSSARY.map(([term, def]) => `| ${mdCell(term)} | ${mdCell(def)} |`).join("\n");
  return `| 用語 | 説明 |\n| --- | --- |\n${rows}`;
}

function treeMd(part: SkillPart): string {
  return flattenTree(part).map(l => `${"  ".repeat(l.depth)}- ${l.text}`).join("\n");
}

export function renderSessionMarkdown(st: SessionTrace, opts?: DocumentOptions): string {
  const skillRows = st.skills.map(part => {
    const counts = countsOf(part.nodes);
    const reached = part.nodes.filter(n => n.order !== null);
    const firstOrder = reached.length ? Math.min(...reached.map(n => n.order!)) : null;
    return `| ${mdCell(part.skillName)} | ${firstOrder !== null ? "#" + firstOrder : "—"} | 高 ${counts.A} ・ 中 ${counts.B} ・ 低 ${counts.C} | ${counts.N} | ${part.nodes.length} | ${fmt(reachedTok(part.nodes))} | ${fmt(totalTok(part.nodes))} |`;
  }).join("\n");
  const trees = st.skills.map(part => `### ${part.skillName}\n\n${treeMd(part)}`).join("\n\n");
  const contextLoads = st.contextLoads?.length
    ? `\n\n## 常時文脈（コンテキストへの読み込み）\n\n${st.contextLoads.map(l => `- ${l.path}${l.at ? `（${formatLocalDateTime(l.at)}）` : ""}`).join("\n")}${startUsageText(st) ? `\n\n${startUsageText(st)}` : ""}\n\nスキル起動とは別に、セッションの文脈として常に読み込まれる文書（steering など）です。` : "";
  const outside = st.outsideReads.length
    ? `\n\n## スキル外で読まれたファイル\n\n${st.outsideReads.map(r => `- ${r.path}（${r.tool} ／ ${r.at ? formatLocalDateTime(r.at) : ""}）${r.failed ? "（読取失敗）" : ""}${r.title ? ` — ${r.title}` : ""}`).join("\n")}` : "";
  return `# セッションサマリ

${metaLines(st).map(([k, v]) => `- ${k}: ${v}`).join("\n")}

プロンプト:
> ${st.session.userMessagePreview.replace(/\n/g, " ")}${st.session.userMessageTruncated ? " …" : ""}

## 起動したスキル

| スキル | 最初の到達順 | 到達の内訳（確度別） | 記録なし | 全ファイル | 到達分の推定トークン合計 | スキル全体の推定トークン合計 |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
${skillRows}
${st.skills.length ? (undiscoveredSkillsNote(st.undiscoveredSkills) ? `\n${undiscoveredSkillsNote(st.undiscoveredSkills)}` : "") : undiscoveredSkillsNote(st.undiscoveredSkills) ? `\n${undiscoveredSkillsNote(st.undiscoveredSkills)} そのため、このスキルについては参照ツリーを表示できません。` : "\nこのセッションではスキル起動は検出されませんでした。"}

## 到達の流れ

${trees}${contextLoads}

## ${st.source === "kiro" ? "クレジット実測" : "トークン実測"}

${measuredMd(st)}

## コンテキストウィンドウ使用量

${contextMd(st)}${outside}${notesMd(true, opts)}
`;
}

export function renderSkillMarkdown(st: SessionTrace, part: SkillPart, opts?: DocumentOptions): string {
  const counts = countsOf(part.nodes);
  const nodeRows = [...part.nodes].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9)).map(n =>
    `| ${mdCell(n.relToSkill)}${n.boundary ? " （スキル外）" : ""} | ${n.grade ? gradeCertaintyLabel(n.grade) : "記録なし"} | ${n.order ?? ""} | ${n.firstAt ? formatLocalDateTime(n.firstAt) : ""} | ${mdCell(n.evidence)} | ${fmt(n.estTokens)} |`).join("\n");
  return `# スキルサマリ — ${part.skillName}

${metaLines(st).map(([k, v]) => `- ${k}: ${v}`).join("\n")}

> このスキルの範囲だけを表示しています。${st.source === "kiro" ? "クレジット実測" : "トークン実測"}とコンテキストウィンドウ使用量はセッション全体の値です（このスキル単独の実測ではありません）。到達順の番号はセッション全体の通し番号です。

プロンプト:
> ${st.session.userMessagePreview.replace(/\n/g, " ")}${st.session.userMessageTruncated ? " …" : ""}

到達: 確度高 ${counts.A}（コンテキストへの読み込みを確認）／ 確度中 ${counts.B}（読み取り）／ 確度低 ${counts.C}（言及のみ）／ 記録なし ${counts.N} ／ 全 ${part.nodes.length} ファイル

## 到達の流れ

${treeMd(part)}

## ノード明細

| ファイル | 確度 | 順 | 初出 | 根拠 | 推定トークン |
| --- | --- | ---: | --- | --- | ---: |
${nodeRows}

## ${st.source === "kiro" ? "クレジット実測" : "トークン実測"}（セッション全体）

${measuredMd(st)}

## コンテキストウィンドウ使用量（セッション全体）

${contextMd(st)}${notesMd(false, opts)}
`;
}

// ---------------- HTML 断片（インラインスタイルのみ） ----------------

const H = {
  root: "font-family:'Segoe UI',system-ui,sans-serif;color:#222;line-height:1.55;font-size:14px",
  h1: "font-size:18px;margin:0 0 8px",
  h2: "font-size:15px;margin:22px 0 6px",
  h3: "font-size:14px;margin:14px 0 4px",
  table: "border-collapse:collapse;font-size:13px;margin:6px 0",
  cell: "border:1px solid #cccccc;padding:4px 8px",
  cellR: "border:1px solid #cccccc;padding:4px 8px;text-align:right",
  muted: "color:#888888;font-size:12px",
  prompt: "background:#f4f6f8;border:1px solid #dddddd;border-radius:6px;padding:8px 12px;font-family:Consolas,monospace;font-size:13px;white-space:pre-wrap",
  note: "background:#f4f6f8;border-radius:6px;padding:8px 12px;font-size:13px",
  mono: "font-family:Consolas,monospace",
} as const;

function pill(grade: TraceNode["grade"]): string {
  if (!grade) return `<span style="color:#888888">記録なし</span>`;
  const color = grade === "A" ? "#3d9970" : grade === "B" ? "#3a6ea5" : "#d4a017";
  return `<span style="display:inline-block;padding:0 7px;border-radius:10px;background:${color};color:#ffffff;font-weight:700;font-size:11px">${gradeCertaintyLabel(grade)}</span>`;
}

function treeHtml(part: SkillPart): string {
  const byId = new Map(part.nodes.map(n => [n.id, n]));
  const root = part.graph.order[0];
  if (!root) return "";
  const seen = new Set<string>();
  const walk = (id: string): string => {
    const gn = part.graph.nodes.get(id);
    if (!gn) return "";
    const tn = byId.get(gn.id);
    let children = "";
    if (!seen.has(id) && !gn.cycle) {
      seen.add(id);
      if (gn.children.length) children = `<ul>${gn.children.map(walk).join("")}</ul>`;
    }
    return `<li>${pill(tn?.grade ?? null)} ${esc(gn.relToSkill)}${gn.title ? ` <span style="${H.muted}">${esc(gn.title)}</span>` : ""}${gn.boundary ? ` <span style="color:#7a4fa3;font-size:12px">スキル外</span>` : ""}${gn.missing ? ` <span style="color:#c0392b;font-size:12px">参照先なし</span>` : ""}${tn?.order ? ` <span style="color:#3a6ea5;font-weight:600">#${tn.order}</span>` : ""} <span style="${H.muted}">~${fmt(gn.estTokens)} トークン</span>${children}</li>`;
  };
  return `<ul>${walk(root.id)}</ul>`;
}

function metaHtml(st: SessionTrace): string {
  return metaLines(st).map(([k, v]) => `<div><span style="color:#888888">${k}:</span> ${esc(v)}</div>`).join("");
}

function measuredHtml(st: SessionTrace): string {
  if (st.source === "kiro") {
    const rows = (st.creditTurns ?? []).map(t =>
      `<tr><td style="${H.cell}">${t.turn + 1}</td><td style="${H.cellR}">${fmtCredits(t.credits)}</td><td style="${H.cell}">${esc(usedToolsSummary(t.usedTools))}</td></tr>`).join("");
    return `<table style="${H.table}"><tr><th style="${H.cell}">ターン</th><th style="${H.cell}">クレジット</th><th style="${H.cell}">使用したツール</th></tr>${rows}
<tr><th style="${H.cell}">合計</th><th style="${H.cellR}">${fmtCredits(st.creditsTotal)}</th><td style="${H.cell}"></td></tr></table>
<p>Kiro の実測はトークンではなくクレジットで記録されます（usage_summary の積算）。</p>`;
  }
  const rows = st.turns.map(r =>
    `<tr><td style="${H.cell}">${r.turn + 1}</td><td style="${H.cellR}">${fmt(r.inputTokens)}</td><td style="${H.cellR}">${fmt(r.cacheReadTokens)}</td><td style="${H.cellR}">${fmt(r.cacheWriteTokens)}</td><td style="${H.cellR}">${fmt(r.outputTokens)}</td><td style="${H.cellR}">${fmt(r.reasoningTokens)}</td></tr>`).join("");
  const t = st.totals;
  const split = inputSplit(t);
  const obs = cacheWriteObservation(st.turns);
  const breakdown = split
    ? `<p>入力トークンの内訳（合計 ${fmt(t.inputTokens)}）: キャッシュ読取（前のターンと共通する入力の再利用） ${fmt(split.cacheRead)} <span style="${H.mono}">${unicodeBar(t.inputTokens ? split.cacheRead / t.inputTokens : 0)}</span> ／ キャッシュ書込（将来の再利用のための保存） ${fmt(split.cacheWrite)} ／ 新規入力 ${fmt(split.fresh)}</p>`
    : `<p>入力トークンの内訳: キャッシュ読取と書込の合計が入力の合計を超えているため、3分解できません（記録の不整合）。合計表の値が実測です。</p>`;
  return `<table style="${H.table}"><tr><th style="${H.cell}">ターン</th><th style="${H.cell}">入力</th><th style="${H.cell}">キャッシュ読取</th><th style="${H.cell}">キャッシュ書込</th><th style="${H.cell}">出力</th><th style="${H.cell}">推論</th></tr>${rows}
<tr><th style="${H.cell}">合計</th><th style="${H.cellR}">${fmt(t.inputTokens)}</th><th style="${H.cellR}">${fmt(t.cacheReadTokens)}</th><th style="${H.cellR}">${fmt(t.cacheWriteTokens)}</th><th style="${H.cellR}">${fmt(t.outputTokens)}</th><th style="${H.cellR}">${fmt(t.reasoningTokens)}</th></tr></table>
${breakdown}${obs ? `<p>${esc(obs)}</p>` : ""}`;
}

function contextHtml(st: SessionTrace): string {
  if (st.source === "kiro") {
    const r = st.lastContextUsageRatio;
    const pct = r !== null && r !== undefined ? `${(r * 100).toFixed(1)}%` : "—";
    return `<p>最終使用率 ${pct} <span style="${H.mono}">${unicodeBar(r)}</span>（記録は使用率のスナップショットのみで、トークンの絶対量と上限は記録されません）</p>`;
  }
  const pct = st.contextFillRatio !== null ? `${(st.contextFillRatio * 100).toFixed(1)}%` : "—";
  return `<p>最終使用量 ${fmt(st.lastContextCurrentTokens)} / 上限 ${fmt(st.contextTokenLimit)} トークン（${pct}） <span style="${H.mono}">${unicodeBar(st.contextFillRatio)}</span></p>`;
}

function glossaryHtml(): string {
  const rows = GLOSSARY.map(([term, def]) =>
    `<tr><td style="${H.cell};font-weight:700;white-space:nowrap;vertical-align:top">${esc(term)}</td><td style="${H.cell}">${esc(def)}</td></tr>`).join("");
  return `<table style="${H.table}"><tr><th style="${H.cell}">用語</th><th style="${H.cell}">説明</th></tr>${rows}</table>`;
}

function notesHtml(sessionScope: boolean): string {
  return `<div style="${H.note}"><ul style="margin:0;padding-left:18px">${notesList(sessionScope).map(n => `<li>${esc(n)}</li>`).join("")}</ul></div>`;
}

function promptHtml(st: SessionTrace): string {
  return `<div style="${H.prompt}">${esc(st.session.userMessagePreview)}${st.session.userMessageTruncated ? " …" : ""}</div>`;
}

export function renderSessionHtmlFragment(st: SessionTrace, opts?: DocumentOptions): string {
  const skillRows = st.skills.map(part => {
    const counts = countsOf(part.nodes);
    const reached = part.nodes.filter(n => n.order !== null);
    const firstOrder = reached.length ? Math.min(...reached.map(n => n.order!)) : null;
    return `<tr><td style="${H.cell}">${esc(part.skillName)}</td><td style="${H.cellR}">${firstOrder !== null ? "#" + firstOrder : "—"}</td><td style="${H.cell}">高 ${counts.A} ・ 中 ${counts.B} ・ 低 ${counts.C}</td><td style="${H.cellR}">${counts.N}</td><td style="${H.cellR}">${part.nodes.length}</td><td style="${H.cellR}">${fmt(reachedTok(part.nodes))}</td><td style="${H.cellR}">${fmt(totalTok(part.nodes))}</td></tr>`;
  }).join("");
  const trees = st.skills.map(part => `<h3 style="${H.h3}">${esc(part.skillName)}</h3>${treeHtml(part)}`).join("");
  const contextLoads = st.contextLoads?.length
    ? `<h2 style="${H.h2}">常時文脈（コンテキストへの読み込み）</h2><ul>${st.contextLoads.map(l => `<li>${esc(l.path)}${l.at ? `（${esc(formatLocalDateTime(l.at))}）` : ""}</li>`).join("")}</ul>${startUsageText(st) ? `<p>${esc(startUsageText(st))}</p>` : ""}<p>スキル起動とは別に、セッションの文脈として常に読み込まれる文書（steering など）です。</p>` : "";
  const outside = st.outsideReads.length
    ? `<h2 style="${H.h2}">スキル外で読まれたファイル</h2><ul>${st.outsideReads.map(r => `<li>${esc(r.path)}（${esc(r.tool)} ／ ${esc(r.at ? formatLocalDateTime(r.at) : "")}）${r.failed ? "（読取失敗）" : ""}${r.title ? ` — ${esc(r.title)}` : ""}</li>`).join("")}</ul>` : "";
  return `<div style="${H.root}">
<h1 style="${H.h1}">セッションサマリ</h1>
${metaHtml(st)}
<p style="${H.muted}">プロンプト</p>
${promptHtml(st)}
<h2 style="${H.h2}">起動したスキル</h2>
<table style="${H.table}"><tr><th style="${H.cell}">スキル</th><th style="${H.cell}">最初の到達順</th><th style="${H.cell}">到達の内訳（確度別）</th><th style="${H.cell}">記録なし</th><th style="${H.cell}">全ファイル</th><th style="${H.cell}">到達分の推定トークン合計</th><th style="${H.cell}">スキル全体の推定トークン合計</th></tr>${skillRows}</table>
${st.skills.length ? (undiscoveredSkillsNote(st.undiscoveredSkills) ? `<p>${esc(undiscoveredSkillsNote(st.undiscoveredSkills))}</p>` : "") : undiscoveredSkillsNote(st.undiscoveredSkills) ? `<p>${esc(undiscoveredSkillsNote(st.undiscoveredSkills))} そのため、このスキルについては参照ツリーを表示できません。</p>` : "<p>このセッションではスキル起動は検出されませんでした。</p>"}
<h2 style="${H.h2}">到達の流れ</h2>
${trees}
${contextLoads}
<h2 style="${H.h2}">${st.source === "kiro" ? "クレジット実測" : "トークン実測"}</h2>
${measuredHtml(st)}
<h2 style="${H.h2}">コンテキストウィンドウ使用量</h2>
${contextHtml(st)}${outside}
${notesHtmlSections(true, opts)}
</div>`;
}

export function renderSkillHtmlFragment(st: SessionTrace, part: SkillPart, opts?: DocumentOptions): string {
  const counts = countsOf(part.nodes);
  const nodeRows = [...part.nodes].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9)).map(n =>
    `<tr><td style="${H.cell}">${esc(n.relToSkill)}${n.boundary ? " （スキル外）" : ""}</td><td style="${H.cell}">${n.grade ? pill(n.grade) : "記録なし"}</td><td style="${H.cellR}">${n.order ?? ""}</td><td style="${H.cell}">${esc(n.firstAt ? formatLocalDateTime(n.firstAt) : "")}</td><td style="${H.cell}">${esc(n.evidence)}</td><td style="${H.cellR}">${fmt(n.estTokens)}</td></tr>`).join("");
  return `<div style="${H.root}">
<h1 style="${H.h1}">スキルサマリ — ${esc(part.skillName)}</h1>
${metaHtml(st)}
<div style="${H.note}">このスキルの範囲だけを表示しています。${st.source === "kiro" ? "クレジット実測" : "トークン実測"}とコンテキストウィンドウ使用量はセッション全体の値です（このスキル単独の実測ではありません）。到達順の番号はセッション全体の通し番号です。</div>
<p style="${H.muted}">プロンプト</p>
${promptHtml(st)}
<p>到達: ${pill("A")} <b>${counts.A}</b>（コンテキストへの読み込みを確認）／ ${pill("B")} <b>${counts.B}</b>（読み取り）／ ${pill("C")} <b>${counts.C}</b>（言及のみ）／ 記録なし <b>${counts.N}</b> ／ 全 ${part.nodes.length} ファイル</p>
<h2 style="${H.h2}">到達の流れ</h2>
${treeHtml(part)}
<h2 style="${H.h2}">ノード明細</h2>
<table style="${H.table}"><tr><th style="${H.cell}">ファイル</th><th style="${H.cell}">確度</th><th style="${H.cell}">順</th><th style="${H.cell}">初出</th><th style="${H.cell}">根拠</th><th style="${H.cell}">推定トークン</th></tr>${nodeRows}</table>
<h2 style="${H.h2}">${st.source === "kiro" ? "クレジット実測" : "トークン実測"}（セッション全体）</h2>
${measuredHtml(st)}
<h2 style="${H.h2}">コンテキストウィンドウ使用量（セッション全体）</h2>
${contextHtml(st)}${notesHtmlSections(false, opts)}
</div>`;
}
