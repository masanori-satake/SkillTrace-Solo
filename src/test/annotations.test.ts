import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseEventsText } from "../core/events";
import { buildGraph } from "../core/graph";
import { buildSessionTrace, firstHeading } from "../core/trace";
import { renderSessionHtmlFragment, renderSessionMarkdown } from "../core/document";
import {
  ANNOTATION_FILE_RE,
  formatAnnotationValue,
  latestSessionVerdict,
  loadAnnotations,
  parseAnnotationFile,
  specSourceFor,
} from "../core/annotations";

const line = (obj: Record<string, unknown>): string => JSON.stringify(obj);
const base = {
  v: 1,
  producer: "skilltrace-solo",
  target: { source: "copilot-cli", session: "sess-1" },
};

test("ファイル名のパターンは producer 規則どおりのものだけを通す", () => {
  assert.ok(ANNOTATION_FILE_RE.test("ann-skilltrace-solo.jsonl"));
  assert.ok(ANNOTATION_FILE_RE.test("ann-a1.jsonl"));
  assert.ok(!ANNOTATION_FILE_RE.test("README.md"));
  assert.ok(!ANNOTATION_FILE_RE.test("ann-.jsonl"));
  assert.ok(!ANNOTATION_FILE_RE.test("ann-UPPER.jsonl"));
  assert.ok(!ANNOTATION_FILE_RE.test("ann-a--b.jsonl"));
  assert.ok(!ANNOTATION_FILE_RE.test("annotations.jsonl"));
});

test("壊れた行と必須項目の欠けた行は、その行だけ飛ばす", () => {
  const text = [
    line({ ...base, id: "a1", ts: "2026-11-11T01:00:00Z", kind: "verdict", value: "good" }),
    "{not json",
    line({ v: 1, id: "a2", ts: "2026-11-11T01:01:00Z", kind: "note", text: "producer なし" }),
    line({ ...base, id: "a3", ts: "2026-11-11T01:02:00Z", kind: "note", text: "有効" }),
    "",
  ].join("\n");
  const out = parseAnnotationFile(text, "personal");
  assert.deepEqual(out.map(a => a.id), ["a1", "a3"]);
});

test("同じ id は最新の ts が有効になり、retract で取り消される", () => {
  const text = [
    line({ ...base, id: "a1", ts: "2026-11-11T01:00:00Z", kind: "verdict", value: "bad" }),
    line({ ...base, id: "a1", ts: "2026-11-11T02:00:00Z", kind: "verdict", value: "good" }),
    line({ ...base, id: "a2", ts: "2026-11-11T01:30:00Z", kind: "note", text: "消えるメモ" }),
    line({ ...base, id: "a2", ts: "2026-11-11T03:00:00Z", kind: "retract" }),
  ].join("\n");
  const out = parseAnnotationFile(text, "shared");
  assert.equal(out.length, 1);
  assert.equal(out[0].value, "good");
  assert.equal(out[0].scope, "shared");
});

test("turn が指定されているのに正の整数でない行は無効（セッション全体へ化けない）", () => {
  const mk = (turn: unknown) => line({ ...base, id: "t1", ts: "2026-11-11T01:00:00Z", kind: "verdict", value: "good", target: { source: "copilot-cli", session: "sess-1", turn } });
  for (const bad of ["1", 0, -2, 1.5, null, true]) {
    assert.equal(parseAnnotationFile(mk(bad), "personal").length, 0, `turn=${String(bad)} は無効`);
  }
  assert.equal(parseAnnotationFile(mk(2), "personal")[0].turn, 2);
  assert.equal(parseAnnotationFile(line({ ...base, id: "t2", ts: "2026-11-11T01:00:00Z", kind: "verdict", value: "ok" }), "personal")[0].turn, undefined);
});

