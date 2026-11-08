// レポート（report.ts）と文書コピー（document.ts）で共有する小さな部品。
export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
export const fmt = (n: number | null | undefined): string => (n === null || n === undefined ? "—" : n.toLocaleString("en-US"));

/** Kiro のクレジット実測の表示（小数2桁。Kiro の画面表示に合わせる） */
export const fmtCredits = (v: number | null | undefined): string => (v === null || v === undefined ? "—" : v.toFixed(2));

/** 使用したツールの一覧を、重複を数えて短くまとめる（例: read_file ×3） */
export function usedToolsSummary(tools: string[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(", ");
}

/** 入力トークンの3分解。Copilot の記録では「入力」はキャッシュ読取・書込を含む総数のため、
 *  新規入力は差し引いて求める（Issue #9: 消費の構造を見せる）。
 *  キャッシュ合計が入力合計を超える不整合な記録では、実測値を切り詰めて見せたりせず、
 *  null を返して「3分解できない」ことを表示側に伝える */
export function inputSplit(t: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): { fresh: number; cacheRead: number; cacheWrite: number } | null {
  const input = Math.max(0, t.inputTokens);
  const cacheRead = Math.max(0, t.cacheReadTokens);
  const cacheWrite = Math.max(0, t.cacheWriteTokens);
  if (cacheRead + cacheWrite > input) return null;
  return { fresh: input - cacheRead - cacheWrite, cacheRead, cacheWrite };
}

/** キャッシュ書込が発生したターン（1始まり）と、初回ターン以外で最大の書込。
 *  診断ではなく観測として示すための事実だけを返す */
export function cacheWriteFacts(turns: { turn: number; cacheWriteTokens: number }[]): { turns: number[]; maxLater: { turn: number; tokens: number } | null } {
  const hits = turns.filter(t => t.cacheWriteTokens > 0).map(t => ({ turn: t.turn + 1, tokens: t.cacheWriteTokens }));
  const later = hits.filter(h => h.turn > 1);
  const maxLater = later.length ? later.reduce((a, b) => (b.tokens > a.tokens ? b : a)) : null;
  return { turns: hits.map(h => h.turn), maxLater };
}

/** キャッシュ書込の発生ターンを観測として述べる一文（発生がなければ空文字） */
export function cacheWriteObservation(turns: { turn: number; cacheWriteTokens: number }[]): string {
  const f = cacheWriteFacts(turns);
  if (!f.turns.length) return "";
  let s = `キャッシュ書込が発生したターン: ${f.turns.join("・")}`;
  if (f.maxLater) s += `。初回ターン以外で最大の書込はターン${f.maxLater.turn}（${fmt(f.maxLater.tokens)} トークン）です`;
  return s;
}

/** Kiro: 最初に記録された文脈使用率（contextUsage の最初のスナップショット。
 *  最初のターンの途中で記録されるため「開始前」の値ではない。常時文脈の重さの目安として使う） */
export function firstContextUsageRatio(series?: { ratio: number }[] | null): number | null {
  return series && series.length ? series[0].ratio : null;
}

/** 用語の説明（用語集 v0.1）。レポート末尾の表と、文書コピーの用語表で共有する。
 *  用語が増えたら、ここだけをメンテする */
export const GLOSSARY: [string, string][] = [
  ["到達の確度（高 / 中 / 低）", "そのファイルが実際に読み込まれた（到達した）ことを、記録からどれだけ確かに言えるかです。確度高: 内容がモデルのコンテキストに読み込まれた（loaded into context）ことを確認できた状態。確度中: ファイルを読むツール呼び出し（tool call）が成功した記録はあるが、内容がコンテキストに載ったところまでは記録から断定できない。確度低: 会話や記録の中でファイルへの言及はあるだけで、読み取りの記録はない（読まれたかどうかは判断できません）。"],
  ["記録なし", "そのファイルについての記録が見つからなかった、という意味です。「読まれていない」という意味ではありません（記録の残り方には範囲があります）。"],
  ["到達・到達順", "ファイルがコンテキストに読み込まれた（または読み取られた）ことを「到達」と呼んでいます。到達順はその順番で、番号はセッション全体の通し番号です。"],
  ["スキル起動（activation）", "依頼がスキルの description にマッチし（またはスラッシュコマンドで呼ばれ）、SKILL.md 本文がコンテキストに読み込まれることです。スキルは progressive disclosure（段階的開示）で読み込まれます: まず name と description（metadata）だけが常にコンテキストにあり、起動時に本文（instructions）、参照されたときに同梱ファイル（bundled resources）が読み込まれます。"],
  ["コンテキスト", "モデルがそのターンで参照している情報全体（システムの指示、会話履歴、読み込まれたファイルなど）のことです。その上限がコンテキストウィンドウ（context window）で、上限に近づくと古い内容が要約・切り捨てられることがあります。"],
  ["キャッシュ", "前のターンに送った入力と共通する部分を再利用する仕組みです。キャッシュ読取は再利用で済んだ入力、キャッシュ書込は将来の再利用のために保存された入力を指します。コンテキストの上限を増やすものではなく、同じ内容を繰り返し送るコストと時間を減らすためのものです。"],
  ["コンテキストウィンドウ使用量／使用率", "セッションの最後のターン時点で、コンテキストウィンドウの上限に対してどれだけ使っていたかです。使用量はトークン数、使用率はその割合を指します。"],
  ["クレジット（credit）", "Kiro での利用量の単位です。トークン数ではなく、依頼（ターン）ごとの作業量に対して課金・記録される単位で、セッション記録の usage_summary にターン単位で残ります。Kiro のセッションでは、SkillTrace はこのクレジット実測を表示します（トークンの内訳は記録されません）。"],
  ["推定トークン", "ファイルの文字数から概算したトークン数です。実際に消費される量とは別物で、大きさの目安として使います。"],
  ["実測", "セッション記録に残る usage（API の利用量記録）を集計した値です。入力（input）はモデルへ送られた量、出力（output）は生成された量、推論（reasoning）はモデル内部の推論に使われた量です。キャッシュまわりは「キャッシュ」の項を見てください。"],
  ["スキル外", "スキルの格納場所（.github / .kiro / .agents の skills フォルダ配下）には入っていないのに、スキルから参照されているファイルです。.kiro/steering/ の文書など、複数のスキルから共有される文書が該当します。"],
  ["スキル外の読み取り", "このスキルの参照関係（SKILL.md からの参照の連なり）の外にあるファイルを、エージェントが読んだ記録です。読取失敗と付いているものは、読み取りを試みて失敗した記録です。"],
  ["セッション／ターン", "セッションは1つのチャット（会話）全体、ターンはその中でのユーザーとエージェントの往復1回を指します。"],
  ["正本（canonical）", ".agents / .github / .kiro の3か所すべてに同じスキルがある場合に、.agents 側を正本（編集の元）とみなす運用を指します。3つ揃わない場合は正本扱いしません（SkillMap-Solo の用語）。"],
];
