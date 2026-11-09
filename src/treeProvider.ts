import * as vscode from "vscode";
import type { GraphNode } from "./core/graph";
import type { SessionTrace, SkillPart } from "./core/trace";
import { gradeCertaintyLabel } from "./core/trace";
import { firstContextUsageRatio, type Lang } from "./core/common";
import { capSessionsBySource, type SessionInfo } from "./core/sessions";

// ツリーの階層（0.4.0）: セッション履歴 ＞ セッション ＞ 発動スキル ＞ 参照ツリー。
// 手動取り込みは廃止し、セッションは履歴として常時並ぶ。表示中のセッションだけが
// 中身（スキルと参照ツリー）を持ち、過去セッションは開いたときに初めて構築する。
export interface SessionEl { kind: "session"; session: SessionInfo }
export interface SkillEl { kind: "skill"; session: SessionInfo; part: SkillPart }
export interface NodeEl { kind: "node"; session: SessionInfo; part: SkillPart; gnode: GraphNode }
export interface OutsideGroupEl { kind: "outsideGroup"; session: SessionInfo; reads: SessionTrace["outsideReads"] }
export interface OutsideEl { kind: "outside"; session: SessionInfo; read: SessionTrace["outsideReads"][number] }
export interface ContextGroupEl { kind: "contextGroup"; session: SessionInfo; loads: NonNullable<SessionTrace["contextLoads"]>; startRatio?: number | null }
export interface ContextFileEl { kind: "contextFile"; session: SessionInfo; load: NonNullable<SessionTrace["contextLoads"]>[number] }
export interface NoteEl { kind: "note"; session: SessionInfo; text: string }
export type El = SessionEl | SkillEl | NodeEl | OutsideGroupEl | OutsideEl | ContextGroupEl | ContextFileEl | NoteEl;

export function elementKey(el: El): string {
  switch (el.kind) {
    case "session": return `s:${el.session.id}`;
    case "skill": return `k:${el.session.id}:${el.part.skillName}`;
    case "node": return `n:${el.session.id}:${el.part.skillName}:${el.gnode.id}`;
    case "outsideGroup": return `o:${el.session.id}`;
    case "outside": return `o:${el.session.id}:${el.read.path}`;
    case "contextGroup": return `c:${el.session.id}`;
    case "contextFile": return `c:${el.session.id}:${el.load.path}`;
    case "note": return `t:${el.session.id}:${el.text}`;
  }
}

class StTreeItem extends vscode.TreeItem {
  constructor(public readonly el: El) { super(""); }
}

