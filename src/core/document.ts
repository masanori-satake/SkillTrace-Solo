// サマリの「文書版」ビルダー（0.7.0）。
// 画面のサマリは対話的（再生・展開）だが、議論の場（Microsoft Loop、PowerPoint、
// GitHub 等）へ貼るには自己完結な文書が要る。ここでは同じ SessionTrace から
// Markdown と HTML 断片（インラインスタイルのみ）の2形式を生成する。
// グラフは SVG ではなく、数値＋文字ブロックの帯で表す（貼り先で欠けないため）。
import type { Graph } from "./graph";
import type { SessionTrace, SkillPart, TraceNode } from "./trace";
import { gradeCertaintyLabel } from "./trace";
import { esc, fmt, fmtCredits, blockBar, countTools, toolColumns, toolGroupsPresent, toolGroupLabel, inputSplit, cacheWriteObservation, firstContextUsageRatio, undiscoveredSkillsNote, glossaryFor, type Lang } from "./common";
import { formatLocalDateTime } from "./sessions";

function unicodeBar(ratio: number | null | undefined, width = 20): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "";
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** コンテキストウィンドウ使用量の系列を 0..1 の割合列にする（供給源の違いを吸収する）。
 *  Copilot / Copilot Chat はトークン実測 ÷ 上限（上限が記録に無ければ系列の最大値）、
 *  Kiro は記録された使用率そのもの。perTurn は横軸がターンか記録順か */
function contextRatios(st: SessionTrace): { ratios: number[]; perTurn: boolean; relativeToMax: boolean } | null {
  if (st.source === "kiro") {
    const ratios = (st.contextUsageSeries ?? []).map(p => p.ratio);
    return ratios.length ? { ratios, perTurn: false, relativeToMax: false } : null;
  }
  const series = st.contextCurrentSeries ?? [];
  if (!series.length) return null;
  // 上限が記録に無い場合は系列の最大値で割る。その場合の 100% は実際の
  // 上限に対する使用率ではないため、表示側で相対表示だと明示する
  const relativeToMax = !st.contextTokenLimit;
  const denom = st.contextTokenLimit ?? Math.max(...series.map(p => p.tokens));
  if (!denom) return null;
  return { ratios: series.map(p => p.tokens / denom), perTurn: true, relativeToMax };
}

const SPARK_GLYPHS = "▁▂▃▄▅▆▇█";
/** 割合列をブロック文字のスパークラインにする。点が多い場合は桶ごとの
 *  最大値で間引く（膨らみのピークを落とさないため）。Markdown 用 */
export function sparkline(ratios: number[], maxPoints = 48): string {
  let pts = ratios;
  if (ratios.length > maxPoints) {
    pts = [];
    const bucket = ratios.length / maxPoints;
    for (let i = 0; i < maxPoints; i++) {
      const slice = ratios.slice(Math.floor(i * bucket), Math.floor((i + 1) * bucket));
      if (slice.length) pts.push(Math.max(...slice));
    }
  }
  return pts.map(r => {
    const c = Math.max(0, Math.min(1, r));
    return SPARK_GLYPHS[Math.min(7, Math.floor(c * 8))];
  }).join("");
}

/** 推移の Markdown 行（2点以上あるときだけ）。画面サマリには折れ線グラフが
 *  既にあるため、文書コピー側の不足分として足す（Issue #30） */
function contextTransitionMd(st: SessionTrace, lang: Lang = "ja"): string {
  const en = lang === "en";
  const s = contextRatios(st);
  if (!s || s.ratios.length < 2) return "";
  const peak = Math.max(...s.ratios);
  const peakIdx = s.ratios.indexOf(peak);
  const last = s.ratios[s.ratios.length - 1];
  const unit = s.perTurn ? (en ? "turn" : "ターン") : (en ? "snapshot" : "記録");
  const relNote = s.relativeToMax
    ? (en ? " (the limit is not recorded, so the values are relative to the series maximum = 100%)" : "（上限が記録されていないため、系列の最大値を100%とした相対表示です）")
    : "";
  return en
    ? `\nTransition (in ${s.perTurn ? "turn" : "recorded"} order): ${sparkline(s.ratios)} (peak ${(peak * 100).toFixed(1)}% at ${unit} ${peakIdx + 1} / final ${(last * 100).toFixed(1)}%)${relNote}`
    : `\n推移（${s.perTurn ? "ターン" : "記録"}順）: ${sparkline(s.ratios)}（最大 ${(peak * 100).toFixed(1)}%・${unit} ${peakIdx + 1} ／ 最終 ${(last * 100).toFixed(1)}%）${relNote}`;
}

