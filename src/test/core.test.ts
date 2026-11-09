import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { buildGraph } from "../core/graph";
import { parseEventsText } from "../core/events";
import { buildSessionTrace, buildTrace, firstHeading, gradeCertaintyLabel } from "../core/trace";
import { capSessionsBySource, formatLocalDateTime, type SessionInfo } from "../core/sessions";
import { langFromEnv, sanitizeFilenamePart } from "../core/common";
import { renderHtml, renderSessionHtml } from "../core/report";

const root = join(__dirname, "..", "..", "test-fixtures");
const workspace = join(root, "workspace");
const skillDir = join(workspace, ".github", "skills", "phase0-probe");

function fixtureTrace() {
  const parsed = parseEventsText(readFileSync(join(root, "events.jsonl"), "utf8"));
  const graph = buildGraph(skillDir, workspace);
  const heading = firstHeading(readFileSync(join(skillDir, "SKILL.md"), "utf8"));
  const trace = buildTrace(parsed, graph, { sessionId: "fixture", workspaceAbs: workspace, skillDirAbs: skillDir, rootHeading: heading });
  return { parsed, graph, trace };
}

test("grades match the fixture expectations", () => {
  const { trace } = fixtureTrace();
  const byName = new Map(trace.nodes.map(n => [n.name, n]));
  assert.equal(byName.get("SKILL.md")?.grade, "A");
  assert.equal(byName.get("alpha.md")?.grade, "A");
  assert.equal(byName.get("beta.md")?.grade, "A");
  assert.equal(byName.get("probe-note.md")?.grade, "B");
  assert.equal(byName.get("probe-note.md")?.boundary, true);
  assert.equal(byName.get("gamma.md")?.grade, "C");
  assert.equal(byName.get("delta.md")?.grade, null);
});

test("parse health is clean and context limit is captured", () => {
  const { parsed, trace } = fixtureTrace();
  assert.equal(parsed.health.skippedLines, 0);
  assert.equal(parsed.health.unknownRatio, 0);
  assert.equal(trace.contextTokenLimit, 200000);
  assert.equal(trace.lastContextCurrentTokens, 10100);
  assert.ok(Math.abs((trace.contextFillRatio ?? 0) - 10100 / 200000) < 1e-9);
});

// Phase 1 CLI（skilltrace.mjs）を同じフィクスチャに当てた結果を正解として固定する。
// 実データはトークン値が深くネストし、パスがキー側や長い文字列の中に埋まっているため、
// 再帰探索と部分一致でなければ CLI と一致しない（0.1.2 までの移植版が実機で外した箇所）。
test("matches the Phase 1 CLI ground truth on the same fixture", () => {
  const { trace } = fixtureTrace();
  assert.deepEqual(trace.totals, {
    inputTokens: 34900, outputTokens: 570, cacheReadTokens: 29400,
    cacheWriteTokens: 470, reasoningTokens: 0,
  });
  const byName = new Map(trace.nodes.map(n => [n.name, n]));
  assert.equal(byName.get("SKILL.md")?.order, 2);
  assert.equal(byName.get("alpha.md")?.order, 3);
  assert.equal(byName.get("beta.md")?.order, 4);
  assert.equal(byName.get("gamma.md")?.order, 1);
  assert.equal(byName.get("probe-note.md")?.order, 5);
  assert.match(byName.get("probe-note.md")?.evidence ?? "", /view/);
});

test("report renders with the context window usage section", () => {
  const { graph, trace } = fixtureTrace();
  const html = renderHtml(trace, graph);
  assert.ok(html.includes("コンテキストウィンドウ使用量"));
  assert.ok(html.includes("読み方の注意"));
});

test("report carries the terminology nav and glossary section", () => {
  const { graph, trace } = fixtureTrace();
  const html = renderHtml(trace, graph);
  assert.ok(html.includes('href="#glossary"'));
  assert.ok(html.includes('id="glossary"'));
  assert.ok(html.includes("用語の説明"));
  assert.ok(html.includes("progressive disclosure"));
});

test("report uses unified grade badges and a bulleted note", () => {
  const { graph, trace } = fixtureTrace();
  const html = renderHtml(trace, graph);
  assert.ok(html.includes('class="badge bA"'));
  assert.ok(html.includes("確度高"));
  assert.ok(html.includes("到達の確度"));
  assert.ok(html.includes("証明ではありません"));
  assert.ok(html.includes('table class="nodes"'));
});

test("prompt preview is marked as truncated when it was cut", () => {
  const { graph, trace } = fixtureTrace();
  assert.equal(trace.session.userMessageTruncated, true);
  const html = renderHtml(trace, graph);
  assert.ok(html.includes("先頭のみ表示・省略あり"));
  assert.ok(html.includes('class="prompt"'));
});

