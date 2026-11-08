// Kiro v3 セッションストア（~/.kiro/sessions/<bucket>/sess_<uuid>/）の読み取りと、
// Copilot 版と同じ SessionTrace への対応付け（Phase 0 実機確認 2026-11-07/08）。
// 記録の形: session.json（メタ）＋ messages.jsonl（{id, timestamp, payload} の封筒）。
// 確度の物差しは Copilot 版と共通: 高=コンテキストへの読み込みが記録で確認できる、
// 中=読み取りツールの成功、低=言及のみ。実測はトークンではなくクレジット。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { normPath, toSlashes, type Graph, type GraphNode } from "./graph";
import { collectStrings, type ParseHealth } from "./events";
import { firstHeading, type Grade, type OutsideRead, type SessionTrace, type TraceNode } from "./trace";

/** 起動（disclose_context）したスキルの SKILL.md の確度。
 *  開示は「文脈へ読み込む」仕組みそのものなので確度高とする（2026-11-08 決定） */
export const DISCLOSED_ROOT_GRADE: Grade = "A";

const KNOWN_TYPES = new Set([
  "session_start", "session_event", "session_metadata", "user", "assistant",
  "turn_start", "turn_end", "tool_call", "tool_result", "usage_summary",
  "steering_inclusion", "pending_interaction", "interaction_resolved", "agent_note",
]);

// --- セッション列挙 ---

export interface KiroSessionInfo {
  id: string;
  dir: string;
  eventsPath: string;
  mtimeMs: number;
  title: string | null;
  createdAt: string | null;
  modelId: string | null;
  workspacePaths: string[];
  rootPaths: string[];
}

export function defaultKiroHome(): string {
  return join(homedir(), ".kiro");
}

