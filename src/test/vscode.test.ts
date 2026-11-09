import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { buildGraph } from "../core/graph";
import {
  buildVSCodeSessionTrace, listVSCodeChatSessions, parseVSCodeChatSessionText, scanVSCodeActivationNames,
} from "../core/vscode";
import { firstHeading } from "../core/trace";
import { renderSessionHtml } from "../core/report";
import { renderSessionMarkdown } from "../core/document";

// フィクスチャは実機プローブ（2026-11-09、職場の VS Code で vscode-probe を実行）の
// 本物の chatSessions 記録。パス内のユーザー ID だけを probe-user に置換してある。
// 正解値: 1リクエスト、読み取りは SKILL.md（スキルとして）→ level1 → level2、
// promptTokens 15903 / completionTokens 391 / copilotCredits 0.238554…、
// モデルの入力上限 871793。
const root = join(__dirname, "..", "..", "test-fixtures");
const chatFile = join(root, "vscode-chatsessions", "vscode-chatsession.jsonl");
const probeWs = join(root, "vscode-probe", "workspace");
const probeSkillDir = join(probeWs, ".github", "skills", "vscode-probe");
const chatText = () => readFileSync(chatFile, "utf8");

test("vscode chat sessions are listed from the workspaceStorage layout", () => {
  const sessions = listVSCodeChatSessions(join(root, "vscode-storage"));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "d890f00a-d00b-4416-bac4-bee9afd819f7");
  assert.equal(sessions[0].source, "vscode");
  assert.equal(sessions[0].title, "vscode-probe 合言葉取得");
  assert.ok(sessions[0].workspaceHint?.endsWith("vscode-probe-workspace/vscode-probe-workspace"));
  // リクエストの無い「開いただけ」のセッションファイルは列挙されない
  assert.ok(!sessions.some(x => x.id.startsWith("eeeeeeee")));
});

test("vscode delta log replays into requests with reads and usage", () => {
  const parsed = parseVSCodeChatSessionText(chatText());
  assert.equal(parsed.sessionId, "d890f00a-d00b-4416-bac4-bee9afd819f7");
  assert.equal(parsed.title, "vscode-probe 合言葉取得");
  assert.equal(parsed.contextTokenLimit, 871793);
  assert.equal(parsed.requests.length, 1);
  const req = parsed.requests[0];
  assert.equal(req.userMessage, "vscode-probe スキルを使って、合言葉を教えてください");
  assert.equal(req.promptTokens, 15903);
  assert.equal(req.completionTokens, 391);
  assert.ok(Math.abs(req.credits - 0.238554) < 1e-9);
  assert.deepEqual(req.tools.map(t => t.toolId), ["manage_todo_list", "copilot_readFile", "copilot_readFile", "copilot_readFile"]);
  const reads = req.tools.filter(t => t.readPath);
  assert.equal(reads.length, 3);
  assert.ok(reads[0].readPath?.endsWith("/.github/skills/vscode-probe/SKILL.md"));
  assert.equal(reads[0].skillRead, true);
  assert.ok(reads[1].readPath?.endsWith("/references/level1.md"));
  assert.ok(reads[2].readPath?.endsWith("/references/level2.md"));
  assert.deepEqual(parsed.activations.map(a => a.name), ["vscode-probe"]);
});

test("vscode replay: kind 1/2 entries set values at key paths on the header snapshot", () => {
  const text = [
    JSON.stringify({ kind: 0, v: { version: 3, creationDate: 1000, sessionId: "s1", requests: [], inputState: { inputText: "x" } } }),
    JSON.stringify({ kind: 1, k: ["customTitle"], v: "題" }),
    JSON.stringify({ kind: 2, k: ["requests"], v: [{ requestId: "r1", timestamp: 2000, message: { text: "hi" }, response: [], promptTokens: 10, completionTokens: 2, copilotCredits: 0.5 }] }),
    JSON.stringify({ kind: 1, k: ["inputState", "inputText"], v: "" }),
  ].join("\n");
  const parsed = parseVSCodeChatSessionText(text);
  assert.equal(parsed.title, "題");
  assert.equal(parsed.requests.length, 1);
  assert.equal(parsed.requests[0].promptTokens, 10);
  assert.equal(parsed.health.parsedLines, 4);
});

test("vscode activation scan reads skill names from the raw record", () => {
  assert.deepEqual(scanVSCodeActivationNames(chatFile), ["vscode-probe"]);
  assert.equal(scanVSCodeActivationNames(join(root, "does-not-exist.jsonl")), null);
});

function fixtureTrace() {
  const parsed = parseVSCodeChatSessionText(chatText());
  const graph = buildGraph(probeSkillDir, probeWs);
  const heading = firstHeading(readFileSync(join(probeSkillDir, "SKILL.md"), "utf8"));
  const st = buildVSCodeSessionTrace(parsed, [{ graph, skillDirAbs: probeSkillDir, rootHeading: heading }], { sessionId: "vscode-chatsession", workspaceAbs: probeWs });
  return { parsed, st };
}

