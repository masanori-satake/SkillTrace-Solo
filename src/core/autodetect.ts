// セッション記録から「どのスキルが使われたか」を自動判定する。
// 1回のチャットで複数スキルが呼ばれうるため、判定は複数返し（発動順）。
// 手がかりの強い順に: (1) skill.invoked 系イベントの文字列にスキルフォルダのパスが含まれる
// (2) 最初のユーザーメッセージの "/スキル名" 呼び出し。
// どれにも当たらず、ワークスペース内のスキルが1つだけなら、それを候補にする。
import { normPath } from "./graph";
import { discoverSkills } from "./sessions";
import type { ParsedEvents } from "./events";

export interface SkillRef { name: string; dir: string }

export function detectSkillsForSession(parsed: ParsedEvents, workspaceDir: string): SkillRef[] {
  const skills = discoverSkills(workspaceDir);
  if (!skills.length) return [];

  const invokedStrings: string[] = [];
  for (const ev of parsed.events) {
    if (ev.type === "skill.invoked" || ev.type === "skill.invoked_ref") invokedStrings.push(...ev.strings);
  }
  const invokedNorm = invokedStrings.map(s => normPath(s));

  const matched: SkillRef[] = [];
  for (const skill of skills) {
    const dirNorm = normPath(skill.dir);
    const hit = invokedNorm.some(s => s.includes(dirNorm))
      || invokedNorm.some(s => s === skill.name.toLowerCase())
      || parsed.firstUserMessage.includes(`/${skill.name}`);
    if (hit) matched.push(skill);
  }
  if (!matched.length) return skills.length === 1 ? [skills[0]] : [];

  // 発動順: 全イベントの文字列にスキルフォルダが最初に現れる位置で並べる
  const firstIdx = new Map<string, number>();
  parsed.events.forEach((ev, i) => {
    for (const s of ev.strings) {
      const ns = normPath(s);
      for (const skill of matched) {
        if (!firstIdx.has(skill.name) && ns.includes(normPath(skill.dir))) firstIdx.set(skill.name, i);
      }
    }
  });
  return matched.sort((a, b) => (firstIdx.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (firstIdx.get(b.name) ?? Number.MAX_SAFE_INTEGER));
}

export function detectSkillForSession(parsed: ParsedEvents, workspaceDir: string): SkillRef | null {
  return detectSkillsForSession(parsed, workspaceDir)[0] ?? null;
}
