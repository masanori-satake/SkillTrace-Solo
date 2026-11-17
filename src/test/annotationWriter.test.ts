import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ANNOTATION_FILE_RE,
  latestSessionVerdict,
  loadAnnotations,
  type AnnotationScope,
} from "../core/annotations";
import {
  ANNOTATION_PRODUCER,
  appendAnnotationRecord,
  buildNoteRecord,
  buildRetractRecord,
  buildVerdictRecord,
  formatAnnotationTs,
  isOwnAnnotation,
  locateOwnAnnotationDir,
  ownAnnotationFileName,
  personalAnnotationDir,
  sharedAnnotationDir,
} from "../core/annotationWriter";
import { ANNOTATION_DIR_NAME } from "../core/annotations";

const TARGET = { source: "copilot-cli", session: "sess-1" };
const T0 = new Date(2026, 10, 18, 10, 0, 0, 0);
const T1 = new Date(2026, 10, 18, 11, 0, 0, 0);
const T2 = new Date(2026, 10, 18, 12, 0, 0, 0);

function dirsOf(root: string): { personal: string; shared: string; list: { dir: string; scope: AnnotationScope }[] } {
  const personal = join(root, "home", ANNOTATION_DIR_NAME);
  const shared = join(root, "ws", ANNOTATION_DIR_NAME);
  return {
    personal,
    shared,
    list: [
      { dir: personal, scope: "personal" },
      { dir: shared, scope: "shared" },
    ],
  };
}

test("ts はタイムゾーン付き ISO 8601 で書かれる", () => {
  const ts = formatAnnotationTs(new Date(2026, 10, 18, 10, 5, 6, 789));
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  assert.ok(!Number.isNaN(Date.parse(ts)));
});

test("自分のファイル名は命名規則に一致し、置き場所は仕様どおり", () => {
  assert.equal(ownAnnotationFileName(), "ann-skilltrace-solo.jsonl");
  assert.ok(ANNOTATION_FILE_RE.test(ownAnnotationFileName()));
  assert.ok(personalAnnotationDir().endsWith(ANNOTATION_DIR_NAME));
  assert.equal(sharedAnnotationDir("/ws/root"), join("/ws/root", ANNOTATION_DIR_NAME));
});

