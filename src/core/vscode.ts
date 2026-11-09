// VS Code の Copilot チャット記録（workspaceStorage/<hash>/chatSessions/<id>.jsonl）の読み取り口。
// 形式は差分ログ: kind 0 = セッション全体のスナップショット、kind 1 = キー経路 k への値のセット、
// kind 2 = キー経路の配列への追記（任意の i で、その長さに切り詰めてから追記する）。
// 順に適用すると最終状態（requests 配列）が復元できる（2026-11-09 の実ファイルで確認）。
// リクエストの応答パートにツール呼び出し（toolInvocationSerialized）が残り、
// copilot_readFile の対象パスは invocationMessage の uris から引ける。
// SKILL.md の読み取りは URI のクエリ vscodeLinkType=skill として明示される（スキル起動の記録）。
// 実測はリクエスト単位: promptTokens / completionTokens / copilotCredits が残る。
import { closeSync, existsSync, openSync, readSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { normPath, toSlashes, type Graph, type GraphNode } from "./graph";
import type { ParseHealth } from "./events";
import { firstHeading, type Grade, type OutsideRead, type SessionTrace, type TraceNode } from "./trace";
import type { SessionInfo } from "./sessions";
import type { Lang } from "./common";

export interface VSCodeToolCall {
  toolId: string;
  toolCallId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  complete: boolean;
  /** copilot_readFile の対象パス（表示用表記）。読み取り系でなければ null */
  readPath: string | null;
  /** SKILL.md が「スキルとして」読み込まれた記録か（vscodeLinkType=skill） */
  skillRead: boolean;
}

export interface VSCodeRequest {
  at: string | null;
  userMessage: string;
  tools: VSCodeToolCall[];
  promptTokens: number;
  completionTokens: number;
  credits: number;
}

export interface VSCodeParsed {
  sessionId: string | null;
  createdAt: string | null;
  title: string | null;
  /** ヘッダーの選択モデルが持つ入力トークン上限（無ければ null） */
  contextTokenLimit: number | null;
  requests: VSCodeRequest[];
  /** 言及（確度低）の判定に使う文字列: ユーザー発話とツール呼び出しメッセージ */
  strings: string[];
  /** 記録で確認できたスキル起動（スキル名と時刻） */
  activations: { name: string; at: string | null }[];
  health: ParseHealth;
  firstUserMessage: string;
  firstUserMessageTruncated: boolean;
  startedAt: string | null;
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function isoFromMs(v: unknown): string | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? new Date(v).toISOString() : null;
}

/** file:// URI や URI オブジェクトの path を、表示用のパス表記へ寄せる（kiro.ts の displayPath と同じ規則） */
export function vsDisplayPath(raw: string): string {
  let s = String(raw).replace(/\\/g, "/");
  s = s.replace(/^file:\/\//i, "");
  try { s = decodeURIComponent(s); } catch { /* そのまま */ }
  if (/^\/[a-zA-Z]:/.test(s)) s = s.slice(1);
  return s;
}

/** 差分ログの再生: キー経路への値セット。数値の節は配列の添字として扱う */
function setPath(state: unknown, path: unknown[], value: unknown): void {
  let cur: unknown = state;
  for (let i = 0; i < path.length - 1; i++) {
    if (!isObj(cur) && !Array.isArray(cur)) return;
    const key = path[i];
    const nextKey = path[i + 1];
    const wantArray = typeof nextKey === "number" || (typeof nextKey === "string" && /^\d+$/.test(nextKey));
    if (Array.isArray(cur)) {
      const idx = typeof key === "number" ? key : /^\d+$/.test(String(key)) ? Number(key) : -1;
      if (idx < 0) return;
      while (cur.length <= idx) cur.push(null);
      if (!isObj(cur[idx]) && !Array.isArray(cur[idx])) cur[idx] = wantArray ? [] : {};
      cur = cur[idx];
    } else {
      const rec = cur as Json;
      const k = String(key);
      if (!isObj(rec[k]) && !Array.isArray(rec[k])) rec[k] = wantArray ? [] : {};
      cur = rec[k];
    }
  }
  const last = path[path.length - 1];
  if (Array.isArray(cur)) {
    const idx = typeof last === "number" ? last : /^\d+$/.test(String(last)) ? Number(last) : -1;
    if (idx < 0) return;
    while (cur.length <= idx) cur.push(null);
    cur[idx] = value;
  } else if (isObj(cur)) {
    cur[String(last)] = value;
  }
}

/** 差分ログの再生（kind 2）: キー経路の配列へ追記する。
 *  e.i が指定されていれば、先にその長さへ切り詰める（再生成で古い応答を捨てる動き）。
 *  対象が配列でなければ空配列から始める。v が配列ならその要素をすべて、そうでなければ v 自体を追記する */
function appendAtPath(state: unknown, path: unknown[], value: unknown, indexHint: unknown): void {
  // 親まで辿る（setPath と同じ経路規則）
  let cur: unknown = state;
  for (let i = 0; i < path.length - 1; i++) {
    if (!isObj(cur) && !Array.isArray(cur)) return;
    const key = path[i];
    const nextKey = path[i + 1];
    const wantArray = typeof nextKey === "number" || (typeof nextKey === "string" && /^\d+$/.test(nextKey));
    if (Array.isArray(cur)) {
      const idx = typeof key === "number" ? key : /^\d+$/.test(String(key)) ? Number(key) : -1;
      if (idx < 0) return;
      while (cur.length <= idx) cur.push(null);
      if (!isObj(cur[idx]) && !Array.isArray(cur[idx])) cur[idx] = wantArray ? [] : {};
      cur = cur[idx];
    } else {
      const rec = cur as Json;
      const k = String(key);
      if (!isObj(rec[k]) && !Array.isArray(rec[k])) rec[k] = wantArray ? [] : {};
      cur = rec[k];
    }
  }
  const last = path[path.length - 1];
  let target: unknown[];
  if (Array.isArray(cur)) {
    const idx = typeof last === "number" ? last : /^\d+$/.test(String(last)) ? Number(last) : -1;
    if (idx < 0) return;
    while (cur.length <= idx) cur.push(null);
    if (!Array.isArray(cur[idx])) cur[idx] = [];
    target = cur[idx] as unknown[];
  } else if (isObj(cur)) {
    const k = String(last);
    if (!Array.isArray(cur[k])) cur[k] = [];
    target = cur[k] as unknown[];
  } else return;
  if (typeof indexHint === "number" && Number.isFinite(indexHint) && indexHint >= 0 && target.length > indexHint) {
    target.length = Math.floor(indexHint);
  }
  if (Array.isArray(value)) target.push(...value);
  else target.push(value);
}

/** ツール呼び出しパートから、読み取り対象のパスと「スキル読み取り」かを取り出す */
function extractRead(part: Json): { readPath: string | null; skillRead: boolean } {
  const msg = isObj(part.invocationMessage) ? part.invocationMessage : isObj(part.pastTenseMessage) ? part.pastTenseMessage : null;
  if (!msg) return { readPath: null, skillRead: false };
  const value = typeof msg.value === "string" ? msg.value : "";
  let skillRead = value.includes("vscodeLinkType=skill") || value.includes("vscodeLinkType%3Dskill");
  let readPath: string | null = null;
  if (isObj(msg.uris)) {
    for (const u of Object.values(msg.uris)) {
      if (isObj(u) && typeof u.path === "string") {
        readPath = vsDisplayPath(u.path);
        if (u.query === "vscodeLinkType=skill") skillRead = true;
        break;
      }
    }
  }
  if (!readPath) {
    // uris が無い表記のときは、メッセージ内の markdown リンク先から拾う
    const m = value.match(/\((file:\/\/[^)\s]+)\)/);
    if (m) readPath = vsDisplayPath(m[1].replace(/\?[^)]*$/, ""));
  }
  return { readPath, skillRead };
}

