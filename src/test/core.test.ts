import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildGraph, MAX_GRAPH_NODES } from "../core/graph";
import { parseEventsText } from "../core/events";
import { buildSessionTrace, buildTrace, extractRecordedPaths, firstHeading, gradeCertaintyLabel } from "../core/trace";
import { capSessionsBySource, discoverSkills, findSkillsByNameInRoots, formatLocalDateTime, locateSkillFromPaths, scanInvokedSkillNames, type SessionInfo } from "../core/sessions";
import { langFromEnv, recordLocatedSkillsNote, sanitizeFilenamePart, undiscoveredSkillsNote } from "../core/common";
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

test("blockBar: fill follows the ratio", async () => {
  const { blockBar } = await import("../core/common.js");
  assert.equal(blockBar(0), "░░░░░░░░░░");
  assert.equal(blockBar(1), "██████████");
  assert.equal(blockBar(0.5), "█████░░░░░");
  assert.equal(blockBar(0.62, 8), "█████░░░");
  assert.equal(blockBar(2), "██████████");
  assert.equal(blockBar(-1), "░░░░░░░░░░");
});

test("token bars appear in document trees and the on-screen tree (Issue #32)", async () => {
  const { renderSessionMarkdown } = await import("../core/document.js");
  const { renderSessionHtml } = await import("../core/report.js");
  const { blockBar, fmt } = await import("../core/common.js");
  const { st } = fixtureSessionTrace();
  const md = renderSessionMarkdown(st);
  assert.ok(md.includes("（バーの長さは、このスキルの全ファイルの推定トークン合計に対する割合です）"));
  // 到達の流れの節だけを取り出し、推定トークン値の直後にバーが付くことと、
  // バーの割合がフィクスチャから算出した割合と一致することを確認する
  const flow = md.split("## 到達の流れ")[1]?.split("\n## ")[0] ?? "";
  assert.ok(flow.length > 0);
  const part = st.skills[0];
  const total = part.nodes.reduce((a, n) => a + n.estTokens, 0);
  const rootTn = part.nodes.find(n => n.id === part.graph.rootId);
  assert.ok(rootTn && rootTn.estTokens > 0 && total > 0);
  assert.ok(flow.includes(`~${fmt(rootTn.estTokens)} トークン ${blockBar(rootTn.estTokens / total)}`));
  const html = renderSessionHtml(st);
  assert.ok(html.includes('class="tbar"'));
  assert.ok(html.includes("バーの長さは、このスキルの全ファイルの推定トークン合計に対する割合です"));
});

