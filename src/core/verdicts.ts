// セッション注釈の集計（Issue #49 フェーズ3、仕様 docs/session-annotations.md §8）。
// Phase 2 で残された評価・メモと、セッション記録からの実測の消費を突き合わせ、
// スキルごとの評価件数・上手くいった率と、「悪かった」評価のセッションを
// 順位付きで示すための材料を作る。注釈は読み取り専用で扱い、元の記録や
// 注釈ファイルには一切書き込まない。
// 帰属の考え方は aggregate.ts と同じ: 評価も消費もセッション全体のもので、
// スキルへの按分はできない。そのセッションで起動した各スキルへ、同じ
// 評価・同じセッション合計がそのまま入る。単位の異なる消費（Kiro の
// クレジット、Copilot Chat のクレジット、Copilot CLI のトークン）は
// 列を分けて持ち、決して合算しない。換算もしない（実測のみ）。
import type { SessionSkillUsage } from "./aggregate";
import { compareTs, latestSessionVerdict, specSourceFor, type Annotation } from "./annotations";

/** メモ1件（評価の補足文・メモ本文）。表示側でエスケープして使う前提の生テキスト */
export interface AnnotationMemo {
  sessionId: string;
  /** 記録源（仕様の source 値: copilot-cli / copilot-vscode / kiro） */
  source: string;
  ts: string;
  text: string;
  /** ターン対象のメモのときだけ、そのターン番号 */
  turn?: number;
}

/** スキル1件分の注釈集計 */
export interface SkillVerdictTotal {
  name: string;
  good: number;
  ok: number;
  bad: number;
  /** 評価のあったセッション数（good + ok + bad） */
  rated: number;
  /** 上手くいった率（good / rated）。評価が無ければ null */
  goodRatio: number | null;
  /** 「悪かった」セッションの実測消費の合計（単位ごとに分離。按分なし） */
  kiroCredits: number;
  chatCredits: number;
  copilotInputTokens: number;
  copilotOutputTokens: number;
  /** このスキルが起動したセッションに付いたメモ（新しい順、上限あり） */
  memos: AnnotationMemo[];
}

/** 「悪かった」と評価されたセッション1件 */
export interface BadSession {
  sessionId: string;
  source: "copilot" | "kiro" | "vscode";
  /** セッション開始時刻（ISO。取れなければ null） */
  at: string | null;
  /** そのセッションで起動したスキルの名前 */
  skills: string[];
  /** Kiro / Copilot Chat のクレジット実測 */
  credits?: number;
  /** Copilot CLI のトークン実測 */
  inputTokens?: number;
  outputTokens?: number;
  /** そのセッションに付いたメモ（新しい順） */
  memos: AnnotationMemo[];
}

/** 注釈集計の結果一式 */
export interface VerdictAggregate {
  /** 注釈（評価またはメモ）のあったスキルだけを含む */
  skills: SkillVerdictTotal[];
  /** 「悪かった」セッション。供給源ごとにまとめ、各供給源の中では実測消費の多い順 */
  badSessions: BadSession[];
  /** 対象セッションのいずれかに注釈が1件でもあったか */
  hasAnnotations: boolean;
}

const MEMO_CAP = 20;

/** 1セッション分の注釈からメモを取り出す。
 *  対象: セッション全体のメモ（kind "note"）、評価の補足文（kind "verdict" で
 *  text が空でないもの）、ターン対象のメモと評価の補足文（turn を保持する）。
 *  新しい順に並べ、上限で切る */
function collectMemos(list: Annotation[] | undefined, sessionId: string, limit: number): AnnotationMemo[] {
  if (!list) return [];
  const memos: AnnotationMemo[] = [];
  for (const a of list) {
    if (a.kind !== "note" && a.kind !== "verdict") continue;
    if (typeof a.text !== "string" || !a.text) continue;
    memos.push({ sessionId, source: a.source, ts: a.ts, text: a.text, turn: a.turn });
  }
  memos.sort((x, y) => compareTs(y.ts, x.ts));
  return memos.slice(0, limit);
}

/** 「悪かった」スキルの順位付け: 悪かった件数の多い順 → その消費の多い順
 *  （Kiro クレジット → Copilot Chat クレジット → Copilot トークン）→ 評価件数の多い順 */