/** 読み取りパスからスキル名を引く（.../skills/<名前>/SKILL.md）。
 *  名前の大文字小文字は保持する（normPath の小文字化を通すと、発見した
 *  スキルのディレクトリ名と一致せず「未発見」の注記が誤って付くため）。
 *  "skills" と "SKILL.md" の照合だけ大文字小文字を区別しない */
function skillNameFromPath(p: string): string | null {
  const segs = vsDisplayPath(p).split("/").filter(x => x !== "" && x !== ".");
  const lowered = segs.map(x => x.toLowerCase());
  const i = lowered.lastIndexOf("skills");
  if (i >= 0 && segs[i + 1] && lowered[lowered.length - 1] === "skill.md") return segs[i + 1];
  return null;
}

export function parseVSCodeChatSessionText(text: string): VSCodeParsed {
  const health: ParseHealth = { totalLines: 0, parsedLines: 0, skippedLines: 0, typeCounts: {}, unknownEventTypes: {}, unknownRatio: 0 };
  let state: Json | null = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    health.totalLines++;
    let e: Json;
    try { e = JSON.parse(t) as Json; } catch { health.skippedLines++; continue; }
    health.parsedLines++;
    const kind = typeof e.kind === "number" ? e.kind : -1;
    const key = `kind${kind}`;
    health.typeCounts[key] = (health.typeCounts[key] || 0) + 1;
    if (kind === 0 && isObj(e.v)) {
      state = JSON.parse(JSON.stringify(e.v)) as Json;
    } else if (kind === 1 && state && Array.isArray(e.k) && e.k.length) {
      setPath(state, e.k as unknown[], e.v);
    } else if (kind === 2 && state && Array.isArray(e.k) && e.k.length) {
      appendAtPath(state, e.k as unknown[], e.v, e.i);
    }
  }

  const requests: VSCodeRequest[] = [];
  const strings: string[] = [];
  const activations: { name: string; at: string | null }[] = [];
  const seenAct = new Set<string>();
  if (state && Array.isArray(state.requests)) {
    for (const rawReq of state.requests) {
      if (!isObj(rawReq)) continue;
      const message = isObj(rawReq.message) && typeof rawReq.message.text === "string" ? rawReq.message.text : "";
      if (message) strings.push(message);
      const tools: VSCodeToolCall[] = [];
      const response = Array.isArray(rawReq.response) ? rawReq.response : [];
      for (const part of response) {
        if (!isObj(part)) continue;
        const msgVal = isObj(part.invocationMessage) && typeof part.invocationMessage.value === "string" ? part.invocationMessage.value : "";
        if (msgVal) { try { strings.push(decodeURIComponent(msgVal)); } catch { strings.push(msgVal); } }
        if (part.kind !== "toolInvocationSerialized") continue;
        const toolId = typeof part.toolId === "string" ? part.toolId : "tool";
        const { readPath, skillRead } = toolId === "copilot_readFile" ? extractRead(part) : { readPath: null, skillRead: false };
        const startedAt = isoFromMs(part.startedAt);
        tools.push({
          toolId,
          toolCallId: typeof part.toolCallId === "string" ? part.toolCallId : null,
          startedAt,
          completedAt: isoFromMs(part.completedAt),
          complete: part.isComplete !== false,
          readPath,
          skillRead,
        });
        if (skillRead && readPath) {
          const name = skillNameFromPath(readPath);
          if (name && !seenAct.has(name)) { seenAct.add(name); activations.push({ name, at: startedAt }); }
        }
      }
      requests.push({
        at: isoFromMs(rawReq.timestamp),
        userMessage: message,
        tools,
        promptTokens: num(rawReq.promptTokens),
        completionTokens: num(rawReq.completionTokens),
        credits: num(rawReq.copilotCredits),
      });
    }
  }

  const inputState = state && isObj(state.inputState) ? state.inputState : null;
  const selectedModel = inputState && isObj(inputState.selectedModel) ? inputState.selectedModel : null;
  const metadata = selectedModel && isObj(selectedModel.metadata) ? selectedModel.metadata : null;
  const limitRaw = metadata ? num(metadata.maxInputTokens) : 0;
  const first = requests.find(r => r.userMessage)?.userMessage ?? "";
  const createdAt = state ? isoFromMs(state.creationDate) : null;
  return {
    sessionId: state && typeof state.sessionId === "string" ? state.sessionId : null,
    createdAt,
    title: state && typeof state.customTitle === "string" && state.customTitle ? state.customTitle : null,
    contextTokenLimit: limitRaw > 0 ? limitRaw : null,
    requests,
    strings,
    activations,
    health,
    firstUserMessage: first.slice(0, 200),
    firstUserMessageTruncated: first.length > 200,
    startedAt: createdAt,
  };
}