test("ts はタイムゾーンを考慮した時刻で比べる（改訂判定と並べ替え）", () => {
  // 12:05+09:00 は 03:05Z で、05:00Z より古い。文字列比較だと新しいと誤判定する
  const text = [
    line({ ...base, id: "a1", ts: "2026-11-11T05:00:00Z", kind: "verdict", value: "good" }),
    line({ ...base, id: "a1", ts: "2026-11-11T12:05:00+09:00", kind: "verdict", value: "bad" }),
    line({ ...base, id: "a2", ts: "2026-11-11T04:00:00Z", kind: "note", text: "先" }),
  ].join("\n");
  const out = parseAnnotationFile(text, "personal");
  assert.equal(out.find(a => a.id === "a1")?.value, "good");
  assert.deepEqual(out.map(a => a.id), ["a2", "a1"]);
  // 同じ瞬間の別表記（12:00+09:00 = 03:00Z）では、後方の行が勝つ
  const sameInstant = [
    line({ ...base, id: "b1", ts: "2026-11-11T03:00:00Z", kind: "verdict", value: "bad" }),
    line({ ...base, id: "b1", ts: "2026-11-11T12:00:00+09:00", kind: "verdict", value: "ok" }),
  ].join("\n");
  assert.equal(parseAnnotationFile(sameInstant, "personal")[0].value, "ok");
});

test("ミリ秒未満の差も順序に反映する（新しい retract が古い注釈に負けない）", () => {
  // Date.parse は .123900 と .123100 を同じミリ秒に切り捨てるため、時刻比較が
  // ミリ秒止まりだと、後ろにある古い注釈が新しい retract を上書きして復活する
  const text = [
    line({ ...base, id: "a1", ts: "2026-11-11T00:00:00.123900Z", kind: "retract" }),
    line({ ...base, id: "a1", ts: "2026-11-11T00:00:00.123100Z", kind: "verdict", value: "good" }),
    line({ ...base, id: "a2", ts: "2026-11-11T00:00:00.123100Z", kind: "note", text: "古い方" }),
    line({ ...base, id: "a2", ts: "2026-11-11T00:00:00.123900Z", kind: "note", text: "新しい方" }),
  ].join("\n");
  const out = parseAnnotationFile(text, "personal");
  assert.deepEqual(out.map(a => a.id), ["a2"]);
  assert.equal(out[0].text, "新しい方");
});

test("範囲外・実在しない日時は無効として最も古く扱う（繰り上がりで retract を負かさない）", () => {
  // setUTCHours(99) は翌々日へ繰り上がるため、検証しないと不正な ts が未来扱いになる
  const text = [
    line({ ...base, id: "a1", ts: "2026-11-11T99:00:00Z", kind: "verdict", value: "good" }),
    line({ ...base, id: "a1", ts: "2026-11-12T00:00:00Z", kind: "retract" }),
    line({ ...base, id: "a2", ts: "2026-02-30T00:00:00Z", kind: "note", text: "実在しない日付" }),
    line({ ...base, id: "a2", ts: "2026-02-01T00:00:00Z", kind: "note", text: "有効な方" }),
    line({ ...base, id: "a3", ts: "2026-11-11T00:00:00+99:99", kind: "note", text: "範囲外オフセット" }),
    line({ ...base, id: "a3", ts: "2026-11-10T00:00:00Z", kind: "note", text: "有効な方" }),
  ].join("\n");
  const out = parseAnnotationFile(text, "personal");
  assert.deepEqual(out.map(a => a.id), ["a2", "a3"]);
  assert.ok(out.every(a => a.text === "有効な方"));
});

test("供給源の対応付け", () => {
  assert.equal(specSourceFor(undefined), "copilot-cli");
  assert.equal(specSourceFor("copilot"), "copilot-cli");
  assert.equal(specSourceFor("vscode"), "copilot-vscode");
  assert.equal(specSourceFor("kiro"), "kiro");
});

