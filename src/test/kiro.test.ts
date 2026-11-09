import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildGraph } from "../core/graph";
import { buildKiroSessionTrace, listKiroSessions, parseKiroMessages, scanKiroActivationNames, scanKiroInvokedSkillNames } from "../core/kiro";
import { renderSessionHtml } from "../core/report";
import { renderSessionMarkdown, renderSessionHtmlFragment } from "../core/document";

// フィクスチャは実機プローブ（2026-11-07/08、kiro-probe）の本物の記録。
// 正解値: 起動=kiro-probe、読み取り=SKILL.md → level1 → level2、
// クレジット合計 0.8200442711442787、contextUsage は7回（最終 4.2921%）。
// 実機で確認した記録の性質: executionId はターン共通で、呼び出しと結果の
// 対応キーは toolCallId。disclose_context の tool_result は success=false
// だったが、起動の事実は tool_call 側で確定する。
const root = join(__dirname, "..", "..", "test-fixtures");
const kiroWorkspace = join(root, "kiro-workspace");
const kiroSkillDir = join(kiroWorkspace, ".kiro", "skills", "kiro-probe");
const messagesText = () => readFileSync(join(root, "kiro-messages.jsonl"), "utf8");

test("kiro sessions are listed from the v3 store layout", () => {
  const sessions = listKiroSessions(join(root, "kiro-home"));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "sess_6d826121-2e9a-4628-a998-cefab29517dd");
  assert.equal(sessions[0].title, "Kiro-Probe スキルで合言葉を確認");
  assert.equal(sessions[0].workspacePaths.length, 1);
  assert.ok(sessions[0].workspacePaths[0].endsWith("skilltrace-kiro-probe"));
});

test("kiro messages parse: activation, credits and context usage", () => {
  const parsed = parseKiroMessages(messagesText());
  assert.equal(parsed.health.skippedLines, 0);
  assert.equal(parsed.health.unknownRatio, 0);
  assert.deepEqual(parsed.activations.map(a => a.name), ["kiro-probe"]);
  assert.ok(Math.abs(parsed.creditsTotal - 0.8200442711442787) < 1e-12);
  assert.equal(parsed.creditTurns.length, 1);
  assert.equal(parsed.contextUsageSeries.length, 7);
  assert.ok(Math.abs((parsed.contextUsageSeries[6]?.ratio ?? 0) - 0.042921) < 1e-6);
  assert.ok(parsed.firstUserMessage.includes("kiro-probe"));
  // 呼び出しと結果は toolCallId で対応付く（ツール名が正しく引ける）
  const names = parsed.toolExecutions.map(t => t.toolName).sort();
  assert.deepEqual(names, ["disclose_context", "read_files", "read_files", "read_files", "search", "search", "search", "search"]);
  // disclose_context の結果だけ success=false（実記録どおり）
  assert.equal(parsed.toolExecutions.find(t => t.toolName === "disclose_context")?.success, false);
  assert.equal(parsed.toolExecutions.filter(t => t.success).length, 7);
});

test("kiro trace: grades and arrival order match the probe ground truth", () => {
  const parsed = parseKiroMessages(messagesText());
  const graph = buildGraph(kiroSkillDir, kiroWorkspace);
  const trace = buildKiroSessionTrace(parsed, [{ graph, skillDirAbs: kiroSkillDir, disclosed: true }], {
    sessionId: "sess_6d826121-2e9a-4628-a998-cefab29517dd",
    workspaceAbs: kiroWorkspace,
  });
  assert.equal(trace.source, "kiro");
  assert.equal(trace.skills.length, 1);
  assert.equal(trace.skills[0].skillName, "kiro-probe");
  const byName = new Map(trace.skills[0].nodes.map(n => [n.name, n]));
  // SKILL.md は disclose_context による開示で確度高（2026-11-08 決定）
  assert.equal(byName.get("SKILL.md")?.grade, "A");
  assert.equal(byName.get("level1.md")?.grade, "B");
  assert.equal(byName.get("level2.md")?.grade, "B");
  assert.equal(byName.get("SKILL.md")?.order, 1);
  assert.equal(byName.get("level1.md")?.order, 2);
  assert.equal(byName.get("level2.md")?.order, 3);
  assert.ok(Math.abs((trace.creditsTotal ?? 0) - 0.8200442711442787) < 1e-12);
  assert.ok(Math.abs((trace.lastContextUsageRatio ?? 0) - 0.042921) < 1e-6);
  assert.equal(trace.outsideReads.length, 0);
});