function baseName(p: string | null): string {
  if (!p) return "";
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/** 履歴ラベル用のワークスペース名。マルチルートの .code-workspace ファイルは
 *  拡張子を落としてグリフ（⧉ = 複数フォルダの束）を付け、行を短く保つ。
 *  フルパスはツールチップ側に残る */
function workspaceLabel(p: string | null): string {
  const base = baseName(p);
  if (/\.code-workspace$/i.test(base)) return `${base.replace(/\.code-workspace$/i, "")} ⧉`;
  return base;
}

function timeLabel(mtimeMs: number, lang: Lang = "ja"): string {
  const d = new Date(mtimeMs);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (d.toDateString() === now.toDateString()) return lang === "en" ? `Today ${hh}:${mm}` : `今日 ${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

export class TraceTreeProvider implements vscode.TreeDataProvider<El> {
  private _onDidChange = new vscode.EventEmitter<El | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private sessions: SessionInfo[] = [];
  private displayedId: string | null = null;
  /** sessionId → 構築済みトレース。null は「構築したがスキル発動なし」 */
  private traces = new Map<string, SessionTrace | null>();
  /** 表示中コピー用: 展開されている要素キーの集合（ビュー側のイベントで維持する） */
  private expanded = new Set<string>();

  constructor(
    private readonly ensureTrace: (session: SessionInfo) => Promise<SessionTrace | null>,
    private readonly invokedLabel: (session: SessionInfo) => string[] | null,
    private readonly lang: Lang = "ja",
  ) {}

  /** 表示言語で出し分ける短いラベル */
  private L(ja: string, en: string): string {
    return this.lang === "en" ? en : ja;
  }

  // --- 状態の受け渡し ---
  setSessions(sessions: SessionInfo[], displayedId: string | null): void {
    this.sessions = sessions;
    this.displayedId = displayedId;
    this._onDidChange.fire(undefined);
  }
  refreshAll(): void { this._onDidChange.fire(undefined); }
  getDisplayedId(): string | null { return this.displayedId; }
  getSession(id: string): SessionInfo | undefined { return this.sessions.find(s => s.id === id); }
  getLatest(): SessionInfo | undefined { return this.sessions[0]; }

  /** 展開状態の初期化（シード）済みのセッション */
  private seeded = new Set<string>();
  /**
   * セッション自体の展開キーを初期表示として記録済みのセッション。
   * トレース再構築のたびに無条件で記録し直すと、ツリーの矢印で手動で
   * 閉じた状態（collapsedFlag は立たない）を上書きしてしまうため、
   * 「この表示期間では初期化済み」をこちらで覚える。再構築では消えない
   */
  private keySeeded = new Set<string>();
  /** 「すべて折りたたむ」の実装用: 世代を上げると項目を作り直させて畳んだ状態で再描画できる */
  private collapseEpoch = new Map<string, number>();
  private collapsedFlag = new Set<string>();
  /** 全セッション展開モード（0.4.6）: オンなら履歴の全セッションを展開状態で描く */
  private allSessionsExpanded = false;
  /** 全項目の作り直し用世代（モード切替時に上げて、展開状態を描き直させる） */
  private renderEpoch = 0;

  isAllSessionsExpanded(): boolean { return this.allSessionsExpanded; }
  setAllSessionsExpanded(on: boolean): void {
    if (this.allSessionsExpanded === on) {
      // すでに全展開モードでも、「すべて展開」の再押下では手で畳まれた
      // 項目を開き直せるよう、項目を作り直して再描画する（モードが
      // 変わらないと再描画されず、ボタンが無反応に見えるため）
      if (on) { this.renderEpoch++; this._onDidChange.fire(undefined); }
      return;
    }
    this.allSessionsExpanded = on;
    // オフに戻すだけでは畳まない（畳むのは collapseAllSessions の役目）。
    // 折りたたみフラグはここでは触らない: 項目単位の操作でモードを抜けたときに、
    // 以前に畳んだセッションまで開いてしまうのを防ぐ
    this.renderEpoch++;
    this._onDidChange.fire(undefined);
  }
  /** 全セッションを明示的に折りたたむ（タイトルバーのトグルをオフにしたとき）。
   *  表示中セッションの「既定で展開」よりも、利用者の明示操作を優先する。
   *  後から到着した新しいセッションにはフラグが付かないので、自動追尾で
   *  最新が開く動きはそのまま保たれる */
  collapseAllSessions(): void {
    for (const s of this.sessions) {
      // 項目を作り直して畳んだ状態を確実に反映させる（collapseSession と同じ。
      // フラグだけでは、同じ項目 ID の開閉状態を保持する VS Code 側に
      // 反映されないことがある）
      this.collapseEpoch.set(s.id, (this.collapseEpoch.get(s.id) ?? 0) + 1);
      this.collapsedFlag.add(s.id);
      this.seeded.delete(s.id);
      this.keySeeded.delete(s.id);
      for (const key of [...this.expanded]) {
        if (key === `s:${s.id}` || key.startsWith(`k:${s.id}:`) || key.startsWith(`n:${s.id}:`) || key.startsWith(`o:${s.id}`) || key.startsWith(`c:${s.id}`)) {
          this.expanded.delete(key);
        }
      }
    }
    this._onDidChange.fire(undefined);
  }

  async getOrBuildTrace(session: SessionInfo): Promise<SessionTrace | null> {
    if (!this.traces.has(session.id)) {
      const trace = await this.ensureTrace(session);
      this.traces.set(session.id, trace);
      if (session.id === this.displayedId && !this.collapsedFlag.has(session.id)) {
        // 表示中セッションは開いて描かれるため、セッション自体の展開は
        // トレースの有無によらず記録する。記録が無いと、項目側トグルが
        // 「閉じている」と誤判定し、トレース無しセッションを閉じられなくなる。
        // ただし記録は表示期間の初期化として1回だけ: 再構築のたびに
        // 記録し直すと、矢印で手動で閉じた状態を上書きしてしまう
        if (!this.keySeeded.has(session.id)) {
          this.keySeeded.add(session.id);
          this.expanded.add(`s:${session.id}`);
        }
        // 子（スキル／ルートノード）のシードはトレースがあって初めてできる。
        // seeded は「子までシード済み」の印として、セッション自体の記録とは
        // 分ける（構築前に完了扱いにすると、構築後も子がシードされず、
        // 表示中コピーが表示されている子を取りこぼす）
        if (trace && !this.seeded.has(session.id)) {
          this.seeded.add(session.id);
          this.seedExpanded(session.id, trace);
        }
      }
    }
    return this.traces.get(session.id) ?? null;
  }
  getTrace(sessionId: string): SessionTrace | null | undefined {
    return this.traces.get(sessionId);
  }
  /** 記録が伸びたセッションのキャッシュを捨てる（次回アクセスで再構築） */
  invalidateTrace(sessionId: string): void { this.traces.delete(sessionId); }

  /** スキルとルートノードの展開シード（セッション自体の記録は呼び出し側で行う） */
  private seedExpanded(sessionId: string, trace: SessionTrace): void {
    for (const part of trace.skills) {
      this.expanded.add(`k:${sessionId}:${part.skillName}`);
      this.expanded.add(`n:${sessionId}:${part.skillName}:${part.graph.rootId}`);
    }
  }
  /** 表示中セッションが切り替わったとき、展開状態は新しいセッションの初期状態から始める。
   *  ただし明示的に畳まれたセッションは、表示に切り替えても畳んだままにする
   *  （開くのは displaySession 側でフラグを解除してからここに来る経路だけ） */
  resetExpandedFor(sessionId: string): void {
    this.expanded = new Set();
    this.seeded.delete(sessionId);
    this.keySeeded.delete(sessionId);
    if (!this.collapsedFlag.has(sessionId)) {
      // トレースの有無によらず、表示中セッション自体の展開は記録する
      // （getOrBuildTrace 側と同じ理由）。子のシードは seeded で別に管理し、
      // トレースがまだ無い場合は構築後に getOrBuildTrace が行う
      this.keySeeded.add(sessionId);
      this.expanded.add(`s:${sessionId}`);
      const trace = this.traces.get(sessionId);
      if (trace) { this.seeded.add(sessionId); this.seedExpanded(sessionId, trace); }
    }
  }
  setExpanded(key: string, isExpanded: boolean): void {
    if (isExpanded) this.expanded.add(key); else this.expanded.delete(key);
  }
  /** セッション自体が開いているか（トグルの判定はこれだけに使う）。
   *  以前は「配下の全要素が開いているか」で判定していたため、手で1つ畳んだり
   *  展開の取りこぼしが1つでもあると永遠に「未展開」と判定され、畳む側に
   *  倒れなかった（2026-11-07 の不具合報告） */
  isSessionExpanded(sessionId: string): boolean {
    return this.expanded.has(`s:${sessionId}`);
  }
  /** そのセッション配下をすべて折りたたむ（項目を作り直して畳んだ状態で再描画する） */
  collapseSession(sessionId: string): void {
    this.collapseEpoch.set(sessionId, (this.collapseEpoch.get(sessionId) ?? 0) + 1);
    this.collapsedFlag.add(sessionId);
    for (const key of [...this.expanded]) {
      if (key === `s:${sessionId}` || key.startsWith(`k:${sessionId}:`) || key.startsWith(`n:${sessionId}:`) || key.startsWith(`o:${sessionId}`) || key.startsWith(`c:${sessionId}`)) {
        this.expanded.delete(key);
      }
    }
    this.seeded.delete(sessionId);
    this.keySeeded.delete(sessionId);
    this._onDidChange.fire(undefined);
  }
  /** ユーザーが手で開いたら、折りたたみフラグはそのセッションについて解除する */
  clearCollapsed(sessionId: string): void { this.collapsedFlag.delete(sessionId); }
  /** そのセッションの項目を作り直させる（項目 ID の世代を上げる）。
   *  VS Code は同じ項目 ID の開閉状態を保持するため、フラグや collapsibleState を
   *  変えただけでは表示に反映されないことがある。作り直しで確実に反映させる */
  recreateSessionItems(sessionId: string): void {
    this.collapseEpoch.set(sessionId, (this.collapseEpoch.get(sessionId) ?? 0) + 1);
  }
  isNodeExpanded(sessionId: string, skillName: string, absId: string): boolean {
    return this.expanded.has(`n:${sessionId}:${skillName}:${absId}`);
  }
  keyOf(el: El): string { return elementKey(el); }

  // --- TreeDataProvider ---
  getTreeItem(element: El): vscode.TreeItem {
    const item = new StTreeItem(element);
    const epoch = this.collapseEpoch.get(element.session.id) ?? 0;
    item.id = elementKey(element) + ((epoch || this.renderEpoch) ? `#${epoch}.${this.renderEpoch}` : "");
    const forceCollapsed = this.collapsedFlag.has(element.session.id);
    const allExp = this.allSessionsExpanded;
    switch (element.kind) {
      case "session": {
        const s = element.session;
        const isLatest = this.sessions[0]?.id === s.id;
        const isDisplayed = this.displayedId === s.id;
        item.label = `${timeLabel(s.mtimeMs, this.lang)} ${workspaceLabel(s.workspaceHint)}`.trim();
        const invoked = this.invokedLabel(s);
        // 行は短く保つ（ホバー時のボタンを収めるため）。発動スキルは子項目とツールチップで示す
        const parts: string[] = [];
        if (s.source === "kiro") parts.push("Kiro");
        if (s.source === "vscode") parts.push("Copilot Chat");
        if (isDisplayed) parts.push(this.L("表示中", "Showing"));
        if (isLatest) parts.push(this.L("最新", "Latest"));
        if (invoked !== null && invoked.length === 0) parts.push(this.L("スキル未使用", "No skill used"));
        item.description = parts.join(this.lang === "en" ? " · " : " ・ ");
        item.tooltip = new vscode.MarkdownString([
          `**${this.L("セッション", "Session")} ${s.id}**`,
          "",
          s.title ? `${this.L("タイトル", "Title")}: ${s.title}` : "",
          `${this.L("最終更新", "Last updated")}: ${new Date(s.mtimeMs).toLocaleString(this.lang === "en" ? "en-US" : "ja-JP")}`,
          s.source === "kiro" ? `${this.L("記録", "Record")}: Kiro` : s.source === "vscode" ? `${this.L("記録", "Record")}: Copilot Chat` : `${this.L("記録", "Record")}: Copilot`,
          s.workspaceHint ? `${this.L("ワークスペース", "Workspace")}: ${s.workspaceHint}` : "",
          `${this.L("起動したスキル", "Activated skills")}: ${invoked === null ? this.L("未判定", "undetermined") : invoked.length ? invoked.join(", ") : this.L("なし", "none")}`,
        ].filter(Boolean).join("\n"));
        item.iconPath = new vscode.ThemeIcon(isDisplayed ? "eye" : "history");
        item.collapsibleState = allExp ? vscode.TreeItemCollapsibleState.Expanded
          : forceCollapsed ? vscode.TreeItemCollapsibleState.Collapsed
          : isDisplayed ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
        item.contextValue = "skilltraceSession";
        item.command = { command: "skilltrace.displaySession", title: "Display Session", arguments: [s.id] };
        break;
      }
      case "skill": {
        const counts = { A: 0, B: 0, C: 0, N: 0 } as Record<string, number>;
        for (const n of element.part.nodes) counts[n.grade ?? "N"]++;
        const reached = element.part.nodes.filter(n => n.order !== null);
        const firstOrder = reached.length ? Math.min(...reached.map(n => n.order!)) : null;
        item.label = element.part.skillName;
        item.description = this.lang === "en"
          ? `High ${counts.A} · Medium ${counts.B} · Low ${counts.C} · No record ${counts.N}${firstOrder !== null ? ` · first arrival #${firstOrder}` : ""}`
          : `確度高 ${counts.A} ・ 確度中 ${counts.B} ・ 確度低 ${counts.C} ・ 記録なし ${counts.N}${firstOrder !== null ? ` ・ 最初の到達 #${firstOrder}` : ""}`;
        item.tooltip = new vscode.MarkdownString(`**${element.part.skillName}**\n\n${element.part.skillDir}`);
        item.iconPath = new vscode.ThemeIcon("extensions");
        item.collapsibleState = allExp ? vscode.TreeItemCollapsibleState.Expanded
          : forceCollapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded;
        item.contextValue = "skilltraceSkill";
        break;
      }
      case "node": {
        const gn = element.gnode;
        const tn = element.part.nodes.find(n => n.id === gn.id);
        const grade = tn?.grade ?? null;
        const parts: string[] = [];
        parts.push(grade ? gradeCertaintyLabel(grade, this.lang) : this.L("記録なし", "No record"));
        if (tn?.order !== null && tn?.order !== undefined) parts.push(`#${tn.order}`);
        if (gn.boundary) parts.push(this.L("スキル外", "outside skill"));
        if (gn.missing) parts.push(this.L("参照先なし", "missing target"));
        if (gn.cycle) parts.push(this.L("循環", "cycle"));
        parts.push(this.L(`~${gn.estTokens} トークン`, `~${gn.estTokens} tokens`));
        item.label = gn.relToSkill;
        item.description = parts.join(this.lang === "en" ? " · " : " ・ ");
        item.tooltip = new vscode.MarkdownString([
          `**${gn.relToSkill}**`,
          "",
          gn.title ? `${this.L("タイトル", "Title")}: ${gn.title}` : "",
          tn ? `${this.L("根拠", "Evidence")}: ${tn.evidence}` : this.L("根拠: 対応付けなし", "Evidence: no match"),
          tn?.firstAt ? `${this.L("初出", "First seen")}: ${tn.firstAt}` : "",
          this.L(`推定トークン: ${gn.estTokens} ／ サイズ: ${gn.sizeBytes} bytes`, `Est. tokens: ${gn.estTokens} / size: ${gn.sizeBytes} bytes`),
        ].filter(Boolean).join("\n"));
        item.iconPath = new vscode.ThemeIcon(
          gn.missing ? "warning" : grade === "A" ? "verified-filled" : grade === "B" ? "file-code" : grade === "C" ? "question" : "circle-outline",
        );
        const hasChildren = gn.children.length > 0 && !gn.cycle;
        item.collapsibleState = !hasChildren ? vscode.TreeItemCollapsibleState.None
          : allExp ? vscode.TreeItemCollapsibleState.Expanded
          : forceCollapsed ? vscode.TreeItemCollapsibleState.Collapsed
          : (gn.id === element.part.graph.rootId ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = "skilltraceNode";
        item.command = { command: "skilltrace.openNodeFile", title: "Open File", arguments: [gn.absPath] };
        break;
      }
      case "outsideGroup": {
        item.label = this.L("スキル外の読み取り", "Reads outside the skill");
        item.description = this.L(`${element.reads.length} 件`, `${element.reads.length} items`);
        item.iconPath = new vscode.ThemeIcon("folder");
        item.collapsibleState = allExp ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
        item.contextValue = "skilltraceOutsideGroup";
        break;
      }
      case "contextGroup": {
        item.label = this.L("常時文脈", "Always-loaded context");
        item.description = element.startRatio !== null && element.startRatio !== undefined
          ? this.L(`${element.loads.length} 件 ・ 最初の記録 ${(element.startRatio * 100).toFixed(1)}%`, `${element.loads.length} items · first record ${(element.startRatio * 100).toFixed(1)}%`)
          : this.L(`${element.loads.length} 件`, `${element.loads.length} items`);
        item.tooltip = this.L("スキル起動とは別に、セッションの文脈として常に読み込まれる文書（steering など）", "Documents that are always loaded as the session's context, apart from skill activation (such as steering)")
          + (element.startRatio !== null && element.startRatio !== undefined
            ? this.L(`\n最初に記録されたコンテキストウィンドウ使用率: ${(element.startRatio * 100).toFixed(1)}%（プロンプト等も含むため、常時文脈だけの使用率は分かりません）`, `\nFirst recorded context window usage: ${(element.startRatio * 100).toFixed(1)}% (includes the prompt and other content, so the share of the always-loaded context alone is unknown)`) : "");
        item.iconPath = new vscode.ThemeIcon("folder");
        item.collapsibleState = allExp ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
        item.contextValue = "skilltraceContextGroup";
        break;
      }
      case "contextFile": {
        const l = element.load;
        item.label = l.path.split(/[/\\\\]/).filter(Boolean).pop() ?? l.path;
        item.description = "";
        item.tooltip = `${l.path}\n${l.at ?? ""}`;
        item.iconPath = new vscode.ThemeIcon("file");
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        item.contextValue = "skilltraceContextFile";
        const segments = l.path.split(/[/\\\\]/).filter(Boolean).length;
        if (/^[a-zA-Z]:[\\\\/]/.test(l.path) || (l.path.startsWith("/") && segments >= 3)) {
          item.command = { command: "skilltrace.openNodeFile", title: "Open File", arguments: [l.path] };
        }
        break;
      }
      case "outside": {
        const r = element.read;
        item.label = r.path.split(/[/\\]/).filter(Boolean).pop() ?? r.path;
        item.description = [r.title ?? "", r.tool, r.failed ? this.L("読取失敗", "read failed") : ""].filter(Boolean).join(this.lang === "en" ? " · " : " ・ ");
        item.tooltip = `${r.path}\n${r.at ?? ""}`;
        item.iconPath = new vscode.ThemeIcon(r.failed ? "error" : "file");
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        item.contextValue = "skilltraceOutside";
        // 絶対パスらしいものはクリックでファイルを開けるようにする
        const segments = r.path.split(/[/\\]/).filter(Boolean).length;
        if (/^[a-zA-Z]:[\\/]/.test(r.path) || (r.path.startsWith("/") && segments >= 3)) {
          item.command = { command: "skilltrace.openNodeFile", title: "Open File", arguments: [r.path] };
        }
        break;
      }
      case "note": {
        item.label = element.text;
        item.iconPath = new vscode.ThemeIcon("info");
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        item.contextValue = "skilltraceNote";
        break;
      }
    }
    return item;
  }

  async getChildren(element?: El): Promise<El[]> {
    if (!element) {
      return capSessionsBySource(this.sessions, 30).map(session => ({ kind: "session", session } as SessionEl));
    }
    switch (element.kind) {
      case "session": {
        const trace = await this.getOrBuildTrace(element.session);
        if (!trace) return [{ kind: "note", session: element.session, text: this.L("このセッションではスキル起動を検出できませんでした", "No skill activation was detected in this session") } as NoteEl];
        const out: El[] = trace.skills.map(part => ({ kind: "skill", session: element.session, part } as SkillEl));
        if (trace.contextLoads?.length) out.push({ kind: "contextGroup", session: element.session, loads: trace.contextLoads, startRatio: firstContextUsageRatio(trace.contextUsageSeries) } as ContextGroupEl);
        if (trace.outsideReads.length) out.push({ kind: "outsideGroup", session: element.session, reads: trace.outsideReads } as OutsideGroupEl);
        // 記録では起動が確認できたのに、現在のワークスペースで見つからないスキル。
        // 何も出さないと「開いたのに空」という無言の失敗になるため、注記として出す
        for (const name of trace.undiscoveredSkills ?? []) {
          const hint = element.session.workspaceHint;
          out.push({ kind: "note", session: element.session, text: this.L(
            `起動したスキル「${name}」は現在のワークスペースで見つかりませんでした${hint ? `（このセッションは ${hint} で実行されました。開くと参照ツリーを表示できます）` : ""}`,
            `The activated skill "${name}" was not found in the current workspace${hint ? ` (this session ran in ${hint}; open it to see the reference tree)` : ""}`) } as NoteEl);
        }
        // トレースはあるのに表示できる項目が無い場合も、空の展開で終わらせない
        if (!out.length) {
          out.push({ kind: "note", session: element.session, text: this.L("このセッションには表示できる項目がありません（スキル起動・常時文脈・読み取りの記録なし）", "Nothing to show in this session (no records of skill activation, always-loaded context, or reads)") } as NoteEl);
        }
        return out;
      }
      case "skill": {
        const root = element.part.graph.nodes.get(element.part.graph.rootId);
        return root ? [{ kind: "node", session: element.session, part: element.part, gnode: root } as NodeEl] : [];
      }
      case "node": {
        const seen = new Set<string>();
        const out: El[] = [];
        for (const cid of element.gnode.children) {
          if (seen.has(cid)) continue;
          seen.add(cid);
          const child = element.part.graph.nodes.get(cid);
          if (child) out.push({ kind: "node", session: element.session, part: element.part, gnode: child } as NodeEl);
        }
        return out;
      }
      case "outsideGroup":
        return element.reads.map(read => ({ kind: "outside", session: element.session, read } as OutsideEl));
      case "contextGroup":
        return element.loads.map(load => ({ kind: "contextFile", session: element.session, load } as ContextFileEl));
      default:
        return [];
    }
  }

  getParent(element: El): El | undefined {
    switch (element.kind) {
      case "session":
        return undefined;
      case "skill":
      case "outsideGroup":
      case "contextGroup":
      case "note":
        return { kind: "session", session: element.session };
      case "outside": {
        const trace = this.traces.get(element.session.id);
        return trace ? { kind: "outsideGroup", session: element.session, reads: trace.outsideReads } : { kind: "session", session: element.session };
      }
      case "contextFile": {
        const trace = this.traces.get(element.session.id);
        return trace?.contextLoads ? { kind: "contextGroup", session: element.session, loads: trace.contextLoads, startRatio: firstContextUsageRatio(trace.contextUsageSeries) } : { kind: "session", session: element.session };
      }
      case "node": {
        if (element.gnode.id === element.part.graph.rootId) {
          return { kind: "skill", session: element.session, part: element.part };
        }
        const parentId = element.gnode.parents[0];
        const parent = parentId ? element.part.graph.nodes.get(parentId) : undefined;
        return parent
          ? { kind: "node", session: element.session, part: element.part, gnode: parent }
          : { kind: "skill", session: element.session, part: element.part };
      }
    }
  }
}
