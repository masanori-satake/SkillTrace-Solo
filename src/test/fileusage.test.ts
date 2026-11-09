// ファイル単位の横断集計（Issue #41）のテスト。
// 抽出は実フィクスチャの記録で、集計は一時スキルのグラフで確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIX = join(process.cwd(), "test-fixtures");

test("per-file reach extraction from the Copilot fixture record", async () => {
  const { extractFileUsageCopilotText } = await import("../core/fileusage.js");
  const text = readFileSync(join(FIX, "events.jsonl"), "utf8");
  const u = extractFileUsageCopilotText(text);
  assert.equal(u.skills.length, 1);
  const s = u.skills[0];
  assert.equal(s.name, "phase0-probe");
  assert.ok(s.dir.endsWith("phase0-probe"), s.dir);
  // skill.invoked の skillPath とツール実行の引数から、読み取りが取れる
  assert.ok(s.readRels.has("skill.md"));
  assert.ok(s.readRels.has("references/alpha.md"));
  assert.ok(s.readRels.has("references/beta.md"));
  // gamma は skill.invoked_ref の参照一覧に現れるだけで、ツールで読まれては
  // いない。読み取りではなく「言及のみ」に分類されることが正しい
  assert.ok(!s.readRels.has("references/gamma.md"));
  assert.ok(s.mentionRels.has("references/gamma.md"));
});

test("per-file reach extraction from the Kiro fixture record", async () => {
  const { extractFileUsageKiroText } = await import("../core/fileusage.js");
  const text = readFileSync(join(FIX, "kiro-messages.jsonl"), "utf8");
  const u = extractFileUsageKiroText(text);
  const s = u.skills.find(x => x.name === "kiro-probe");
  assert.ok(s);
  assert.ok(s.dir.endsWith("kiro-probe"), s.dir);
  assert.ok(s.readRels.has("skill.md"));
  assert.ok(s.readRels.has("references/level1.md"));
  assert.ok(s.readRels.has("references/level2.md"));
});

test("per-file reach extraction from the VS Code chat fixture record", async () => {
  const { extractFileUsageVSCodeText } = await import("../core/fileusage.js");
  const text = readFileSync(join(FIX, "vscode-chatsessions/vscode-chatsession.jsonl"), "utf8");
  const u = extractFileUsageVSCodeText(text);
  const s = u.skills.find(x => x.name === "vscode-probe");
  assert.ok(s);
  assert.ok(s.readRels.has("skill.md"));
  assert.ok(s.readRels.has("references/level1.md"), JSON.stringify([...s.readRels.keys()]));
  assert.ok(s.readRels.has("references/level2.md"));
});

test("aggregation marks files never reached in any session (Issue #41)", async () => {
  const { extractFileUsageCopilotText, aggregateFileUsage } = await import("../core/fileusage.js");
  const { buildGraph } = await import("../core/graph.js");
  // SKILL.md が alpha と delta を参照し、alpha が beta を参照するスキル。
  // フィクスチャのセッションは alpha / beta / gamma を読んでいる
  const root = mkdtempSync(join(tmpdir(), "skilltrace-fileusage-"));
  const skillDir = join(root, ".github", "skills", "phase0-probe");
  mkdirSync(join(skillDir, "references"), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# Probe\n\nRead [alpha](references/alpha.md) and [delta](references/delta.md).\n");
  writeFileSync(join(skillDir, "references", "alpha.md"), "# Alpha\n\nThen [beta](beta.md).\n");
  writeFileSync(join(skillDir, "references", "beta.md"), "# Beta\n");
  writeFileSync(join(skillDir, "references", "delta.md"), "# Delta\n");
  const graph = buildGraph(skillDir, root);
  const text = readFileSync(join(FIX, "events.jsonl"), "utf8");
  const usage = aggregateFileUsage([graph], [extractFileUsageCopilotText(text)], "phase0-probe");
  assert.equal(usage.invokedSessions, 1);
  const byRel = new Map(usage.rows.map(r => [r.rel, r]));
  assert.equal(byRel.get("SKILL.md")?.readSessions, 1);
  assert.equal(byRel.get("references/alpha.md")?.readSessions, 1);
  assert.equal(byRel.get("references/beta.md")?.readSessions, 1);
  // グラフに無い gamma は数えず、読まれていない delta が到達なしになる
  assert.ok(!byRel.has("references/gamma.md"));
  assert.equal(byRel.get("references/delta.md")?.noneSessions, 1);
  // 並びは到達なしの多い順（delta が先頭側に来る）
  assert.equal(usage.rows[0].rel, "references/delta.md");
});
