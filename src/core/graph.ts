// 静的グラフ: SKILL.md から参照を辿ってファイルの木を作る。
// 規則（SkillMap-Solo と統一）: 深さ上限なし、スキルディレクトリ外は「スキル外」ノード、
// 循環は葉で打ち切り、存在しない参照先は missing として残す。
// ただし走査の総量には歯止めをかける（監査 2026-11-22）: ノード数と
// 読み取り総バイト数に上限を設け、超過したら打ち切って notes に残す。
// また、許可ルート（スキルディレクトリとワークスペース）の外へ解決される
// 参照先については見出しを取得せず、パスの表示のみに留める。
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { MAX_GRAPH_FILE_BYTES, readTextFileWithinLimit } from "./readfile";

export function normPath(p: string): string {
  let s = String(p).replace(/\\/g, "/");
  s = s.replace(/^file:\/\//i, "");
  try { s = decodeURIComponent(s); } catch { /* そのまま */ }
  const parts: string[] = [];
  for (const seg of s.split("/")) {
    if (seg === "" || seg === ".") { if (parts.length === 0 && seg === "") parts.push(""); continue; }
    if (seg === "..") { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join("/").toLowerCase();
}
export function toSlashes(p: string): string { return String(p).split(sep).join("/"); }

/**
 * 正規化済みの記録パスがスキルフォルダ内を指しているかを判定し、指していれば
 * フォルダ内相対パスを、そうでなければ null を返す。
 * 絶対パスはフォルダ配下かどうかだけで判定する（読み取りに失敗したファイルは
 * 実在しなくても、パス自体が場所を示している）。相対パス（スキル名を含む形や
 * スキルルート相対の形）は、同名の別ファイルをスキル内と誤認しないよう、
 * 実ファイルの存在で裏を取る。
 */
/**
 * フォルダ配下に、相対セグメント列が指すファイルが実在するかを返す。
 * 記録パスは正規化で小文字化されているため、そのまま existsSync に渡すと
 * 大文字小文字を区別するファイルシステムでは実在するファイルを見落とす。
 * フォルダ内の実名と小文字同士で突き合わせながら辿る。
 */
function existsUnderDir(dirAbs: string, relSegs: string[]): boolean {
  let cur = dirAbs;
  for (const seg of relSegs) {
    let names: string[];
    try { names = readdirSync(cur); } catch { return false; }
    const hit = names.find(name => name.toLowerCase() === seg);
    if (hit === undefined) return false;
    cur = join(cur, hit);
  }
  return existsSync(cur);
}

export function skillDirRelativePath(recordedNorm: string, skillDirAbs: string): string | null {
  const dir = normPath(skillDirAbs);
  const p = recordedNorm;
  if (p === dir) return null;
  if (p.startsWith(dir + "/")) return p.slice(dir.length + 1);
  // 配下でない絶対パスはここで打ち切る。スキル名と同名の別フォルダ配下の
  // ファイルをスキル内と誤認しないよう、存在確認によるフォールバックは
  // 相対パスだけに適用する
  if (p.startsWith("/") || /^[a-z]:/.test(p)) return null;
  const segs = p.split("/");
  const base = dir.split("/").pop() ?? "";
  // 例: ../<スキル名>/references/docs/guide.md（正規化で先頭の ../ は落ちている）
  const idx = base ? segs.lastIndexOf(base) : -1;
  if (idx >= 0 && idx < segs.length - 1) {
    const rel = segs.slice(idx + 1).join("/");
    if (existsUnderDir(skillDirAbs, rel.split("/"))) return rel;
  }
  // スキルルート相対（例: references/docs/guide.md）。区切りを含まない
  // ファイル名だけの断片は誤認しやすいため対象にしない
  if (p.includes("/")) {
    if (existsUnderDir(skillDirAbs, p.split("/"))) return p;
  }
  return null;
}

// トークン推定（概算。実測とは混ぜない表示用）
export function estimateTokens(text: string): number {
  let ascii = 0, other = 0;
  for (const ch of text) { if ((ch.codePointAt(0) ?? 0) < 0x80) ascii++; else other++; }
  return Math.ceil(ascii / 4 + other * 0.9);
}

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const CODE_RE = /`([^`\n]+)`/g;
const DOC_EXT = /\.(md|markdown|txt|json|ya?ml|toml|xml|csv)$/i;
export function extractReferences(text: string): string[] {
  const refs: string[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    const t = m[1].trim();
    if (/^(https?:|mailto:|#)/i.test(t)) continue;
    refs.push(t.split("#")[0]);
  }
  for (const m of text.matchAll(CODE_RE)) {
    const t = m[1].trim();
    if (/[/\\]/.test(t) && DOC_EXT.test(t)) refs.push(t);
  }
  return [...new Set(refs)];
}

export interface GraphNode {
  id: string;
  absPath: string;
  name: string;
  relToSkill: string;
  relToWorkspace: string;
  boundary: boolean;
  missing: boolean;
  cycle: boolean;
  children: string[];
  parents: string[];
  depth: number | null;
  estTokens: number;
  sizeBytes: number;
  /** 文書のタイトル（最初の見出し）。無ければ null */
  title: string | null;
}

function firstHeadingLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^#\s+(.+)/);
    if (m) return m[1].trim();
  }
  return null;
}
export interface Graph {
  rootId: string;
  nodes: Map<string, GraphNode>;
  order: GraphNode[];
  /** 走査を打ち切った場合の注記（上限の理由）。打ち切りが無ければ空 */
  notes: string[];
}

/** グラフ走査のノード数上限。細工したスキルで際限なく辿り続けないための歯止め */
export const MAX_GRAPH_NODES = 500;
/** グラフ走査で読む総バイト数の上限（1ファイル上限 MAX_GRAPH_FILE_BYTES とは別の総量） */
export const MAX_GRAPH_TOTAL_BYTES = 64 * 1024 * 1024;

export function buildGraph(skillDirAbs: string, workspaceAbs: string): Graph {
  const rootAbs = resolve(skillDirAbs);
  const nodes = new Map<string, GraphNode>();
  const order: GraphNode[] = [];
  function getNode(abs: string, via: string | null): GraphNode {
    const key = normPath(abs);
    if (!nodes.has(key)) {
      const relSkill = toSlashes(relative(rootAbs, abs));
      const outside = relSkill.startsWith("..");
      const node: GraphNode = {
        id: key, absPath: toSlashes(abs), name: basename(abs),
        relToSkill: outside ? relSkill : (relSkill || basename(abs)),
        relToWorkspace: toSlashes(relative(resolve(workspaceAbs), abs)),
        boundary: outside, missing: !existsSync(abs), cycle: false,
        children: [], parents: [], depth: null, estTokens: 0, sizeBytes: 0, title: null,
      };
      nodes.set(key, node); order.push(node);
    }
    const n = nodes.get(key)!;
    if (via && !n.parents.includes(via)) n.parents.push(via);
    return n;
  }
  function isAncestor(maybeAncestorId: string, nodeId: string): boolean {
    const seen = new Set<string>(); const stack = [nodeId];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === maybeAncestorId) return true;
      if (seen.has(cur)) continue; seen.add(cur);
      const n = nodes.get(cur); if (n) stack.push(...n.parents);
    }
    return false;
  }
  const root = getNode(join(rootAbs, "SKILL.md"), null);
  root.depth = 0;
  const queue: GraphNode[] = [root];
  const expanded = new Set<string>();
  const notes: string[] = [];
  let totalBytes = 0;
  let capped = false;
  const noteCap = (note: string): void => { if (!capped) { capped = true; notes.push(note); } };
  while (queue.length) {
    const node = queue.shift()!;
    if (expanded.has(node.id) || node.missing) continue;
    expanded.add(node.id);
    if (totalBytes >= MAX_GRAPH_TOTAL_BYTES) {
      noteCap(`参照グラフの走査を打ち切りました（読み取り総量の上限 ${MAX_GRAPH_TOTAL_BYTES} バイトに達したため）`);
      break;
    }
    // 参照先が巨大なファイルや通常ファイルでない場合は、読み飛ばして
    // missing 相当として扱う（監査 F4: 参照はワークスペース外も取りうる）。
    // 確認と読み取りは readfile 側で同じ fd に対して行う（パス確認後の
    // 差し替えで上限を迂回できないように）
    const text = readTextFileWithinLimit(node.absPath, MAX_GRAPH_FILE_BYTES);
    if (text === null) { node.missing = true; continue; }
    node.sizeBytes = Buffer.byteLength(text, "utf8");
    totalBytes += node.sizeBytes;
    node.estTokens = estimateTokens(text);
    // 許可ルート（スキルディレクトリとワークスペース）の外のファイルは
    // 見出しを取得しない。辿ること自体は設計どおりだが、外の文書の見出しが
    // ツールチップやサマリに載ることまでは意図していない（監査 2026-11-22）
    const outsideRoots = node.boundary && node.relToWorkspace.startsWith("..");
    node.title = outsideRoots ? null : firstHeadingLine(text);
    for (const ref of extractReferences(text)) {
      const childAbs = resolve(dirname(node.absPath), ref);
      if (!nodes.has(normPath(childAbs)) && nodes.size >= MAX_GRAPH_NODES) {
        noteCap(`参照グラフの走査を打ち切りました（ノード数の上限 ${MAX_GRAPH_NODES} に達したため）`);
        break;
      }
      const child = getNode(childAbs, node.id);
      if (!node.children.includes(child.id)) node.children.push(child.id);
      if (child.id === node.id || (child.parents.length > 0 && isAncestor(child.id, node.id))) { child.cycle = true; continue; }
      if (child.depth === null) child.depth = node.boundary ? node.depth : (node.depth ?? 0) + 1;
      if (!expanded.has(child.id)) queue.push(child);
    }
  }
  return { rootId: root.id, nodes, order, notes };
}
