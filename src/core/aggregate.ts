// スキル単位の横断集計（Issue #31）。
// 履歴に表示中のセッションをまたいで、スキルごとの起動回数と実測の
// 消費（クレジット／トークン）を合計する。単位の異なる供給源の値は
// 混ぜず、列を分けて持つ。換算はしない（実測のみ）。
// 注意: クレジット／トークンはセッション全体の実測であり、スキルへの
// 按分はできない。そのため消費は「そのスキルが起動したセッションの
// 合計」として寄せる。複数のスキルが起動したセッションでは、同じ
// セッション合計が各スキルに入る（表示側でその旨を明記する）。
import { readFileSync } from "node:fs";
import { parseEventsText } from "./events";
import { parseKiroMessages } from "./kiro";
import type { SessionInfo } from "./sessions";
import { parseVSCodeChatSessionText } from "./vscode";

/** 1セッション分の、集計に必要な最小限の実測 */
export interface SessionSkillUsage {
  sessionId: string;
  source: "copilot" | "kiro" | "vscode";
  /** セッション開始時刻（ISO。取れなければ null） */
  at: string | null;
  mtimeMs: number;
  /** 起動したスキルと、そのセッション内での起動回数。
   *  Copilot Chat は記録の性質上、セッション内の有無しか分からないため 1 になる */
  skills: { name: string; activations: number }[];
  /** Kiro / Copilot Chat のクレジット実測（供給源ごとに別物として扱う） */
  credits?: number;
  /** Copilot CLI のトークン実測（usage_record の積算。入力はキャッシュ分を含む） */
  inputTokens?: number;
  outputTokens?: number;
}

/** スキル1件分の横断集計 */
export interface SkillTotal {
  name: string;
  sessions: number;
  activations: number;
  /** 供給源ごとのセッション数（その供給源で現れたことがあるかの判定にも使う） */
  kiroSessions: number;
  chatSessions: number;
  copilotSessions: number;
  kiroCredits: number;
  chatCredits: number;
  copilotInputTokens: number;
  copilotOutputTokens: number;
  /** 最終利用（開始時刻が取れたセッションはその時刻、無ければ更新時刻） */
  lastUsedAt: string | null;
  lastUsedMs: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function countByName(names: string[]): { name: string; activations: number }[] {
  const map = new Map<string, number>();
  for (const n of names) map.set(n, (map.get(n) ?? 0) + 1);
  return [...map.entries()].map(([name, activations]) => ({ name, activations }));
}

/** Copilot CLI の events.jsonl から集計分を取り出す */
export function aggregateCopilotSessionText(text: string, meta: { sessionId: string; mtimeMs: number }): SessionSkillUsage {
  const parsed = parseEventsText(text);
  const names: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  for (const ev of parsed.events) {
    if (ev.type === "skill.invoked") {
      const n = ev.data["name"];
      if (typeof n === "string" && n) names.push(n);
    } else if (ev.type === "session.usage_record") {
      inputTokens += num(ev.data["inputTokens"]);
      outputTokens += num(ev.data["outputTokens"]);
    }
  }
  return {
    sessionId: meta.sessionId, source: "copilot",
    at: parsed.startedAt, mtimeMs: meta.mtimeMs,
    skills: countByName(names),
    inputTokens, outputTokens,
  };
}

/** Kiro の messages.jsonl から集計分を取り出す */
export function aggregateKiroSessionText(text: string, meta: { sessionId: string; mtimeMs: number }): SessionSkillUsage {
  const parsed = parseKiroMessages(text);
  return {
    sessionId: meta.sessionId, source: "kiro",
    at: parsed.startedAt, mtimeMs: meta.mtimeMs,
    skills: countByName(parsed.activations.map(a => a.name)),
    credits: parsed.creditsTotal,
  };
}

/** Copilot Chat の chatSessions 差分ログから集計分を取り出す */
export function aggregateVSCodeSessionText(text: string, meta: { sessionId: string; mtimeMs: number }): SessionSkillUsage {
  const parsed = parseVSCodeChatSessionText(text);
  let credits = 0;
  for (const r of parsed.requests) credits += r.credits;
  return {
    sessionId: meta.sessionId, source: "vscode",
    at: parsed.startedAt, mtimeMs: meta.mtimeMs,
    // activations は名前ごとに重複を除いた形で返る（記録に再起動の区別が無い）
    skills: parsed.activations.map(a => ({ name: a.name, activations: 1 })),
    credits,
  };
}

/** セッションの記録ファイルを読んで集計分を作る。読めなければ null */
export function aggregateSessionFile(info: SessionInfo): SessionSkillUsage | null {
  let text: string;
  try { text = readFileSync(info.eventsPath, "utf8"); } catch { return null; }
  const meta = { sessionId: info.id, mtimeMs: info.mtimeMs };
  try {
    if (info.source === "kiro") return aggregateKiroSessionText(text, meta);
    if (info.source === "vscode") return aggregateVSCodeSessionText(text, meta);
    return aggregateCopilotSessionText(text, meta);
  } catch { return null; }
}

/** セッション単位の実測をスキル単位に寄せる。
 *  並び: セッション数の多い順 → 起動回数の多い順 → 名前順 */
export function mergeSkillTotals(usages: SessionSkillUsage[]): SkillTotal[] {
  const map = new Map<string, SkillTotal & { sessionIds: Set<string> }>();
  for (const u of usages) {
    const usedMs = (u.at ? Date.parse(u.at) : NaN) || u.mtimeMs;
    for (const s of u.skills) {
      let row = map.get(s.name);
      if (!row) {
        row = {
          name: s.name, sessions: 0, activations: 0,
          kiroSessions: 0, chatSessions: 0, copilotSessions: 0,
          kiroCredits: 0, chatCredits: 0, copilotInputTokens: 0, copilotOutputTokens: 0,
          lastUsedAt: null, lastUsedMs: 0, sessionIds: new Set<string>(),
        };
        map.set(s.name, row);
      }
      if (!row.sessionIds.has(u.sessionId)) {
        row.sessionIds.add(u.sessionId);
        row.sessions++;
        // 消費はセッション単位の実測なので、セッションを初めて数えたときだけ加える
        if (u.source === "kiro") { row.kiroSessions++; row.kiroCredits += u.credits ?? 0; }
        if (u.source === "vscode") { row.chatSessions++; row.chatCredits += u.credits ?? 0; }
        if (u.source === "copilot") {
          row.copilotSessions++;
          row.copilotInputTokens += u.inputTokens ?? 0;
          row.copilotOutputTokens += u.outputTokens ?? 0;
        }
      }
      row.activations += s.activations;
      if (usedMs > row.lastUsedMs) {
        row.lastUsedMs = usedMs;
        row.lastUsedAt = u.at ?? new Date(u.mtimeMs).toISOString();
      }
    }
  }
  const rows = [...map.values()].map(({ sessionIds: _drop, ...rest }) => rest);
  rows.sort((a, b) => b.sessions - a.sessions || b.activations - a.activations || a.name.localeCompare(b.name));
  return rows;
}
