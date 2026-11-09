// 静的グラフ × セッション記録の対応付け（Phase 1 CLI と同一ロジック）。
// 照合は「文字列の中にパスが含まれるか」の部分一致（絶対パス／特徴的なサフィックス）。
// グレード: A=内容がコンテキストへ読み込まれた証拠 / B=読み取りツール成功 / C=言及のみ。
// 記録がないノードは「記録なし」とだけ表示し、「未到達」とは言わない。
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { normPath, toSlashes, type Graph, type GraphNode } from "./graph";
import { findNumber, findString, type ParsedEvents } from "./events";
import type { Lang } from "./common";

export type Grade = "A" | "B" | "C" | null;

/** 到達の確度（表示用）: 内部の A/B/C を、読む人にそのまま伝わる言葉に置く */
export function gradeWord(grade: Grade, lang: Lang = "ja"): string {
  if (lang === "en") return grade === "A" ? "High" : grade === "B" ? "Medium" : grade === "C" ? "Low" : "";
  return grade === "A" ? "高" : grade === "B" ? "中" : grade === "C" ? "低" : "";
}
export function gradeCertaintyLabel(grade: Grade, lang: Lang = "ja"): string {
  const w = gradeWord(grade, lang);
  if (lang === "en") return w ? w : "No record";
  return w ? `確度${w}` : "記録なし";
}
export interface TraceNode {
  id: string;
  relToSkill: string;
  relToWorkspace: string;
  name: string;
  boundary: boolean;
  missing: boolean;
  cycle: boolean;
  depth: number | null;
  estTokens: number;
  sizeBytes: number;
  grade: Grade;
  evidence: string;
  firstAt: string | null;
  order: number | null;
  failed: boolean;
  title: string | null;
  parents: string[];
  children: string[];
}
export interface OutsideRead { path: string; at: string | null; tool: string; failed: boolean; title: string | null }
export interface Trace {
  /** 記録の供給源（未指定は Copilot として扱う。SessionTrace と同じ任意項目） */
  source?: "copilot" | "kiro" | "vscode";
  creditsTotal?: number;
  creditTurns?: { turn: number; credits: number; usedTools: string[] }[];
  contextUsageSeries?: { at: string | null; ratio: number }[];
  lastContextUsageRatio?: number | null;
  session: { id: string; startedAt: string | null; workspace: string; skillDir: string; skillName: string; userMessagePreview: string; userMessageTruncated: boolean };
  health: ParsedEvents["health"];
  contextCurrentSeries: { at: string; tokens: number }[];
  lastContextCurrentTokens: number | null;
  contextTokenLimit: number | null;
  contextFillRatio: number | null;
  turns: { turn: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number }[];
  totals: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number };
  toolExecutions: { at: string | null; toolName: string; success: boolean }[];
  nodes: TraceNode[];
  outsideReads: OutsideRead[];
}

// 記録中のパスがグラフ内ノードのものかを判定する。
// 絶対パスの包含に加え、ワークスペース相対パスのサフィックス一致も見る
// （記録とグラフ構築でルートが異なる表記でも、同じファイルを取りこぼさないため）。
export function pathBelongsToNodes(p: string, nodes: Iterable<{ id: string; relToWorkspace: string }>): boolean {
  for (const n of nodes) {
    if (p.includes(n.id) || n.id.includes(p)) return true;
    const rel = normPath(n.relToWorkspace);
    if (rel && !rel.startsWith("..") && p.endsWith("/" + rel)) return true;
  }
  return false;
}

const TOKEN_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const;
type TokenKey = (typeof TOKEN_KEYS)[number];
type UsageRec = { at: string | null; contextCurrentTokens?: number } & Partial<Record<TokenKey, number>>;