test("autodetect finds the invoked skill in the session workspace", async () => {
  const { detectSkillForSession, detectSkillsForSession } = await import("../core/autodetect.js");
  const { parsed } = fixtureTrace();
  const found = detectSkillForSession(parsed, workspace);
  assert.equal(found?.name, "phase0-probe");
  const all = detectSkillsForSession(parsed, workspace);
  assert.deepEqual(all.map(s => s.name), ["phase0-probe"]);
});

function fixtureSessionTrace() {
  const { parsed } = fixtureTrace();
  const graph = buildGraph(skillDir, workspace);
  const heading = firstHeading(readFileSync(join(skillDir, "SKILL.md"), "utf8"));
  const st = buildSessionTrace(parsed, [{ graph, skillDirAbs: skillDir, rootHeading: heading }], { sessionId: "fixture", workspaceAbs: workspace });
  return { parsed, graph, st };
}

test("session trace: global order numbers match the CLI ground truth", () => {
  const { st } = fixtureSessionTrace();
  assert.equal(st.skills.length, 1);
  assert.equal(st.skills[0].skillName, "phase0-probe");
  const byName = new Map(st.skills[0].nodes.map(n => [n.name, n]));
  assert.equal(byName.get("gamma.md")?.order, 1);
  assert.equal(byName.get("SKILL.md")?.order, 2);
  assert.equal(byName.get("alpha.md")?.order, 3);
  assert.equal(byName.get("beta.md")?.order, 4);
  assert.equal(byName.get("probe-note.md")?.order, 5);
  assert.deepEqual(st.totals, {
    inputTokens: 34900, outputTokens: 570, cacheReadTokens: 29400,
    cacheWriteTokens: 470, reasoningTokens: 0,
  });
});

test("graph captures document titles; own files are not outside reads", () => {
  const { graph, trace } = fixtureTrace();
  const root = graph.nodes.get(graph.rootId);
  assert.equal(root?.title, "Phase0 Probe Skill");
  const alpha = graph.order.find(n => n.name === "alpha.md");
  assert.equal(alpha?.title, "Alpha: 合言葉とコード番号 A");
  // 記録側のパス（Windows）とグラフ側のパス（この環境）でルートが違っても、
  // 自スキルのファイルが「スキル外」に入らないこと（サフィックス一致の回帰テスト）
  assert.ok(!trace.outsideReads.some(r => r.path.includes("phase0-probe") || r.path.includes("probe-note")));
});

test("skill report shows document titles", () => {
  const { graph, trace } = fixtureTrace();
  const html = renderHtml(trace, graph);
  assert.ok(html.includes("Phase0 Probe Skill"));
  assert.ok(html.includes("Alpha: 合言葉とコード番号 A"));
});

test("session summary renders the per-skill digest and timeline", () => {
  const { st } = fixtureSessionTrace();
  const html = renderSessionHtml(st);
  assert.ok(html.includes("<title>セッションサマリ</title>"));
  assert.ok(html.includes("ワークスペース:"));
  assert.ok(html.includes("開始:"));
  assert.ok(html.includes("起動したスキル"));
  assert.ok(html.includes("最初の到達順"));
  assert.ok(html.includes("到達の内訳（確度別）"));
  assert.ok(html.includes("到達分の推定トークン合計"));
  assert.ok(!html.includes("session.usage_record"));
  assert.ok(!html.includes("窓の埋まり方"));
  assert.ok(html.includes("入力トークンの内訳"));
  assert.ok(html.includes('href="#glossary"'));
  assert.ok(html.includes('id="glossary"'));
  assert.ok(html.includes('<table class="gloss">'));
  assert.ok(html.includes("キャッシュ"));
  assert.ok(html.includes("phase0-probe"));
  assert.ok(html.includes("到達の流れ"));
  assert.ok(html.includes("到達順に再生"));
  assert.ok(html.includes('class="tree"'));
  assert.ok(html.includes('data-order="1"'));
});

