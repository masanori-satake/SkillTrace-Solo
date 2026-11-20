import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HEADING_PREFIX_BYTES, MAX_GRAPH_FILE_BYTES, MAX_RECORD_BYTES,
  isFileWithinLimit, readFilePrefix, readTextFileWithinLimit,
} from "../core/readfile";
import { readOutsideTitle } from "../core/trace";
import { buildGraph } from "../core/graph";
import { scanInvokedSkillNames, type SessionInfo } from "../core/sessions";
import { parseKiroMessagesFile, scanKiroActivationNames } from "../core/kiro";
import { parseVSCodeChatSessionFile, scanVSCodeActivationNames } from "../core/vscode";
import { parseEventsFile } from "../core/events";
import { aggregateSessionFile } from "../core/aggregate";
import { extractSessionFileUsage } from "../core/fileusage";
import { loadAnnotations } from "../core/annotations";

/** 中身を書かずにサイズだけ大きいファイルを作る（stat のサイズで判定される経路の確認用） */
function sparseFile(dir: string, name: string, size: number): string {
  const p = join(dir, name);
  writeFileSync(p, "");
  truncateSync(p, size);
  return p;
}

function withTempDir(fn: (dir: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "skilltrace-readfile-"));
    try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

test("readTextFileWithinLimit: reads small files, rejects oversized / non-regular / missing", withTempDir((dir) => {
  const p = join(dir, "a.txt");
  writeFileSync(p, "hello", "utf8");
  assert.equal(readTextFileWithinLimit(p, 100), "hello");
  assert.equal(readTextFileWithinLimit(p, 4), null);
  assert.equal(readTextFileWithinLimit(dir, 100), null);
  assert.equal(readTextFileWithinLimit(join(dir, "missing.txt"), 100), null);
  assert.equal(isFileWithinLimit(p, 5), true);
  assert.equal(isFileWithinLimit(p, 4), false);
  assert.equal(isFileWithinLimit(dir, 100), false);
}));

test("readFilePrefix: returns only the head of the file", withTempDir((dir) => {
  const p = join(dir, "a.txt");
  writeFileSync(p, "0123456789", "utf8");
  assert.equal(readFilePrefix(p, 4), "0123");
  assert.equal(readFilePrefix(p, 100), "0123456789");
  assert.equal(readFilePrefix(dir, 4), null);
}));

test("readOutsideTitle: reads the first heading from the head of the file only (audit F4)", withTempDir((dir) => {
  const withHeading = join(dir, "headed.md");
  writeFileSync(withHeading, "# Outside Title\n\nbody\n", "utf8");
  assert.equal(readOutsideTitle(withHeading), "Outside Title");

  // 見出しが先頭 HEADING_PREFIX_BYTES の外にあるものは拾わない（全文読みをしない）
  const lateHeading = join(dir, "late.md");
  writeFileSync(lateHeading, "x".repeat(HEADING_PREFIX_BYTES + 16) + "\n# Late Title\n", "utf8");
  assert.equal(readOutsideTitle(lateHeading), null);

  // 相対パスと通常ファイルでないものは対象外
  assert.equal(readOutsideTitle("relative/path.md"), null);
  assert.equal(readOutsideTitle(dir), null);
}));

test("oversized record files are treated as unreadable at every entry point (audit F3)", withTempDir(async (dir) => {
  const big = sparseFile(dir, "big.jsonl", MAX_RECORD_BYTES + 1);
  const info: SessionInfo = { id: "big", dir, eventsPath: big, mtimeMs: 0, workspaceHint: null };
  assert.throws(() => parseVSCodeChatSessionFile(big));
  assert.equal(scanVSCodeActivationNames(big), null);
  assert.equal(scanKiroActivationNames(big), null);
  assert.equal(scanInvokedSkillNames(big, []), null);
  await assert.rejects(parseKiroMessagesFile(big));
  await assert.rejects(parseEventsFile(big));
  assert.equal(aggregateSessionFile(info), null);
  assert.equal(extractSessionFileUsage(info), null);
}));

