// セッション注釈（評価・メモ）の読み取り口。仕様は docs/session-annotations.md。
//
// 方針:
// - Copilot / Kiro / VS Code のセッション記録には一切書き込まない（読み取り専用）。
// - 注釈は `.skilltrace-annotations` フォルダに書き手ごとの JSONL で置かれ、
//   ここでは個人用（ホーム）と共有用（ワークスペース）の両方を読んで合流する。
// - 壊れた行はその行だけを飛ばし、知らない項目・kind・型は無視する（仕様の読み手規則）。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Lang } from "./common";
import { formatLocalDateTime } from "./sessions";

export const ANNOTATION_DIR_NAME = ".skilltrace-annotations";
export const ANNOTATION_FILE_RE = /^ann-[a-z0-9]+(-[a-z0-9]+)*\.jsonl$/;

export type AnnotationScope = "personal" | "shared";
export type Verdict = "good" | "ok" | "bad";

export interface Annotation {
  id: string;
  ts: string;
  producer: string;
  author?: string;
  scope: AnnotationScope;
  /** 記録源（仕様の source 値: copilot-cli / copilot-vscode / kiro） */
  source: string;
  session: string;
  turn?: number;
  kind: string;
  value?: unknown;
  valueType?: string;
  unit?: string;
  label?: string;
  text?: string;
  tags?: string[];
}

/** SkillTrace 内部の供給源名を、注釈仕様の source 値へ対応付ける */
export function specSourceFor(source: "copilot" | "kiro" | "vscode" | undefined): string {
  if (source === "kiro") return "kiro";
  if (source === "vscode") return "copilot-vscode";
  return "copilot-cli";
}

/** 注釈フォルダの候補（個人用=ホーム、共有用=各ワークスペースルート） */
export function annotationDirs(workspaceRoots: string[]): { dir: string; scope: AnnotationScope }[] {
  const out: { dir: string; scope: AnnotationScope }[] = [{ dir: join(homedir(), ANNOTATION_DIR_NAME), scope: "personal" }];
  for (const root of workspaceRoots) {
    if (root) out.push({ dir: join(root, ANNOTATION_DIR_NAME), scope: "shared" });
  }
  return out;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function parseLine(line: string, scope: AnnotationScope): Annotation | null {
  let obj: unknown;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!isRecord(obj)) return null;
  if (obj.v !== 1) return null;
  if (typeof obj.id !== "string" || !obj.id) return null;
  if (typeof obj.ts !== "string" || !obj.ts) return null;
  if (typeof obj.producer !== "string" || !obj.producer) return null;
  if (typeof obj.kind !== "string" || !obj.kind) return null;
  if (!isRecord(obj.target)) return null;
  if (typeof obj.target.source !== "string" || !obj.target.source) return null;
  if (typeof obj.target.session !== "string" || !obj.target.session) return null;
  const turn = typeof obj.target.turn === "number" && Number.isFinite(obj.target.turn) ? obj.target.turn : undefined;
  return {
    id: obj.id,
    ts: obj.ts,
    producer: obj.producer,
    author: typeof obj.author === "string" ? obj.author : undefined,
    scope,
    source: obj.target.source,
    session: obj.target.session,
    turn,
    kind: obj.kind,
    value: obj.value,
    valueType: typeof obj.value_type === "string" ? obj.value_type : (typeof obj.valueType === "string" ? obj.valueType : undefined),
    unit: typeof obj.unit === "string" ? obj.unit : undefined,
    label: typeof obj.label === "string" ? obj.label : undefined,
    text: typeof obj.text === "string" ? obj.text : undefined,
    tags: Array.isArray(obj.tags) ? obj.tags.filter((t): t is string => typeof t === "string") : undefined,
  };
}

/**
 * 1ファイル分の JSONL を解釈し、改訂・取り消しを解決した注釈一覧を返す。
 * 同じ id では ts が最新の行が有効（ts が同値なら後方の行）。retract は取り消し。
 */