export function parseVSCodeChatSessionFile(eventsPath: string): VSCodeParsed {
  return parseVSCodeChatSessionText(readFileSync(eventsPath, "utf8"));
}

// --- 列挙 ---

export function defaultVSCodeStorageDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "Code", "User", "workspaceStorage");
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Code", "User", "workspaceStorage");
  return join(homedir(), ".config", "Code", "User", "workspaceStorage");
}

function workspaceHintOf(hashDir: string): string | null {
  const p = join(hashDir, "workspace.json");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as Json;
    const raw = typeof j.folder === "string" ? j.folder : typeof j.workspace === "string" ? j.workspace : null;
    return raw ? vsDisplayPath(raw) : null;
  } catch { return null; }
}

/** 列挙用の軽量スキャン: 先頭 1MB だけ読み、ヘッダーと customTitle だけ拾う
 *  （chatSessions のファイルは数 MB になりうるため、履歴表示で全文は読まない） */
function lightScan(filePath: string): { title: string | null } {
  try {
    const fd = openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(1024 * 1024);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const text = buf.toString("utf8", 0, n);
      for (const line of text.split(/\r?\n/)) {
        if (!line.includes("customTitle")) continue;
        try {
          const e = JSON.parse(line) as Json;
          if (Array.isArray(e.k) && e.k[0] === "customTitle" && typeof e.v === "string" && e.v) return { title: e.v };
        } catch { /* 次の行へ */ }
      }
    } finally { closeSync(fd); }
  } catch { /* 読めなければタイトルなし */ }
  return { title: null };
}