test("parseVSCodeChatSessionFile still parses a small record file (audit F3 positive control)", withTempDir((dir) => {
  const p = join(dir, "small.jsonl");
  writeFileSync(p, JSON.stringify({ kind: 0, v: { sessionId: "x", creationDate: 1, requests: [] } }) + "\n", "utf8");
  assert.equal(parseVSCodeChatSessionFile(p).sessionId, "x");
}));

test("loadAnnotations skips an oversized annotation file but keeps valid ones (audit F3)", withTempDir((dir) => {
  sparseFile(dir, "ann-big.jsonl", MAX_RECORD_BYTES + 1);
  const line = JSON.stringify({
    v: 1, id: "a1", ts: "2026-11-11T01:00:00Z", kind: "note", text: "有効",
    producer: "skilltrace-solo", target: { source: "copilot-cli", session: "sess-1" },
  });
  writeFileSync(join(dir, "ann-skilltrace-solo.jsonl"), line + "\n", "utf8");
  const map = loadAnnotations([{ dir, scope: "personal" }]);
  const all = [...map.values()].flat();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, "a1");
}));

test("buildGraph treats an oversized referenced file as missing (audit F4)", withTempDir((dir) => {
  const skillDir = join(dir, "skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# Skill\n\n[big](big.md)\n[small](small.md)\n", "utf8");
  sparseFile(skillDir, "big.md", MAX_GRAPH_FILE_BYTES + 1);
  writeFileSync(join(skillDir, "small.md"), "# Small\n", "utf8");
  const graph = buildGraph(skillDir, dir);
  const big = graph.order.find(n => n.name === "big.md");
  const small = graph.order.find(n => n.name === "small.md");
  assert.ok(big);
  assert.equal(big.missing, true);
  assert.ok(small);
  assert.equal(small.missing, false);
  assert.equal(small.title, "Small");
}));

test("special files (FIFO) are rejected without blocking on open (audit follow-up)", { timeout: 15_000 }, async () => {
  if (process.platform === "win32") return; // FIFO の作法は POSIX のみ
  const dir = mkdtempSync(join(tmpdir(), "skilltrace-readfile-"));
  try {
    const fifo = join(dir, "pipe");
    execFileSync("mkfifo", [fifo]);
    // 書き手のいない FIFO を通常の open で開くと待機してしまう。O_NONBLOCK で
    // 開いて fd の種別を確認するため、どちらも即座に null を返す
    assert.equal(readTextFileWithinLimit(fifo, 100), null);
    assert.equal(readFilePrefix(fifo, 100), null);
    assert.equal(readOutsideTitle(fifo), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("parseEventsFile parses a small record file, counting raw bytes (audit follow-up)", withTempDir(async (dir) => {
  const p = join(dir, "events.jsonl");
  const lines = [
    JSON.stringify({ type: "session.start", timestamp: "2026-11-18T01:00:00Z", data: {} }),
    JSON.stringify({ type: "user.message", timestamp: "2026-11-18T01:00:01Z", data: { content: "日本語の依頼です" } }),
  ];
  writeFileSync(p, lines.join("\n") + "\n", "utf8");
  const parsed = await parseEventsFile(p);
  assert.equal(parsed.startedAt, "2026-11-18T01:00:00Z");
  assert.equal(parsed.firstUserMessage, "日本語の依頼です");
  assert.equal(parsed.health.parsedLines, 2);
}));

test("parseKiroMessagesFile still parses a small record file (audit follow-up positive control)", withTempDir(async (dir) => {
  const p = join(dir, "messages.jsonl");
  copyFileSync(join(__dirname, "..", "..", "test-fixtures", "kiro-messages.jsonl"), p);
  const parsed = await parseKiroMessagesFile(p);
  assert.deepEqual(parsed.activations.map(a => a.name), ["kiro-probe"]);
  assert.equal(parsed.health.skippedLines, 0);
}));
