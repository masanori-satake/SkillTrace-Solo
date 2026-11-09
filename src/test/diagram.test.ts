import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../core/graph";
import { parseEventsText } from "../core/events";
import { buildTrace, firstHeading, type TraceNode } from "../core/trace";
import { buildReferenceDiagram, renderHtml } from "../core/report";

const root = join(__dirname, "..", "..", "test-fixtures");
const workspace = join(root, "workspace");
const skillDir = join(workspace, ".github", "skills", "phase0-probe");

function node(partial: Partial<TraceNode> & { id: string }): TraceNode {
  return {
    relToSkill: partial.id.split("/").pop() ?? partial.id,
    relToWorkspace: "",
    name: partial.id.split("/").pop() ?? partial.id,
    boundary: false,
    missing: false,
    cycle: false,
    depth: null,
    estTokens: 100,
    sizeBytes: 400,
    grade: null,
    evidence: "",
    firstAt: null,
    order: null,
    failed: false,
    title: null,
    parents: [],
    children: [],
    ...partial,
  };
}

test("reference diagram converges shared references and survives cycles (Issue #40)", () => {
  const nodes = [
    node({ id: "root", relToSkill: "SKILL.md", name: "SKILL.md", grade: "A", order: 1, children: ["a.md", "b.md"] }),
    node({ id: "a", relToSkill: "a.md", name: "a.md", grade: "A", order: 2, children: ["shared.md"] }),
    node({ id: "b", relToSkill: "b.md", name: "b.md", grade: "C", order: null, children: ["shared.md"] }),
    node({ id: "shared", relToSkill: "shared.md", name: "shared.md", grade: "B", order: 3, children: ["a.md"] }),
  ];
  const d = buildReferenceDiagram(nodes, "SKILL.md");
  // 共有参照は複製されず1ノードに集まる
  assert.equal(d.nodes.length, 4);
  assert.equal(d.nodes.filter(n => n.rel === "shared.md").length, 1);
  // 辺は重複なく、循環（shared → a）も含む
  assert.deepEqual(d.edges.map(e => `${e.from}->${e.to}`).sort(), ["SKILL.md->a.md", "SKILL.md->b.md", "a.md->shared.md", "b.md->shared.md", "shared.md->a.md"]);
  // 深さは BFS の最短（循環で無限ループしない）
  const depthOf = (rel: string) => d.nodes.find(n => n.rel === rel)?.depth;
  assert.equal(depthOf("SKILL.md"), 0);
  assert.equal(depthOf("a.md"), 1);
  assert.equal(depthOf("shared.md"), 2);
  // used 判定: 両端とも A/B のときだけ
  assert.equal(d.edges.find(e => e.from === "a.md")?.used, true);
  assert.equal(d.edges.find(e => e.from === "b.md")?.used, false);
});

test("skill summary renders the reference diagram with a legend (Issue #40)", () => {
  const parsed = parseEventsText(readFileSync(join(root, "events.jsonl"), "utf8"));
  const graph = buildGraph(skillDir, workspace);
  const heading = firstHeading(readFileSync(join(skillDir, "SKILL.md"), "utf8"));
  const trace = buildTrace(parsed, graph, { sessionId: "fixture", workspaceAbs: workspace, skillDirAbs: skillDir, rootHeading: heading });
  const html = renderHtml(trace, graph);
  assert.ok(html.includes("参照構造"));
  assert.ok(html.includes("参照構造の図"));
  assert.ok(html.includes("凡例"));
  assert.ok(html.includes("marker-end"));
});

function bigSkillTrace(refCount: number) {
  const base = mkdtempSync(join(tmpdir(), "skilltrace-diagram-"));
  const ws = join(base, "ws");
  const dir = join(ws, ".github", "skills", "big");
  mkdirSync(dir, { recursive: true });
  const links = Array.from({ length: refCount }, (_, i) => `[f${i}](f${i}.md)`).join(" ");
  writeFileSync(join(dir, "SKILL.md"), `# Big\n\n${links}\n`);
  for (let i = 0; i < refCount; i++) writeFileSync(join(dir, `f${i}.md`), `# F${i}\n`);
  const graph = buildGraph(dir, ws);
  const trace = buildTrace(parseEventsText(""), graph, { sessionId: "x", workspaceAbs: ws, skillDirAbs: dir, rootHeading: "Big" });
  return { graph, trace };
}

test("wide reference diagram scrolls at natural size instead of shrinking (Issue #40 review)", () => {
  const { graph, trace } = bigSkillTrace(39); // 40 ノード、1段に39件で横幅が大きくなる
  const html = renderHtml(trace, graph);
  assert.ok(html.includes("参照構造の図"));
  assert.ok(html.includes("overflow-x:auto"));
});

test("omitted diagram points to the node-details file list, noting cycles (Issue #40 review)", () => {
  const { graph, trace } = bigSkillTrace(40); // 41 ノードで上限超過
  const html = renderHtml(trace, graph);
  assert.ok(!html.includes("参照構造の図"));
  assert.ok(html.includes("ノード明細のファイル一覧を参照してください"));
  assert.ok(html.includes("ツリーは循環箇所で展開を止める場合があります"));
});