test("sparkline: glyph mapping and peak-preserving sampling", async () => {
  const { sparkline } = await import("../core/document.js");
  assert.equal(sparkline([0, 0.5, 1]), "▁▅█");
  assert.equal(sparkline([0.25]), "▃");
  // 100点を48点に間引いても、途中のピーク（最大値）は落ちない
  const many = Array.from({ length: 100 }, (_, i) => (i === 77 ? 1 : 0.1));
  const sampled = sparkline(many);
  assert.equal([...sampled].length, 48);
  assert.ok(sampled.includes("█"));
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

test("vscode-probe: sessions recorded by VS Code's Copilot agent host (CLI format) trace fully", () => {
  // VS Code のエージェント実行が Copilot CLI ホストに委ねられる環境では、
  // 記録は CLI 形式の events.jsonl として ~/.copilot/session-state に残る。
  // その実ファイル（自宅プローブ、2026-11-09）で、起動と辿りが復元できることを固定する
  const probeRoot = join(root, "vscode-probe");
  const probeWs = join(probeRoot, "workspace");
  const probeSkillDir = join(probeWs, ".github", "skills", "vscode-probe");
  const parsed = parseEventsText(readFileSync(join(probeRoot, "events.jsonl"), "utf8"));
  const graph = buildGraph(probeSkillDir, probeWs);
  const heading = firstHeading(readFileSync(join(probeSkillDir, "SKILL.md"), "utf8"));
  const st = buildSessionTrace(parsed, [{ graph, skillDirAbs: probeSkillDir, rootHeading: heading }], { sessionId: "vscode-probe", workspaceAbs: probeWs });
  assert.ok(st);
  assert.equal(st.skills.length, 1);
  assert.equal(st.skills[0].skillName, "vscode-probe");
  const byName = new Map(st.skills[0].nodes.map(n => [n.name, n]));
  assert.equal(byName.get("SKILL.md")?.grade, "A");
  assert.equal(byName.get("SKILL.md")?.order, 1);
  assert.equal(byName.get("level1.md")?.grade, "A");
  assert.equal(byName.get("level1.md")?.order, 2);
  assert.equal(byName.get("level2.md")?.grade, "A");
  assert.equal(byName.get("level2.md")?.order, 3);
  assert.equal(st.outsideReads.length, 0);
  assert.equal(st.totals.inputTokens, 119282);
  assert.equal(st.totals.cacheReadTokens, 89202);
});

test("copilot: a session trace builds even when no skill is discoverable in the workspace", () => {
  // 過去のセッションではスキルが移動・削除されていることが多く、発見できた
  // スキルが無くても実測（ターン・トークン）と起動の事実はサマリで見えること
  const probeRoot = join(root, "vscode-probe");
  const parsed = parseEventsText(readFileSync(join(probeRoot, "events.jsonl"), "utf8"));
  const st = buildSessionTrace(parsed, [], { sessionId: "past", workspaceAbs: "", undiscoveredSkills: ["vscode-probe"] });
  assert.equal(st.skills.length, 0);
  assert.equal(st.totals.inputTokens, 119282);
  assert.equal(st.totals.cacheReadTokens, 89202);
  assert.ok(st.turns.length > 0);
  assert.ok(st.toolExecutions.length > 0);
  assert.deepEqual(st.undiscoveredSkills, ["vscode-probe"]);
});

test("copilot: history labels read invocation names from the record itself", () => {
  const probeRoot = join(root, "vscode-probe");
  // 候補（現在のワークスペースのスキル）が無くても、記録の data.name から拾える
  assert.deepEqual(scanInvokedSkillNames(join(probeRoot, "events.jsonl"), []), ["vscode-probe"]);
  // 起動行の無い記録は、読めた時点で「未使用」で確定する
  const dir = mkdtempSync(join(tmpdir(), "skilltrace-label-"));
  try {
    const p = join(dir, "events.jsonl");
    writeFileSync(p, JSON.stringify({ type: "session.start", data: {} }) + "\n" + JSON.stringify({ type: "user.message", data: {} }) + "\n");
    assert.deepEqual(scanInvokedSkillNames(p, []), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("health: the model.* event layer of newer Copilot runtimes is known", () => {
  // 2026-11-09 の実セッション採取（種別と件数のみ）で確認した構成。
  // model.* 層が未知扱いだと 21% の警告が出ていた
  const lines = [
    { type: "session.start", data: {} },
    { type: "model.turn_started", data: {} },
    { type: "model.model_call_started", data: {} },
    { type: "model.message", data: {} },
    { type: "model.response", data: {} },
    { type: "model.model_call_success", data: {} },
    { type: "model.messages_snapshot", data: {} },
    { type: "model.captured_assignment_context", data: {} },
    { type: "model.turn_ended", data: {} },
    { type: "session.model_change", data: {} },
    { type: "system.notification", data: {} },
    { type: "session.permissions_changed", data: {} },
    { type: "session.shutdown", data: {} },
  ];
  const parsed = parseEventsText(lines.map(l => JSON.stringify(l)).join("\n"));
  assert.equal(parsed.health.unknownRatio, 0);
  assert.deepEqual(parsed.health.unknownEventTypes, {});
});

test("undiscovered skills note guides to the workspace the session ran in", () => {
  const withWs = undiscoveredSkillsNote(["some-skill"], "ja", "C:/ws/project");
  assert.ok(withWs.includes("some-skill"));
  assert.ok(withWs.includes("C:/ws/project"));
  assert.ok(withWs.includes("そのワークスペースを開くと、参照ツリーを表示できます"));
  const without = undiscoveredSkillsNote(["some-skill"], "ja");
  assert.ok(!without.includes("実行されました"));
  assert.equal(undiscoveredSkillsNote([], "ja", "C:/ws/project"), "");
  assert.ok(undiscoveredSkillsNote(["s"], "en", "C:/ws/project").includes("Open that workspace"));
});

test("extractRecordedPaths returns the same paths as the former regex (audit F2)", () => {
  // 鎖の中で最後に成立した拡張子まで伸びる、旧正規表現の一致の形を固定する
  assert.deepEqual(extractRecordedPaths("see /a/b.txt/c.md end"), ["/a/b.txt/c.md"]);
  assert.deepEqual(extractRecordedPaths("/a.md/b.txt"), ["/a.md/b.txt"]);
  assert.deepEqual(extractRecordedPaths("/a.txt.md"), ["/a.txt.md"]);
  assert.deepEqual(extractRecordedPaths("/a/b.md and /c/d.json"), ["/a/b.md", "/c/d.json"]);
  assert.deepEqual(extractRecordedPaths("C:\\work\\bar\\notes.txt"), ["C:\\work\\bar\\notes.txt"]);
  assert.deepEqual(extractRecordedPaths("C:file.md"), []);
  assert.deepEqual(extractRecordedPaths("file.md"), []);
  assert.deepEqual(extractRecordedPaths("/a//b.md"), ["/b.md"]);
  assert.deepEqual(extractRecordedPaths("/a/b.txt//c.md"), ["/a/b.txt", "/c.md"]);
  assert.deepEqual(extractRecordedPaths("no paths here"), []);
  // 拡張子として成立しない末尾は含めず、成立した位置で確定する（旧正規表現と実測で一致）
  assert.deepEqual(extractRecordedPaths("/a.json.bak"), ["/a.json"]);
  assert.deepEqual(extractRecordedPaths("/a.md/b"), ["/a.md"]);
});

test("extractRecordedPaths stays linear on path-like strings without extensions (audit F2)", () => {
  // 監査 PoC: 旧正規表現は 48 KB で約 4.8 秒（長さ2倍で時間4倍の二乗）。
  // 192 KB でも実用時間で終わることを見る
  const s = "/ab".repeat(64_000);
  const started = Date.now();
  assert.deepEqual(extractRecordedPaths(s), []);
  assert.ok(Date.now() - started < 5000, "extraction must stay fast");
});

test("graph walk stops at the node cap and leaves a note (audit 2026-11-22)", () => {
  const dir = mkdtempSync(join(tmpdir(), "skilltrace-graph-cap-"));
  try {
    const ws = join(dir, "ws");
    const skill = join(ws, ".github", "skills", "wide");
    mkdirSync(skill, { recursive: true });
    const refs: string[] = [];
    const total = MAX_GRAPH_NODES + 50;
    for (let i = 0; i < total; i++) {
      writeFileSync(join(skill, `f${i}.md`), `# File ${i}\n`);
      refs.push(`[f${i}](f${i}.md)`);
    }
    writeFileSync(join(skill, "SKILL.md"), `# Wide\n\n${refs.join("\n")}\n`);
    const graph = buildGraph(skill, ws);
    assert.ok(graph.nodes.size <= MAX_GRAPH_NODES, `nodes ${graph.nodes.size} must stay within the cap`);
    assert.ok(graph.notes.length > 0, "a truncation note must be recorded");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("graph does not fetch headings outside the allowed roots (audit 2026-11-22)", () => {
  const dir = mkdtempSync(join(tmpdir(), "skilltrace-graph-roots-"));
  try {
    const ws = join(dir, "ws");
    const skill = join(ws, ".github", "skills", "s");
    mkdirSync(skill, { recursive: true });
    // ワークスペース内・スキル外の文書: 見出しは従来どおり取得する
    writeFileSync(join(ws, "inside.md"), "# Inside Heading\n");
    // 許可ルート（スキルとワークスペース）の外の文書: 見出しは取得しない
    const outsideDir = join(dir, "elsewhere");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "outside.md"), "# Outside Heading\n");
    writeFileSync(join(skill, "SKILL.md"), "# S\n\n[a](../../../inside.md)\n[b](../../../../elsewhere/outside.md)\n");
    const graph = buildGraph(skill, ws);
    const byName = new Map(graph.order.map(n => [n.name, n]));
    assert.equal(byName.get("inside.md")?.title, "Inside Heading");
    assert.equal(byName.get("outside.md")?.title, null);
    assert.equal(byName.get("outside.md")?.boundary, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("locateSkillFromPaths: 記録のパスからワークスペース外スキルを特定する（Issue #60）", () => {
  const base = mkdtempSync(join(tmpdir(), "skilltrace-locate-"));
  try {
    const skillDir = join(base, "diataxis_skills", ".github", "skills", "diataxis-reviewer");
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# reviewer\n");
    const found = (p: string) => p.replace(/\\/g, "/");
    // references の読み取りパスから特定できる（スラッシュ・バックスラッシュ両対応）
    assert.equal(found(locateSkillFromPaths("diataxis-reviewer", [join(skillDir, "references", "review-criteria.md")])!), found(skillDir));
    assert.equal(found(locateSkillFromPaths("diataxis-reviewer", [`${base.replace(/\//g, "\\")}\\diataxis_skills\\.github\\skills\\diataxis-reviewer\\SKILL.md`])!), found(skillDir));
    // 名前が違えば特定しない／標準ルート外の同名フォルダは候補にしない
    assert.equal(locateSkillFromPaths("diataxis-creator", [join(skillDir, "SKILL.md")]), null);
    const stray = join(base, "elsewhere", "diataxis-reviewer");
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, "SKILL.md"), "# stray\n");
    assert.equal(locateSkillFromPaths("diataxis-reviewer", [join(stray, "SKILL.md")]), null);
    // SKILL.md が無ければ特定しない／相対パスの断片は対象にしない
    const noSkill = join(base, "repo2", ".agents", "skills", "ghost");
    mkdirSync(noSkill, { recursive: true });
    assert.equal(locateSkillFromPaths("ghost", [join(noSkill, "references", "x.md")]), null);
    assert.equal(locateSkillFromPaths("diataxis-reviewer", ["/../diataxis-reviewer/references/compass.md", "skills/diataxis-reviewer/SKILL.md"]), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("recordLocatedSkillsNote: 特定できたスキルの注記文", () => {
  assert.equal(recordLocatedSkillsNote(undefined), "");
  assert.equal(recordLocatedSkillsNote([]), "");
  const note = recordLocatedSkillsNote([{ name: "diataxis-reviewer", dir: "C:/git_workspace/diataxis_skills/.github/skills/diataxis-reviewer" }]);
  assert.ok(note.includes("diataxis-reviewer"));
  assert.ok(note.includes("ワークスペース外"));
  assert.ok(recordLocatedSkillsNote([{ name: "x", dir: "/tmp/x" }], "en").includes("located from paths in the record"));
});

test("discoverSkills: descendIntoChildFolders は直下の子フォルダ（clone）の中まで見る", () => {
  // 「1つのワークスペースフォルダの下に複数の clone を並べる」構成では、
  // スキルは <ルート>/<リポジトリ>/.github/skills/<名前> にある（2026-11-27 の報告）
  const root = mkdtempSync(join(tmpdir(), "skilltrace-discover-"));
  try {
    const mk = (rel: string) => {
      mkdirSync(join(root, rel), { recursive: true });
      writeFileSync(join(root, rel, "SKILL.md"), "# skill\n");
    };
    mk(".github/skills/root-skill");
    mk("repo-a/.github/skills/child-skill");
    mk("repo-a/nested/.github/skills/deep-skill");
    mk("node_modules/pkg/.github/skills/nm-skill");
    mk(".hidden/.github/skills/hidden-skill");

    const shallow = discoverSkills(root).map(s => s.name);
    assert.deepEqual(shallow, ["root-skill"]);

    const deep = discoverSkills(root, { descendIntoChildFolders: true }).map(s => s.name).sort();
    // 子フォルダ1段目まで。2段下（deep）、node_modules、隠しフォルダは対象外
    assert.deepEqual(deep, ["child-skill", "root-skill"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverSkills: 列挙できない標準ルートがあっても、他のルートの探索は続く", () => {
  // .github/skills が通常ファイルだと readdirSync が例外になる。1つの標準
  // ルートの失敗で探索全体（ひいてはトレース構築）が落ちないことの回帰テスト
  const root = mkdtempSync(join(tmpdir(), "skilltrace-discover-bad-"));
  try {
    mkdirSync(join(root, ".github"), { recursive: true });
    writeFileSync(join(root, ".github", "skills"), "not a directory\n");
    mkdirSync(join(root, ".agents", "skills", "demo"), { recursive: true });
    writeFileSync(join(root, ".agents", "skills", "demo", "SKILL.md"), "# demo\n");
    // 子フォルダ側の壊れた標準ルートでも、ルート直下の結果は返る
    mkdirSync(join(root, "repo-x", ".github"), { recursive: true });
    writeFileSync(join(root, "repo-x", ".github", "skills"), "not a directory\n");
    assert.deepEqual(discoverSkills(root).map(s => s.name), ["demo"]);
    assert.deepEqual(discoverSkills(root, { descendIntoChildFolders: true }).map(s => s.name), ["demo"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverSkills: シンボリックリンクの別名で重複排除されても、記録の別名パスで照合できる", async () => {
  // .github/skills/lint が .agents/skills/lint へのリンクだと、重複排除で
  // 残るのは .github 側だけになる。記録が .agents 側のパスを指していても、
  // 実パスでの照合で検出できることの回帰テスト
  const { detectSkillsForSession } = await import("../core/autodetect.js");
  const root = mkdtempSync(join(tmpdir(), "skilltrace-alias-"));
  try {
    const agentsLint = join(root, ".agents", "skills", "lint");
    mkdirSync(agentsLint, { recursive: true });
    writeFileSync(join(agentsLint, "SKILL.md"), "# lint\n");
    mkdirSync(join(root, ".agents", "skills", "other"), { recursive: true });
    writeFileSync(join(root, ".agents", "skills", "other", "SKILL.md"), "# other\n");
    mkdirSync(join(root, ".github", "skills"), { recursive: true });
    symlinkSync(agentsLint, join(root, ".github", "skills", "lint"), "dir");

    const found = discoverSkills(root);
    // 実フォルダが同じ lint は1件にまとまる（別名の二重登録をしない）
    assert.deepEqual(found.map(s => s.name).sort(), ["lint", "other"]);
    assert.equal(found.filter(s => s.name === "lint").length, 1);

    // 起動記録は別名（.agents）側のパスだけを持ち、スキル名の文字列は含まない
    const invokedPath = join(agentsLint, "SKILL.md").replace(/\\/g, "/");
    const text = [
      JSON.stringify({ type: "user.message", timestamp: "2026-11-27T00:00:00.000Z", id: "u1", data: { content: "please check the code" } }),
      JSON.stringify({ type: "skill.invoked", timestamp: "2026-11-27T00:00:01.000Z", id: "e1", data: { skillPath: invokedPath } }),
    ].join("\n");
    const parsed = parseEventsText(text);
    // 他スキル（other）があるため単一候補フォールバックでは救えない条件で、
    // lint だけがパス照合で検出される
    assert.deepEqual(detectSkillsForSession(parsed, root).map(s => s.name), ["lint"]);

    // 履歴ラベルの候補照合（scanInvokedSkillNames）でも別名で一致する
    const eventsPath = join(root, "events.jsonl");
    writeFileSync(eventsPath, text + "\n");
    assert.deepEqual(scanInvokedSkillNames(eventsPath, found), ["lint"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverSkills: 実体が先に見つかる向きのリンクでも、別名パスで照合できる", async () => {
  // .github/skills/lint が実体で .agents/skills/lint がそのリンクだと、
  // 重複排除で残るのは実体（.github）側だけになり、実パス形は実体と同一に
  // なる。記録が別名（.agents）側のパスだけを持つ場合でも、重複排除で
  // 落ちた別名を aliasDirs として保持し、照合に使えることの回帰テスト
  const { detectSkillsForSession } = await import("../core/autodetect.js");
  const root = mkdtempSync(join(tmpdir(), "skilltrace-alias-rev-"));
  try {
    const githubLint = join(root, ".github", "skills", "lint");
    mkdirSync(githubLint, { recursive: true });
    writeFileSync(join(githubLint, "SKILL.md"), "# lint\n");
    mkdirSync(join(root, ".github", "skills", "other"), { recursive: true });
    writeFileSync(join(root, ".github", "skills", "other", "SKILL.md"), "# other\n");
    mkdirSync(join(root, ".agents", "skills"), { recursive: true });
    const agentsLint = join(root, ".agents", "skills", "lint");
    symlinkSync(githubLint, agentsLint, "dir");

    const found = discoverSkills(root);
    assert.deepEqual(found.map(s => s.name).sort(), ["lint", "other"]);
    const lint = found.find(s => s.name === "lint");
    assert.ok(lint);
    // 残ったのは実体（.github）側で、落ちた別名（.agents）側が保持される
    assert.equal(lint.dir, githubLint);
    assert.deepEqual(lint.aliasDirs, [agentsLint]);

    const invokedPath = join(agentsLint, "SKILL.md").replace(/\\/g, "/");
    const text = [
      JSON.stringify({ type: "user.message", timestamp: "2026-11-27T00:00:00.000Z", id: "u1", data: { content: "please check the code" } }),
      JSON.stringify({ type: "skill.invoked", timestamp: "2026-11-27T00:00:01.000Z", id: "e1", data: { skillPath: invokedPath } }),
    ].join("\n");
    const parsed = parseEventsText(text);
    assert.deepEqual(detectSkillsForSession(parsed, root).map(s => s.name), ["lint"]);

    const eventsPath = join(root, "events.jsonl");
    writeFileSync(eventsPath, text + "\n");
    assert.deepEqual(scanInvokedSkillNames(eventsPath, found), ["lint"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("locateSkillFromPaths: 文章や JSON 文字列に埋め込まれたパスからも特定する", () => {
  // Copilot CLI の記録では、読み取りパスがツール結果の文章や引数の JSON
  // 文字列の中に埋め込まれて現れることがある。文字列全体を区切るだけでは
  // 先頭に余分な部分が付いて絶対パスとして組み立てられず、スキル外の
  // 読み取りには出るのに所在を特定できない、という不整合があった
  const base = mkdtempSync(join(tmpdir(), "skilltrace-locate-embed-"));
  try {
    const skillDir = join(base, "diataxis_skills", ".github", "skills", "diataxis-reviewer");
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# reviewer\n");
    const clean = join(skillDir, "references", "review-criteria.md");
    const found = (p: string) => p.replace(/\\/g, "/");
    // 文章に埋め込まれた形（ツール結果）
    assert.equal(found(locateSkillFromPaths("diataxis-reviewer", [`Successfully read the file: ${clean} (120 lines)`])!), found(skillDir));
    // JSON 文字列に埋め込まれた形（ツール引数）
    assert.equal(found(locateSkillFromPaths("diataxis-reviewer", [JSON.stringify({ path: clean })])!), found(skillDir));
    // file:// URI の形
    assert.equal(found(locateSkillFromPaths("diataxis-reviewer", [`file://${clean}`])!), found(skillDir));
    // 埋め込まれていても、実在しないフォルダや名前違いは特定しない
    assert.equal(locateSkillFromPaths("diataxis-reviewer", [`read: ${join(base, "nope", ".github", "skills", "diataxis-reviewer", "SKILL.md")}`]), null);
    assert.equal(locateSkillFromPaths("diataxis-creator", [JSON.stringify({ path: clean })]), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("findSkillsByNameInRoots: 別ルートの現在の置き場所から、名前で拾う", () => {
  // マルチルートのワークスペースで実行されたセッションでは、スキルが
  // 実行時フォルダ以外のルートにあり、しかも記録時点から置き場所が
  // 変わっている（.github → .agents）ことがある。記録のパスでは特定
  // できないため、今開いている別ルートの現在の置き場所から名前で拾う
  const base = mkdtempSync(join(tmpdir(), "skilltrace-roots-"));
  try {
    const sessionRoot = join(base, "lui_skills_creator");
    mkdirSync(sessionRoot, { recursive: true });
    const otherRoot = join(base, "diataxis_skills");
    const reviewerDir = join(otherRoot, ".agents", "skills", "diataxis-reviewer");
    const fixerDir = join(otherRoot, ".agents", "skills", "diataxis-fixer");
    const otherDir = join(otherRoot, ".agents", "skills", "diataxis-creator");
    for (const d of [reviewerDir, fixerDir, otherDir]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "SKILL.md"), "# skill\n");
    }
    // 子フォルダ（clone）の中にある場合も拾う
    const childSkillDir = join(base, "parent", "clone-a", ".kiro", "skills", "child-skill");
    mkdirSync(childSkillDir, { recursive: true });
    writeFileSync(join(childSkillDir, "SKILL.md"), "# child\n");

    const found = findSkillsByNameInRoots(["diataxis-reviewer", "diataxis-fixer", "child-skill"], [sessionRoot, otherRoot, join(base, "parent")]);
    assert.deepEqual(found.map(f => f.name).sort(), ["child-skill", "diataxis-fixer", "diataxis-reviewer"]);
    assert.equal(found.find(f => f.name === "diataxis-reviewer")!.dir, reviewerDir);
    // 起動していないスキルは拾わない／見つからない名前は返さない
    assert.equal(findSkillsByNameInRoots(["diataxis-creator"], [otherRoot]).length, 1);
    assert.deepEqual(findSkillsByNameInRoots(["ghost"], [otherRoot]), []);
    assert.deepEqual(findSkillsByNameInRoots([], [otherRoot]), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
