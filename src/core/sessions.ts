// Copilot CLI のセッション（~/.copilot/session-state/<id>/）の列挙と、
// ワークスペース内のスキル探索。
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normPath } from "./graph";
import { collectStrings } from "./events";
import { HEADING_PREFIX_BYTES, MAX_RECORD_BYTES, readFilePrefix, readTextFileWithinLimit } from "./readfile";
import type { Lang } from "./common";

export interface SessionInfo {
  id: string;
  dir: string;
  eventsPath: string;
  mtimeMs: number;
  workspaceHint: string | null;
  /** 記録の供給源（未指定は Copilot） */
  source?: "copilot" | "kiro" | "vscode";
  /** Kiro: session.json のタイトル */
  title?: string | null;
  /** Kiro: ワークスペースのパス一覧（マルチルート。先頭が主） */
  workspacePaths?: string[];
}

export function defaultSessionStateDir(): string {
  return join(homedir(), ".copilot", "session-state");
}

/** ISO 文字列を、読む人のローカル時刻で「2026年11月7日 13:59:34」と表示する。
 *  タイムゾーン名は付けない（表示するマシンのローカル時刻であることが前提） */
export function formatLocalDateTime(iso: string | null | undefined, lang: Lang = "ja"): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  if (lang === "en") return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function listSessions(baseDir: string): SessionInfo[] {
  if (!existsSync(baseDir)) return [];
  const out: SessionInfo[] = [];
  // 列挙自体が失敗（権限・競合で消えた等）しても、例外を伝播させず空で返す
  let names: string[];
  try { names = readdirSync(baseDir); } catch { return []; }
  for (const name of names) {
    const dir = join(baseDir, name);
    const eventsPath = join(dir, "events.jsonl");
    try {
      if (!statSync(dir).isDirectory() || !existsSync(eventsPath)) continue;
    } catch { continue; }
    let workspaceHint: string | null = null;
    const yamlPath = join(dir, "workspace.yaml");
    if (existsSync(yamlPath)) {
      // cwd の行だけが目的なので、先頭だけを上限付きで読む（監査 2026-11-22）
      const head = readFilePrefix(yamlPath, HEADING_PREFIX_BYTES);
      if (head !== null) {
        const m = head.match(/^\s*cwd:\s*(.+)$/m);
        if (m) workspaceHint = m[1].trim().replace(/^["']|["']$/g, "");
      }
    }
    out.push({ id: name, dir, eventsPath, mtimeMs: statSync(eventsPath).mtimeMs, workspaceHint });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 履歴表示用に、供給源ごとに新しい順で最大 perSource 件までに絞る。
 *  合算で絞ると、件数の多い供給源（Kiro は数百件になりうる）が他方を
 *  全部押し出してしまう。入力は新しい順に整列済みである前提で、
 *  全体の並び順は保ったまま供給源ごとの件数だけを数える */
/** セッションの記録に残るワークスペースのパス候補（判定の材料） */
export function sessionWorkspacePaths(s: SessionInfo): string[] {
  const out: string[] = [];
  if (s.workspaceHint) out.push(s.workspaceHint);
  for (const p of s.workspacePaths ?? []) if (p && !out.includes(p)) out.push(p);
  return out;
}

/** パスの関係: 一致、または一方が他方の配下にある */
function pathRelated(a: string, b: string): boolean {
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

/**
 * セッションが、開いているワークスペースに確実に関係するかを判定する（Issue #44）。
 * 記録からワークスペースが分からないセッションは「確実」とは言えないため false。
 */
export function sessionMatchesWorkspace(s: SessionInfo, roots: string[]): boolean {
  const rootsNorm = roots.map(r => normPath(r)).filter(Boolean);
  if (!rootsNorm.length) return false;
  return sessionWorkspacePaths(s).some(p => {
    const pn = normPath(p);
    return pn.length > 0 && rootsNorm.some(r => pathRelated(pn, r));
  });
}

/**
 * 現在のワークスペースに関連するセッションだけに絞る（Issue #44）。
 * 上限（供給源ごとに新しい順30件）の適用より前に絞る前提の関数。
 */
export function filterSessionsToWorkspace(list: SessionInfo[], roots: string[]): SessionInfo[] {
  return list.filter(s => sessionMatchesWorkspace(s, roots));
}

export function capSessionsBySource(sessions: SessionInfo[], perSource: number): SessionInfo[] {
  const counts = new Map<string, number>();
  const out: SessionInfo[] = [];
  for (const s of sessions) {
    const key = s.source ?? "copilot";
    const n = counts.get(key) ?? 0;
    if (n >= perSource) continue;
    counts.set(key, n + 1);
    out.push(s);
  }
  return out;
}

// 履歴ラベル用の軽量スキャン: skill.invoked 系の行だけをパースし、
// 発動したスキル名を返す（全文パースは表示中のセッションだけに行う）。
// 候補が無い・読めない場合は null（未判定）。発動が無ければ空配列。
export function scanInvokedSkillNames(eventsPath: string, candidates: { name: string; dir: string }[]): string[] | null {
  const text = readTextFileWithinLimit(eventsPath, MAX_RECORD_BYTES);
  if (text === null) return null;
  const names: string[] = [];
  let sawInvoked = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("skill.invoked")) continue;
    sawInvoked = true;
    let ev: unknown;
    try { ev = JSON.parse(line); } catch { continue; }
    // 記録そのものが持つスキル名（data.name）を正とする。スキルが現在の
    // ワークスペースから消えていても、起動の事実はラベルに残す
    const data = (ev as { data?: unknown }).data;
    if (typeof data === "object" && data !== null) {
      const n = (data as Record<string, unknown>).name;
      if (typeof n === "string" && n && !names.includes(n)) names.push(n);
    }
    // 名前が無い形式向けに、候補（現在のワークスペースのスキル）との照合も残す
    const strings = collectStrings(ev);
    const norm = strings.map(x => normPath(x));
    for (const c of candidates) {
      if (names.includes(c.name)) continue;
      if (norm.some(x => x.includes(normPath(c.dir))) || norm.some(x => x === c.name.toLowerCase())) names.push(c.name);
    }
  }
  if (names.length) return names;
  // 読めた以上、起動行が無ければ「未使用」で確定。起動行があるのに名前を
  // 特定できなかった場合だけ未判定（null）とする
  return sawInvoked ? null : [];
}

const SKILL_ROOTS = [".github/skills", ".agents/skills", ".kiro/skills", ".claude/skills"];

/** 記録のパス証拠からスキルフォルダを特定するときに認めるルート名。
 *  ワークスペースの標準ルートに、個人用スキル置き場（~/.copilot/skills）を加えたもの */
const LOCATE_ROOT_HEADS = new Set([".github", ".agents", ".kiro", ".claude", ".copilot"]);

/** 未発見スキルの所在を、セッション記録に残るパスから特定する（Issue #60）。
 *  パス中に「<ルート>/skills/<名前>/」の形が現れた場合に限り、そのフォルダを候補とし、
 *  実在して SKILL.md を含むときだけ返す。任意のディレクトリ走査はせず、記録に実際に
 *  現れた絶対パスだけを使う。相対パスの断片は実在確認の対象にしない */
export function locateSkillFromPaths(name: string, paths: readonly string[]): string | null {
  const target = name.toLowerCase();
  for (const raw of paths) {
    if (!raw) continue;
    const segs = raw.replace(/\\/g, "/").split("/");
    for (let i = 0; i + 2 < segs.length; i++) {
      if (!LOCATE_ROOT_HEADS.has(segs[i].toLowerCase())) continue;
      if (segs[i + 1].toLowerCase() !== "skills") continue;
      if (segs[i + 2].toLowerCase() !== target) continue;
      const dir = segs.slice(0, i + 3).join("/");
      if (!/^[a-zA-Z]:\//.test(dir) && !dir.startsWith("/")) continue;
      try {
        if (statSync(dir).isDirectory() && existsSync(join(dir, "SKILL.md"))) return dir;
      } catch { /* skip */ }
    }
  }
  return null;
}

/** 1段下の探索で対象にしない子フォルダ（依存パッケージ置き場） */
const DESCEND_SKIP = new Set(["node_modules"]);

/** base 直下の標準ルート（SKILL_ROOTS）からスキルを集める */
function collectSkills(base: string, found: { name: string; dir: string }[]): void {
  for (const root of SKILL_ROOTS) {
    const skillsBase = join(base, root);
    if (!existsSync(skillsBase)) continue;
    for (const name of readdirSync(skillsBase)) {
      const dir = join(skillsBase, name);
      try {
        if (statSync(dir).isDirectory() && existsSync(join(dir, "SKILL.md"))) found.push({ name, dir });
      } catch { /* skip */ }
    }
  }
}

/** 同じ実フォルダへの重複登録を除くためのキー（シンボリックリンク経由の二重発見を防ぐ） */
function skillDirKey(dir: string): string {
  let p = dir;
  try { p = realpathSync(dir); } catch { /* 実パスが取れなければそのまま */ }
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/** ワークスペース内のスキルを、標準ルート（SKILL_ROOTS）から探す。
 *  descendIntoChildFolders を付けると、直下の子フォルダ（clone してきた
 *  リポジトリ等）の中の標準ルートも見る。広げるのは1段目までで、再帰的な
 *  走査はしない。隠しフォルダと node_modules は対象にしない。
 *  「1つのワークスペースフォルダの下に複数の clone を並べる」構成への対応 */
export function discoverSkills(workspaceDir: string, opts?: { descendIntoChildFolders?: boolean }): { name: string; dir: string }[] {
  const found: { name: string; dir: string }[] = [];
  collectSkills(workspaceDir, found);
  if (opts?.descendIntoChildFolders) {
    let children: string[] = [];
    try { children = readdirSync(workspaceDir); } catch { children = []; }
    for (const child of children) {
      if (child.startsWith(".") || DESCEND_SKIP.has(child)) continue;
      const childDir = join(workspaceDir, child);
      try { if (!statSync(childDir).isDirectory()) continue; } catch { continue; }
      collectSkills(childDir, found);
    }
  }
  const seen = new Set<string>();
  return found.filter(s => {
    const key = skillDirKey(s.dir);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
