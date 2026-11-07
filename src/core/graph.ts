// 静的グラフ: SKILL.md から参照を辿ってファイルの木を作る。
// 規則（SkillMap-Solo と統一）: 深さ上限なし、スキルディレクトリ外は「スキル外」ノード、
// 循環は葉で打ち切り、存在しない参照先は missing として残す。
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

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
}

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
  while (queue.length) {
    const node = queue.shift()!;
    if (expanded.has(node.id) || node.missing) continue;
    expanded.add(node.id);
    let text = "";
    try { text = readFileSync(node.absPath, "utf8"); } catch { node.missing = true; continue; }
    node.sizeBytes = Buffer.byteLength(text, "utf8");
    node.estTokens = estimateTokens(text);
    node.title = firstHeadingLine(text);
    for (const ref of extractReferences(text)) {
      const childAbs = resolve(dirname(node.absPath), ref);
      const child = getNode(childAbs, node.id);
      if (!node.children.includes(child.id)) node.children.push(child.id);
      if (child.id === node.id || (child.parents.length > 0 && isAncestor(child.id, node.id))) { child.cycle = true; continue; }
      if (child.depth === null) child.depth = node.boundary ? node.depth : (node.depth ?? 0) + 1;
      if (!expanded.has(child.id)) queue.push(child);
    }
  }
  return { rootId: root.id, nodes, order };
}