/** 推移の SVG（文書 HTML 用。貼り付け先で CSS が効かない前提で色は固定値） */
function contextChartSvg(st: SessionTrace, lang: Lang = "ja"): string {
  const en = lang === "en";
  const s = contextRatios(st);
  if (!s || s.ratios.length < 2) return "";
  const ratios = s.ratios;
  const W = 680, H = 200, mL = 46, mR = 12, mT = 16, mB = 26;
  const iw = W - mL - mR, ih = H - mT - mB;
  const X = (i: number) => mL + (ratios.length === 1 ? iw / 2 : (iw * i) / (ratios.length - 1));
  const Y = (v: number) => mT + ih * (1 - Math.max(0, Math.min(1, v)));
  const grid = [0, 0.25, 0.5, 0.75, 1].map(r => {
    const y = Y(r);
    const dash = r === 1 ? ` stroke-dasharray="4 3"` : "";
    return `<line x1="${mL}" y1="${y}" x2="${W - mR}" y2="${y}" stroke="#dddddd"${dash}/>`
      + `<text x="${mL - 6}" y="${y + 4}" text-anchor="end" font-size="11" fill="#888888">${Math.round(r * 100)}%</text>`;
  }).join("");
  const pts = ratios.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const peak = Math.max(...ratios);
  const peakIdx = ratios.indexOf(peak);
  const dots = ratios.map((v, i) =>
    `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="${i === peakIdx ? 3.5 : 2}" fill="${i === peakIdx ? "#d97b29" : "#6cb2f5"}"/>`).join("");
  const unit = s.perTurn ? (en ? "Turn" : "ターン") : (en ? "Snapshot" : "記録");
  const xLabels = `<text x="${X(0)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="#888888">${unit} 1</text>`
    + `<text x="${X(ratios.length - 1)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="#888888">${unit} ${ratios.length}</text>`;
  const peakLabel = `<text x="${X(peakIdx).toFixed(1)}" y="${Math.max(11, Y(peak) - 8).toFixed(1)}" text-anchor="middle" font-size="11" fill="#d97b29">${en ? "Peak" : "最大"} ${(peak * 100).toFixed(1)}%</text>`;
  const caption = s.relativeToMax
    ? (en ? "Vertical: context window usage (relative to the series maximum = 100%, because the limit is not recorded) / Horizontal: " + (s.perTurn ? "turn" : "order of recorded snapshots") + ". The orange dot marks the peak."
      : `縦軸: コンテキストウィンドウ使用量（上限が記録されていないため、系列の最大値を100%とした相対表示）／ 横軸: ${s.perTurn ? "ターン" : "記録された時点の順序"}。オレンジの点は最大の位置です。`)
    : (en ? "Vertical: context window usage (share of the limit) / Horizontal: " + (s.perTurn ? "turn" : "order of recorded snapshots") + ". The orange dot marks the peak."
      : `縦軸: コンテキストウィンドウ使用量（上限に対する割合）／ 横軸: ${s.perTurn ? "ターン" : "記録された時点の順序"}。オレンジの点は最大の位置です。`);
  return `<svg width="${W}" height="${H}" style="background:#f4f6f8;border:1px solid #dddddd;border-radius:6px">${grid}<polyline points="${pts}" fill="none" stroke="#6cb2f5" stroke-width="2"/>${dots}${peakLabel}${xLabels}</svg>`
    + `<p style="color:#888888;font-size:12px">${caption}</p>`;
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

function nodeSuffix(tn: TraceNode | undefined, gn: { boundary: boolean; missing: boolean }, lang: Lang = "ja"): string {
  const en = lang === "en";
  const parts: string[] = [];
  parts.push(tn?.grade ? `[${gradeCertaintyLabel(tn.grade, lang)}${tn.order ? ` #${tn.order}` : ""}]` : (en ? "[No record]" : "[記録なし]"));
  if (gn.boundary) parts.push(en ? "outside skill" : "スキル外");
  if (gn.missing) parts.push(en ? "missing target" : "参照先なし");
  return parts.join(" ");
}

/** グラフを深さ付きの行リストに平らにする（共有参照は最初の出現だけ辿る。画面表示と同じ） */
/** ノード明細の推定トークンに添えるバー（母数はそのスキルの全ファイル合計） */
function nodeBar(n: TraceNode, part: SkillPart): string {
  const total = part.nodes.reduce((a, x) => a + x.estTokens, 0);
  return n.estTokens > 0 && total > 0 ? ` ${blockBar(n.estTokens / total)}` : "";
}

function flattenTree(part: SkillPart, lang: Lang = "ja"): { depth: number; text: string; tn?: TraceNode }[] {
  const byId = new Map(part.nodes.map(n => [n.id, n]));
  const out: { depth: number; text: string; tn?: TraceNode }[] = [];
  const root = part.graph.order[0];
  if (!root) return out;
  const total = part.nodes.reduce((a, n) => a + n.estTokens, 0);
  const seen = new Set<string>();
  const walk = (id: string, depth: number): void => {
    const gn = part.graph.nodes.get(id);
    if (!gn) return;
    const tn = byId.get(gn.id);
    const bar = gn.estTokens > 0 && total > 0 ? ` ${blockBar(gn.estTokens / total)}` : "";
    out.push({ depth, text: `${gn.relToSkill}${gn.title ? ` — ${gn.title}` : ""} ${nodeSuffix(tn, gn, lang)} ~${fmt(gn.estTokens)} ${lang === "en" ? "tokens" : "トークン"}${bar}`, tn });
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
  /** 表示言語（未指定は日本語。拡張はホストの表示言語から決めて渡す） */
  lang?: Lang;
}

function notesMd(sessionScope: boolean, opts?: DocumentOptions): string {
  if (!opts?.includeNotes) return "";
  const lang = opts?.lang ?? "ja";
  const en = lang === "en";
  return `\n\n## ${en ? "How to read this" : "読み方の注意"}\n\n${notesList(sessionScope, lang).map(n => `- ${n}`).join("\n")}\n\n## ${en ? "Glossary" : "用語の説明"}\n\n${glossaryMd(lang)}`;
}

function notesHtmlSections(sessionScope: boolean, opts?: DocumentOptions): string {
  if (!opts?.includeNotes) return "";
  const lang = opts?.lang ?? "ja";
  const en = lang === "en";
  return `\n<h2 style="${H.h2}">${en ? "How to read this" : "読み方の注意"}</h2>\n${notesHtml(sessionScope, lang)}\n<h2 style="${H.h2}">${en ? "Glossary" : "用語の説明"}</h2>\n${glossaryHtml(lang)}`;
}

function metaLines(st: SessionTrace, lang: Lang = "ja"): [string, string][] {
  const en = lang === "en";
  return [
    [en ? "Workspace" : "ワークスペース", st.session.workspace],
    [en ? "Started" : "開始", formatLocalDateTime(st.session.startedAt, lang)],
    [en ? "Session" : "セッション", st.session.id],
  ];
}

function notesList(sessionScope: boolean, lang: Lang = "ja"): string[] {
  if (lang === "en") {
    const notes: string[] = [];
    if (sessionScope) notes.push("Arrival order numbers run across the whole session. If the same file is reached from several skills, the number is the same for all of them.");
    notes.push("\"No record\" is not proof that a file was not read. If the record format changes, matching may miss entries.");
    notes.push("Medium certainty (a successful read) does not mean \"unused\". Loading may simply not have been recorded as a separate event.");
    notes.push("Estimated tokens are approximations. Read them separately from measured usage.");
    return notes;
  }
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

/** クレジット実測の表（ターン×ツールのマトリクス。Markdown では列またがりと色は
 *  表現できないため、列の並び順でグループが分かる形にする。並びはグループ→合計の多い順） */
function creditsMd(st: SessionTrace, lang: Lang = "ja"): string {
  const en = lang === "en";
  const turns = st.creditTurns ?? [];
  const cols = toolColumns(turns);
  if (!cols.length) {
    const rows = turns.map(t => `| ${t.turn + 1} | ${fmtCredits(t.credits)} |  |`).join("\n");
    return `| ${en ? "Turn" : "ターン"} | ${en ? "Credits" : "クレジット"} | ${en ? "Tools used" : "使用したツール"} |\n| --- | ---: | --- |\n${rows}\n| ${en ? "Total" : "合計"} | ${fmtCredits(st.creditsTotal)} |  |`;
  }
  const header = `| ${en ? "Turn" : "ターン"} | ${en ? "Credits" : "クレジット"} | ${cols.map(c => mdCell(c.name)).join(" | ")} |`;
  const sep = `| --- | ---: | ${cols.map(() => "---:").join(" | ")} |`;
  const rows = turns.map(t => {
    const counts = countTools(t.usedTools);
    return `| ${t.turn + 1} | ${fmtCredits(t.credits)} | ${cols.map(c => counts.get(c.name) ?? "").join(" | ")} |`;
  }).join("\n");
  const total = `| ${en ? "Total" : "合計"} | ${fmtCredits(st.creditsTotal)} | ${cols.map(c => c.total).join(" | ")} |`;
  return `${header}\n${sep}\n${rows}\n${total}`;
}

function measuredMd(st: SessionTrace, lang: Lang = "ja"): string {
  const en = lang === "en";
  if (st.source === "kiro") {
    const note = en ? `\n\nKiro records credits, not tokens (summed from usage_summary).` : `\n\nKiro の実測はトークンではなくクレジットで記録されます（usage_summary の積算）。`;
    return `${creditsMd(st, lang)}${note}`;
  }
  const rows = st.turns.map(r =>
    `| ${r.turn + 1} | ${fmt(r.inputTokens)} | ${fmt(r.cacheReadTokens)} | ${fmt(r.cacheWriteTokens)} | ${fmt(r.outputTokens)} | ${fmt(r.reasoningTokens)} |`).join("\n");
  const t = st.totals;
  const split = inputSplit(t);
  const obs = cacheWriteObservation(st.turns, lang);
  const breakdown = split
    ? (en
      ? `Input token breakdown (total ${fmt(t.inputTokens)}): cache read (reuse of input shared with previous turns) ${fmt(split.cacheRead)}${t.inputTokens ? ` ${unicodeBar(split.cacheRead / t.inputTokens)}` : ""} / cache write (stored for future reuse) ${fmt(split.cacheWrite)} / new input ${fmt(split.fresh)}`
      : `入力トークンの内訳（合計 ${fmt(t.inputTokens)}）: キャッシュ読取（前のターンと共通する入力の再利用） ${fmt(split.cacheRead)}${t.inputTokens ? ` ${unicodeBar(split.cacheRead / t.inputTokens)}` : ""} ／ キャッシュ書込（将来の再利用のための保存） ${fmt(split.cacheWrite)} ／ 新規入力 ${fmt(split.fresh)}`)
    : (en
      ? `Input token breakdown: cache reads and writes together exceed the total input, so the three-way breakdown is unavailable (inconsistent record). The totals table shows the measured values.`
      : `入力トークンの内訳: キャッシュ読取と書込の合計が入力の合計を超えているため、3分解できません（記録の不整合）。合計表の値が実測です。`);
  const tokenMd = en
    ? `| Turn | Input | Cache read | Cache write | Output | Reasoning |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${rows}\n| Total | ${fmt(t.inputTokens)} | ${fmt(t.cacheReadTokens)} | ${fmt(t.cacheWriteTokens)} | ${fmt(t.outputTokens)} | ${fmt(t.reasoningTokens)} |\n\n${breakdown}${obs ? `\n\n${obs}` : ""}`
    : `| ターン | 入力 | キャッシュ読取 | キャッシュ書込 | 出力 | 推論 |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${rows}\n| 合計 | ${fmt(t.inputTokens)} | ${fmt(t.cacheReadTokens)} | ${fmt(t.cacheWriteTokens)} | ${fmt(t.outputTokens)} | ${fmt(t.reasoningTokens)} |\n\n${breakdown}${obs ? `\n\n${obs}` : ""}`;
  // VS Code の記録にはクレジット実測（各リクエストの copilotCredits）も残るため併記する
  if (st.source === "vscode" && (st.creditsTotal ?? 0) > 0) {
    const note = en ? `\n\nCopilot Chat also records credit usage (each request's copilotCredits).` : `\n\nCopilot Chat の記録にはクレジット実測（各リクエストの copilotCredits）も残ります。`;
    return `${tokenMd}\n\n${en ? "Credit usage" : "クレジット実測"}:\n\n${creditsMd(st, lang)}${note}`;
  }
  return tokenMd;
}

/** 常時文脈の節に併記する「最初に記録された使用率」（Kiro の最初の contextUsage） */
function startUsageText(st: SessionTrace, lang: Lang = "ja"): string {
  const r = firstContextUsageRatio(st.contextUsageSeries);
  if (r === null) return "";
  return lang === "en"
    ? `First recorded context window usage: ${(r * 100).toFixed(1)}% (recorded early in the session. It includes the prompt and loaded files, so it is not the usage of the always-loaded context alone — but it is a guide to how heavy that context is)`
    : `最初に記録されたコンテキストウィンドウ使用率: ${(r * 100).toFixed(1)}%（セッションの早い段階の記録です。プロンプトや読み込まれたファイルも含まれるため常時文脈だけの使用率は分かりませんが、常時文脈の重さを見る手がかりになります）`;
}

function contextMd(st: SessionTrace, lang: Lang = "ja"): string {
  const en = lang === "en";
  const transition = contextTransitionMd(st, lang);
  if (st.source === "kiro") {
    const r = st.lastContextUsageRatio;
    const pct = r !== null && r !== undefined ? `${(r * 100).toFixed(1)}%` : "—";
    return (en
      ? `Final usage ratio ${pct} ${unicodeBar(r)} (the record holds usage-ratio snapshots only; absolute token counts and the limit are not recorded)`
      : `最終使用率 ${pct} ${unicodeBar(r)}（記録は使用率のスナップショットのみで、トークンの絶対量と上限は記録されません）`) + transition;
  }
  const pct = st.contextFillRatio !== null ? `${(st.contextFillRatio * 100).toFixed(1)}%` : "—";
  return (en
    ? `Final usage ${fmt(st.lastContextCurrentTokens)} / limit ${fmt(st.contextTokenLimit)} tokens (${pct}) ${unicodeBar(st.contextFillRatio)}`
    : `最終使用量 ${fmt(st.lastContextCurrentTokens)} / 上限 ${fmt(st.contextTokenLimit)} トークン（${pct}） ${unicodeBar(st.contextFillRatio)}`) + transition;
}

function glossaryMd(lang: Lang = "ja"): string {
  const rows = glossaryFor(lang).map(([term, def]) => `| ${mdCell(term)} | ${mdCell(def)} |`).join("\n");
  return lang === "en" ? `| Term | Description |\n| --- | --- |\n${rows}` : `| 用語 | 説明 |\n| --- | --- |\n${rows}`;
}

function treeMd(part: SkillPart, lang: Lang = "ja"): string {
  const en = lang === "en";
  const body = flattenTree(part, lang).map(l => `${"  ".repeat(l.depth)}- ${l.text}`).join("\n");
  const total = part.nodes.reduce((a, n) => a + n.estTokens, 0);
  if (!total) return body;
  return body + (en
    ? "\n\n(Bar length: share of this skill's total estimated tokens across all its files)"
    : "\n\n（バーの長さは、このスキルの全ファイルの推定トークン合計に対する割合です）");
}

export function renderSessionMarkdown(st: SessionTrace, opts?: DocumentOptions): string {
  const lang = opts?.lang ?? "ja";
  const en = lang === "en";
  const skillRows = st.skills.map(part => {
    const counts = countsOf(part.nodes);
    const reached = part.nodes.filter(n => n.order !== null);
    const firstOrder = reached.length ? Math.min(...reached.map(n => n.order!)) : null;
    return `| ${mdCell(part.skillName)} | ${firstOrder !== null ? "#" + firstOrder : "—"} | ${en ? `High ${counts.A} · Medium ${counts.B} · Low ${counts.C}` : `高 ${counts.A} ・ 中 ${counts.B} ・ 低 ${counts.C}`} | ${counts.N} | ${part.nodes.length} | ${fmt(reachedTok(part.nodes))} | ${fmt(totalTok(part.nodes))} |`;
  }).join("\n");
  const trees = st.skills.map(part => `### ${part.skillName}\n\n${treeMd(part, lang)}`).join("\n\n");
  const contextLoads = st.contextLoads?.length
    ? `\n\n## ${en ? "Always-loaded context (loaded into context)" : "常時文脈（コンテキストへの読み込み）"}\n\n${st.contextLoads.map(l => `- ${l.path}${l.at ? ` (${formatLocalDateTime(l.at, lang)})` : ""}`).join("\n")}${startUsageText(st, lang) ? `\n\n${startUsageText(st, lang)}` : ""}\n\n${en ? "Documents that are always loaded as the session's context, apart from skill activation (such as steering)." : "スキル起動とは別に、セッションの文脈として常に読み込まれる文書（steering など）です。"}` : "";
  const outside = st.outsideReads.length
    ? `\n\n## ${en ? "Files read outside the skill" : "スキル外で読まれたファイル"}\n\n${st.outsideReads.map(r => en ? `- ${r.path} (${r.tool} / ${r.at ? formatLocalDateTime(r.at, lang) : ""})${r.failed ? " (read failed)" : ""}${r.title ? ` — ${r.title}` : ""}` : `- ${r.path}（${r.tool} ／ ${r.at ? formatLocalDateTime(r.at, lang) : ""}）${r.failed ? "（読取失敗）" : ""}${r.title ? ` — ${r.title}` : ""}`).join("\n")}` : "";
  return `# ${en ? "Session summary" : "セッションサマリ"}

${metaLines(st, lang).map(([k, v]) => `- ${k}: ${v}`).join("\n")}

${en ? "Prompt" : "プロンプト"}:
> ${st.session.userMessagePreview.replace(/\n/g, " ")}${st.session.userMessageTruncated ? " …" : ""}

## ${en ? "Activated skills" : "起動したスキル"}

${en
    ? `| Skill | First arrival | Arrivals by certainty | No record | All files | Est. tokens (arrived) | Est. tokens (whole skill) |
| --- | ---: | --- | ---: | ---: | ---: | ---: |`
    : `| スキル | 最初の到達順 | 到達の内訳（確度別） | 記録なし | 全ファイル | 到達分の推定トークン合計 | スキル全体の推定トークン合計 |
| --- | ---: | --- | ---: | ---: | ---: | ---: |`}
${skillRows}
${st.skills.length ? (undiscoveredSkillsNote(st.undiscoveredSkills, lang, st.session.workspace) ? `\n${undiscoveredSkillsNote(st.undiscoveredSkills, lang, st.session.workspace)}` : "") : undiscoveredSkillsNote(st.undiscoveredSkills, lang, st.session.workspace) ? `\n${undiscoveredSkillsNote(st.undiscoveredSkills, lang, st.session.workspace)}${en ? " The reference tree for this skill cannot be shown." : " そのため、このスキルについては参照ツリーを表示できません。"}` : (en ? "\nNo skill activation was detected in this session." : "\nこのセッションではスキル起動は検出されませんでした。")}

## ${en ? "Arrival flow" : "到達の流れ"}

${trees}${contextLoads}

## ${st.source === "kiro" ? (en ? "Credit usage" : "クレジット実測") : (en ? "Token usage" : "トークン実測")}

${measuredMd(st, lang)}

## ${en ? "Context window usage" : "コンテキストウィンドウ使用量"}

${contextMd(st, lang)}${outside}${notesMd(true, opts)}
`;
}

export function renderSkillMarkdown(st: SessionTrace, part: SkillPart, opts?: DocumentOptions): string {
  const lang = opts?.lang ?? "ja";
  const en = lang === "en";
  const counts = countsOf(part.nodes);
  const nodeRows = [...part.nodes].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9)).map(n =>
    `| ${mdCell(n.relToSkill)}${n.boundary ? (en ? " (outside skill)" : " （スキル外）") : ""} | ${n.grade ? gradeCertaintyLabel(n.grade, lang) : (en ? "No record" : "記録なし")} | ${n.order ?? ""} | ${n.firstAt ? formatLocalDateTime(n.firstAt, lang) : ""} | ${mdCell(n.evidence)} | ${fmt(n.estTokens)}${nodeBar(n, part)} |`).join("\n");
  return `# ${en ? "Skill summary" : "スキルサマリ"} — ${part.skillName}

${metaLines(st, lang).map(([k, v]) => `- ${k}: ${v}`).join("\n")}

> ${en
    ? `Showing only this skill's scope. ${st.source === "kiro" ? "Credit usage" : "Token usage"} and context window usage are session-wide values (not measurements of this skill alone). Arrival order numbers run across the whole session.`
    : `このスキルの範囲だけを表示しています。${st.source === "kiro" ? "クレジット実測" : "トークン実測"}とコンテキストウィンドウ使用量はセッション全体の値です（このスキル単独の実測ではありません）。到達順の番号はセッション全体の通し番号です。`}

${en ? "Prompt" : "プロンプト"}:
> ${st.session.userMessagePreview.replace(/\n/g, " ")}${st.session.userMessageTruncated ? " …" : ""}

${en
    ? `Arrivals: High ${counts.A} (loading into context confirmed) / Medium ${counts.B} (read) / Low ${counts.C} (mention only) / No record ${counts.N} / ${part.nodes.length} files in total`
    : `到達: 確度高 ${counts.A}（コンテキストへの読み込みを確認）／ 確度中 ${counts.B}（読み取り）／ 確度低 ${counts.C}（言及のみ）／ 記録なし ${counts.N} ／ 全 ${part.nodes.length} ファイル`}

## ${en ? "Arrival flow" : "到達の流れ"}

${treeMd(part, lang)}

## ${en ? "Node details" : "ノード明細"}

${en
    ? `| File | Certainty | Order | First seen | Evidence | Est. tokens |
| --- | --- | ---: | --- | --- | ---: |`
    : `| ファイル | 確度 | 順 | 初出 | 根拠 | 推定トークン |
| --- | --- | ---: | --- | --- | ---: |`}
${nodeRows}

## ${st.source === "kiro" ? (en ? "Credit usage" : "クレジット実測") : (en ? "Token usage" : "トークン実測")}${en ? " (session-wide)" : "（セッション全体）"}

${measuredMd(st, lang)}

## ${en ? "Context window usage (session-wide)" : "コンテキストウィンドウ使用量（セッション全体）"}

${contextMd(st, lang)}${notesMd(false, opts)}
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

function pill(grade: TraceNode["grade"], lang: Lang = "ja"): string {
  if (!grade) return `<span style="color:#888888">${lang === "en" ? "No record" : "記録なし"}</span>`;
  const color = grade === "A" ? "#3d9970" : grade === "B" ? "#3a6ea5" : "#d4a017";
  return `<span style="display:inline-block;padding:0 7px;border-radius:10px;background:${color};color:#ffffff;font-weight:700;font-size:11px">${gradeCertaintyLabel(grade, lang)}</span>`;
}

function treeHtml(part: SkillPart, lang: Lang = "ja"): string {
  const en = lang === "en";
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
    const total = part.nodes.reduce((a, n) => a + n.estTokens, 0);
    const bar = gn.estTokens > 0 && total > 0 ? ` <span style="${H.mono}">${blockBar(gn.estTokens / total)}</span>` : "";
    return `<li>${pill(tn?.grade ?? null, lang)} ${esc(gn.relToSkill)}${gn.title ? ` <span style="${H.muted}">${esc(gn.title)}</span>` : ""}${gn.boundary ? ` <span style="color:#7a4fa3;font-size:12px">${en ? "outside skill" : "スキル外"}</span>` : ""}${gn.missing ? ` <span style="color:#c0392b;font-size:12px">${en ? "missing target" : "参照先なし"}</span>` : ""}${tn?.order ? ` <span style="color:#3a6ea5;font-weight:600">#${tn.order}</span>` : ""} <span style="${H.muted}">~${fmt(gn.estTokens)} ${en ? "tokens" : "トークン"}</span>${bar}${children}</li>`;
  };
  const totalAll = part.nodes.reduce((a, n) => a + n.estTokens, 0);
  const note = totalAll ? `<p style="${H.muted}">${en ? "Bar length: share of this skill's total estimated tokens across all its files" : "バーの長さは、このスキルの全ファイルの推定トークン合計に対する割合です"}</p>` : "";
  return `<ul>${walk(root.id)}</ul>${note}`;
}

function metaHtml(st: SessionTrace, lang: Lang = "ja"): string {
  return metaLines(st, lang).map(([k, v]) => `<div><span style="color:#888888">${k}:</span> ${esc(v)}</div>`).join("");
}

/** クレジット実測の表（ターン×ツールのマトリクス: セルはそのターンの呼び出し回数だけ。
 *  列見出しはグループ色で塗り、対応は表の下の凡例で示す） */
function creditsHtml(st: SessionTrace, lang: Lang = "ja"): string {
  const en = lang === "en";
  const turns = st.creditTurns ?? [];
  const cols = toolColumns(turns);
  if (!cols.length) {
    const rows = turns.map(t => `<tr><td style="${H.cell}">${t.turn + 1}</td><td style="${H.cellR}">${fmtCredits(t.credits)}</td><td style="${H.cell}"></td></tr>`).join("");
    return `<table style="${H.table}"><tr><th style="${H.cell}">${en ? "Turn" : "ターン"}</th><th style="${H.cell}">${en ? "Credits" : "クレジット"}</th><th style="${H.cell}">${en ? "Tools used" : "使用したツール"}</th></tr>${rows}
<tr><th style="${H.cell}">${en ? "Total" : "合計"}</th><th style="${H.cellR}">${fmtCredits(st.creditsTotal)}</th><td style="${H.cell}"></td></tr></table>`;
  }
  const headRows = `<tr><th style="${H.cell}" rowspan="2">${en ? "Turn" : "ターン"}</th><th style="${H.cell}" rowspan="2">${en ? "Credits" : "クレジット"}</th><th style="${H.cell}" colspan="${cols.length}">${en ? "Tools used" : "使用したツール"}</th></tr><tr>${cols.map(c => `<th style="${H.cell};background:${c.group.color};color:#222">${esc(c.name)}</th>`).join("")}</tr>`;
  const rows = turns.map(t => {
    const counts = countTools(t.usedTools);
    return `<tr><td style="${H.cell}">${t.turn + 1}</td><td style="${H.cellR}">${fmtCredits(t.credits)}</td>${cols.map(c => `<td style="${H.cellR}">${counts.get(c.name) ?? ""}</td>`).join("")}</tr>`;
  }).join("");
  const totalRow = `<tr><th style="${H.cell}">${en ? "Total" : "合計"}</th><th style="${H.cellR}">${fmtCredits(st.creditsTotal)}</th>${cols.map(c => `<th style="${H.cellR}">${c.total}</th>`).join("")}</tr>`;
  const legend = `<p style="font-size:12px;color:#666;margin:4px 0">${en ? "Legend (tool groups): " : "凡例（ツールのグループ）: "}${toolGroupsPresent(cols).map(g => `<span style="display:inline-block;width:10px;height:10px;background:${g.color};border:1px solid #bbbbbb;border-radius:2px;margin:0 4px 0 12px;vertical-align:-1px"></span>${esc(toolGroupLabel(g, lang))}`).join("")}</p>`;
  return `<div style="overflow-x:auto"><table style="${H.table}">${headRows}${rows}
${totalRow}</table></div>
${legend}`;
}

function measuredHtml(st: SessionTrace, lang: Lang = "ja"): string {
  const en = lang === "en";
  if (st.source === "kiro") {
    const note = en ? `<p>Kiro records credits, not tokens (summed from usage_summary).</p>` : `<p>Kiro の実測はトークンではなくクレジットで記録されます（usage_summary の積算）。</p>`;
    return `${creditsHtml(st, lang)}
${note}`;
  }
  const rows = st.turns.map(r =>
    `<tr><td style="${H.cell}">${r.turn + 1}</td><td style="${H.cellR}">${fmt(r.inputTokens)}</td><td style="${H.cellR}">${fmt(r.cacheReadTokens)}</td><td style="${H.cellR}">${fmt(r.cacheWriteTokens)}</td><td style="${H.cellR}">${fmt(r.outputTokens)}</td><td style="${H.cellR}">${fmt(r.reasoningTokens)}</td></tr>`).join("");
  const t = st.totals;
  const split = inputSplit(t);
  const obs = cacheWriteObservation(st.turns, lang);
  const breakdown = split
    ? (en
      ? `<p>Input token breakdown (total ${fmt(t.inputTokens)}): cache read (reuse of input shared with previous turns) ${fmt(split.cacheRead)} <span style="${H.mono}">${unicodeBar(t.inputTokens ? split.cacheRead / t.inputTokens : 0)}</span> / cache write (stored for future reuse) ${fmt(split.cacheWrite)} / new input ${fmt(split.fresh)}</p>`
      : `<p>入力トークンの内訳（合計 ${fmt(t.inputTokens)}）: キャッシュ読取（前のターンと共通する入力の再利用） ${fmt(split.cacheRead)} <span style="${H.mono}">${unicodeBar(t.inputTokens ? split.cacheRead / t.inputTokens : 0)}</span> ／ キャッシュ書込（将来の再利用のための保存） ${fmt(split.cacheWrite)} ／ 新規入力 ${fmt(split.fresh)}</p>`)
    : (en
      ? `<p>Input token breakdown: cache reads and writes together exceed the total input, so the three-way breakdown is unavailable (inconsistent record). The totals table shows the measured values.</p>`
      : `<p>入力トークンの内訳: キャッシュ読取と書込の合計が入力の合計を超えているため、3分解できません（記録の不整合）。合計表の値が実測です。</p>`);
  const tokenHtml = `<table style="${H.table}"><tr><th style="${H.cell}">${en ? "Turn" : "ターン"}</th><th style="${H.cell}">${en ? "Input" : "入力"}</th><th style="${H.cell}">${en ? "Cache read" : "キャッシュ読取"}</th><th style="${H.cell}">${en ? "Cache write" : "キャッシュ書込"}</th><th style="${H.cell}">${en ? "Output" : "出力"}</th><th style="${H.cell}">${en ? "Reasoning" : "推論"}</th></tr>${rows}
<tr><th style="${H.cell}">${en ? "Total" : "合計"}</th><th style="${H.cellR}">${fmt(t.inputTokens)}</th><th style="${H.cellR}">${fmt(t.cacheReadTokens)}</th><th style="${H.cellR}">${fmt(t.cacheWriteTokens)}</th><th style="${H.cellR}">${fmt(t.outputTokens)}</th><th style="${H.cellR}">${fmt(t.reasoningTokens)}</th></tr></table>
${breakdown}${obs ? `<p>${esc(obs)}</p>` : ""}`;
  // VS Code の記録にはクレジット実測（各リクエストの copilotCredits）も残るため併記する
  if (st.source === "vscode" && (st.creditsTotal ?? 0) > 0) {
    const note = en ? `<p>Copilot Chat also records credit usage (each request's copilotCredits).</p>` : `<p>Copilot Chat の記録にはクレジット実測（各リクエストの copilotCredits）も残ります。</p>`;
    return `${tokenHtml}
<h3>${en ? "Credit usage" : "クレジット実測"}</h3>
${creditsHtml(st, lang)}
${note}`;
  }
  return tokenHtml;
}

function contextHtml(st: SessionTrace, lang: Lang = "ja"): string {
  const en = lang === "en";
  const chart = contextChartSvg(st, lang);
  if (st.source === "kiro") {
    const r = st.lastContextUsageRatio;
    const pct = r !== null && r !== undefined ? `${(r * 100).toFixed(1)}%` : "—";
    return (en
      ? `<p>Final usage ratio ${pct} <span style="${H.mono}">${unicodeBar(r)}</span> (the record holds usage-ratio snapshots only; absolute token counts and the limit are not recorded)</p>`
      : `<p>最終使用率 ${pct} <span style="${H.mono}">${unicodeBar(r)}</span>（記録は使用率のスナップショットのみで、トークンの絶対量と上限は記録されません）</p>`) + chart;
  }
  const pct = st.contextFillRatio !== null ? `${(st.contextFillRatio * 100).toFixed(1)}%` : "—";
  return (en
    ? `<p>Final usage ${fmt(st.lastContextCurrentTokens)} / limit ${fmt(st.contextTokenLimit)} tokens (${pct}) <span style="${H.mono}">${unicodeBar(st.contextFillRatio)}</span></p>`
    : `<p>最終使用量 ${fmt(st.lastContextCurrentTokens)} / 上限 ${fmt(st.contextTokenLimit)} トークン（${pct}） <span style="${H.mono}">${unicodeBar(st.contextFillRatio)}</span></p>`) + chart;
}

function glossaryHtml(lang: Lang = "ja"): string {
  const rows = glossaryFor(lang).map(([term, def]) =>
    `<tr><td style="${H.cell};font-weight:700;white-space:nowrap;vertical-align:top">${esc(term)}</td><td style="${H.cell}">${esc(def)}</td></tr>`).join("");
  return `<table style="${H.table}"><tr><th style="${H.cell}">${lang === "en" ? "Term" : "用語"}</th><th style="${H.cell}">${lang === "en" ? "Description" : "説明"}</th></tr>${rows}</table>`;
}

function notesHtml(sessionScope: boolean, lang: Lang = "ja"): string {
  return `<div style="${H.note}"><ul style="margin:0;padding-left:18px">${notesList(sessionScope, lang).map(n => `<li>${esc(n)}</li>`).join("")}</ul></div>`;
}

function promptHtml(st: SessionTrace): string {
  return `<div style="${H.prompt}">${esc(st.session.userMessagePreview)}${st.session.userMessageTruncated ? " …" : ""}</div>`;
}

export function renderSessionHtmlFragment(st: SessionTrace, opts?: DocumentOptions): string {
  const lang = opts?.lang ?? "ja";
  const en = lang === "en";
  const skillRows = st.skills.map(part => {
    const counts = countsOf(part.nodes);
    const reached = part.nodes.filter(n => n.order !== null);
    const firstOrder = reached.length ? Math.min(...reached.map(n => n.order!)) : null;
    return `<tr><td style="${H.cell}">${esc(part.skillName)}</td><td style="${H.cellR}">${firstOrder !== null ? "#" + firstOrder : "—"}</td><td style="${H.cell}">${en ? `High ${counts.A} · Medium ${counts.B} · Low ${counts.C}` : `高 ${counts.A} ・ 中 ${counts.B} ・ 低 ${counts.C}`}</td><td style="${H.cellR}">${counts.N}</td><td style="${H.cellR}">${part.nodes.length}</td><td style="${H.cellR}">${fmt(reachedTok(part.nodes))}</td><td style="${H.cellR}">${fmt(totalTok(part.nodes))}</td></tr>`;
  }).join("");
  const trees = st.skills.map(part => `<h3 style="${H.h3}">${esc(part.skillName)}</h3>${treeHtml(part, lang)}`).join("");
  const contextLoads = st.contextLoads?.length
    ? `<h2 style="${H.h2}">${en ? "Always-loaded context (loaded into context)" : "常時文脈（コンテキストへの読み込み）"}</h2><ul>${st.contextLoads.map(l => `<li>${esc(l.path)}${l.at ? ` (${esc(formatLocalDateTime(l.at, lang))})` : ""}</li>`).join("")}</ul>${startUsageText(st, lang) ? `<p>${esc(startUsageText(st, lang))}</p>` : ""}<p>${en ? "Documents that are always loaded as the session's context, apart from skill activation (such as steering)." : "スキル起動とは別に、セッションの文脈として常に読み込まれる文書（steering など）です。"}</p>` : "";
  const outside = st.outsideReads.length
    ? `<h2 style="${H.h2}">${en ? "Files read outside the skill" : "スキル外で読まれたファイル"}</h2><ul>${st.outsideReads.map(r => `<li>${esc(r.path)}${en ? ` (${esc(r.tool)} / ${esc(r.at ? formatLocalDateTime(r.at, lang) : "")})` : `（${esc(r.tool)} ／ ${esc(r.at ? formatLocalDateTime(r.at, lang) : "")}）`}${r.failed ? (en ? " (read failed)" : "（読取失敗）") : ""}${r.title ? ` — ${esc(r.title)}` : ""}</li>`).join("")}</ul>` : "";
  return `<div style="${H.root}">
<h1 style="${H.h1}">${en ? "Session summary" : "セッションサマリ"}</h1>
${metaHtml(st, lang)}
<p style="${H.muted}">${en ? "Prompt" : "プロンプト"}</p>
${promptHtml(st)}
<h2 style="${H.h2}">${en ? "Activated skills" : "起動したスキル"}</h2>
<table style="${H.table}"><tr><th style="${H.cell}">${en ? "Skill" : "スキル"}</th><th style="${H.cell}">${en ? "First arrival" : "最初の到達順"}</th><th style="${H.cell}">${en ? "Arrivals by certainty" : "到達の内訳（確度別）"}</th><th style="${H.cell}">${en ? "No record" : "記録なし"}</th><th style="${H.cell}">${en ? "All files" : "全ファイル"}</th><th style="${H.cell}">${en ? "Est. tokens (arrived)" : "到達分の推定トークン合計"}</th><th style="${H.cell}">${en ? "Est. tokens (whole skill)" : "スキル全体の推定トークン合計"}</th></tr>${skillRows}</table>
${st.skills.length ? (undiscoveredSkillsNote(st.undiscoveredSkills, lang, st.session.workspace) ? `<p>${esc(undiscoveredSkillsNote(st.undiscoveredSkills, lang, st.session.workspace))}</p>` : "") : undiscoveredSkillsNote(st.undiscoveredSkills, lang, st.session.workspace) ? `<p>${esc(undiscoveredSkillsNote(st.undiscoveredSkills, lang, st.session.workspace))}${en ? " The reference tree for this skill cannot be shown." : " そのため、このスキルについては参照ツリーを表示できません。"}</p>` : `<p>${en ? "No skill activation was detected in this session." : "このセッションではスキル起動は検出されませんでした。"}</p>`}
<h2 style="${H.h2}">${en ? "Arrival flow" : "到達の流れ"}</h2>
${trees}
${contextLoads}
<h2 style="${H.h2}">${st.source === "kiro" ? (en ? "Credit usage" : "クレジット実測") : (en ? "Token usage" : "トークン実測")}</h2>
${measuredHtml(st, lang)}
<h2 style="${H.h2}">${en ? "Context window usage" : "コンテキストウィンドウ使用量"}</h2>
${contextHtml(st, lang)}${outside}
${notesHtmlSections(true, opts)}
</div>`;
}

export function renderSkillHtmlFragment(st: SessionTrace, part: SkillPart, opts?: DocumentOptions): string {
  const lang = opts?.lang ?? "ja";
  const en = lang === "en";
  const counts = countsOf(part.nodes);
  const nodeRows = [...part.nodes].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9)).map(n =>
    `<tr><td style="${H.cell}">${esc(n.relToSkill)}${n.boundary ? (en ? " (outside skill)" : " （スキル外）") : ""}</td><td style="${H.cell}">${n.grade ? pill(n.grade, lang) : (en ? "No record" : "記録なし")}</td><td style="${H.cellR}">${n.order ?? ""}</td><td style="${H.cell}">${esc(n.firstAt ? formatLocalDateTime(n.firstAt, lang) : "")}</td><td style="${H.cell}">${esc(n.evidence)}</td><td style="${H.cellR}">${fmt(n.estTokens)}${nodeBar(n, part)}</td></tr>`).join("");
  return `<div style="${H.root}">
<h1 style="${H.h1}">${en ? "Skill summary" : "スキルサマリ"} — ${esc(part.skillName)}</h1>
${metaHtml(st, lang)}
<div style="${H.note}">${en
    ? `Showing only this skill's scope. ${st.source === "kiro" ? "Credit usage" : "Token usage"} and context window usage are session-wide values (not measurements of this skill alone). Arrival order numbers run across the whole session.`
    : `このスキルの範囲だけを表示しています。${st.source === "kiro" ? "クレジット実測" : "トークン実測"}とコンテキストウィンドウ使用量はセッション全体の値です（このスキル単独の実測ではありません）。到達順の番号はセッション全体の通し番号です。`}</div>