export function buildTrace(parsed: ParsedEvents, graph: Graph, opts: { sessionId: string; workspaceAbs: string; skillDirAbs: string; rootHeading: string | null; lang?: Lang }): Trace {
  const en = opts.lang === "en";
  const { events } = parsed;
  const nodesById = graph.nodes;

  function matchNode(text: string): GraphNode[] {
    const t = normPath(text);
    const hits: GraphNode[] = [];
    for (const n of nodesById.values()) {
      if (n.missing) continue;
      const abs = n.id;
      if (t.includes(abs)) { hits.push(n); continue; }
      const segs = abs.split("/");
      if (segs.length >= 2) {
        const suffix = segs.slice(-3).join("/");
        if (suffix.length > 8 && t.includes(suffix)) { hits.push(n); continue; }
        const tail2 = segs.slice(-2).join("/");
        if (t.endsWith("/" + tail2) || t.includes("/" + tail2)) hits.push(n);
      }
    }
    return hits;
  }
  function mentionedNodes(ev: (typeof events)[number]): GraphNode[] {
    const map = new Map<string, GraphNode>();
    for (const s of ev.strings) for (const h of matchNode(s)) if (!map.has(h.id)) map.set(h.id, h);
    return [...map.values()];
  }

  const fileReads: { nodeId: string; at: string | null; tool: string }[] = [];
  const failedReads: { nodeId: string }[] = [];
  const failedOutsidePaths = new Set<string>();
  const delivered = new Set<string>();
  const deliveredAt = new Map<string, string | null>();
  const inferred = new Map<string, { at: string | null; via: string }>();
  const outsideReads = new Map<string, { path: string; at: string | null; tool: string }>();
  const usageRecords: UsageRec[] = [];
  const turns: Trace["turns"] = [];
  let currentTurn: Trace["turns"][number] | null = null;
  const toolStartNames = new Map<string, string>();
  const toolExecutions: Trace["toolExecutions"] = [];
  let rootInvokedA: { at: string | null } | null = null;
  let lastCtxAny: number | null = null;

  const PATH_RE = /(?:[a-zA-Z]:)?(?:[\\/][^\\/:*?"<>|\s]+)+?\.(?:md|markdown|txt|json|ya?ml|toml|xml|csv)/g;
  function noteOutside(ev: (typeof events)[number]): void {
    for (const s of ev.strings) {
      for (const m of s.matchAll(PATH_RE)) {
        const p = normPath(m[0]);
        if (pathBelongsToNodes(p, nodesById.values())) continue;
        if (!outsideReads.has(p)) {
          outsideReads.set(p, { path: m[0], at: ev.at, tool: findString(ev.data, ["toolName"]) ?? ev.type });
        }
      }
    }
  }

  for (const ev of events) {
    const ctxAny = findNumber(ev.data, ["context_current_tokens"]);
    if (typeof ctxAny === "number") lastCtxAny = ctxAny;
    switch (ev.type) {
      case "assistant.turn_start":
        currentTurn = { turn: turns.length, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
        turns.push(currentTurn);
        break;
      case "assistant.turn_end":
        currentTurn = null;
        break;
      case "skill.invoked":
        if (opts.rootHeading && ev.strings.some(s => s.includes(opts.rootHeading!))) rootInvokedA = { at: ev.at };
        for (const n of mentionedNodes(ev)) if (!inferred.has(n.id)) inferred.set(n.id, { at: ev.at, via: ev.type });
        break;
      case "skill.invoked_ref":
        for (const n of mentionedNodes(ev)) if (!inferred.has(n.id)) inferred.set(n.id, { at: ev.at, via: ev.type });
        break;
      case "skill.context_delivered_ref":
        for (const n of mentionedNodes(ev)) {
          delivered.add(n.id);
          if (!deliveredAt.has(n.id)) deliveredAt.set(n.id, ev.at);
        }
        break;
      case "tool.execution_start": {
        const cid = findString(ev.data, ["toolCallId", "toolCallID", "callId"]);
        const tn = findString(ev.data, ["toolName"]) ?? findString(ev.data, ["tool"]);
        if (cid && tn) toolStartNames.set(cid, tn);
        for (const n of mentionedNodes(ev)) if (!inferred.has(n.id)) inferred.set(n.id, { at: ev.at, via: ev.type });
        noteOutside(ev);
        break;
      }
      case "tool.execution_complete": {
        const success = ev.data["success"] !== false && !ev.data["error"];
        const cid = findString(ev.data, ["toolCallId", "toolCallID", "callId"]);
        const toolName = findString(ev.data, ["toolName"]) ?? (cid ? toolStartNames.get(cid) : undefined) ?? "tool";
        const mentioned = mentionedNodes(ev);
        toolExecutions.push({ at: ev.at, toolName, success });
        for (const n of mentioned) {
          if (success) fileReads.push({ nodeId: n.id, at: ev.at, tool: toolName });
          else failedReads.push({ nodeId: n.id });
        }
        if (!success) {
          for (const s of ev.strings) for (const m of s.matchAll(PATH_RE)) failedOutsidePaths.add(normPath(m[0]));
        }
        if (mentioned.length === 0) noteOutside(ev);
        break;
      }
      case "session.usage_record": {
        const rec: UsageRec = { at: ev.at };
        for (const k of TOKEN_KEYS) { const v = findNumber(ev.data, [k]); if (typeof v === "number") rec[k] = v; }
        const ctx = findNumber(ev.data, ["context_current_tokens"]);
        if (typeof ctx === "number") rec.contextCurrentTokens = ctx;
        if (Object.keys(rec).length > 1) {
          usageRecords.push(rec);
          if (currentTurn) for (const k of TOKEN_KEYS) if (rec[k]) currentTurn[k] = (currentTurn[k] ?? 0) + (rec[k] as number);
        }
        break;
      }
      default:
        for (const n of mentionedNodes(ev)) if (!inferred.has(n.id)) inferred.set(n.id, { at: ev.at, via: ev.type });
        break;
    }
  }

  const readBy = new Map<string, { at: string | null; tool: string }>();
  for (const r of fileReads) if (!readBy.has(r.nodeId)) readBy.set(r.nodeId, r);

  const traceNodes: TraceNode[] = graph.order.map(gn => {
    let grade: Grade = null;
    let evidence = en ? "No matching event" : "イベントに対応付けなし";
    let firstAt: string | null = null;
    if (delivered.has(gn.id)) {
      grade = "A";
      evidence = en ? "Mentioned in skill.context_delivered_ref (content loaded into context)" : "skill.context_delivered_ref で言及（内容がコンテキストへ読み込まれた）";
      firstAt = deliveredAt.get(gn.id) ?? null;
    } else if (readBy.has(gn.id)) {
      grade = "B";
      evidence = en ? `tool.execution_complete succeeded (${readBy.get(gn.id)!.tool})` : `tool.execution_complete 成功 (${readBy.get(gn.id)!.tool})`;
      firstAt = readBy.get(gn.id)!.at;
    } else if (inferred.has(gn.id)) {
      grade = "C";
      evidence = en ? `Mention only in ${inferred.get(gn.id)!.via}` : `${inferred.get(gn.id)!.via} での言及のみ`;
      firstAt = inferred.get(gn.id)!.at;
    }
    if (gn.id === graph.rootId && rootInvokedA && grade !== "A") {
      grade = "A";
      evidence = en ? "SKILL.md heading found in skill.invoked (body loaded on activation)" : "skill.invoked 内に SKILL.md の見出しを確認（起動時に本文が読み込まれた）";
      firstAt = rootInvokedA.at;
    }
    return {
      id: gn.id, relToSkill: gn.relToSkill, relToWorkspace: gn.relToWorkspace, name: gn.name,
      boundary: gn.boundary, missing: gn.missing, cycle: gn.cycle, depth: gn.depth,
      estTokens: gn.estTokens, sizeBytes: gn.sizeBytes,
      grade, evidence, firstAt, order: null,
      failed: failedReads.some(r => r.nodeId === gn.id),
      title: gn.title,
      parents: gn.parents.map(p => nodesById.get(p)?.relToSkill ?? p),
      children: gn.children.map(c => nodesById.get(c)?.relToSkill ?? c),
    };
  });
  const reachedSorted = traceNodes.filter(r => r.firstAt).sort((a, b) => String(a.firstAt).localeCompare(String(b.firstAt)));
  reachedSorted.forEach((r, i) => { r.order = i + 1; });

  const totals: Trace["totals"] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  for (const r of usageRecords) for (const k of TOKEN_KEYS) if (r[k]) totals[k] += r[k] as number;
  const lastCtxRec = [...usageRecords].reverse().find(r => typeof r.contextCurrentTokens === "number");
  const lastContextCurrentTokens = lastCtxRec?.contextCurrentTokens ?? lastCtxAny;
  const contextTokenLimit = parsed.contextTokenLimit;

  return {
    session: {
      id: opts.sessionId, startedAt: parsed.startedAt, workspace: toSlashes(opts.workspaceAbs),
      skillDir: toSlashes(resolve(opts.skillDirAbs)), skillName: basename(resolve(opts.skillDirAbs)),
      userMessagePreview: parsed.firstUserMessage,
      userMessageTruncated: parsed.firstUserMessageTruncated,
    },
    health: parsed.health,
    contextCurrentSeries: parsed.contextCurrentSeries,
    lastContextCurrentTokens,
    contextTokenLimit,
    contextFillRatio: contextTokenLimit && lastContextCurrentTokens !== null ? lastContextCurrentTokens / contextTokenLimit : null,
    turns, totals, toolExecutions,
    nodes: traceNodes,
    outsideReads: [...outsideReads.values()].map(r => ({
      ...r,
      failed: failedOutsidePaths.has(normPath(r.path)),
      title: readOutsideTitle(r.path),
    })),
  };
}

// スキル外ファイルのタイトル（絶対パスで実在する場合だけ、最初の見出しを読む）
function readOutsideTitle(p: string): string | null {
  if (!/^[a-zA-Z]:[\\/]/.test(p) && !p.startsWith("/")) return null;
  try { return firstHeading(readFileSync(p, "utf8")); } catch { return null; }
}

// --- セッション全体のトレース（複数スキル対応） ---
// 1回のチャットで複数スキルが呼ばれうるため、Trace の単位はセッションに置く。
// 各スキルは SkillPart として保持し、到達順はセッション全体の通し番号に付け替える
// （同じファイルが複数スキルから到達した場合は全スキルで同じ番号になる）。
export interface SkillPart {
  skillName: string;
  skillDir: string;
  graph: Graph;
  nodes: TraceNode[];
}
export interface SessionTrace {
  session: { id: string; startedAt: string | null; workspace: string; userMessagePreview: string; userMessageTruncated: boolean };
  /** 記録の供給源（未指定は Copilot として扱う） */
  source?: "copilot" | "kiro" | "vscode";
  /** Kiro: クレジット実測の合計（usage_summary の積算） */
  creditsTotal?: number;
  /** Kiro: ターン別のクレジット実測 */
  creditTurns?: { turn: number; credits: number; usedTools: string[] }[];
  /** Kiro: コンテキストウィンドウ使用率の推移（0..1、contextUsage スナップショット） */
  contextUsageSeries?: { at: string | null; ratio: number }[];
  /** Kiro: 最後のコンテキストウィンドウ使用率（0..1） */
  lastContextUsageRatio?: number | null;
  /** Kiro: 常時文脈としてコンテキストに読み込まれた文書（steering_inclusion 等の documents） */
  contextLoads?: { path: string; at: string | null }[];
  /** 記録では起動が確認できたが、現在のワークスペースで見つからなかったスキル名。
   *  起動の判定を「発見できたスキル」との照合だけで行うと、移動・改名・削除された
   *  スキルの起動が記録から消えてしまうため、名前だけでも残す（2026-11-08 の不具合対応） */
  undiscoveredSkills?: string[];
  health: ParsedEvents["health"];
  contextCurrentSeries: { at: string; tokens: number }[];
  lastContextCurrentTokens: number | null;
  contextTokenLimit: number | null;
  contextFillRatio: number | null;
  turns: Trace["turns"];
  totals: Trace["totals"];
  toolExecutions: Trace["toolExecutions"];
  skills: SkillPart[];
  outsideReads: OutsideRead[];
}

export function buildSessionTrace(
  parsed: ParsedEvents,
  parts: { graph: Graph; skillDirAbs: string; rootHeading: string | null }[],
  opts: { sessionId: string; workspaceAbs: string; lang?: Lang; undiscoveredSkills?: string[] },
): SessionTrace {
  const traces = parts.map(p => buildTrace(parsed, p.graph, {
    sessionId: opts.sessionId, workspaceAbs: opts.workspaceAbs, skillDirAbs: p.skillDirAbs, rootHeading: p.rootHeading, lang: opts.lang,
  }));

  // 到達順の通し番号化: ファイル（ノード id）ごとに最も早い初出時刻で一意に採番する
  const firstAtById = new Map<string, string>();
  for (const t of traces) for (const n of t.nodes) {
    if (!n.firstAt) continue;
    const cur = firstAtById.get(n.id);
    if (!cur || n.firstAt < cur) firstAtById.set(n.id, n.firstAt);
  }
  const orderedIds = [...firstAtById.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([id]) => id);
  const orderById = new Map(orderedIds.map((id, i) => [id, i + 1] as const));
  for (const t of traces) for (const n of t.nodes) n.order = n.firstAt ? (orderById.get(n.id) ?? null) : null;

  // 発見できたスキルが無いセッションでも、ターン・実測・ツール実行は記録から
  // 復元できる。空グラフで集計だけを行い、サマリを表示できるようにする
  // （Kiro / Copilot Chat で「中身が見えることが先」とした扱いに揃える）
  const aggregates = parts.length ? null : buildTrace(parsed, { rootId: "", nodes: new Map(), order: [] }, {
    sessionId: opts.sessionId, workspaceAbs: opts.workspaceAbs, skillDirAbs: "", rootHeading: null, lang: opts.lang,
  });

  // スキル外の読み取りは、全スキルのグラフの和集合に対して判定する
  const allNodes = traces.flatMap(t => t.nodes);
  const base = traces[0] ?? aggregates ?? undefined;
  const outsideReads = (base?.outsideReads ?? []).filter(r => !pathBelongsToNodes(normPath(r.path), allNodes));

  return {
    source: "copilot",
    session: {
      id: opts.sessionId,
      startedAt: base?.session.startedAt ?? parsed.startedAt,
      workspace: toSlashes(opts.workspaceAbs),
      userMessagePreview: parsed.firstUserMessage,
      userMessageTruncated: parsed.firstUserMessageTruncated,
    },
    health: parsed.health,
    contextCurrentSeries: base?.contextCurrentSeries ?? parsed.contextCurrentSeries,
    lastContextCurrentTokens: base?.lastContextCurrentTokens ?? null,
    contextTokenLimit: base?.contextTokenLimit ?? parsed.contextTokenLimit,
    contextFillRatio: base?.contextFillRatio ?? null,
    turns: base?.turns ?? [],
    totals: base?.totals ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    toolExecutions: base?.toolExecutions ?? [],
    skills: traces.map((t, i) => ({ skillName: t.session.skillName, skillDir: t.session.skillDir, graph: parts[i].graph, nodes: t.nodes })),
    outsideReads,
    undiscoveredSkills: opts.undiscoveredSkills,
  };
}

export function firstHeading(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^#\s+(.+)/);
    if (m) return m[1].trim();
  }
  return null;
}
