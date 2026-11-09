// 参照ファイル単位の横断集計（Issue #41）。
// スキルの分割方法（どの情報をどの分量で分散させるか）の判断材料として、
// セッションをまたいで「どの参照ファイルが、どれだけのセッションで実際に
// 読み込まれたか」を集計する。
//
// Phase 0（2026-11-10）の確認:
// - 到達したファイル（分子）は3供給源とも記録だけで分かる。Copilot は
//   skill.invoked の skillPath、Kiro は read_files のパス、Copilot Chat は
//   vscodeLinkType=skill の URI と読み取り URI が絶対パスで残る
// - ファイルの一覧（分母）は記録には無いため、今開いているワークスペースで
//   見つかったスキルの参照グラフから取る。到達の相対パスは記録側のスキル
//   フォルダ基準で求めるので、セッション当時と置き場所が変わっていても
//   突き合わせられる
// - ここでの「読み込まれた」は記録の構造的な証拠（ツール実行の引数、
//   読み取り URI、常時文脈の取り込み）に基づく近似で、セッション単位の
//   トレース（グラフ突合せ済み）より粗い。言及のみは、パスが記録の文面に
//   現れたが読み取りの証拠が無い場合を数える
import { readFileSync } from "node:fs";
import { parseEventsText, findString } from "./events";
import { parseKiroMessages, displayPath } from "./kiro";
import { parseVSCodeChatSessionText, skillNameFromPath } from "./vscode";
import { normPath, type Graph } from "./graph";
import type { SessionInfo } from "./sessions";

/** 1セッションで1スキルについて記録から取れた到達（相対パスは小文字化済み） */
export interface SessionSkillFileReach {
  name: string;
  /** 記録から求めたスキルフォルダ（正規化済み）。不明なら "" */
  dir: string;
  /** 読み込まれた相対パス → 最終到達時刻 */
  readRels: Map<string, string | null>;
  /** 言及のみの相対パス */
  mentionRels: Set<string>;
}

export interface SessionFileUsage {
  startedAt: string | null;
  skills: SessionSkillFileReach[];
}

interface MutableReach extends SessionSkillFileReach { }

function newReach(name: string, dir: string): MutableReach {
  return { name, dir, readRels: new Map(), mentionRels: new Set() };
}

