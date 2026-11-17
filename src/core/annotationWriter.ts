// セッション注釈の書き手側（書き込み口）。仕様は docs/session-annotations.md §7。
//
// 方針（書き手の規則）:
// - 追記するのは自分の ann-<producer>.jsonl のみ。他の書き手のファイルと、
//   Copilot / Kiro / VS Code のセッション記録には絶対に書き込まない。
// - 既存の行は書き換えも削除もしない。改訂は同じ id の新しい行、取り消しは
//   同じ id の kind: "retract" の行を追記して表現する（§6）。
// - 改訂・取り消しは、元の注釈があるファイル（同じ範囲のフォルダ）へ追記する。
//   別のフォルダに書くと読み手側で旧行と新行が別々に解決され、両方残ってしまう。
// - 1 行 = 1 オブジェクトの完全な JSON を追記する（整形出力しない）。
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ANNOTATION_DIR_NAME, type Annotation, type AnnotationScope, type Verdict } from "./annotations";

/** SkillTrace-Solo 自身の producer 識別子（ファイル名と一致させる。§2.1） */
export const ANNOTATION_PRODUCER = "skilltrace-solo";

export function ownAnnotationFileName(producer: string = ANNOTATION_PRODUCER): string {
  return `ann-${producer}.jsonl`;
}

/** 個人用フォルダ（ホーム直下） */
export function personalAnnotationDir(): string {
  return join(homedir(), ANNOTATION_DIR_NAME);
}

/** 共有用フォルダ（ワークスペースルート直下） */
export function sharedAnnotationDir(workspaceRoot: string): string {
  return join(workspaceRoot, ANNOTATION_DIR_NAME);
}

/** Date を ISO 8601（タイムゾーン付き、ミリ秒まで）で書く。例: 2026-11-18T02:40:00.123+09:00 */
export function formatAnnotationTs(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

export interface AnnotationTargetInput {
  /** 記録源（仕様の source 値。specSourceFor で変換したもの） */
  source: string;
  session: string;
  /** ターン対象の場合のターン通し番号（サマリ表示の数え方で 1 始まり） */
  turn?: number;
  turnTs?: string;
  sessionStarted?: string;
  workspace?: string;
}

export interface AnnotationWriteOptions {
  /** 注釈の id。改訂のときだけ元の id を渡す（新規は省略 = 新規採番） */
  id?: string;
  /** 書き込み時刻。省略時は現在時刻 */
  now?: Date;
  producerVersion?: string;
}

function targetObject(t: AnnotationTargetInput): Record<string, unknown> {
  if (!t.source) throw new Error("annotation target.source is required");
  if (!t.session) throw new Error("annotation target.session is required");
  if (t.turn !== undefined && (!Number.isInteger(t.turn) || t.turn < 1)) throw new Error("annotation target.turn must be a positive integer");
  const out: Record<string, unknown> = { source: t.source, session: t.session };
  if (t.turn !== undefined) out.turn = t.turn;
  if (t.turnTs) out.turn_ts = t.turnTs;
  if (t.sessionStarted) out.session_started = t.sessionStarted;
  if (t.workspace) out.workspace = t.workspace;
  return out;
}

function baseRecord(kind: string, target: AnnotationTargetInput, opts: AnnotationWriteOptions): Record<string, unknown> {
  const rec: Record<string, unknown> = {
    v: 1,
    id: opts.id ?? randomUUID(),
    ts: formatAnnotationTs(opts.now ?? new Date()),
    producer: ANNOTATION_PRODUCER,
  };
  if (opts.producerVersion) rec.producer_version = opts.producerVersion;
  rec.target = targetObject(target);
  rec.kind = kind;
  return rec;
}

const VERDICTS: readonly string[] = ["good", "ok", "bad"];

/** 評価レコード（kind: "verdict"、値は 3 段階のみ）を組み立てる。改訂は opts.id に元の id を渡す */
export function buildVerdictRecord(
  input: { target: AnnotationTargetInput; value: Verdict; text?: string; tags?: string[] },
  opts: AnnotationWriteOptions = {},
): Record<string, unknown> {
  if (!VERDICTS.includes(input.value)) throw new Error(`invalid verdict value: ${String(input.value)}`);
  const rec = baseRecord("verdict", input.target, opts);
  rec.value = input.value;
  if (input.text) rec.text = input.text;
  if (input.tags?.length) rec.tags = [...input.tags];
  return rec;
}

/** メモレコード（kind: "note"、本文必須）を組み立てる */
export function buildNoteRecord(
  input: { target: AnnotationTargetInput; text: string; tags?: string[] },
  opts: AnnotationWriteOptions = {},
): Record<string, unknown> {
  if (!input.text) throw new Error("note text is required");
  const rec = baseRecord("note", input.target, opts);
  rec.text = input.text;
  if (input.tags?.length) rec.tags = [...input.tags];
  return rec;
}

/** 取り消しレコード（kind: "retract"）。元の注釈と同じ id・対象で組み立てる */
export function buildRetractRecord(
  original: Pick<Annotation, "id" | "source" | "session" | "turn">,
  opts: AnnotationWriteOptions = {},
): Record<string, unknown> {
  return baseRecord("retract", {
    source: original.source,
    session: original.session,
    turn: original.turn,
  }, { ...opts, id: original.id });
}

/**
 * レコードをフォルダ内の自分のファイルへ 1 行追記し、ファイルパスを返す。
 * フォルダ・ファイルが無ければ作る。既存ファイルの末尾に改行が無い場合は
 * 先に改行を補ってから追記する（最後尾の行と混ざらないように）。
 */
export function appendAnnotationRecord(dir: string, record: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, ownAnnotationFileName());
  let prefix = "";
  try {
    const size = statSync(file).size;
    if (size > 0) {
      const fd = openSync(file, "r");
      try {
        const buf = Buffer.alloc(1);
        readSync(fd, buf, 0, 1, size - 1);
        if (buf[0] !== 0x0a) prefix = "\n";
      } finally { closeSync(fd); }
    }
  } catch { /* ファイルが無い場合はそのまま作る */ }
  appendFileSync(file, `${prefix}${JSON.stringify(record)}\n`, "utf8");
  return file;
}

/** 注釈が自分のもの（SkillTrace-Solo が書いたもの）か。改訂・取り消しは自分の注釈だけに行う */
export function isOwnAnnotation(a: Pick<Annotation, "producer">): boolean {
  return a.producer === ANNOTATION_PRODUCER;
}

/**
 * 元の注釈が書かれたフォルダを探す（改訂・取り消しの追記先）。
 * 自分のファイルだけを対象に、id を含む行があるフォルダを返す。見つからなければ null。
 */
export function locateOwnAnnotationDir(
  dirs: { dir: string; scope: AnnotationScope }[],
  id: string,
): { dir: string; scope: AnnotationScope } | null {
  for (const d of dirs) {
    const file = join(d.dir, ownAnnotationFileName());
    if (!existsSync(file)) continue;
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes(id)) continue;
      try {
        const obj = JSON.parse(line) as { id?: unknown };
        if (obj.id === id) return d;
      } catch { /* 壊れた行は飛ばす */ }
    }
  }
  return null;
}
