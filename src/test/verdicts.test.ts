import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSkillUsage } from "../core/aggregate";
import type { Annotation } from "../core/annotations";
import { aggregateVerdicts, rankBadSkills } from "../core/verdicts";

const usage = (partial: Partial<SessionSkillUsage>): SessionSkillUsage => ({
  sessionId: "k1",
  source: "kiro",
  at: "2026-11-10T01:00:00.000Z",
  mtimeMs: 1000,
  skills: [{ name: "alpha", activations: 1, lastAt: null }],
  credits: 1,
  ...partial,
});

let seq = 0;
const ann = (partial: Partial<Annotation>): Annotation => ({
  id: `a${++seq}`,
  ts: "2026-11-10T02:00:00.000Z",
  producer: "skilltrace-solo",
  scope: "personal",
  source: "kiro",
  session: "k1",
  kind: "note",
  ...partial,
});

const mapOf = (...lists: Annotation[][]): Map<string, Annotation[]> => {
  const map = new Map<string, Annotation[]>();
  for (const list of lists) {
    if (!list.length) continue;
    map.set(`${list[0].source}:${list[0].session}`, list);
  }
  return map;
};

test("verdicts: セッション評価をスキルごとに数え、上手くいった率を出す", () => {
  const agg = aggregateVerdicts(
    [usage({})],
    mapOf([ann({ kind: "verdict", value: "good" })]),
  );
  assert.equal(agg.hasAnnotations, true);
  assert.equal(agg.skills.length, 1);
  const alpha = agg.skills[0];
  assert.equal(alpha.name, "alpha");
  assert.equal(alpha.good, 1);
  assert.equal(alpha.ok, 0);
  assert.equal(alpha.bad, 0);
  assert.equal(alpha.rated, 1);
  assert.equal(alpha.goodRatio, 1);
  assert.equal(agg.badSessions.length, 0);
});

test("verdicts: 複数スキルが起動したセッションでは、評価も消費も各スキルにそのまま入る（按分なし）", () => {
  const agg = aggregateVerdicts(
    [usage({ skills: [{ name: "alpha", activations: 1, lastAt: null }, { name: "beta", activations: 2, lastAt: null }], credits: 2.5 })],
    mapOf([ann({ kind: "verdict", value: "bad" })]),
  );
  assert.equal(agg.skills.length, 2);
  for (const s of agg.skills) {
    assert.equal(s.bad, 1);
    assert.equal(s.rated, 1);
    assert.equal(s.goodRatio, 0);
    // セッション合計 2.5 が按分されず、両方のスキルに入る
    assert.ok(Math.abs(s.kiroCredits - 2.5) < 1e-9);
  }
  // セッション自体は1件だけが「悪かった」一覧に入る
  assert.equal(agg.badSessions.length, 1);
  assert.deepEqual(agg.badSessions[0].skills, [{ name: "alpha", dir: "" }, { name: "beta", dir: "" }]);
});

test("verdicts: 同じセッションに評価が2つあれば、最新のものだけを数える", () => {
  const agg = aggregateVerdicts(
    [usage({})],
    mapOf([
      ann({ kind: "verdict", value: "good", ts: "2026-11-10T02:00:00.000Z" }),
      ann({ kind: "verdict", value: "bad", ts: "2026-11-10T03:00:00.000Z" }),
    ]),
  );
  const alpha = agg.skills[0];
  assert.equal(alpha.good, 0);
  assert.equal(alpha.bad, 1);
  assert.equal(alpha.rated, 1);
  assert.equal(agg.badSessions.length, 1);
});

test("verdicts: ターン対象の verdict はセッション評価として数えない", () => {
  const agg = aggregateVerdicts(
    [usage({})],
    mapOf([ann({ kind: "verdict", value: "bad", turn: 2 })]),
  );
  assert.equal(agg.skills.length, 0);
  assert.equal(agg.badSessions.length, 0);
  // 注釈自体は存在するので hasAnnotations は立つ
  assert.equal(agg.hasAnnotations, true);
});