test("評価を追記すると、既存の読み取り口でセッション評価として反映される", () => {
  const root = mkdtempSync(join(tmpdir(), "skilltrace-annw-"));
  try {
    const { personal, list } = dirsOf(root);
    const rec = buildVerdictRecord(
      { target: TARGET, value: "good", text: "一発で意図どおりに直った" },
      { now: T0, producerVersion: "1.15.0" },
    );
    // レコードの形（仕様 §3）: 必須フィールドと producer の一致
    assert.equal(rec.v, 1);
    assert.equal(rec.producer, ANNOTATION_PRODUCER);
    assert.equal(rec.producer_version, "1.15.0");
    assert.equal(typeof rec.id, "string");
    const file = appendAnnotationRecord(personal, rec);
    assert.equal(file, join(personal, "ann-skilltrace-solo.jsonl"));
    // 1 行 = 1 オブジェクトの完全な JSON で、末尾に改行がある
    const raw = readFileSync(file, "utf8");
    assert.ok(raw.endsWith("\n"));
    assert.equal(raw.trim().split("\n").length, 1);
    assert.deepEqual(JSON.parse(raw.trim()).target, TARGET);

    const map = loadAnnotations(list);
    const anns = map.get("copilot-cli:sess-1");
    assert.ok(anns);
    assert.equal(anns.length, 1);
    assert.equal(anns[0].scope, "personal");
    assert.equal(latestSessionVerdict(anns), "good");
    assert.equal(anns[0].text, "一発で意図どおりに直った");
    assert.ok(isOwnAnnotation(anns[0]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("改訂は同じ id の新しい行で、最新の評価だけが有効になる（既存行は書き換えない）", () => {
  const root = mkdtempSync(join(tmpdir(), "skilltrace-annw-"));
  try {
    const { personal, list } = dirsOf(root);
    const first = buildVerdictRecord({ target: TARGET, value: "bad" }, { now: T0 });
    appendAnnotationRecord(personal, first);
    const before = readFileSync(join(personal, "ann-skilltrace-solo.jsonl"), "utf8");

    const revision = buildVerdictRecord(
      { target: TARGET, value: "good", text: "見直したら十分だった" },
      { now: T1, id: first.id as string },
    );
    appendAnnotationRecord(personal, revision);

    const after = readFileSync(join(personal, "ann-skilltrace-solo.jsonl"), "utf8");
    assert.ok(after.startsWith(before), "既存行はそのまま残る（追記専用）");
    assert.equal(after.trim().split("\n").length, 2);

    const anns = loadAnnotations(list).get("copilot-cli:sess-1");
    assert.ok(anns);
    assert.equal(anns.length, 1, "改訂前の行は有効な注釈として残らない");
    assert.equal(latestSessionVerdict(anns), "good");
    assert.equal(anns[0].text, "見直したら十分だった");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retract を追記すると注釈が消える", () => {
  const root = mkdtempSync(join(tmpdir(), "skilltrace-annw-"));
  try {
    const { personal, list } = dirsOf(root);
    const rec = buildNoteRecord({ target: TARGET, text: "消えるメモ" }, { now: T0 });
    appendAnnotationRecord(personal, rec);
    let anns = loadAnnotations(list).get("copilot-cli:sess-1");
    assert.equal(anns?.length, 1);

    const loaded = anns![0];
    appendAnnotationRecord(personal, buildRetractRecord(loaded, { now: T1 }));
    anns = loadAnnotations(list).get("copilot-cli:sess-1");
    assert.equal(anns, undefined, "取り消した注釈は束ね結果からも消える");
    // ファイル自体には両方の行が残る（履歴を消すのではない）
    const raw = readFileSync(join(personal, "ann-skilltrace-solo.jsonl"), "utf8");
    assert.equal(raw.trim().split("\n").length, 2);
    assert.ok(raw.includes('"retract"'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("別の producer のファイルが同じフォルダにあっても、両方読める（自分のファイルにだけ書く）", () => {
  const root = mkdtempSync(join(tmpdir(), "skilltrace-annw-"));
  try {
    const { personal, list } = dirsOf(root);
    mkdirSync(personal, { recursive: true });
    const otherLine = JSON.stringify({
      v: 1, id: "manual-1", ts: "2026-11-18T01:00:00Z", producer: "manual-notes",
      target: { source: "copilot-cli", session: "sess-1" }, kind: "note", text: "手書きの注釈",
    });
    writeFileSync(join(personal, "ann-manual-notes.jsonl"), `${otherLine}\n`, "utf8");

    appendAnnotationRecord(personal, buildVerdictRecord({ target: TARGET, value: "ok" }, { now: T0 }));

    const anns = loadAnnotations(list).get("copilot-cli:sess-1");
    assert.ok(anns);
    assert.equal(anns.length, 2);
    assert.deepEqual(anns.map(a => a.producer).sort(), ["manual-notes", "skilltrace-solo"]);
    assert.equal(latestSessionVerdict(anns), "ok");
    // 他者のファイルは変更されていない
    assert.equal(readFileSync(join(personal, "ann-manual-notes.jsonl"), "utf8"), `${otherLine}\n`);
    // フォルダにできたファイルは自分のものだけ
    assert.deepEqual(readdirSync(personal).sort(), ["ann-manual-notes.jsonl", "ann-skilltrace-solo.jsonl"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("セッション記録ファイルには一切書き込まれない", () => {
  const root = mkdtempSync(join(tmpdir(), "skilltrace-annw-"));
  try {
    const { personal, shared, list } = dirsOf(root);
    const sessionDir = join(root, "session-state", "sess-1");
    mkdirSync(sessionDir, { recursive: true });
    const eventsPath = join(sessionDir, "events.jsonl");
    const eventsBody = `${JSON.stringify({ type: "session.start", data: {} })}\n${JSON.stringify({ type: "user.message", data: {} })}\n`;
    writeFileSync(eventsPath, eventsBody, "utf8");

    const rec = buildVerdictRecord({ target: TARGET, value: "bad", text: "記録は不変のはず" }, { now: T0 });
    appendAnnotationRecord(personal, rec);
    appendAnnotationRecord(shared, buildVerdictRecord({ target: TARGET, value: "good" }, { now: T1, id: "shared-1" }));
    appendAnnotationRecord(personal, buildRetractRecord({ id: rec.id as string, source: "copilot-cli", session: "sess-1" }, { now: T2 }));

    assert.equal(readFileSync(eventsPath, "utf8"), eventsBody, "セッション記録の内容が変わっていない");
    assert.deepEqual(readdirSync(sessionDir), ["events.jsonl"], "セッション記録のフォルダにファイルが増えていない");
    assert.ok(existsSync(join(personal, "ann-skilltrace-solo.jsonl")));
    assert.ok(list.length === 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("個人用と共有用で書き込み先が分かれ、由来（scope）つきで両方読める", () => {
  const root = mkdtempSync(join(tmpdir(), "skilltrace-annw-"));
  try {
    const { personal, shared, list } = dirsOf(root);
    appendAnnotationRecord(personal, buildVerdictRecord({ target: TARGET, value: "ok" }, { now: T0, id: "p-1" }));
    appendAnnotationRecord(shared, buildNoteRecord({ target: TARGET, text: "共有側のメモ" }, { now: T1, id: "s-1" }));

    assert.ok(existsSync(join(personal, "ann-skilltrace-solo.jsonl")));
    assert.ok(existsSync(join(shared, "ann-skilltrace-solo.jsonl")));
    const anns = loadAnnotations(list).get("copilot-cli:sess-1");
    assert.ok(anns);
    assert.equal(anns.length, 2);
    assert.equal(anns.find(a => a.id === "p-1")?.scope, "personal");
    assert.equal(anns.find(a => a.id === "s-1")?.scope, "shared");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("改訂・取り消しの追記先は、元の注釈があるフォルダに解決される", () => {
  const root = mkdtempSync(join(tmpdir(), "skilltrace-annw-"));
  try {
    const { personal, shared, list } = dirsOf(root);
    appendAnnotationRecord(shared, buildVerdictRecord({ target: TARGET, value: "ok" }, { now: T0, id: "shared-only" }));
    appendAnnotationRecord(personal, buildVerdictRecord({ target: TARGET, value: "good" }, { now: T0, id: "personal-only" }));
    assert.deepEqual(locateOwnAnnotationDir(list, "shared-only"), { dir: shared, scope: "shared" });
    assert.deepEqual(locateOwnAnnotationDir(list, "personal-only"), { dir: personal, scope: "personal" });
    assert.equal(locateOwnAnnotationDir(list, "no-such-id"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ターン対象の評価はセッション全体の評価に混ざらない", () => {
  const root = mkdtempSync(join(tmpdir(), "skilltrace-annw-"));
  try {
    const { personal, list } = dirsOf(root);
    appendAnnotationRecord(personal, buildVerdictRecord({ target: { ...TARGET, turn: 2 }, value: "bad" }, { now: T0 }));
    appendAnnotationRecord(personal, buildNoteRecord({ target: { ...TARGET, turn: 2, turnTs: "2026-11-18T09:59:00+09:00" }, text: "このターンから逸れた" }, { now: T1 }));
    const anns = loadAnnotations(list).get("copilot-cli:sess-1");
    assert.ok(anns);
    assert.equal(anns.length, 2);
    assert.equal(anns[0].turn, 2);
    assert.equal(latestSessionVerdict(anns), null, "ターンの verdict はセッション全体の verdict ではない");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("不正な入力は書かずにエラーにする（3段階以外の値、ターンが正の整数でない、メモ本文なし）", () => {
  assert.throws(() => buildVerdictRecord({ target: TARGET, value: "great" as never }, { now: T0 }));
  assert.throws(() => buildVerdictRecord({ target: { ...TARGET, turn: 0 }, value: "good" }, { now: T0 }));
  assert.throws(() => buildVerdictRecord({ target: { ...TARGET, turn: 1.5 }, value: "good" }, { now: T0 }));
  assert.throws(() => buildNoteRecord({ target: TARGET, text: "" }, { now: T0 }));
});