<p style="${H.muted}">${en ? "Prompt" : "プロンプト"}</p>
${promptHtml(st)}
<p>${en ? "Arrivals" : "到達"}: ${pill("A", lang)} <b>${counts.A}</b>${en ? " (loading into context confirmed)" : "（コンテキストへの読み込みを確認）"} / ${pill("B", lang)} <b>${counts.B}</b>${en ? " (read)" : "（読み取り）"} / ${pill("C", lang)} <b>${counts.C}</b>${en ? " (mention only)" : "（言及のみ）"} / ${en ? "No record" : "記録なし"} <b>${counts.N}</b> / ${en ? `${part.nodes.length} files in total` : `全 ${part.nodes.length} ファイル`}</p>
<h2 style="${H.h2}">${en ? "Arrival flow" : "到達の流れ"}</h2>
${treeHtml(part, lang)}
<h2 style="${H.h2}">${en ? "Node details" : "ノード明細"}</h2>
<table style="${H.table}"><tr><th style="${H.cell}">${en ? "File" : "ファイル"}</th><th style="${H.cell}">${en ? "Certainty" : "確度"}</th><th style="${H.cell}">${en ? "Order" : "順"}</th><th style="${H.cell}">${en ? "First seen" : "初出"}</th><th style="${H.cell}">${en ? "Evidence" : "根拠"}</th><th style="${H.cell}">${en ? "Est. tokens" : "推定トークン"}</th></tr>${nodeRows}</table>
<h2 style="${H.h2}">${st.source === "kiro" ? (en ? "Credit usage" : "クレジット実測") : (en ? "Token usage" : "トークン実測")}${en ? " (session-wide)" : "（セッション全体）"}</h2>
${measuredHtml(st, lang)}
<h2 style="${H.h2}">${en ? "Context window usage (session-wide)" : "コンテキストウィンドウ使用量（セッション全体）"}</h2>
${contextHtml(st, lang)}${notesHtmlSections(false, opts)}
</div>`;
}
