import test from "node:test";
import assert from "node:assert/strict";
import { renderSkillTotalsHtml } from "../core/report.js";
import type { SkillTotal } from "../core/aggregate.js";

const row = (name: string, dir: string): SkillTotal => ({
  name, dir, sessions: 1, activations: 1,
  kiroSessions: 0, chatSessions: 0, copilotSessions: 1,
  kiroCredits: 0, chatCredits: 0, copilotInputTokens: 10, copilotOutputTokens: 1,
  lastUsedAt: null, lastUsedMs: 0,
});

test("report totals: 短縮名が重なる同名行は完全なフォルダパスで区別される", () => {
  const html = renderSkillTotalsHtml([
    row("alpha", "c:/repo-a/.agents/skills/alpha"),
    row("alpha", "c:/repo-b/.agents/skills/alpha"),
  ], { scanned: 2, skipped: 0 });
  assert.ok(html.includes("alpha (c:/repo-a/.agents/skills/alpha)"), "別ルートの同名行が区別できる");
  assert.ok(html.includes("alpha (c:/repo-b/.agents/skills/alpha)"), "別ルートの同名行が区別できる");
});

test("report totals: 場所不明の行にはファイル別リンクが付かない", () => {
  const html = renderSkillTotalsHtml([
    row("alpha", "c:/repo-a/.agents/skills/alpha"),
    row("alpha", ""),
  ], { scanned: 2, skipped: 0 });
  assert.ok(html.includes("alpha (場所不明)"));
  // 「ファイル別」リンクは、フォルダを特定できる行にだけ付く
  const links = html.match(/showFileUsage/g) ?? [];
  assert.equal(links.length, 1);
  assert.ok(html.includes(encodeURIComponent(JSON.stringify(["alpha", "c:/repo-a/.agents/skills/alpha"]))));
});