test("vscode session trace: skill read is grade A, file reads are grade B, in recorded order", () => {
  const { st } = fixtureTrace();
  assert.equal(st.source, "vscode");
  assert.equal(st.skills.length, 1);
  assert.equal(st.skills[0].skillName, "vscode-probe");
  const byName = new Map(st.skills[0].nodes.map(n => [n.name, n]));
  assert.equal(byName.get("SKILL.md")?.grade, "A");
  assert.equal(byName.get("SKILL.md")?.order, 1);
  assert.equal(byName.get("level1.md")?.grade, "B");
  assert.equal(byName.get("level1.md")?.order, 2);
  assert.equal(byName.get("level2.md")?.grade, "B");
  assert.equal(byName.get("level2.md")?.order, 3);
  assert.equal(st.outsideReads.length, 0);
  assert.deepEqual(st.undiscoveredSkills, []);
});

test("vscode session trace: tokens, credits and context fill come from the record", () => {
  const { st } = fixtureTrace();
  assert.equal(st.totals.inputTokens, 15903);
  assert.equal(st.totals.outputTokens, 391);
  assert.ok(Math.abs((st.creditsTotal ?? 0) - 0.238554) < 1e-9);
  assert.equal(st.creditTurns?.length, 1);
  assert.deepEqual(st.creditTurns?.[0].usedTools, ["manage_todo_list", "copilot_readFile", "copilot_readFile", "copilot_readFile"]);
  assert.equal(st.contextTokenLimit, 871793);
  assert.equal(st.lastContextCurrentTokens, 15903);
  assert.ok(Math.abs((st.contextFillRatio ?? 0) - 15903 / 871793) < 1e-9);
});

test("vscode summaries show both token usage and credit usage", () => {
  const { st } = fixtureTrace();
  const html = renderSessionHtml(st);
  assert.ok(html.includes("トークン実測"));
  assert.ok(html.includes("クレジット実測"));
  const md = renderSessionMarkdown(st);
  assert.ok(md.includes("クレジット実測"));
  assert.ok(md.includes("| 1 | 0.24 | 3 | 1 |"));
});

test("vscode replay: kind 2 appends to arrays, and i truncates before appending", () => {
  const req = (id: string) => ({ requestId: id, timestamp: 2000, message: { text: id }, response: [], promptTokens: 1, completionTokens: 1, copilotCredits: 0 });
  const header = JSON.stringify({ kind: 0, v: { version: 3, creationDate: 1000, sessionId: "s2", requests: [] } });
  const appended = parseVSCodeChatSessionText([
    header,
    JSON.stringify({ kind: 2, k: ["requests"], v: [req("r1")] }),
    JSON.stringify({ kind: 2, k: ["requests"], v: [req("r2")] }),
  ].join("\n"));
  assert.deepEqual(appended.requests.map(r => r.userMessage), ["r1", "r2"]);
  const truncated = parseVSCodeChatSessionText([
    header,
    JSON.stringify({ kind: 2, k: ["requests"], v: [req("r1"), req("r2")] }),
    JSON.stringify({ kind: 2, k: ["requests"], v: [req("r3")], i: 1 }),
  ].join("\n"));
  assert.deepEqual(truncated.requests.map(r => r.userMessage), ["r1", "r3"]);
});

test("vscode activations keep the skill directory's letter case", () => {
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
    JSON.stringify({ kind: 0, v: { version: 3, creationDate: 1000, sessionId: "s3", requests: [] } }),
    JSON.stringify({ kind: 2, k: ["requests"], v: [{ requestId: "r1", timestamp: 2000, message: { text: "hi" }, response: [part], promptTokens: 1, completionTokens: 1, copilotCredits: 0 }] }),
  ].join("\n");
  const parsed = parseVSCodeChatSessionText(text);
  assert.deepEqual(parsed.activations.map(a => a.name), ["MySkill"]);
});

test("vscode replay: dangerous keys in delta paths never touch Object.prototype", () => {
  const text = [
    JSON.stringify({ kind: 0, v: { version: 3, creationDate: 1000, sessionId: "s4", requests: [] } }),
    JSON.stringify({ kind: 1, k: ["__proto__", "polluted"], v: "yes" }),
    JSON.stringify({ kind: 1, k: ["constructor", "prototype", "polluted"], v: "yes" }),
    JSON.stringify({ kind: 2, k: ["__proto__"], v: [{ polluted: "yes" }] }),
    JSON.stringify({ kind: 1, k: ["customTitle"], v: "通常の更新は通る" }),
  ].join("\n");
  const parsed = parseVSCodeChatSessionText(text);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
  assert.equal(parsed.title, "通常の更新は通る");
  assert.equal(parsed.requests.length, 0);
});