test("input split is three-way and cache-write turns are observed (Issue #9)", async () => {
  const { inputSplit, cacheWriteObservation } = await import("../core/common.js");
  const { st } = fixtureSessionTrace();
  // フィクスチャ正解値: 入力 34,900 = 読取 29,400 + 書込 470 + 新規 5,030
  assert.deepEqual(inputSplit(st.totals), { fresh: 5030, cacheRead: 29400, cacheWrite: 470 });
  // 書込は全ターンに発生し、初回以外ではターン2（100）が最大
  assert.equal(cacheWriteObservation(st.turns),
    "キャッシュ書込が発生したターン: 1・2・3・4。初回ターン以外で最大の書込はターン2（100 トークン）です");
  assert.equal(cacheWriteObservation([]), "");
  const html = renderSessionHtml(st);
  assert.ok(html.includes("キャッシュ書込（将来の再利用のための保存） 470"));
  assert.ok(html.includes("新規入力 5,030"));
  assert.ok(html.includes("キャッシュ書込が発生したターン: 1・2・3・4"));
  // 不整合な記録（キャッシュ合計 > 入力合計）では実測値を切り詰めず、3分解できないと表示する
  assert.equal(inputSplit({ inputTokens: 100, cacheReadTokens: 80, cacheWriteTokens: 50 }), null);
  const broken = fixtureSessionTrace().st;
  broken.totals = { inputTokens: 100, cacheReadTokens: 80, cacheWriteTokens: 50, outputTokens: 0, reasoningTokens: 0 };
  assert.ok(renderSessionHtml(broken).includes("3分解できません"));
});

test("tool matrix columns are grouped and ordered by totals", async () => {
  const { toolColumns, toolGroupOf, toolGroupsPresent } = await import("../core/common.js");
  const turns = [
    { usedTools: ["read_file", "read_file", "invoke_sub_agent", "validate_spec_format"] },
    { usedTools: ["read_file", "fs_write", "grep_search", "report_progress"] },
  ];
  const cols = toolColumns(turns);
  // グループ順（読み取り・探索→書き込み・編集→サブエージェント→進行・対話→その他）、
  // グループ内は合計の多い順
  assert.deepEqual(cols.map(c => c.name), ["read_file", "grep_search", "fs_write", "invoke_sub_agent", "report_progress", "validate_spec_format"]);
  assert.deepEqual(cols.map(c => c.total), [3, 1, 1, 1, 1, 1]);
  assert.deepEqual(toolGroupsPresent(cols).map(g => g.id), ["read", "write", "subagent", "interact", "other"]);
  // 分類: キーワード判定とフォールバック
  assert.equal(toolGroupOf("fs_append").id, "write");
  assert.equal(toolGroupOf("invoke_sub_agent").id, "subagent");
  assert.equal(toolGroupOf("subagent_response").id, "subagent");
  assert.equal(toolGroupOf("execute_pwsh").id, "exec");
  assert.equal(toolGroupOf("user_input").id, "interact");
  assert.equal(toolGroupOf("prework").id, "other");
  assert.deepEqual(toolColumns([]), []);
});

test("document: session markdown and html fragment", async () => {
  const { renderSessionMarkdown, renderSessionHtmlFragment } = await import("../core/document.js");
  const { st } = fixtureSessionTrace();
  const md = renderSessionMarkdown(st);
  assert.ok(md.includes("# セッションサマリ"));
  assert.ok(md.includes("## 起動したスキル"));
  assert.ok(md.includes("- SKILL.md"));
  assert.ok(md.includes("[確度高 #2]"));
  assert.ok(md.includes("入力トークンの内訳"));
  assert.ok(md.includes("キャッシュ書込（将来の再利用のための保存） 470"));
  assert.ok(md.includes("新規入力 5,030"));
  assert.ok(md.includes("キャッシュ書込が発生したターン: 1・2・3・4"));
  // 既定では「読み方の注意」と「用語の説明」は文書に入らない（貼り付け後の編集を軽くするため）
  assert.ok(!md.includes("## 用語の説明"));
  assert.ok(!md.includes("## 読み方の注意"));
  const withNotes = renderSessionMarkdown(st, { includeNotes: true });
  assert.ok(withNotes.includes("## 読み方の注意"));
  assert.ok(withNotes.includes("| 用語 | 説明 |"));
  const frag = renderSessionHtmlFragment(st);
  assert.ok(frag.includes("border-collapse:collapse"));
  assert.ok(frag.includes("確度高"));
  assert.ok(!frag.includes("用語の説明"));
  assert.ok(renderSessionHtmlFragment(st, { includeNotes: true }).includes("用語の説明"));
  assert.ok(!frag.includes("<script"));
  assert.ok(!frag.includes("session.usage_record"));
});

test("document: skill markdown has node details", async () => {
  const { renderSkillMarkdown } = await import("../core/document.js");
  const { st } = fixtureSessionTrace();
  const md = renderSkillMarkdown(st, st.skills[0]);
  assert.ok(md.includes("# スキルサマリ — phase0-probe"));
  assert.ok(md.includes("## ノード明細"));
  assert.ok(md.includes("references/alpha.md"));
});

test("summary pages embed the document copy buttons", () => {
  const { st } = fixtureSessionTrace();
  const html = renderSessionHtml(st);
  assert.ok(html.includes('id="copyMd"'));
  assert.ok(html.includes('id="copyHtml"'));
});