/** 正規化済み文字列の中から、フォルダ配下のパスの相対部分を取り出す */
function relsUnder(text: string, dirNorm: string): string[] {
  if (!dirNorm) return [];
  const t = normPath(text);
  const prefix = dirNorm.endsWith("/") ? dirNorm : dirNorm + "/";
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const j = t.indexOf(prefix, i);
    if (j < 0) break;
    const rest = t.slice(j + prefix.length);
    const m = rest.match(/^[^\s"'<>|`*]+/);
    if (m && m[0]) {
      const rel = m[0].split(/[?#]/)[0].replace(/\/+$/, "");
      if (rel && !rel.includes("://")) out.push(rel);
    }
    i = j + prefix.length;
  }
  return out;
}

/** 正確なパス同士の突き合わせ（空白を含むパスでも切れない） */
function relExact(pathNorm: string, dirNorm: string): string | null {
  if (!dirNorm) return null;
  const prefix = dirNorm.endsWith("/") ? dirNorm : dirNorm + "/";
  return pathNorm.startsWith(prefix) ? pathNorm.slice(prefix.length) : null;
}

/** フォルダが不明な場合の予備: /スキル名/ の後ろを相対パスとして取り出す */
function relsAfterSegment(text: string, nameLower: string): string[] {
  return relsUnder(text, "/" + nameLower);
}

function dirOfSkillMd(pathNorm: string): string {
  const i = pathNorm.toLowerCase().lastIndexOf("/skill.md");
  return i > 0 ? pathNorm.slice(0, i) : "";
}

function noteRead(s: MutableReach, rel: string, at: string | null): void {
  if (!s.readRels.has(rel)) { s.readRels.set(rel, at); return; }
  const prev = s.readRels.get(rel);
  if (at !== null && (prev == null || at > prev)) s.readRels.set(rel, at);
}

function finish(skills: Map<string, MutableReach>): SessionFileUsage["skills"] {
  const out = [...skills.values()];
  for (const s of out) for (const rel of s.readRels.keys()) s.mentionRels.delete(rel);
  return out;
}

export function extractFileUsageCopilotText(text: string): SessionFileUsage {
  const parsed = parseEventsText(text);
  const skills = new Map<string, MutableReach>();
  const ensure = (name: string, dir: string): MutableReach => {
    const key = name.toLowerCase();
    let s = skills.get(key);
    if (!s) { s = newReach(name, dir); skills.set(key, s); }
    if (dir && !s.dir) s.dir = dir;
    return s;
  };
  for (const ev of parsed.events) {
    if (ev.type !== "skill.invoked" && ev.type !== "skill.invoked_ref") continue;
    const path = findString(ev.data, ["skillPath", "path"]);
    const name = findString(ev.data, ["skillName", "name"]) ?? (path ? skillNameFromPath(path) : null);
    if (!name) continue;
    const s = ensure(name, path ? dirOfSkillMd(normPath(path)) : "");
    noteRead(s, "skill.md", ev.at);
  }
  const list = [...skills.values()];
  if (!list.length) return { startedAt: parsed.startedAt, skills: [] };
  const collect = (strings: string[], read: boolean, at: string | null): void => {
    for (const s of list) {
      for (const str of strings) {
        const rels = s.dir ? relsUnder(str, s.dir) : relsAfterSegment(str, s.name.toLowerCase());
        for (const rel of rels) {
          if (read) noteRead(s, rel, at);
          else s.mentionRels.add(rel);
        }
      }
    }
  };
  for (const ev of parsed.events) {
    const isTool = ev.type === "tool.execution_start" || ev.type === "external_tool.requested";
    collect(ev.strings, isTool, ev.at);
  }
  return { startedAt: parsed.startedAt, skills: finish(skills) };
}

export function extractFileUsageKiroText(text: string): SessionFileUsage {
  const parsed = parseKiroMessages(text);
  const skills = new Map<string, MutableReach>();
  const ensure = (name: string, dir: string): MutableReach => {
    const key = name.toLowerCase();
    let s = skills.get(key);
    if (!s) { s = newReach(name, dir); skills.set(key, s); }
    if (dir && !s.dir) s.dir = dir;
    return s;
  };
  // 起動は SKILL.md が読み込まれたことと同義（到達の確度「高」の決定どおり）
  for (const a of parsed.activations) noteRead(ensure(a.name, ""), "skill.md", a.at);
  // 読み取り証拠は tool_call の args.path / args.paths から取る。文字列値そのもの
  // を使うので、空白を含むパスでも途中で切れない。文面の走査は言及の判定にだけ使う
  const readPaths: { path: string; at: string | null }[] = [];
  for (const ev of parsed.events) {
    if (ev.type !== "tool_call") continue;
    const p = ev.payload;
    const isRead = String(p.kind ?? "") === "read"
      || /read/.test(String(p.toolName ?? ""))
      || /read/.test(String(p.actionType ?? ""));
    if (!isRead) continue;
    const args = p.args as Record<string, unknown> | undefined;
    if (!args) continue;
    if (typeof args.path === "string") readPaths.push({ path: args.path, at: ev.at });
    if (Array.isArray(args.paths)) {
      for (const x of args.paths) if (typeof x === "string") readPaths.push({ path: x, at: ev.at });
    }
  }
  // SKILL.md の読み取りからフォルダとスキルを確定する（言及だけでは登録しない）
  for (const r of readPaths) {
    const n = normPath(r.path);
    if (!n.endsWith("/skill.md")) continue;
    const dir = dirOfSkillMd(n);
    const name = dir.split("/").pop() ?? "";
    if (name) noteRead(ensure(name, dir), "skill.md", r.at);
  }
  // 残りの読み取りを、フォルダ配下として帰属させる。フォルダ未確定でも、
  // 起動済みスキルの名前セグメントを含む読み取りパスからは逆引きできる
  for (const r of readPaths) {
    const n = normPath(r.path);
    if (n.endsWith("/skill.md")) continue;
    let attributed = false;
    for (const s of skills.values()) {
      const rel = relExact(n, s.dir);
      if (rel) { noteRead(s, rel, r.at); attributed = true; }
    }
    if (attributed) continue;
    for (const s of skills.values()) {
      const seg = "/" + s.name.toLowerCase() + "/";
      const idx = n.indexOf(seg);
      if (idx < 0) continue;
      if (!s.dir) s.dir = n.slice(0, idx + seg.length - 1);
      noteRead(s, n.slice(idx + seg.length), r.at);
    }
  }
  // 常時文脈への取り込みは、起動または読み取りで登録済みのスキルについてだけ
  // 読み取り証拠として数える（未起動スキルの取り込みは数えない）
  const registered = [...skills.values()];
  for (const inc of parsed.inclusions) {
    for (const doc of inc.documents) {
      const n = normPath(displayPath(doc));
      for (const s of registered) {
        const rel = relExact(n, s.dir);
        if (rel) { noteRead(s, rel, inc.at); continue; }
        const seg = "/" + s.name.toLowerCase() + "/";
        const idx = n.indexOf(seg);
        if (idx >= 0) noteRead(s, n.slice(idx + seg.length), inc.at);
      }
    }
  }
  // 言及は登録済みスキルについてだけ、文面の走査で数える
  const withDir = registered.filter(s => s.dir);
  for (const ev of parsed.events) {
    for (const s of withDir) {
      for (const str of ev.strings) {
        for (const rel of relsUnder(str, s.dir)) s.mentionRels.add(rel);
      }
    }
  }
  return { startedAt: parsed.startedAt, skills: finish(skills) };
}

export function extractFileUsageVSCodeText(text: string): SessionFileUsage {
  const parsed = parseVSCodeChatSessionText(text);
  const skills = new Map<string, MutableReach>();
  const ensure = (name: string, dir: string): MutableReach => {
    const key = name.toLowerCase();
    let s = skills.get(key);
    if (!s) { s = newReach(name, dir); skills.set(key, s); }
    if (dir && !s.dir) s.dir = dir;
    return s;
  };
  for (const a of parsed.activations) ensure(a.name, "");
  // まずスキルとして読み込まれた SKILL.md からフォルダを確定する
  for (const req of parsed.requests) {
    for (const t of req.tools) {
      if (!t.skillRead || !t.readPath) continue;
      const name = skillNameFromPath(t.readPath);
      if (name) ensure(name, dirOfSkillMd(normPath(t.readPath)));
    }
  }
  for (const req of parsed.requests) {
    for (const t of req.tools) {
      if (!t.readPath) continue;
      const at = t.startedAt ?? req.at;
      if (t.skillRead) {
        const name = skillNameFromPath(t.readPath);
        const s = name ? skills.get(name.toLowerCase()) : undefined;
        if (s) noteRead(s, "skill.md", at);
        continue;
      }
      const n = normPath(t.readPath);
      for (const s of skills.values()) {
        // 読み取りパス同士の突き合わせは正確に行う（空白を含むパスでも
        // 切れない）。フォルダが未確定の場合だけ名前セグメントで予備判定する
        const rel = relExact(n, s.dir);
        if (rel) { noteRead(s, rel, at); continue; }
        if (!s.dir) for (const r of relsAfterSegment(n, s.name.toLowerCase())) noteRead(s, r, at);
      }
    }
  }
  for (const s of skills.values()) {
    if (!s.dir) continue;
    for (const str of parsed.strings) {
      for (const rel of relsUnder(str, s.dir)) s.mentionRels.add(rel);
    }
  }
  return { startedAt: parsed.startedAt, skills: finish(skills) };
}

/** 記録ファイルを読み、ファイル単位の到達を取り出す。読めなければ null */
export function extractSessionFileUsage(info: SessionInfo): SessionFileUsage | null {
  try {
    const text = readFileSync(info.eventsPath, "utf8");
    if (info.source === "kiro") return extractFileUsageKiroText(text);
    if (info.source === "vscode") return extractFileUsageVSCodeText(text);
    return extractFileUsageCopilotText(text);
  } catch {
    return null;
  }
}

export interface FileUsageRow {
  /** スキルフォルダからの相対パス（グラフ側の表記） */
  rel: string;
  readSessions: number;
  mentionSessions: number;
  noneSessions: number;
  lastReadAt: string | null;
}

export interface SkillFileUsage {
  name: string;
  /** このスキルが起動したセッション数（母数） */
  invokedSessions: number;
  rows: FileUsageRow[];
}

/**
 * 発見済みスキルのグラフ（ファイル一覧）とセッション横断の到達を突き合わせる。
 * ファイル一覧はグラフに現れるファイルに限る（参照されていないファイルは
 * 構造側の関心事として対象外）。スキル外（境界）のファイルと、参照先の無い
 * ファイルは数えない。到達の相対パスは記録側のフォルダ基準なので、
 * 置き場所が変わったセッションとも突き合わせられる。
 */
export function aggregateFileUsage(graphs: Graph[], usages: SessionFileUsage[], skillName: string): SkillFileUsage {
  const files = new Map<string, string>();
  for (const g of graphs) {
    for (const node of g.order) {
      if (node.missing || node.boundary) continue;
      const rel = node.relToSkill.replace(/\\/g, "/");
      if (!rel || rel.startsWith("../")) continue;
      files.set(rel.toLowerCase(), rel);
    }
  }
  const counts = new Map<string, FileUsageRow>();
  for (const [key, rel] of files) counts.set(key, { rel, readSessions: 0, mentionSessions: 0, noneSessions: 0, lastReadAt: null });
  let invokedSessions = 0;
  const nameLower = skillName.toLowerCase();
  for (const u of usages) {
    const reach = u.skills.filter(s => s.name.toLowerCase() === nameLower);
    if (!reach.length) continue;
    invokedSessions++;
    const read = new Map<string, string | null>();
    const mention = new Set<string>();
    for (const r of reach) {
      for (const [rel, at] of r.readRels) {
        const prev = read.get(rel);
        if (prev === undefined || (at !== null && (prev === null || at > prev))) read.set(rel, at);
      }
      for (const rel of r.mentionRels) mention.add(rel);
    }
    for (const [key, row] of counts) {
      const at = read.get(key);
      if (at !== undefined) {
        row.readSessions++;
        if (at !== null && (row.lastReadAt === null || at > row.lastReadAt)) row.lastReadAt = at;
      } else if (mention.has(key)) row.mentionSessions++;
      else row.noneSessions++;
    }
  }
  const rows = [...counts.values()].sort((a, b) =>
    b.noneSessions - a.noneSessions || b.mentionSessions - a.mentionSessions || a.rel.localeCompare(b.rel));
  return { name: skillName, invokedSessions, rows };
}