export function listKiroSessions(kiroHome: string): KiroSessionInfo[] {
  const base = join(kiroHome, "sessions");
  if (!existsSync(base)) return [];
  const out: KiroSessionInfo[] = [];
  for (const bucket of readdirSync(base)) {
    const bucketDir = join(base, bucket);
    try { if (!statSync(bucketDir).isDirectory()) continue; } catch { continue; }
    for (const name of readdirSync(bucketDir)) {
      if (!name.startsWith("sess_")) continue;
      const dir = join(bucketDir, name);
      const eventsPath = join(dir, "messages.jsonl");
      try {
        if (!statSync(dir).isDirectory() || !existsSync(eventsPath)) continue;
      } catch { continue; }
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as Record<string, unknown>; } catch { /* メタが読めなくても列挙はする */ }
      const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      out.push({
        id: typeof meta.id === "string" ? meta.id : name,
        dir,
        eventsPath,
        mtimeMs: statSync(eventsPath).mtimeMs,
        title: typeof meta.title === "string" ? meta.title : null,
        createdAt: typeof meta.createdAt === "string" ? meta.createdAt : null,
        modelId: typeof meta.modelId === "string" ? meta.modelId : null,
        workspacePaths: strings(meta.workspacePaths),
        rootPaths: strings(meta.rootPaths),
      });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// --- messages.jsonl の解析 ---

export interface KiroEvent {
  seq: number;
  at: string | null;
  type: string;
  payload: Record<string, unknown>;
  strings: string[];
}

export interface KiroParsed {
  events: KiroEvent[];
  health: ParseHealth;
  startedAt: string | null;
  firstUserMessage: string;
  firstUserMessageTruncated: boolean;
  activations: { name: string; at: string | null; seq: number }[];
  /** 常時文脈の取り込み（steering_inclusion と user の documents。生の URI 表記を保持） */
  inclusions: { documents: string[]; at: string | null; seq: number }[];
  creditTurns: { credits: number; usedTools: string[]; at: string | null }[];
  creditsTotal: number;
  contextUsageSeries: { at: string | null; ratio: number }[];
  toolExecutions: { at: string | null; toolName: string; success: boolean }[];
}

function userText(payload: Record<string, unknown>): string {
  const c = payload.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const b of c) {
      if (typeof b === "string") parts.push(b);
      else if (b && typeof b === "object") {
        const t = (b as Record<string, unknown>).text;
        if (typeof t === "string") parts.push(t);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/** tool_result の成功判定。実機確認（2026-11-08）で payload に success（真偽値）が
 *  あることが分かっているため、それを正とする。無い形式では失敗の印だけを見る */
export function isKiroToolSuccess(payload: Record<string, unknown>): boolean {
  if (typeof payload.success === "boolean") return payload.success;
  if (payload.error) return false;
  const st = typeof payload.status === "string" ? payload.status.toLowerCase() : "";
  if (st === "error" || st === "failed" || st === "failure") return false;
  const oc = typeof payload.outcome === "string" ? payload.outcome.toLowerCase() : "";
  if (oc === "error" || oc === "failed" || oc === "failure") return false;
  return true;
}

/** 記録にある disclose_context の起動名を、候補と照合せずすべて拾う軽量スキャン。
 *  読めない場合は null。スキルが現在のワークスペースで見つからない場合でも、
 *  「記録では起動していた」こと自体は分かるようにするためのもの */
export function scanKiroActivationNames(eventsPath: string): string[] | null {
  let text: string;
  try { text = readFileSync(eventsPath, "utf8"); } catch { return null; }
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("disclose_context")) continue;
    try {
      const env = JSON.parse(line) as { payload?: Record<string, unknown> };
      const p = env.payload;
      if (!p || p.type !== "tool_call" || p.actionType !== "disclose_context") continue;
      const args = p.args as Record<string, unknown> | undefined;
      if (args && typeof args.name === "string" && !names.includes(args.name)) {
        names.push(args.name);
      }
    } catch { /* 壊れた行は読み飛ばす */ }
  }
  return names;
}

/** 履歴ラベル用の軽量スキャン: disclose_context の行だけを解析し、
 *  起動したスキル名を返す。候補が無い・読めない場合は null（未判定） */
export function scanKiroInvokedSkillNames(eventsPath: string, candidates: { name: string; dir: string }[]): string[] | null {
  if (!candidates.length) return null;
  const all = scanKiroActivationNames(eventsPath);
  if (all === null) return null;
  const candNames = new Set(candidates.map(c => c.name));
  return all.filter(n => candNames.has(n));
}

export async function parseKiroMessagesFile(path: string): Promise<KiroParsed> {
  const { readFile } = await import("node:fs/promises");
  return parseKiroMessages(await readFile(path, "utf8"));
}

export function parseKiroMessages(text: string): KiroParsed {
  const events: KiroEvent[] = [];
  const health: ParseHealth = { totalLines: 0, parsedLines: 0, skippedLines: 0, typeCounts: {}, unknownEventTypes: {}, unknownRatio: 0 };
  const activations: KiroParsed["activations"] = [];
  const inclusions: KiroParsed["inclusions"] = [];
  const creditTurns: KiroParsed["creditTurns"] = [];
  const contextUsageSeries: KiroParsed["contextUsageSeries"] = [];
  const toolExecutions: KiroParsed["toolExecutions"] = [];
  let creditsTotal = 0;
  let firstUserMessage = "";
  let firstUserMessageTruncated = false;
  let startedAt: string | null = null;

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    health.totalLines++;
    let env: Record<string, unknown>;
    try { env = JSON.parse(line) as Record<string, unknown>; } catch { health.skippedLines++; continue; }
    const payload = (env.payload && typeof env.payload === "object" ? env.payload : {}) as Record<string, unknown>;
    const type = typeof payload.type === "string" ? payload.type : "";
    const at = typeof env.timestamp === "string" ? env.timestamp : null;
    if (startedAt === null && at) startedAt = at;
    health.parsedLines++;
    health.typeCounts[type] = (health.typeCounts[type] || 0) + 1;
    if (!KNOWN_TYPES.has(type)) health.unknownEventTypes[type] = (health.unknownEventTypes[type] || 0) + 1;
    const ev: KiroEvent = { seq: events.length, at, type, payload, strings: collectStrings(payload) };
    events.push(ev);

    if (type === "user" && !firstUserMessage) {
      const t = userText(payload);
      if (t) {
        firstUserMessage = t.length > 120 ? t.slice(0, 120) : t;
        firstUserMessageTruncated = t.length > 120;
      }
    }
    if (type === "tool_call" && payload.actionType === "disclose_context") {
      const args = payload.args as Record<string, unknown> | undefined;
      if (args && typeof args.name === "string") activations.push({ name: args.name, at, seq: ev.seq });
    }
    if ((type === "steering_inclusion" || type === "user") && Array.isArray(payload.documents)) {
      const documents = payload.documents.filter((d): d is string => typeof d === "string");
      if (documents.length) inclusions.push({ documents, at, seq: ev.seq });
    }
    if (type === "usage_summary") {
      const sums = Array.isArray(payload.promptTurnSummaries) ? payload.promptTurnSummaries : [];
      let credits = 0;
      const usedTools: string[] = [];
      for (const s of sums) {
        if (!s || typeof s !== "object") continue;
        const rec = s as Record<string, unknown>;
        if (typeof rec.usage === "number") credits += rec.usage;
        if (Array.isArray(rec.usedTools)) for (const t of rec.usedTools) if (typeof t === "string") usedTools.push(t);
      }
      creditTurns.push({ credits, usedTools, at });
      creditsTotal += credits;
    }
    if (type === "session_metadata" && payload.key === "contextUsage") {
      const v = payload.value as Record<string, unknown> | undefined;
      if (v && typeof v.usagePercentage === "number") contextUsageSeries.push({ at, ratio: v.usagePercentage / 100 });
    }
  }
  health.unknownRatio = health.parsedLines
    ? Object.values(health.unknownEventTypes).reduce((a, b) => a + b, 0) / health.parsedLines
    : 0;

  // toolExecutions は tool_call / tool_result の対応付けで作る。
  // 対応キーは toolCallId（executionId はターン全体で共通の値なので使えない。
  // 2026-11-08 実フィクスチャで確認）
  const callKey = (payload: Record<string, unknown>): string | null =>
    typeof payload.toolCallId === "string" ? payload.toolCallId
      : typeof payload.executionId === "string" ? payload.executionId : null;
  const callById = new Map<string, { actionType: string; at: string | null }>();
  for (const ev of events) {
    if (ev.type === "tool_call") {
      const k = callKey(ev.payload);
      if (k) callById.set(k, { actionType: String(ev.payload.actionType ?? "tool"), at: ev.at });
    }
  }
  for (const ev of events) {
    if (ev.type !== "tool_result") continue;
    const k = callKey(ev.payload);
    const call = k ? callById.get(k) : undefined;
    toolExecutions.push({ at: ev.at, toolName: call?.actionType ?? "tool", success: isKiroToolSuccess(ev.payload) });
  }

  return { events, health, startedAt, firstUserMessage, firstUserMessageTruncated, activations, inclusions, creditTurns, creditsTotal, contextUsageSeries, toolExecutions };
}

/** 表示用のパス表記（file:// を外し、% エンコードを戻す。大文字小文字は保持する） */
export function displayPath(raw: string): string {
  let s = String(raw).replace(/\\/g, "/");
  s = s.replace(/^file:\/\//i, "");
  try { s = decodeURIComponent(s); } catch { /* そのまま */ }
  if (/^\/[a-zA-Z]:/.test(s)) s = s.slice(1);
  return s;
}

// --- トレース構築 ---

function matchNodes(text: string, nodesById: Map<string, GraphNode>): GraphNode[] {
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

function readOutsideTitle(p: string): string | null {
  if (!/^[a-zA-Z]:[\\/]/.test(p) && !p.startsWith("/")) return null;
  try { return firstHeading(readFileSync(p, "utf8")); } catch { return null; }
}

export interface KiroSkillPartInput {
  graph: Graph;
  skillDirAbs: string;
  /** このスキルが disclose_context で起動されたか */
  disclosed: boolean;
}

export function buildKiroSessionTrace(
  parsed: KiroParsed,
  parts: KiroSkillPartInput[],
  opts: { sessionId: string; workspaceAbs: string },
): SessionTrace {
  // 供給源をまたいだ証拠の収集（seq は到達順の土台）
  const includedPaths = new Map<string, { at: string | null; seq: number }>(); // normPath → 初出
  const readPaths = new Map<string, { at: string | null; seq: number; success: boolean }>();
  // 対応キーは toolCallId（executionId はターン共通で衝突するため不可）
  const callKey = (payload: Record<string, unknown>): string | null =>
    typeof payload.toolCallId === "string" ? payload.toolCallId
      : typeof payload.executionId === "string" ? payload.executionId : null;
  const callById = new Map<string, { actionType: string; path: string | null }>();
  const outside = new Map<string, { path: string; at: string | null; tool: string; failed: boolean }>();

  const noteIncluded = (raw: string, at: string | null, seq: number): void => {
    const p = normPath(raw);
    if (!includedPaths.has(p)) includedPaths.set(p, { at, seq });
  };

  // 常時文脈の一覧（表示用表記を保持し、重複は最初の出現で代表させる）
  const contextLoads: { path: string; at: string | null }[] = [];
  {
    const seen = new Set<string>();
    for (const inc of parsed.inclusions) {
      for (const d of inc.documents) {
        noteIncluded(d, inc.at, inc.seq);
        const key = normPath(d);
        if (seen.has(key)) continue;
        seen.add(key);
        contextLoads.push({ path: displayPath(d), at: inc.at });
      }
    }
  }

  for (const ev of parsed.events) {
    if (ev.type === "tool_call") {
      const k = callKey(ev.payload);
      if (!k) continue;
      const args = ev.payload.args as Record<string, unknown> | undefined;
      const path = args && typeof args.path === "string" ? args.path : null;
      callById.set(k, { actionType: String(ev.payload.actionType ?? "tool"), path });
    }
    if (ev.type === "tool_result") {
      const k = callKey(ev.payload);
      const call = k ? callById.get(k) : undefined;
      if (call?.path && call.actionType === "read_files") {
        const p = normPath(call.path);
        const success = isKiroToolSuccess(ev.payload);
        const prev = readPaths.get(p);
        if (!prev) readPaths.set(p, { at: ev.at, seq: ev.seq, success });
        else if (success && !prev.success) readPaths.set(p, { at: ev.at, seq: ev.seq, success });
      }
    }
  }

  const allGraphs = parts.map(p => p.graph);
  const belongsToAny = (norm: string): boolean =>
    allGraphs.some(g => matchNodes(norm, g.nodes).length > 0);

  // スキル外: 読み取りのうち、どのグラフにも属さないもの。
  // 取り込み（inclusions）は「読み取り」ではなく常時文脈として別に示す
  for (const [p, r] of readPaths) {
    if (!belongsToAny(p)) outside.set(p, { path: p, at: r.at, tool: "read_files", failed: !r.success });
  }

  const firstSeqByNode = new Map<string, number>();
  const skills = parts.map(part => {
    const nodesById = part.graph.nodes;
    const nodes: TraceNode[] = part.graph.order.map(gn => {
      let grade: Grade = null;
      let evidence = "イベントに対応付けなし";
      let firstAt: string | null = null;
      let firstSeq: number | null = null;
      // このノードに対応する read_files（失敗の有無の判定にも使う）
      let rd: { at: string | null; seq: number; success: boolean } | undefined;
      for (const [p, r] of readPaths) {
        if (matchNodes(p, nodesById).some(h => h.id === gn.id)) { rd = r; break; }
      }
      // includedPaths のキーは記録側の表記で正規化されているため、グラフ側の
      // 絶対パスと表記がずれる場合は matchNodes で吸収する
      for (const [p, inc] of includedPaths) {
        if (matchNodes(p, nodesById).some(h => h.id === gn.id)) {
          grade = "A";
          evidence = "documents に列挙（内容がコンテキストへ読み込まれた）";
          firstAt = inc.at; firstSeq = inc.seq;
          break;
        }
      }
      if (grade === null && part.disclosed && gn.id === part.graph.rootId && DISCLOSED_ROOT_GRADE) {
        grade = DISCLOSED_ROOT_GRADE;
        evidence = "disclose_context によるスキル起動（内容がコンテキストへ開示された）";
        const act = parsed.activations.find(a => a.name === basename(resolve(part.skillDirAbs)));
        firstAt = act?.at ?? null; firstSeq = act?.seq ?? null;
      }
      if (grade === null && rd?.success) {
        grade = "B";
        evidence = "read_files の読み取り成功";
        firstAt = rd.at; firstSeq = rd.seq;
      }
      if (grade === null) {
        // 言及（確度低）: いずれかのイベントの文字列にパスが現れる
        for (const ev of parsed.events) {
          if (ev.strings.some(s => matchNodes(s, nodesById).some(h => h.id === gn.id))) {
            grade = "C";
            evidence = `${ev.type} での言及のみ`;
            firstAt = ev.at; firstSeq = ev.seq;
            break;
          }
        }
      }
      if (firstSeq !== null && !gn.missing) {
        const cur = firstSeqByNode.get(gn.id);
        if (cur === undefined || firstSeq < cur) firstSeqByNode.set(gn.id, firstSeq);
      }
      return {
        id: gn.id, relToSkill: gn.relToSkill, relToWorkspace: gn.relToWorkspace, name: gn.name,
        boundary: gn.boundary, missing: gn.missing, cycle: gn.cycle, depth: gn.depth,
        estTokens: gn.estTokens, sizeBytes: gn.sizeBytes,
        grade, evidence, firstAt, order: null,
        failed: !!rd && !rd.success,
        title: gn.title,
        parents: gn.parents.map(p => nodesById.get(p)?.relToSkill ?? p),
        children: gn.children.map(c => nodesById.get(c)?.relToSkill ?? c),
      };
    });
    return { skillName: basename(resolve(part.skillDirAbs)), skillDir: toSlashes(resolve(part.skillDirAbs)), graph: part.graph, nodes };
  });

  // 到達順: 証拠の seq（行順）でセッション通し番号を付ける
  const ordered = [...firstSeqByNode.entries()].sort((a, b) => a[1] - b[1]);
  const orderById = new Map(ordered.map(([id], i) => [id, i + 1] as const));
  for (const s of skills) for (const n of s.nodes) {
    n.order = n.grade ? (orderById.get(n.id) ?? null) : null;
  }

  // 記録では起動が確認できたが、発見できたスキルに含まれないもの（移動・改名・削除など）。
  // 起動の事実が表示から消えないよう、名前を残す
  const discoveredNames = new Set(parts.map(p => basename(resolve(p.skillDirAbs))));
  const undiscoveredSkills = [...new Set(parsed.activations.map(a => a.name))].filter(n => !discoveredNames.has(n));

  const lastUsage = parsed.contextUsageSeries.length ? parsed.contextUsageSeries[parsed.contextUsageSeries.length - 1] : null;
  return {
    source: "kiro",
    session: {
      id: opts.sessionId,
      startedAt: parsed.startedAt,
      workspace: toSlashes(opts.workspaceAbs),
      userMessagePreview: parsed.firstUserMessage,
      userMessageTruncated: parsed.firstUserMessageTruncated,
    },
    health: parsed.health,
    contextCurrentSeries: [],
    lastContextCurrentTokens: null,
    contextTokenLimit: null,
    contextFillRatio: null,
    turns: [],
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    toolExecutions: parsed.toolExecutions,
    skills: skills.map(s => ({ skillName: s.skillName, skillDir: s.skillDir, graph: s.graph, nodes: s.nodes })),
    outsideReads: [...outside.values()].map(r => ({ ...r, title: readOutsideTitle(r.path) })) as OutsideRead[],
    creditsTotal: parsed.creditsTotal,
    creditTurns: parsed.creditTurns.map((t, i) => ({ turn: i, credits: t.credits, usedTools: t.usedTools })),
    contextUsageSeries: parsed.contextUsageSeries,
    lastContextUsageRatio: lastUsage ? lastUsage.ratio : null,
    contextLoads,
    undiscoveredSkills,
  };
}