test("copy: all / visible / subtree (session scope)", async () => {
  const { renderSessionCopy } = await import("../core/copy.js");
  const { graph, st } = fixtureSessionTrace();
  const all = renderSessionCopy(st, { kind: "all" });
  assert.ok(all.includes("SkillTrace セッションサマリ"));
  assert.ok(all.includes("ワークスペース:"));
  assert.ok(all.includes("開始:"));
  assert.ok(all.includes("== phase0-probe =="));
  assert.ok(all.includes("references/alpha.md"));
  assert.ok(all.includes("[確度高"));
  assert.ok(all.includes("probe-note.md"));
  const rootOnly = renderSessionCopy(st, { kind: "visible", isExpanded: () => false });
  assert.ok(!rootOnly.includes("references/alpha.md"));
  const beta = graph.order.find(n => n.name === "beta.md")!;
  const sub = renderSessionCopy(st, { kind: "subtree", part: st.skills[0], rootId: beta.id });
  assert.ok(sub.startsWith("references/beta.md"));
  assert.ok(sub.includes("probe-note.md"));
  assert.ok(!sub.includes("alpha.md"));
});

test("english rendering (copilot): token usage, breakdown, glossary and labels switch to English", async () => {
  const { renderSessionCopy } = await import("../core/copy.js");
  const { st } = fixtureSessionTrace();
  const html = renderSessionHtml(st, { lang: "en" });
  assert.ok(html.includes("Token usage"));
  assert.ok(html.includes("Input token breakdown"));
  assert.ok(html.includes("Cache read (reuse of input shared with previous turns)"));
  assert.ok(html.includes("Arrival certainty (high / medium / low)"));
  assert.ok(html.includes("Turns with cache writes:"));
  assert.ok(!html.includes("トークン実測"));
  assert.equal(gradeCertaintyLabel("A", "en"), "High");
  assert.equal(gradeCertaintyLabel(null as never, "en"), "No record");
  assert.equal(gradeCertaintyLabel("A"), "確度高");
  assert.equal(langFromEnv("ja"), "ja");
  assert.equal(langFromEnv("en-US"), "en");
  assert.equal(langFromEnv("fr"), "en");
  assert.ok(formatLocalDateTime("2026-11-08T01:02:03", "en").startsWith("2026-11-08"));
  const copyEn = renderSessionCopy(st, { kind: "all" }, "en");
  assert.ok(copyEn.includes("SkillTrace session summary"));
  assert.ok(copyEn.includes("High"));
});

test("sanitizeFilenamePart sanitizes path traversal and invalid characters", () => {
  // 正常なセッションID
  assert.equal(sanitizeFilenamePart("sess_6d826121-2e9a-4628"), "sess_6d826121-2e9a-4628");
  // パストラバーサル試行（相対パス・親ディレクトリ指定）
  assert.equal(sanitizeFilenamePart("../../evil_session"), "evil_session");
  assert.equal(sanitizeFilenamePart("..\\..\\evil_session"), "evil_session");
  // スラッシュや記号が含まれる場合
  assert.equal(sanitizeFilenamePart("foo/bar/baz"), "foo_bar_baz");
  assert.equal(sanitizeFilenamePart("session:id?*<>|"), "session_id");
  // 空文字やnull/undefined、記号のみの場合のフォールバック
  assert.equal(sanitizeFilenamePart(""), "session");
  assert.equal(sanitizeFilenamePart(null), "session");
  assert.equal(sanitizeFilenamePart(undefined), "session");
  assert.equal(sanitizeFilenamePart("../.."), "session");
  assert.equal(sanitizeFilenamePart("///"), "session");
});

test("history cap is per source, so Kiro sessions cannot crowd out Copilot ones", () => {
  const mk = (id: string, mtimeMs: number, source?: "copilot" | "kiro"): SessionInfo =>
    ({ id, dir: "", eventsPath: "", mtimeMs, workspaceHint: null, ...(source ? { source } : {}) });
  // 新しい Kiro 35件の後ろに、古い Copilot 3件（source 未指定 = Copilot）
  const sessions: SessionInfo[] = [];
  for (let i = 0; i < 35; i++) sessions.push(mk(`kiro-${i}`, 10000 - i, "kiro"));
  sessions.push(mk("cop-old-1", 100), mk("cop-old-2", 90), mk("cop-old-3", 80));
  const capped = capSessionsBySource(sessions, 30);
  assert.equal(capped.filter(s => s.source === "kiro").length, 30);
  assert.deepEqual(capped.filter(s => s.source !== "kiro").map(s => s.id), ["cop-old-1", "cop-old-2", "cop-old-3"]);
  // 全体の並び（新しい順）は保たれる
  for (let i = 1; i < capped.length; i++) assert.ok(capped[i - 1].mtimeMs >= capped[i].mtimeMs);
});
