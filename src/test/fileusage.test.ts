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
  const { extractFileUsageCopilotText, aggregateFileUsageGroups } = await import("../core/fileusage.js");
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
  const { results } = aggregateFileUsageGroups(
    [{ label: root, dirs: [skillDir.replace(/\\/g, "/").toLowerCase()], graphs: [graph] }],
    [extractFileUsageCopilotText(text)], "phase0-probe");
  const usage = results[0];
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

test("kiro: a skill only mentioned in text is not registered (Issue #41 review)", async () => {
  const { extractFileUsageKiroText } = await import("../core/fileusage.js");
  const line = (payload: unknown) => JSON.stringify({ id: "x", timestamp: "2026-11-10T00:00:00.000Z", payload });
  const text = [
    line({ type: "user", content: "ghost スキルの C:/ws/.kiro/skills/ghost/SKILL.md と references/g1.md を見ておいて" }),
    line({ type: "assistant", content: "ghost/SKILL.md には触れていません" }),
  ].join("\n");
  const u = extractFileUsageKiroText(text);
  assert.equal(u.skills.length, 0);
});

test("kiro: read paths with spaces are kept whole (Issue #41 review)", async () => {
  const { extractFileUsageKiroText } = await import("../core/fileusage.js");
  const line = (payload: unknown) => JSON.stringify({ id: "x", timestamp: "2026-11-10T00:00:00.000Z", payload });
  const text = [
    line({ type: "tool_call", toolName: "read_file", kind: "read", actionType: "read_files", args: { path: "C:/work/my skill pack/SKILL.md" } }),
    line({ type: "tool_call", toolName: "read_file", kind: "read", actionType: "read_files", args: { path: "C:/work/my skill pack/references/a b.md" } }),
  ].join("\n");
  const u = extractFileUsageKiroText(text);
  const s = u.skills.find(x => x.name === "my skill pack");
  assert.ok(s);
  assert.ok(s.readRels.has("skill.md"));
  assert.ok(s.readRels.has("references/a b.md"), JSON.stringify([...s.readRels.keys()]));
});

test("kiro: inclusions count as reads only for activated skills (Issue #41 review)", async () => {
  const { extractFileUsageKiroText } = await import("../core/fileusage.js");
  const line = (payload: unknown) => JSON.stringify({ id: "x", timestamp: "2026-11-10T00:00:00.000Z", payload });
  const text = [
    line({ type: "tool_call", toolName: "disclose_context", actionType: "disclose_context", args: { name: "inc-probe" } }),
    line({ type: "steering_inclusion", documents: ["file:///C:/ws/.kiro/skills/inc-probe/references/inc.md", "file:///C:/ws/.kiro/skills/other-probe/references/o.md"] }),
  ].join("\n");
  const u = extractFileUsageKiroText(text);
  const s = u.skills.find(x => x.name === "inc-probe");
  assert.ok(s);
  assert.ok(s.readRels.has("skill.md"));
  assert.ok(s.readRels.has("references/inc.md"));
  // 起動も読み取りも無い other-probe は、取り込みに現れても登録されない
  assert.ok(!u.skills.some(x => x.name === "other-probe"));
});

test("vscode: read paths with spaces match the skill folder exactly (Issue #41 review)", async () => {
  const { extractFileUsageVSCodeText } = await import("../core/fileusage.js");
  const uri = (path: string, query?: string) => ({
    "$mid": 1, path, scheme: "file", ...(query ? { query } : {}),
  });
  const part = (id: string, value: string, u: Record<string, unknown>) => ({
    kind: "toolInvocationSerialized", toolId: "copilot_readFile", toolCallId: id,
    startedAt: 1794200002000, isComplete: true, invocationMessage: { value, uris: u },
  });
  const snapshot = {
    kind: 0,
    v: {
      sessionId: "space-test", creationDate: 1794200000000,
      requests: [{
        requestId: "r1", timestamp: 1794200001000, message: { text: "space skill を使って" },
        response: [
          part("t1", "Reading skill [space skill](file:///c%3A/ws/.github/skills/space%20skill/SKILL.md?vscodeLinkType%3Dskill)",
            { "file:///c%3A/ws/.github/skills/space%20skill/SKILL.md?vscodeLinkType%3Dskill": uri("/c:/ws/.github/skills/space skill/SKILL.md", "vscodeLinkType=skill") }),
          part("t2", "Reading file",
            { "file:///c%3A/ws/.github/skills/space%20skill/references/a%20b.md": uri("/c:/ws/.github/skills/space skill/references/a b.md") }),
        ],
      }],
    },
  };
  const u = extractFileUsageVSCodeText(JSON.stringify(snapshot));
  const s = u.skills.find(x => x.name === "space skill");
  assert.ok(s);
  assert.ok(s.readRels.has("skill.md"));
  assert.ok(s.readRels.has("references/a b.md"), JSON.stringify([...s.readRels.keys()]));
});

