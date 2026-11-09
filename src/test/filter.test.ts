import { test } from "node:test";
import assert from "node:assert/strict";
import { filterSessionsToWorkspace, sessionMatchesWorkspace, type SessionInfo } from "../core/sessions.js";

function s(partial: Partial<SessionInfo>): SessionInfo {
  return {
    id: partial.id ?? "s1",
    dir: "/sessions/s1",
    eventsPath: "/sessions/s1/events.jsonl",
    mtimeMs: 1,
    workspaceHint: null,
    ...partial,
  };
}

test("workspace filter matches exact, child and parent paths (Issue #44)", () => {
  const roots = ["/work/proj"];
  assert.equal(sessionMatchesWorkspace(s({ workspaceHint: "/work/proj" }), roots), true);
  assert.equal(sessionMatchesWorkspace(s({ workspaceHint: "/work/proj/sub" }), roots), true);
  assert.equal(sessionMatchesWorkspace(s({ workspaceHint: "/work" }), roots), true);
  // 名前が似ているだけの別フォルダーは一致しない
  assert.equal(sessionMatchesWorkspace(s({ workspaceHint: "/work/proj2" }), roots), false);
  assert.equal(sessionMatchesWorkspace(s({ workspaceHint: "/elsewhere/proj" }), roots), false);
});

test("workspace filter uses Kiro workspacePaths and excludes unknown sessions (Issue #44)", () => {
  const roots = ["/work/b"];
  // マルチルート: 2番目のルートでも一致する
  assert.equal(sessionMatchesWorkspace(s({ source: "kiro", workspaceHint: "/work/a", workspacePaths: ["/work/a", "/work/b"] }), roots), true);
  // ワークスペースが記録から分からないセッションは、確実とは言えないため除く
  assert.equal(sessionMatchesWorkspace(s({ workspaceHint: null }), roots), false);
  assert.equal(sessionMatchesWorkspace(s({ source: "kiro", workspaceHint: null, workspacePaths: [] }), roots), false);
  // 開いているフォルダーが無い場合は何も一致しない
  assert.equal(sessionMatchesWorkspace(s({ workspaceHint: "/work/b" }), []), false);
});

test("filterSessionsToWorkspace keeps only related sessions, order preserved (Issue #44)", () => {
  const list = [
    s({ id: "a", workspaceHint: "/work/proj" }),
    s({ id: "b", workspaceHint: "/other" }),
    s({ id: "c", workspaceHint: null }),
    s({ id: "d", workspaceHint: "/work/proj/deep/nest" }),
  ];
  assert.deepEqual(filterSessionsToWorkspace(list, ["/work/proj"]).map(x => x.id), ["a", "d"]);
});