export function parseAnnotationFile(text: string, scope: AnnotationScope): Annotation[] {
  const byId = new Map<string, { ann: Annotation | null; ts: string; pos: number }>();
  let pos = 0;
  for (const line of text.split(/\r?\n/)) {
    pos++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const ann = parseLine(trimmed, scope);
    if (!ann) continue;
    const prev = byId.get(ann.id);
    if (prev && (prev.ts > ann.ts || (prev.ts === ann.ts && prev.pos > pos))) continue;
    byId.set(ann.id, { ann: ann.kind === "retract" ? null : ann, ts: ann.ts, pos });
  }
  const out: Annotation[] = [];
  for (const e of byId.values()) if (e.ann) out.push(e.ann);
  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/** フォルダ群の署名（ファイル名+更新時刻+サイズ）。キャッシュの無効化判定用 */
export function annotationSignature(dirs: { dir: string }[]): string {
  const parts: string[] = [];
  for (const { dir } of dirs) {
    if (!existsSync(dir)) continue;
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names.filter(n => ANNOTATION_FILE_RE.test(n)).sort()) {
      try {
        const st = statSync(join(dir, name));
        parts.push(`${dir}/${name}:${st.mtimeMs}:${st.size}`);
      } catch { /* 読めないファイルは署名に入れない */ }
    }
  }
  return parts.join("|");
}

/**
 * フォルダ群の全注釈ファイルを読み、`${source}:${session}` をキーに束ねて返す。
 * フォルダやファイルが無い場合は空の Map（注釈ゼロは異常ではない）。
 */
export function loadAnnotations(dirs: { dir: string; scope: AnnotationScope }[]): Map<string, Annotation[]> {
  const out = new Map<string, Annotation[]>();
  for (const { dir, scope } of dirs) {
    if (!existsSync(dir)) continue;
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names.filter(n => ANNOTATION_FILE_RE.test(n)).sort()) {
      let text: string;
      try { text = readFileSync(join(dir, name), "utf8"); } catch { continue; }
      for (const ann of parseAnnotationFile(text, scope)) {
        const key = `${ann.source}:${ann.session}`;
        const list = out.get(key);
        if (list) list.push(ann); else out.set(key, [ann]);
      }
    }
  }
  for (const list of out.values()) list.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return out;
}

/** セッション全体への最新の verdict（ターン対象の verdict は数えない） */
export function latestSessionVerdict(list: Annotation[] | undefined): Verdict | null {
  if (!list) return null;
  let found: Verdict | null = null;
  for (const a of list) {
    if (a.kind === "verdict" && a.turn === undefined && (a.value === "good" || a.value === "ok" || a.value === "bad")) found = a.value;
  }
  return found;
}

/** 値の整形（仕様 §3.6）。整形できない場合は元の文字列表現を返す */
export function formatAnnotationValue(a: Pick<Annotation, "value" | "valueType" | "unit">, lang: Lang = "ja"): string {
  const v = a.value;
  if (v === null || v === undefined) return "";
  const en = lang === "en";
  switch (a.valueType) {
    case "percent": {
      if (typeof v !== "number" || !Number.isFinite(v)) return String(v);
      const p = v * 100;
      const s = Number.isInteger(p) ? String(p) : p.toFixed(1);
      return `${s}%`;
    }
    case "number": {
      if (typeof v !== "number" || !Number.isFinite(v)) return String(v);
      return v.toLocaleString("en-US") + (a.unit ? (en ? ` ${a.unit}` : ` ${a.unit}`) : "");
    }
    case "duration": {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return String(v);
      const total = Math.round(v);
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      if (en) return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`;
      return h ? `${h}時間${m}分${s}秒` : m ? `${m}分${s}秒` : `${s}秒`;
    }
    case "boolean":
      return v === true ? (en ? "Yes" : "はい") : v === false ? (en ? "No" : "いいえ") : String(v);
    case "timestamp":
      return typeof v === "string" ? formatLocalDateTime(v, lang) : String(v);
    default:
      return typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  }
}