test("kiro trace: activated but undiscovered skills are named instead of vanishing", () => {
  const parsed = parseKiroMessages(messagesText());
  // スキルが現在のワークスペースで見つからない（parts が空）場合でも、
  // 起動の事実は名前とともに残り、「検出されませんでした」にはならない
  const trace = buildKiroSessionTrace(parsed, [], {
    sessionId: "sess_6d826121-2e9a-4628-a998-cefab29517dd",
    workspaceAbs: kiroWorkspace,
  });
  assert.equal(trace.skills.length, 0);
  assert.deepEqual(trace.undiscoveredSkills, ["kiro-probe"]);
  const html = renderSessionHtml(trace);
  assert.ok(html.includes("現在のワークスペースでは見つかりませんでした"));
  assert.ok(!html.includes("スキル起動は検出されませんでした"));
  const md = renderSessionMarkdown(trace);
  assert.ok(md.includes("現在のワークスペースでは見つかりませんでした"));
  assert.ok(md.includes("kiro-probe"));
  // スキルが見つかる通常ケースでは未発見は空
  const graph = buildGraph(kiroSkillDir, kiroWorkspace);
  const found = buildKiroSessionTrace(parsed, [{ graph, skillDirAbs: kiroSkillDir, disclosed: true }], {
    sessionId: "sess_6d826121-2e9a-4628-a998-cefab29517dd",
    workspaceAbs: kiroWorkspace,
  });
  assert.deepEqual(found.undiscoveredSkills, []);
  // ラベル用スキャン: 候補なしでも記録の起動名は拾える。候補照合版は従来どおり null
  assert.deepEqual(scanKiroActivationNames(join(root, "kiro-messages.jsonl")), ["kiro-probe"]);
  assert.equal(scanKiroInvokedSkillNames(join(root, "kiro-messages.jsonl"), []), null);
});

test("kiro summaries render credits and usage ratio instead of token tables", () => {
  const parsed = parseKiroMessages(messagesText());
  const graph = buildGraph(kiroSkillDir, kiroWorkspace);
  const trace = buildKiroSessionTrace(parsed, [{ graph, skillDirAbs: kiroSkillDir, disclosed: true }], {
    sessionId: "sess_6d826121-2e9a-4628-a998-cefab29517dd",
    workspaceAbs: kiroWorkspace,
  });
  const html = renderSessionHtml(trace);
  assert.ok(html.includes("クレジット実測"));
  assert.ok(html.includes("0.82"));
  assert.ok(html.includes("最終使用率 4.3%"));
  assert.ok(!html.includes("トークン実測")); // 用語集の「キャッシュ」項は共通表示なので対象外
  const md = renderSessionMarkdown(trace);
  assert.ok(md.includes("## クレジット実測"));
  assert.ok(md.includes("最終使用率 4.3%"));
  assert.ok(!md.includes("キャッシュ読取"));
});

test("kiro trace: a session without skill activation still shows context loads and credits", () => {
  const text = [
    { id: "s1", timestamp: "2026-11-07T15:00:00.000Z", payload: { type: "session_start", content: "" } },
    { id: "s2", timestamp: "2026-11-07T15:00:01.000Z", payload: { type: "user", content: "仕様を書いてください。" } },
    { id: "s3", timestamp: "2026-11-07T15:00:02.000Z", payload: { type: "steering_inclusion", documents: ["file:///c%3A/Users/masas/proj/AGENTS.md", "file:///c%3A/Users/masas/proj/.kiro/steering/product.md"], executionId: "e1", turnId: "e1" } },
    { id: "s4", timestamp: "2026-11-07T15:00:03.000Z", payload: { type: "tool_call", actionType: "read_files", args: { path: "c:\\Users\\masas\\proj\\notes.md", offset: null, limit: null }, executionId: "e1", toolCallId: "tc1" } },
    { id: "s5", timestamp: "2026-11-07T15:00:04.000Z", payload: { type: "tool_result", executionId: "e1", toolCallId: "tc1", success: true, content: "# notes" } },
    { id: "s6", timestamp: "2026-11-07T15:00:05.000Z", payload: { type: "session_metadata", key: "contextUsage", value: { usagePercentage: 12.5 }, executionId: "e1" } },
    { id: "s7", timestamp: "2026-11-07T15:00:06.000Z", payload: { type: "usage_summary", promptTurnSummaries: [{ unit: "credit", unitPlural: "credits", usage: 19.877, usedTools: ["read_file"] }], elapsedTime: 1000, status: "success", executionId: "e1", turnId: "e1", requestIds: [] } },
  ].map(o => JSON.stringify(o)).join("\n");
  const parsed = parseKiroMessages(text);
  assert.equal(parsed.inclusions.length, 1);
  assert.equal(parsed.activations.length, 0);
  const trace = buildKiroSessionTrace(parsed, [], { sessionId: "sess_y", workspaceAbs: kiroWorkspace });
  assert.equal(trace.skills.length, 0);
  assert.equal(trace.contextLoads?.length, 2);
  assert.equal(trace.contextLoads?.[0].path, "c:/Users/masas/proj/AGENTS.md");
  // 取り込みは「スキル外の読み取り」には混ぜない（読み取りだけが入る）
  assert.equal(trace.outsideReads.length, 1);
  assert.ok(Math.abs((trace.creditsTotal ?? 0) - 19.877) < 1e-9);
  const html = renderSessionHtml(trace);
  assert.ok(html.includes("常時文脈"));
  assert.ok(html.includes("AGENTS.md"));
  assert.ok(html.includes("19.88"));
  assert.ok(html.includes("スキル起動は検出されませんでした"));
  // 最初に記録された使用率（最初の contextUsage = 12.5%）が常時文脈の節に併記される（Issue #9）
  // 画面サマリには文書コピー用の Markdown が script 内に埋め込まれるため、可視部分と断片を分けて検証する
  const visibleHtml = html.replace(/<script>[\s\S]*?<\/script>/g, "");
  assert.ok(visibleHtml.includes("最初に記録されたコンテキストウィンドウ使用率: 12.5%"));
  assert.ok(renderSessionHtmlFragment(trace).includes("最初に記録されたコンテキストウィンドウ使用率: 12.5%"));
  const md = renderSessionMarkdown(trace);
  assert.ok(md.includes("最初に記録されたコンテキストウィンドウ使用率: 12.5%"));
});

