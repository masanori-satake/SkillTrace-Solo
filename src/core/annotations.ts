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
  // turn が指定されているのに正の整数でない行は無効とする。黙って省略扱いに
  // すると、ターン対象の評価がセッション全体の評価として表示されてしまう
  if (obj.target.turn !== undefined
    && (typeof obj.target.turn !== "number" || !Number.isInteger(obj.target.turn) || obj.target.turn < 1)) return null;
  const turn = typeof obj.target.turn === "number" ? obj.target.turn : undefined;
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

/** ts を「秒＋小数秒の桁列」の組に分解する。ISO 8601 はタイムゾーン付きで
 *  書けるため文字列のままでは比べられず、Date.parse はミリ秒で切り捨てる
 *  ため小数秒の差（例: .123900 と .123100）が消えてしまう。ISO 形式として
 *  解釈できない場合は Date.parse に委ね、それも駄目なら null（最も古い扱い） */
function instantKey(ts: string): [number, string] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(ts.trim());
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const h = Number(m[4]);
    const mi = Number(m[5]);
    const s = m[6] ? Number(m[6]) : 0;
    // 範囲外の要素は setUTC* が翌日以降へ繰り上げてしまうため、先に弾く
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
    let offsetSec = 0;
    const zone = m[8];
    if (zone && zone !== "Z") {
      const digits = zone.slice(1).replace(":", "");
      const oh = Number(digits.slice(0, 2));
      const om = Number(digits.slice(2, 4));
      if (oh > 23 || om > 59) return null;
      offsetSec = (zone.startsWith("-") ? -1 : 1) * (oh * 3600 + om * 60);
    }
    const dt = new Date(0);
    dt.setUTCFullYear(y, mo - 1, d);
    dt.setUTCHours(h, mi, s, 0);
    // 実在しない日付（2月30日など）は繰り上がるため、往復で一致を確認する
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d
      || dt.getUTCHours() !== h || dt.getUTCMinutes() !== mi || dt.getUTCSeconds() !== s) return null;
    return [dt.getTime() / 1000 - offsetSec, m[7] ?? ""];
  }
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return null;
  const sec = Math.floor(t / 1000);
  return [sec, String(t - sec * 1000).padStart(3, "0")];
}

/** ts を時刻として比べる（改訂判定と並べ替えの共通方針）。
 *  解釈できない ts は「最も古い」として一貫した順序に置く */
export function compareTs(a: string, b: string): number {
  const ka = instantKey(a);
  const kb = instantKey(b);
  if (ka === null || kb === null) return ka === kb ? 0 : ka === null ? -1 : 1;
  if (ka[0] !== kb[0]) return ka[0] < kb[0] ? -1 : 1;
  const len = Math.max(ka[1].length, kb[1].length);
  const fa = ka[1].padEnd(len, "0");
  const fb = kb[1].padEnd(len, "0");
  return fa < fb ? -1 : fa > fb ? 1 : 0;
}

/**
 * 1ファイル分の JSONL を解釈し、改訂・取り消しを解決した注釈一覧を返す。
 * 同じ id では ts（時刻）が最新の行が有効（同時刻なら後方の行）。retract は取り消し。
 */
export function parseAnnotationFile(text: string, scope: AnnotationScope): Annotation[] {
  const byId = new Map<string, { ann: Annotation | null; ts: string }>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const ann = parseLine(trimmed, scope);
    if (!ann) continue;
    const prev = byId.get(ann.id);
    if (prev && compareTs(prev.ts, ann.ts) > 0) continue;
    byId.set(ann.id, { ann: ann.kind === "retract" ? null : ann, ts: ann.ts });
  }
  const out: Annotation[] = [];
  for (const e of byId.values()) if (e.ann) out.push(e.ann);
  return out.sort((a, b) => compareTs(a.ts, b.ts));
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
  for (const list of out.values()) list.sort((a, b) => compareTs(a.ts, b.ts));
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
