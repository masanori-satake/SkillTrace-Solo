// Copilot CLI の events.jsonl パーサ。
// 実データはフィールドが深くネストしたり、パスがオブジェクトのキー側に入ったりするため、
// 文字列と数値は再帰的に探す（Phase 1 CLI と同一方針）。本文は保持しない。
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export interface ParsedEvent {
  idx: number;
  type: string;
  at: string | null;
  data: Record<string, unknown>;
  strings: string[];
}

export const KNOWN_TYPES = new Set([
  "session.start", "session.end", "session.usage_record", "session.usage_checkpoint",
  "session.auto_mode_resolved", "user.message", "system.message",
  "assistant.turn_start", "assistant.turn_end", "assistant.message",
  "tool.execution_start", "tool.execution_complete",
  "external_tool.requested", "external_tool.completed",
  "permission.requested", "permission.completed", "hook.start", "hook.end",
  "skill.invoked", "skill.invoked_ref", "skill.context_delivered_ref",
  "session.shutdown",
  // 2026-11-09 の実セッション採取で確認した種別。新しい Copilot ランタイムが
  // 付けるモデル呼び出し層（model.*）と、モデル変更・通知・権限変更の通知系。
  // 起動・読み取り・使用量の証拠は従来の種別（skill.invoked /
  // tool.execution_* / session.usage_record）側に残るため、ここでは
  // 「未知ではない」とだけ扱い、個別のパースはしない
  "model.turn_started", "model.turn_ended", "model.model_call_started",
  "model.model_call_success", "model.response", "model.message",
  "model.messages_snapshot", "model.captured_assignment_context",
  "session.model_change", "session.permissions_changed", "system.notification",
]);

// 文字列を再帰的に全部集める。値だけでなくキー名も対象（参照がキー側に入る形式でも拾う）
export function collectStrings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || v === null || v === undefined) return out;
  if (typeof v === "string") { out.push(v); return out; }
  if (Array.isArray(v)) { for (const x of v) collectStrings(x, out, depth + 1); return out; }
  if (typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) { out.push(k); collectStrings(x, out, depth + 1); }
    return out;
  }
  return out;
}

// 数値キーを再帰的に探す（最初に見つかった値を返す）
export function findNumber(v: unknown, keys: string[], depth = 0): number | undefined {
  if (depth > 8 || v === null || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  for (const k of keys) if (typeof o[k] === "number") return o[k] as number;
  for (const x of Object.values(o)) { const r = findNumber(x, keys, depth + 1); if (r !== undefined) return r; }
  return undefined;
}

// 文字列キーを再帰的に探す（最初に見つかった値を返す）
export function findString(v: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 8 || v === null || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  for (const k of keys) if (typeof o[k] === "string") return o[k] as string;
  for (const x of Object.values(o)) { const r = findString(x, keys, depth + 1); if (r !== undefined) return r; }
  return undefined;
}

export interface ParseHealth {
  totalLines: number;
  parsedLines: number;
  skippedLines: number;
  typeCounts: Record<string, number>;
  unknownEventTypes: Record<string, number>;
  unknownRatio: number;
}
export interface ParsedEvents {
  events: ParsedEvent[];
  health: ParseHealth;
  firstUserMessage: string;
  firstUserMessageTruncated: boolean;
  startedAt: string | null;
  contextCurrentSeries: { at: string; tokens: number }[];
  contextTokenLimit: number | null;
}

export function parseEventsText(text: string): ParsedEvents {
  const events: ParsedEvent[] = [];
  const health: ParseHealth = { totalLines: 0, parsedLines: 0, skippedLines: 0, typeCounts: {}, unknownEventTypes: {}, unknownRatio: 0 };
  let firstUserMessage = "";
  let firstUserMessageTruncated = false;
  let startedAt: string | null = null;
  const contextCurrentSeries: { at: string; tokens: number }[] = [];
  let contextTokenLimit: number | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    health.totalLines++;
    let ev: { type?: unknown; timestamp?: unknown; data?: unknown };
    try { ev = JSON.parse(line) as typeof ev; } catch { health.skippedLines++; continue; }
    const type = typeof ev.type === "string" ? ev.type : "(種別なし)";
    const at = typeof ev.timestamp === "string" ? ev.timestamp : null;
    const data = (ev.data && typeof ev.data === "object" ? ev.data : {}) as Record<string, unknown>;
    health.parsedLines++;
    health.typeCounts[type] = (health.typeCounts[type] || 0) + 1;
    if (!KNOWN_TYPES.has(type)) health.unknownEventTypes[type] = (health.unknownEventTypes[type] || 0) + 1;
    events.push({ idx: events.length, type, at, data, strings: collectStrings(data) });
    if (type === "session.start" && at) startedAt = at;
    if (type === "user.message" && !firstUserMessage && typeof data["content"] === "string") {
      const raw = data["content"] as string;
      firstUserMessage = raw.slice(0, 120);
      firstUserMessageTruncated = raw.length > 120;
    }
    const ctx = findNumber(data, ["context_current_tokens"]);
    if (typeof ctx === "number" && at) contextCurrentSeries.push({ at, tokens: ctx });
    const lim = findNumber(data, ["context_token_limit"]);
    if (typeof lim === "number" && lim > 0) contextTokenLimit = lim;
  }
  health.unknownRatio = health.parsedLines
    ? Object.values(health.unknownEventTypes).reduce((a, b) => a + b, 0) / health.parsedLines : 0;
  return { events, health, firstUserMessage, firstUserMessageTruncated, startedAt, contextCurrentSeries, contextTokenLimit };
}

export async function parseEventsFile(path: string): Promise<ParsedEvents> {
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  const lines: string[] = [];
  for await (const line of rl) lines.push(line);
  return parseEventsText(lines.join("\n"));
}