test("kiro trace: steering_inclusion documents give grade A", () => {
  const inclusion = JSON.stringify({
    id: "mx",
    timestamp: "2026-11-07T15:04:47.000Z",
    payload: {
      type: "steering_inclusion",
      documents: ["file:///c%3A/Users/masas/Downloads/skilltrace-kiro-probe/skilltrace-kiro-probe/.kiro/skills/kiro-probe/references/level2.md"],
      executionId: "9d980af8-b68b-4a68-bef7-5f7f9b289f25",
      turnId: "9d980af8-b68b-4a68-bef7-5f7f9b289f25",
    },
  });
  const lines = messagesText().trimEnd().split("\n");
  lines.splice(28, 0, inclusion); // level2 の読み取り（29行目）の直前に入れる
  const parsed = parseKiroMessages(lines.join("\n"));
  const graph = buildGraph(kiroSkillDir, kiroWorkspace);
  const trace = buildKiroSessionTrace(parsed, [{ graph, skillDirAbs: kiroSkillDir, disclosed: true }], {
    sessionId: "sess_x",
    workspaceAbs: kiroWorkspace,
  });
  const byName = new Map(trace.skills[0].nodes.map(n => [n.name, n]));
  assert.equal(byName.get("level2.md")?.grade, "A");
});

test("kiro english rendering: summary, matrix legend, markdown and copy are in English", () => {
  const parsed = parseKiroMessages(messagesText());
  const graph = buildGraph(kiroSkillDir, kiroWorkspace);
  const trace = buildKiroSessionTrace(parsed, [{ graph, skillDirAbs: kiroSkillDir, disclosed: true }], {
    sessionId: "sess_6d826121-2e9a-4628-a998-cefab29517dd",
    workspaceAbs: kiroWorkspace,
    lang: "en",
  });
  // 根拠も英語で組み立てられる
  const skillNode = trace.skills[0].nodes.find(n => n.name === "SKILL.md");
  assert.ok(skillNode?.evidence.startsWith("Skill activation via disclose_context"));
  const html = renderSessionHtml(trace, { lang: "en" });
  assert.ok(html.includes('<html lang="en">'));
  assert.ok(html.includes("Session summary"));
  assert.ok(html.includes("Credit usage"));
  assert.ok(html.includes("Tools used"));
  assert.ok(html.includes("Legend (tool groups): "));
  assert.ok(html.includes("Read / explore"));
  assert.ok(!html.includes("クレジット実測"));
  // ツリー内の確度バッジも英語になる（gradeBadge へ lang を渡す）
  assert.ok(html.includes('badge bA">High'));
  assert.ok(!html.includes("確度高"));
  const md = renderSessionMarkdown(trace, { lang: "en", includeNotes: true });
  assert.ok(md.includes("# Session summary"));
  assert.ok(md.includes("## Credit usage"));
  assert.ok(md.includes("## Glossary"));
  assert.ok(md.includes("Arrival certainty (high / medium / low)"));
  const frag = renderSessionHtmlFragment(trace, { lang: "en" });
  assert.ok(frag.includes("Legend (tool groups): "));
  assert.ok(!frag.includes("凡例"));
});

test("kiro listing: workspacePaths and rootPaths are unioned for skill discovery", () => {
  // マルチルートでは2つの記録が食い違うことがある。片方にしか無いルートの
  // スキルを「見つからない」と誤判定しないよう、和集合を探索対象にする
  const home = mkdtempSync(join(tmpdir(), "skilltrace-kiro-"));
  try {
    const dir = join(home, "sessions", "bucket1", "sess_00000000-0000-4000-8000-000000000001");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.json"), JSON.stringify({
      id: "sess_00000000-0000-4000-8000-000000000001", title: "multi",
      workspacePaths: ["C:/ws/rootA"], rootPaths: ["C:/ws/rootA", "C:/ws/rootB"],
    }));
    writeFileSync(join(dir, "messages.jsonl"), "");
    const sessions = listKiroSessions(home);
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0].workspacePaths, ["C:/ws/rootA", "C:/ws/rootB"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