test("same-name skills in different locations are not mixed (Issue #41 review)", async () => {
  const { aggregateFileUsageGroups } = await import("../core/fileusage.js");
  const { buildGraph, normPath } = await import("../core/graph.js");
  const mkSkill = (rootName: string, extra: string): { root: string; dir: string } => {
    const root = mkdtempSync(join(tmpdir(), rootName));
    const dir = join(root, ".github", "skills", "dup");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `# Dup\n\nRead [x](${extra}).\n`);
    writeFileSync(join(dir, extra), "# X\n");
    return { root, dir };
  };
  const a = mkSkill("skilltrace-dup-a-", "only-a.md");
  const b = mkSkill("skilltrace-dup-b-", "only-b.md");
  const usage = (dir: string, rel: string) => ({
    startedAt: null,
    skills: [{ name: "dup", dir, readRels: new Map([["skill.md", null], [rel, null]]), mentionRels: new Set<string>() }],
  });
  const usages = [usage(normPath(a.dir), "only-a.md"), usage(normPath(b.dir), "only-b.md"), usage("", "skill.md")];
  const groups = [
    { label: a.root, dirs: [normPath(a.dir)], graphs: [buildGraph(a.dir, a.root)] },
    { label: b.root, dirs: [normPath(b.dir)], graphs: [buildGraph(b.dir, b.root)] },
  ];
  const { results, unattributedSessions } = aggregateFileUsageGroups(groups, usages, "dup");
  assert.equal(results.length, 2);
  // A には A のファイルだけが、A のセッションだけで数えられる
  assert.equal(results[0].invokedSessions, 1);
  assert.ok(results[0].rows.some(r => r.rel === "only-a.md" && r.readSessions === 1));
  assert.ok(!results[0].rows.some(r => r.rel === "only-b.md"));
  assert.equal(results[1].invokedSessions, 1);
  assert.ok(results[1].rows.some(r => r.rel === "only-b.md" && r.readSessions === 1));
  // フォルダの分からないセッションは、複数グループのときはどこにも混ぜない
  assert.equal(unattributedSessions, 1);
  // グループが1つだけなら、フォルダ不明のセッションも名前で数える
  const single = aggregateFileUsageGroups([groups[0]], usages, "dup");
  assert.equal(single.unattributedSessions, 0);
  assert.equal(single.results[0].invokedSessions, 3);
});

test("co-reading pairs and isolated files are aggregated (Issue #42)", async () => {
  const { aggregateFileUsageGroups } = await import("../core/fileusage.js");
  const { buildGraph, normPath } = await import("../core/graph.js");
  const root = mkdtempSync(join(tmpdir(), "skilltrace-coread-"));
  const dir = join(root, ".github", "skills", "coread");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "# Co\n\n[a](a.md) [b](b.md) [c](c.md) [d](d.md)\n");
  for (const f of ["a.md", "b.md", "c.md", "d.md"]) writeFileSync(join(dir, f), `# ${f}\n`);
  const usage = (rels: string[]) => ({
    startedAt: null,
    skills: [{ name: "coread", dir: normPath(dir), readRels: new Map(rels.map(r => [r, null] as [string, null])), mentionRels: new Set<string>() }],
  });
  const usages = [
    usage(["skill.md", "a.md", "b.md"]),
    usage(["skill.md", "a.md", "b.md", "c.md"]),
    usage(["skill.md", "d.md"]),
  ];
  const { results } = aggregateFileUsageGroups(
    [{ label: root, dirs: [normPath(dir)], graphs: [buildGraph(dir, root)] }], usages, "coread");
  const co = results[0].coRead;
  const pairOf = (a: string, b: string) => co.pairs.find(p => p.a === a && p.b === b)?.sessions;
  assert.equal(pairOf("a.md", "b.md"), 2);
  assert.equal(pairOf("a.md", "c.md"), 1);
  assert.equal(pairOf("b.md", "c.md"), 1);
  // SKILL.md は常時読み込まれるため、組み合わせの対象に入らない
  assert.ok(!co.pairs.some(p => p.a === "SKILL.md" || p.b === "SKILL.md"));
  assert.deepEqual(co.isolated, ["d.md"]);
});

test("per-file page renders the co-reading graph and pair table (Issue #42)", async () => {
  const { aggregateFileUsageGroups } = await import("../core/fileusage.js");
  const { buildGraph, normPath } = await import("../core/graph.js");
  const { renderFileUsageHtml } = await import("../core/report.js");
  const root = mkdtempSync(join(tmpdir(), "skilltrace-coread-html-"));
  const dir = join(root, ".github", "skills", "coread");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "# Co\n\n[a](a.md) [b](b.md)\n");
  writeFileSync(join(dir, "a.md"), "# A\n");
  writeFileSync(join(dir, "b.md"), "# B\n");
  const usages = [{
    startedAt: null,
    skills: [{ name: "coread", dir: normPath(dir), readRels: new Map([["skill.md", null], ["a.md", null], ["b.md", null]] as [string, null][]), mentionRels: new Set<string>() }],
  }];
  const { results } = aggregateFileUsageGroups(
    [{ label: root, dirs: [normPath(dir)], graphs: [buildGraph(dir, root)] }], usages, "coread");
  const html = renderFileUsageHtml(results, { scanned: 1, skipped: 0, unattributed: 0 });
  assert.ok(html.includes("同時読み込み"));
  assert.ok(html.includes("<svg"));
  assert.ok(html.includes("a.md + b.md"));
  assert.ok(html.includes("線の太さ＝一緒に読み込まれたセッション数"));
});
