import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateCopilotSessionText,
  aggregateKiroSessionText,
  aggregateVSCodeSessionText,
  mergeSkillTotals,
} from "../core/aggregate";

test("aggregate copilot: skill.invoked の名前で数え、usage_record を積算する", () => {
  const lines = [
    { type: "session.start", timestamp: "2026-11-09T01:00:00.000Z", data: { sessionId: "s1" } },
    { type: "skill.invoked", timestamp: "2026-11-09T01:00:10.000Z", data: { name: "alpha", path: "C:/w/.github/skills/alpha/SKILL.md" } },
    { type: "skill.invoked", timestamp: "2026-11-09T01:05:00.000Z", data: { name: "alpha", path: "C:/w/.github/skills/alpha/SKILL.md" } },
    { type: "skill.invoked", timestamp: "2026-11-09T01:06:00.000Z", data: { name: "beta", path: "C:/w/.github/skills/beta/SKILL.md" } },
    { type: "session.usage_record", timestamp: "2026-11-09T01:07:00.000Z", data: { inputTokens: 100, outputTokens: 10 } },
    { type: "session.usage_record", timestamp: "2026-11-09T01:08:00.000Z", data: { inputTokens: 50, outputTokens: 5 } },
  ].map(o => JSON.stringify(o)).join("\n");
  const u = aggregateCopilotSessionText(lines, { sessionId: "s1", mtimeMs: 123 });
  assert.equal(u.source, "copilot");
  assert.equal(u.at, "2026-11-09T01:00:00.000Z");
  assert.deepEqual(u.skills, [
    { name: "alpha", activations: 2, lastAt: "2026-11-09T01:05:00.000Z" },
    { name: "beta", activations: 1, lastAt: "2026-11-09T01:06:00.000Z" },
  ]);
  assert.equal(u.inputTokens, 150);
  assert.equal(u.outputTokens, 15);
});

test("aggregate kiro: disclose_context を数え、usage_summary のクレジットを積算する", () => {
  const env = (timestamp: string, payload: Record<string, unknown>) => JSON.stringify({ id: "x", timestamp, payload });
  const text = [
    env("2026-11-09T02:00:00.000Z", { type: "tool_call", actionType: "disclose_context", args: { name: "alpha" }, toolCallId: "t1" }),
    env("2026-11-09T02:01:00.000Z", { type: "tool_call", actionType: "disclose_context", args: { name: "alpha" }, toolCallId: "t2" }),
    env("2026-11-09T02:02:00.000Z", { type: "usage_summary", promptTurnSummaries: [{ usage: 0.5, usedTools: [] }, { usage: 0.25, usedTools: [] }] }),
  ].join("\n");
  const u = aggregateKiroSessionText(text, { sessionId: "k1", mtimeMs: 456 });
  assert.equal(u.source, "kiro");
  assert.deepEqual(u.skills, [{ name: "alpha", activations: 2, lastAt: "2026-11-09T02:01:00.000Z" }]);
  assert.ok(Math.abs((u.credits ?? 0) - 0.75) < 1e-9);
});

test("aggregate vscode: スキル読み取りを有無で数え、リクエストのクレジットを積算する", () => {
  const uri = "file:///c%3A/work/.github/skills/MySkill/SKILL.md?vscodeLinkType%3Dskill";
  const part = {
    kind: "toolInvocationSerialized", toolId: "copilot_readFile", toolCallId: "c1", isComplete: true,
    startedAt: 3000, completedAt: 3001,
    invocationMessage: {
      value: `Reading skill [MySkill](${uri})`,
      uris: { [decodeURIComponent(uri)]: { $mid: 1, path: "/c:/work/.github/skills/MySkill/SKILL.md", scheme: "file", query: "vscodeLinkType=skill" } },
    },
  };
  const text = [
    JSON.stringify({ kind: 0, v: { version: 3, creationDate: 1000, sessionId: "v1", requests: [] } }),
    JSON.stringify({ kind: 2, k: ["requests"], v: [{ requestId: "r1", timestamp: 2000, message: { text: "hi" }, response: [part], promptTokens: 100, completionTokens: 5, copilotCredits: 0.5 }] }),
    JSON.stringify({ kind: 2, k: ["requests"], v: [{ requestId: "r2", timestamp: 4000, message: { text: "more" }, response: [], promptTokens: 50, completionTokens: 2, copilotCredits: 0.25 }] }),
  ].join("\n");
  const u = aggregateVSCodeSessionText(text, { sessionId: "v1", mtimeMs: 789 });
  assert.equal(u.source, "vscode");
  assert.deepEqual(u.skills, [{ name: "MySkill", activations: 1, lastAt: "1970-01-01T00:00:03.000Z" }]);
  assert.ok(Math.abs((u.credits ?? 0) - 0.75) < 1e-9);
});

test("merge: 供給源を混ぜずに寄せ、セッション消費は各スキルにセッション合計で入る", () => {
  const rows = mergeSkillTotals([
    { sessionId: "k1", source: "kiro", at: "2026-11-09T02:00:00.000Z", mtimeMs: 2000, skills: [{ name: "alpha", activations: 2, lastAt: "2026-11-09T03:30:00.000Z" }, { name: "beta", activations: 1, lastAt: null }], credits: 0.75 },
    { sessionId: "s1", source: "copilot", at: "2026-11-09T01:00:00.000Z", mtimeMs: 1000, skills: [{ name: "alpha", activations: 1, lastAt: "2026-11-09T01:30:00.000Z" }], inputTokens: 150, outputTokens: 15 },
    { sessionId: "v1", source: "vscode", at: null, mtimeMs: Date.parse("2026-11-10T00:00:00.000Z"), skills: [{ name: "beta", activations: 1, lastAt: null }], credits: 0.5 },
  ]);
  assert.equal(rows.length, 2);
  const alpha = rows.find(r => r.name === "alpha")!;
  const beta = rows.find(r => r.name === "beta")!;
  // 並び: セッション数 2 で同点 → 起動回数 alpha 3 > beta 2 で alpha が先
  assert.equal(rows[0].name, "alpha");
  assert.equal(alpha.sessions, 2);
  assert.equal(alpha.activations, 3);
  assert.equal(alpha.kiroSessions, 1);
  assert.equal(alpha.copilotSessions, 1);
  assert.equal(alpha.chatSessions, 0);
  assert.ok(Math.abs(alpha.kiroCredits - 0.75) < 1e-9);
  assert.equal(alpha.chatCredits, 0);
  assert.equal(alpha.copilotInputTokens, 150);
  assert.equal(alpha.copilotOutputTokens, 15);
  // 最終利用はセッション開始時刻ではなく、スキル自体の最後の起動時刻（03:30）
  assert.equal(alpha.lastUsedAt, "2026-11-09T03:30:00.000Z");
  // beta は Kiro セッションと Chat セッションに現れ、Kiro の消費 0.75 は
  // セッション合計として beta にも入る（按分しない仕様）
  assert.equal(beta.sessions, 2);
  assert.ok(Math.abs(beta.kiroCredits - 0.75) < 1e-9);
  assert.ok(Math.abs(beta.chatCredits - 0.5) < 1e-9);
  assert.equal(beta.copilotInputTokens, 0);
  // 開始時刻が無いセッションは更新時刻で最終利用を判定する
  assert.equal(beta.lastUsedMs, Date.parse("2026-11-10T00:00:00.000Z"));
  assert.equal(beta.lastUsedAt, "2026-11-10T00:00:00.000Z");
});
