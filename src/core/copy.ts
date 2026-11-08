// ツリーをプレーンテキスト化する（クリップボードコピー用）。
// 罫線スタイルは SkillMap-Solo / StructMap-Solo と揃え、シリーズで見た目を統一する。
// 発見や不具合をチャットで共有したり、メモに残したりするための機能。
// 部分コピー（表示中／選択サブツリー）が要るのは、全体コピー後に不要箇所を削る
// 編集が、考えている最中の流れを止めてしまうため（ユーザーの要件）。
// 0.4.0 からコピーの単位はセッション（配下に発動スキルが並ぶ）。
import type { Graph, GraphNode } from "./graph";
import type { SessionTrace, SkillPart, TraceNode } from "./trace";
import { gradeCertaintyLabel } from "./trace";
import { formatLocalDateTime } from "./sessions";
import type { Lang } from "./common";

const GLYPHS = { branch: "├─ ", last: "└─ ", vert: "│  ", blank: "   " } as const;

function nodeDescription(nodes: TraceNode[], gn: GraphNode, lang: Lang = "ja"): string {
  const en = lang === "en";
  const tn = nodes.find(n => n.id === gn.id);
  const parts: string[] = [];
  if (gn.missing) parts.push(en ? "[missing target]" : "[参照先なし]");
  else if (tn?.grade) parts.push(`[${gradeCertaintyLabel(tn.grade, lang)}${tn.order ? ` #${tn.order}` : ""}]`);
  else parts.push(en ? "[no record]" : "[記録なし]");
  if (gn.boundary) parts.push(en ? "outside skill" : "スキル外");
  if (gn.cycle) parts.push(en ? "cycle" : "循環");
  if (tn?.failed) parts.push(en ? "read failed" : "読取失敗あり");
  parts.push(en ? `~${gn.estTokens} tokens` : `~${gn.estTokens} トークン`);
  return parts.join(" ");
}

export type SessionCopyMode =
  | { kind: "all" }
  | { kind: "visible"; isExpanded: (skillName: string, absId: string) => boolean }
  | { kind: "subtree"; part: SkillPart; rootId: string };

function renderPartLines(part: SkillPart, mode: SessionCopyMode, lines: string[], lang: Lang = "ja"): void {
  const byId: Map<string, GraphNode> = part.graph.nodes;
  const renderChildren = (parent: GraphNode, prefix: string, seen: Set<string>): void => {
    const kids = parent.children
      .map(id => byId.get(id))
      .filter((n): n is GraphNode => !!n);
    kids.forEach((kid, i) => {
      const isLast = i === kids.length - 1;
      lines.push(prefix + (isLast ? GLYPHS.last : GLYPHS.branch) + `${kid.relToSkill}  ${nodeDescription(part.nodes, kid, lang)}`);
      const includeKids = kid.children.length > 0 && !kid.cycle && !seen.has(kid.id)
        && (mode.kind !== "visible" || mode.isExpanded(part.skillName, kid.id));
      if (includeKids) {
        seen.add(kid.id);
        renderChildren(kid, prefix + (isLast ? GLYPHS.blank : GLYPHS.vert), seen);
      }
    });
  };
  const root = byId.get(part.graph.rootId);
  if (!root) return;
  lines.push(`${root.relToSkill}  ${nodeDescription(part.nodes, root, lang)}`);
  const rootIncluded = mode.kind !== "visible" || mode.isExpanded(part.skillName, root.id);
  if (rootIncluded && !root.cycle) renderChildren(root, "", new Set([root.id]));
}

export function renderSessionCopy(st: SessionTrace, mode: SessionCopyMode, lang: Lang = "ja"): string {
  const en = lang === "en";
  const lines: string[] = [];

  if (mode.kind === "subtree") {
    const byId: Map<string, GraphNode> = mode.part.graph.nodes;
    const root = byId.get(mode.rootId);
    if (!root) return "";
    lines.push(`${root.relToSkill}  ${nodeDescription(mode.part.nodes, root, lang)}`);
    if (!root.cycle) {
      const seen = new Set([root.id]);
      const renderChildren = (parent: GraphNode, prefix: string): void => {
        const ks = parent.children.map(id => byId.get(id)).filter((n): n is GraphNode => !!n);
        ks.forEach((kid, i) => {
          const isLast = i === ks.length - 1;
          lines.push(prefix + (isLast ? GLYPHS.last : GLYPHS.branch) + `${kid.relToSkill}  ${nodeDescription(mode.part.nodes, kid, lang)}`);
          if (kid.children.length > 0 && !kid.cycle && !seen.has(kid.id)) {
            seen.add(kid.id);
            renderChildren(kid, prefix + (isLast ? GLYPHS.blank : GLYPHS.vert));
          }
        });
      };
      renderChildren(root, "");
    }
    return lines.join("\n");
  }

  // セッション全体の到達数（ファイル単位で重複を除く。グレードは最も強いものを採用）
  const bestGrade = new Map<string, string>();
  const rank = (g: string | null): number => (g === "A" ? 3 : g === "B" ? 2 : g === "C" ? 1 : 0);
  for (const part of st.skills) for (const n of part.nodes) {
    const cur = bestGrade.get(n.id);
    if (!cur || rank(n.grade) > rank(cur)) bestGrade.set(n.id, n.grade ?? "");
  }
  const counts = { A: 0, B: 0, C: 0, N: 0 } as Record<string, number>;
  for (const g of bestGrade.values()) counts[g || "N"]++;
  const skillNames = st.skills.map(p => p.skillName).join(", ");
  lines.push(en ? `SkillTrace session summary` : `SkillTrace セッションサマリ`);
  lines.push(`${en ? "Workspace" : "ワークスペース"}: ${st.session.workspace}`);
  lines.push(`${en ? "Started" : "開始"}: ${st.session.startedAt ? formatLocalDateTime(st.session.startedAt, lang) : en ? "unknown" : "不明"}`);
  lines.push(`${en ? "Session" : "セッション"}: ${st.session.id}`);
  lines.push(en
    ? `Skills: ${skillNames} / High ${counts.A} · Medium ${counts.B} · Low ${counts.C} · No record ${counts.N}`
    : `スキル: ${skillNames} ／ 確度高 ${counts.A} ・ 確度中 ${counts.B} ・ 確度低 ${counts.C} ・ 記録なし ${counts.N}`);

  for (const part of st.skills) {
    lines.push(`== ${part.skillName} ==`);
    renderPartLines(part, mode, lines, lang);
  }
  if (st.outsideReads.length) {
    lines.push(en ? "== Reads outside the skill ==" : "== スキル外の読み取り ==");
    for (const r of st.outsideReads) lines.push(en ? `- ${r.path} (${r.tool}${r.failed ? " · read failed" : ""})${r.title ? ` — ${r.title}` : ""}` : `- ${r.path}（${r.tool}${r.failed ? "・読取失敗" : ""}）${r.title ? ` — ${r.title}` : ""}`);
  }
  return lines.join("\n");
}