test("verdicts: ターン対象のメモはターン番号つきでメモに入り、新しい順に並ぶ", () => {
  const agg = aggregateVerdicts(
    [usage({})],
    mapOf([
      ann({ kind: "note", text: "古いメモ", ts: "2026-11-10T02:00:00.000Z" }),
      ann({ kind: "note", text: "このターンから逸れた", turn: 3, ts: "2026-11-10T04:00:00.000Z" }),
      ann({ kind: "verdict", value: "ok", text: "まあまあ", ts: "2026-11-10T03:00:00.000Z" }),
    ]),
  );
  const alpha = agg.skills[0];
  assert.equal(alpha.memos.length, 3);
  assert.equal(alpha.memos[0].text, "このターンから逸れた");
  assert.equal(alpha.memos[0].turn, 3);
  assert.equal(alpha.memos[1].text, "まあまあ");
  assert.equal(alpha.memos[1].turn, undefined);
  assert.equal(alpha.memos[2].text, "古いメモ");
  // 評価 ok も数える
  assert.equal(alpha.ok, 1);
  assert.equal(alpha.goodRatio, 0);
});

test("verdicts: 「悪かった」セッションは供給源の中で消費の多い順に並ぶ", () => {
  const agg = aggregateVerdicts(
    [
      usage({ sessionId: "k1", credits: 1 }),
      usage({ sessionId: "k2", credits: 5 }),
      usage({ sessionId: "k3", credits: 3 }),
    ],
    mapOf(
      [ann({ session: "k1", kind: "verdict", value: "bad" })],
      [ann({ session: "k2", kind: "verdict", value: "bad" })],
      [ann({ session: "k3", kind: "verdict", value: "bad" })],
    ),
  );
  assert.deepEqual(agg.badSessions.map(s => s.sessionId), ["k2", "k3", "k1"]);
});

test("verdicts: 単位の異なる消費は混ぜない（Kiro クレジットと Copilot トークンは別列）", () => {
  const agg = aggregateVerdicts(
    [
      usage({ sessionId: "k1", credits: 2 }),
      usage({
        sessionId: "c1", source: "copilot", credits: undefined, inputTokens: 100, outputTokens: 40,
        skills: [{ name: "alpha", activations: 1, lastAt: null }],
      }),
    ],
    mapOf(
      [ann({ session: "k1", kind: "verdict", value: "bad" })],
      [ann({ session: "c1", source: "copilot-cli", kind: "verdict", value: "bad" })],
    ),
  );
  const alpha = agg.skills.find(s => s.name === "alpha")!;
  assert.equal(alpha.bad, 2);
  assert.ok(Math.abs(alpha.kiroCredits - 2) < 1e-9);
  assert.equal(alpha.chatCredits, 0);
  assert.equal(alpha.copilotInputTokens, 100);
  assert.equal(alpha.copilotOutputTokens, 40);
  // 供給源ごとにまとまって返る
  assert.deepEqual(agg.badSessions.map(s => s.source), ["kiro", "copilot"]);
});

test("verdicts: 注釈が無ければ空の集計（hasAnnotations は false）", () => {
  const agg = aggregateVerdicts([usage({})], new Map());
  assert.equal(agg.hasAnnotations, false);
  assert.deepEqual(agg.skills, []);
  assert.deepEqual(agg.badSessions, []);
});

test("verdicts: 評価が無くメモだけのスキルは goodRatio が null", () => {
  const agg = aggregateVerdicts(
    [usage({})],
    mapOf([ann({ kind: "note", text: "様子見メモ" })]),
  );
  const alpha = agg.skills[0];
  assert.equal(alpha.rated, 0);
  assert.equal(alpha.goodRatio, null);
  assert.equal(alpha.memos.length, 1);
  assert.equal(alpha.memos[0].text, "様子見メモ");
});

test("verdicts: rankBadSkills は悪かった件数→消費の順で並べ、悪かったの無いスキルを除く", () => {
  const base = { ok: 0, goodRatio: null, memos: [] as never[], dir: "" };
  const ranked = rankBadSkills([
    { ...base, name: "few", good: 0, bad: 1, rated: 3, kiroCredits: 99, chatCredits: 0, copilotInputTokens: 0, copilotOutputTokens: 0 },
    { ...base, name: "many-light", good: 0, bad: 2, rated: 2, kiroCredits: 1, chatCredits: 0, copilotInputTokens: 0, copilotOutputTokens: 0 },
    { ...base, name: "many-heavy", good: 0, bad: 2, rated: 4, kiroCredits: 7, chatCredits: 0, copilotInputTokens: 0, copilotOutputTokens: 0 },
    { ...base, name: "clean", good: 3, bad: 0, rated: 3, kiroCredits: 0, chatCredits: 0, copilotInputTokens: 0, copilotOutputTokens: 0 },
  ]);
  assert.deepEqual(ranked.map(s => s.name), ["many-heavy", "many-light", "few"]);
});