test("フォルダ群を読み、名前の合わないファイルは開かず、セッションで束ねる", () => {
  const root = mkdtempSync(join(tmpdir(), "skilltrace-ann-"));
  try {
    const personal = join(root, "home-ann");
    const shared = join(root, "ws-ann");
    mkdirSync(personal);
    mkdirSync(shared);
    writeFileSync(join(personal, "ann-skilltrace-solo.jsonl"), [
      line({ ...base, id: "p1", ts: "2026-11-11T01:00:00Z", kind: "verdict", value: "ok" }),
      line({ ...base, id: "p2", ts: "2026-11-11T01:05:00Z", kind: "note", text: "ターンのメモ", target: { source: "copilot-cli", session: "sess-1", turn: 3 } }),
    ].join("\n"));
    writeFileSync(join(personal, "README.md"), "{壊れた JSON でも読まれない");
    writeFileSync(join(shared, "ann-review-tool.jsonl"),
      line({ ...base, id: "s1", ts: "2026-11-11T02:00:00Z", kind: "x-review-tool-score", value: 0.75, value_type: "percent", producer: "review-tool" }));
    const map = loadAnnotations([
      { dir: personal, scope: "personal" },
      { dir: shared, scope: "shared" },
      { dir: join(root, "missing"), scope: "personal" },
    ]);
    const list = map.get("copilot-cli:sess-1");
    assert.ok(list);
    assert.equal(list.length, 3);
    assert.equal(list[2].scope, "shared");
    // セッション全体の verdict はターン対象に影響されず、最新のもの
    assert.equal(latestSessionVerdict(list), "ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("サマリ（Markdown / HTML）に注釈の節が入り、値は型で整形され、本文はエスケープされる", () => {
  const root = join(__dirname, "..", "..", "test-fixtures");
  const workspace = join(root, "workspace");
  const skillDir = join(workspace, ".github", "skills", "phase0-probe");
  const parsed = parseEventsText(readFileSync(join(root, "events.jsonl"), "utf8"));
  const graph = buildGraph(skillDir, workspace);
  const heading = firstHeading(readFileSync(join(skillDir, "SKILL.md"), "utf8"));
  const trace = buildSessionTrace(parsed, [{ graph, skillDirAbs: skillDir, rootHeading: heading }], { sessionId: "fixture", workspaceAbs: workspace });
  trace.annotations = [
    { id: "a1", ts: "2026-11-11T01:00:00Z", producer: "skilltrace-solo", scope: "personal", source: "copilot-cli", session: "fixture", kind: "verdict", value: "good" },
    { id: "a2", ts: "2026-11-11T01:05:00Z", producer: "review-tool", scope: "shared", source: "copilot-cli", session: "fixture", kind: "x-review-tool-score", value: 0.75, valueType: "percent", label: "合格率" },
    { id: "a3", ts: "2026-11-11T01:10:00Z", producer: "skilltrace-solo", scope: "personal", source: "copilot-cli", session: "fixture", turn: 2, kind: "note", text: "<script> 混入チェック" },
  ];
  const md = renderSessionMarkdown(trace, { lang: "ja" });
  assert.ok(md.includes("## 注釈"));
  assert.ok(md.includes("[good]"));
  assert.ok(md.includes("合格率: 75%"));
  assert.ok(md.includes("ターン 2:"));
  const html = renderSessionHtmlFragment(trace, { lang: "ja" });
  assert.ok(html.includes("注釈"));
  assert.ok(html.includes("評価の凡例"));
  assert.ok(html.includes("75%"));
  assert.ok(!html.includes("<script> 混入"));
  assert.ok(html.includes("&lt;script&gt;"));
  // 注釈が無い場合は節自体が出ない（従来表示と同一）
  trace.annotations = undefined;
  assert.ok(!renderSessionMarkdown(trace, { lang: "ja" }).includes("## 注釈"));
});

test("値の型に応じた整形（percent は比率、duration は秒）", () => {
  assert.equal(formatAnnotationValue({ value: 0.756, valueType: "percent" }, "ja"), "75.6%");
  assert.equal(formatAnnotationValue({ value: 1, valueType: "percent" }, "en"), "100%");
  assert.equal(formatAnnotationValue({ value: 1234567, valueType: "number" }, "ja"), "1,234,567");
  assert.equal(formatAnnotationValue({ value: 42, valueType: "number", unit: "credits" }, "en"), "42 credits");
  assert.equal(formatAnnotationValue({ value: 125, valueType: "duration" }, "ja"), "2分5秒");
  assert.equal(formatAnnotationValue({ value: 125, valueType: "duration" }, "en"), "2m 5s");
  assert.equal(formatAnnotationValue({ value: true, valueType: "boolean" }, "ja"), "はい");
  assert.equal(formatAnnotationValue({ value: "不明な型はそのまま", valueType: "x-future" }, "ja"), "不明な型はそのまま");
});
