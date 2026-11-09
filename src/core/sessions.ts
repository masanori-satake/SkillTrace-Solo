// Copilot CLI のセッション（~/.copilot/session-state/<id>/）の列挙と、
// ワークスペース内のスキル探索。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normPath } from "./graph";
import { collectStrings } from "./events";
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
  for (const name of readdirSync(baseDir)) {
    const dir = join(baseDir, name);
    const eventsPath = join(dir, "events.jsonl");
    try {
      if (!statSync(dir).isDirectory() || !existsSync(eventsPath)) continue;
    } catch { continue; }
    let workspaceHint: string | null = null;
    const yamlPath = join(dir, "workspace.yaml");
    if (existsSync(yamlPath)) {
      try {
        const m = readFileSync(yamlPath, "utf8").match(/^\s*cwd:\s*(.+)$/m);
        if (m) workspaceHint = m[1].trim().replace(/^["']|["']$/g, "");
      } catch { /* ヒントなしで続行 */ }
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
  let text: string;
  try { text = readFileSync(eventsPath, "utf8"); } catch { return null; }
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
export function discoverSkills(workspaceDir: string): { name: string; dir: string }[] {
  const found: { name: string; dir: string }[] = [];
  for (const root of SKILL_ROOTS) {
    const base = join(workspaceDir, root);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const dir = join(base, name);
      try {
        if (statSync(dir).isDirectory() && existsSync(join(dir, "SKILL.md"))) found.push({ name, dir });
      } catch { /* skip */ }
    }
  }
  return found;
}