export function rankBadSkills(skills: SkillVerdictTotal[]): SkillVerdictTotal[] {
  return skills
    .filter(s => s.bad > 0)
    .sort((a, b) =>
      b.bad - a.bad
      || b.kiroCredits - a.kiroCredits
      || b.chatCredits - a.chatCredits
      || (b.copilotInputTokens + b.copilotOutputTokens) - (a.copilotInputTokens + a.copilotOutputTokens)
      || b.rated - a.rated
      || a.name.localeCompare(b.name));
}

/**
 * セッション単位の実測（usages）と注釈（annotations）を突き合わせて集計する。
 * セッションの評価は、セッション全体への最新の verdict のみを使う
 * （ターン対象の verdict は数えない。latestSessionVerdict と同じ規則）。
 * 改訂・取り消しは loadAnnotations / parseAnnotationFile で解決済みの前提。
 */
export function aggregateVerdicts(
  usages: SessionSkillUsage[],
  annotations: Map<string, Annotation[]>,
): VerdictAggregate {
  const skillMap = new Map<string, SkillVerdictTotal & { memoPool: AnnotationMemo[] }>();
  const badBySource = new Map<string, BadSession[]>();
  let hasAnnotations = false;
  const seenSessions = new Set<string>();

  const skillRow = (name: string): SkillVerdictTotal & { memoPool: AnnotationMemo[] } => {
    let row = skillMap.get(name);
    if (!row) {
      row = {
        name, good: 0, ok: 0, bad: 0, rated: 0, goodRatio: null,
        kiroCredits: 0, chatCredits: 0, copilotInputTokens: 0, copilotOutputTokens: 0,
        memos: [], memoPool: [],
      };
      skillMap.set(name, row);
    }
    return row;
  };

  for (const u of usages) {
    const key = `${specSourceFor(u.source)}:${u.sessionId}`;
    if (seenSessions.has(key)) continue;
    seenSessions.add(key);
    const list = annotations.get(key);
    if (!list || !list.length) continue;
    hasAnnotations = true;
    const verdict = latestSessionVerdict(list);
    const sessionMemos = collectMemos(list, u.sessionId, MEMO_CAP);

    if (verdict === "bad") {
      const entry: BadSession = {
        sessionId: u.sessionId, source: u.source, at: u.at,
        skills: u.skills.map(s => s.name),
        credits: u.credits, inputTokens: u.inputTokens, outputTokens: u.outputTokens,
        memos: sessionMemos,
      };
      const bucket = badBySource.get(u.source);
      if (bucket) bucket.push(entry); else badBySource.set(u.source, [entry]);
    }

    for (const s of u.skills) {
      const row = skillRow(s.name);
      if (verdict) {
        row[verdict]++;
        row.rated++;
        if (verdict === "bad") {
          // 消費はセッション全体の実測を、単位を混ぜずにそのまま寄せる
          if (u.source === "kiro") row.kiroCredits += u.credits ?? 0;
          if (u.source === "vscode") row.chatCredits += u.credits ?? 0;
          if (u.source === "copilot") {
            row.copilotInputTokens += u.inputTokens ?? 0;
            row.copilotOutputTokens += u.outputTokens ?? 0;
          }
        }
      }
      row.memoPool.push(...sessionMemos);
    }
  }

  const skills: SkillVerdictTotal[] = [...skillMap.values()]
    .map(({ memoPool, ...rest }) => {
      const memos = memoPool.sort((x, y) => compareTs(y.ts, x.ts)).slice(0, MEMO_CAP);
      return { ...rest, memos, goodRatio: rest.rated > 0 ? rest.good / rest.rated : null };
    })
    // 評価もメモも無いスキルは集計に出さない（例: ターン対象の verdict だけのセッション）
    .filter(s => s.rated > 0 || s.memos.length > 0);
  skills.sort((a, b) => a.name.localeCompare(b.name));

  // 供給源ごとにまとめ、各供給源の中では実測消費の多い順
  // （クレジット源はクレジット、Copilot CLI は入力+出力トークン）
  const consumptionOf = (s: BadSession): number =>
    s.source === "copilot" ? (s.inputTokens ?? 0) + (s.outputTokens ?? 0) : (s.credits ?? 0);
  const badSessions: BadSession[] = [];
  for (const bucket of badBySource.values()) {
    bucket.sort((a, b) => consumptionOf(b) - consumptionOf(a) || a.sessionId.localeCompare(b.sessionId));
    badSessions.push(...bucket);
  }

  return { skills, badSessions, hasAnnotations };
}