/** 列挙用タイトルのキャッシュ（ファイルパス + mtimeMs が同じなら再スキャンしない）。
 *  履歴の再描画のたびに全セッションを lightScan すると、件数が多い環境で重くなる */
const titleCache = new Map<string, { mtimeMs: number; title: string | null }>();
function cachedTitle(eventsPath: string, mtimeMs: number): string | null {
  const hit = titleCache.get(eventsPath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.title;
  const title = lightScan(eventsPath).title;
  titleCache.set(eventsPath, { mtimeMs, title });
  return title;
}

export function listVSCodeChatSessions(storageDir: string): SessionInfo[] {
  if (!existsSync(storageDir)) return [];
  const out: SessionInfo[] = [];
  let hashes: string[];
  try { hashes = readdirSync(storageDir); } catch { return []; }
  for (const hash of hashes) {
    const hashDir = join(storageDir, hash);
    const chatDir = join(hashDir, "chatSessions");
    try { if (!statSync(chatDir).isDirectory()) continue; } catch { continue; }
    const hint = workspaceHintOf(hashDir);
    let files: string[];
    try { files = readdirSync(chatDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const eventsPath = join(chatDir, f);
      try {
        const st = statSync(eventsPath);
        if (!st.isFile()) continue;
        out.push({
          id: f.replace(/\.jsonl$/, ""),
          dir: chatDir,
          eventsPath,
          mtimeMs: st.mtimeMs,
          workspaceHint: hint,
          source: "vscode",
          title: cachedTitle(eventsPath, st.mtimeMs),
          workspacePaths: hint ? [hint] : [],
        });
      } catch { /* skip */ }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// --- 履歴ラベル用の軽量スキャン ---
// 記録で「スキルとして読み込まれた」SKILL.md のスキル名を返す。読めなければ null（未判定）。
export function scanVSCodeActivationNames(eventsPath: string): string[] | null {
  let text: string;
  try { text = readFileSync(eventsPath, "utf8"); } catch { return null; }
  const names: string[] = [];
  const push = (n: string | null): void => { if (n && !names.includes(n)) names.push(n); };
  for (const m of text.matchAll(/Reading skill \[([^\]]+)\]/g)) push(m[1]);
  // 明示メッセージが無い表記でも、vscodeLinkType=skill の対象パスから拾う
  for (const m of text.matchAll(/skills\/([^/"%?]+)\/SKILL\.md\?vscodeLinkType(?:=|%3D)skill/gi)) push(m[1]);
  return names;
}

// --- トレース構築（kiro.ts と同じ作法: 記録の読み取りを証拠に、グラフのノードへ対応付ける） ---

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

export interface VSCodeSkillPartInput {
  graph: Graph;
  skillDirAbs: string;
  rootHeading: string | null;
}

export function buildVSCodeSessionTrace(
  parsed: VSCodeParsed,
  parts: VSCodeSkillPartInput[],
  opts: { sessionId: string; workspaceAbs: string; lang?: Lang },
): SessionTrace {
  const en = opts.lang === "en";
  // 全リクエストを通した読み取り証拠（seq は応答パートの出現順 = 到達順の土台）
  const reads: { norm: string; display: string; at: string | null; seq: number; success: boolean; skillRead: boolean }[] = [];
  let seq = 0;
  for (const r of parsed.requests) {
    for (const t of r.tools) {
      seq++;
      if (!t.readPath) continue;
      reads.push({ norm: normPath(t.readPath), display: t.readPath, at: t.startedAt, seq, success: t.complete, skillRead: t.skillRead });
    }
  }

  const allGraphs = parts.map(p => p.graph);
  const belongsToAny = (norm: string): boolean => allGraphs.some(g => matchNodes(norm, g.nodes).length > 0);
  const outside = new Map<string, { path: string; at: string | null; tool: string; failed: boolean }>();
  for (const r of reads) {
    if (!belongsToAny(r.norm) && !outside.has(r.norm)) {
      outside.set(r.norm, { path: r.display, at: r.at, tool: "copilot_readFile", failed: !r.success });
    }
  }

  const firstSeqByNode = new Map<string, number>();
  const skills = parts.map(part => {
    const nodesById = part.graph.nodes;
    const nodes: TraceNode[] = part.graph.order.map(gn => {
      let grade: Grade = null;
      let evidence = en ? "No matching event" : "イベントに対応付けなし";
      let firstAt: string | null = null;
      let firstSeq: number | null = null;
      const rd = reads.find(r => matchNodes(r.norm, nodesById).some(h => h.id === gn.id));
      if (rd?.skillRead && gn.id === part.graph.rootId) {
        grade = "A";
        evidence = en ? "Recorded as a skill read (vscodeLinkType=skill)" : "スキルとして読み込まれた記録（vscodeLinkType=skill）";
        firstAt = rd.at; firstSeq = rd.seq;
      } else if (rd?.success) {
        grade = "B";
        evidence = en ? "Successful read via copilot_readFile" : "copilot_readFile の読み取り成功";
        firstAt = rd.at; firstSeq = rd.seq;
      }
      if (grade === null) {
        for (const s of parsed.strings) {
          if (matchNodes(s, nodesById).some(h => h.id === gn.id)) {
            grade = "C";
            evidence = en ? "Mention only in the session record" : "セッション記録での言及のみ";
            firstAt = null; firstSeq = seq + 1;
            break;
          }
        }
      }
      if (firstSeq !== null && grade !== "C" && !gn.missing) {
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

  // 到達順: 証拠の seq（記録の出現順）でセッション通し番号を付ける
  const ordered = [...firstSeqByNode.entries()].sort((a, b) => a[1] - b[1]);
  const orderById = new Map(ordered.map(([id], i) => [id, i + 1] as const));
  for (const s of skills) for (const n of s.nodes) {
    n.order = n.grade && n.grade !== "C" ? (orderById.get(n.id) ?? null) : null;
  }

  const discoveredNames = new Set(parts.map(p => basename(resolve(p.skillDirAbs))));
  const undiscoveredSkills = [...new Set(parsed.activations.map(a => a.name))].filter(n => !discoveredNames.has(n));

  const turns = parsed.requests.map((r, i) => ({
    turn: i, inputTokens: r.promptTokens, outputTokens: r.completionTokens,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
  }));
  const totals = turns.reduce((a, t) => ({
    inputTokens: a.inputTokens + t.inputTokens, outputTokens: a.outputTokens + t.outputTokens,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
  }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
  const creditTurns = parsed.requests.map((r, i) => ({ turn: i, credits: r.credits, usedTools: r.tools.map(t => t.toolId) }));
  const creditsTotal = creditTurns.reduce((a, t) => a + t.credits, 0);
  const contextCurrentSeries = parsed.requests.filter(r => r.promptTokens > 0).map(r => ({ at: r.at ?? "", tokens: r.promptTokens }));
  const lastContextCurrentTokens = contextCurrentSeries.length ? contextCurrentSeries[contextCurrentSeries.length - 1].tokens : null;
  const contextTokenLimit = parsed.contextTokenLimit;
  return {
    source: "vscode",
    session: {
      id: opts.sessionId,
      startedAt: parsed.startedAt,
      workspace: toSlashes(opts.workspaceAbs),
      userMessagePreview: parsed.firstUserMessage,
      userMessageTruncated: parsed.firstUserMessageTruncated,
    },
    health: parsed.health,
    contextCurrentSeries,
    lastContextCurrentTokens,
    contextTokenLimit,
    contextFillRatio: contextTokenLimit && lastContextCurrentTokens !== null ? lastContextCurrentTokens / contextTokenLimit : null,
    turns,
    totals,
    toolExecutions: parsed.requests.flatMap(r => r.tools.map(t => ({ at: t.startedAt, toolName: t.toolId, success: t.complete }))),
    skills,
    outsideReads: [...outside.values()].map(r => ({ ...r, title: readOutsideTitle(r.path) })) as OutsideRead[],
    creditsTotal,
    creditTurns,
    undiscoveredSkills,
  };
}
