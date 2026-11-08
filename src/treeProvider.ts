import * as vscode from "vscode";
import type { GraphNode } from "./core/graph";
import type { SessionTrace, SkillPart } from "./core/trace";
import { gradeCertaintyLabel } from "./core/trace";
import { firstContextUsageRatio } from "./core/common";
import type { SessionInfo } from "./core/sessions";

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

function timeLabel(mtimeMs: number): string {
  const d = new Date(mtimeMs);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (d.toDateString() === now.toDateString()) return `今日 ${hh}:${mm}`;
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
  ) {}

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
  /** 「すべて折りたたむ」の実装用: 世代を上げると項目を作り直させて畳んだ状態で再描画できる */
  private collapseEpoch = new Map<string, number>();
  private collapsedFlag = new Set<string>();
  /** 全セッション展開モード（0.4.6）: オンなら履歴の全セッションを展開状態で描く */
  private allSessionsExpanded = false;
  /** 全項目の作り直し用世代（モード切替時に上げて、展開状態を描き直させる） */
  private renderEpoch = 0;

  isAllSessionsExpanded(): boolean { return this.allSessionsExpanded; }
  setAllSessionsExpanded(on: boolean): void {
    if (this.allSessionsExpanded === on) return;
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
      this.collapsedFlag.add(s.id);
      this.seeded.delete(s.id);
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
      if (trace && session.id === this.displayedId && !this.seeded.has(session.id) && !this.collapsedFlag.has(session.id)) {
        this.seeded.add(session.id);
        this.seedExpanded(session.id, trace);
      }
    }
    return this.traces.get(session.id) ?? null;
  }
  getTrace(sessionId: string): SessionTrace | null | undefined {
    return this.traces.get(sessionId);
  }
  /** 記録が伸びたセッションのキャッシュを捨てる（次回アクセスで再構築） */
  invalidateTrace(sessionId: string): void { this.traces.delete(sessionId); }

  private seedExpanded(sessionId: string, trace: SessionTrace): void {
    this.expanded.add(`s:${sessionId}`);
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
    const trace = this.traces.get(sessionId);
    if (trace && !this.collapsedFlag.has(sessionId)) { this.seeded.add(sessionId); this.seedExpanded(sessionId, trace); }
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
        item.label = `${timeLabel(s.mtimeMs)} ${baseName(s.workspaceHint)}`.trim();
        const invoked = this.invokedLabel(s);
        // 行は短く保つ（ホバー時のボタンを収めるため）。発動スキルは子項目とツールチップで示す
        const parts: string[] = [];
        if (s.source === "kiro") parts.push("Kiro");
        if (isDisplayed) parts.push("表示中");
        if (isLatest) parts.push("最新");
        if (invoked !== null && invoked.length === 0) parts.push("スキル未使用");
        item.description = parts.join(" ・ ");
        item.tooltip = new vscode.MarkdownString([
          `**セッション ${s.id}**`,
          "",
          s.title ? `タイトル: ${s.title}` : "",
          `最終更新: ${new Date(s.mtimeMs).toLocaleString()}`,
          s.source === "kiro" ? "記録: Kiro" : "記録: Copilot",
          s.workspaceHint ? `ワークスペース: ${s.workspaceHint}` : "",
          `起動したスキル: ${invoked === null ? "未判定" : invoked.length ? invoked.join(", ") : "なし"}`,
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
        item.description = `確度高 ${counts.A} ・ 確度中 ${counts.B} ・ 確度低 ${counts.C} ・ 記録なし ${counts.N}${firstOrder !== null ? ` ・ 最初の到達 #${firstOrder}` : ""}`;
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
        parts.push(grade ? gradeCertaintyLabel(grade) : "記録なし");
        if (tn?.order !== null && tn?.order !== undefined) parts.push(`#${tn.order}`);
        if (gn.boundary) parts.push("スキル外");
        if (gn.missing) parts.push("参照先なし");
        if (gn.cycle) parts.push("循環");
        parts.push(`~${gn.estTokens} トークン`);
        item.label = gn.relToSkill;
        item.description = parts.join(" ・ ");
        item.tooltip = new vscode.MarkdownString([
          `**${gn.relToSkill}**`,
          "",
          gn.title ? `タイトル: ${gn.title}` : "",
          tn ? `根拠: ${tn.evidence}` : "根拠: 対応付けなし",
          tn?.firstAt ? `初出: ${tn.firstAt}` : "",
          `推定トークン: ${gn.estTokens} ／ サイズ: ${gn.sizeBytes} bytes`,
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
        item.label = "スキル外の読み取り";
        item.description = `${element.reads.length} 件`;
        item.iconPath = new vscode.ThemeIcon("folder");
        item.collapsibleState = allExp ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
        item.contextValue = "skilltraceOutsideGroup";
        break;
      }
      case "contextGroup": {
        item.label = "常時文脈";
        item.description = element.startRatio !== null && element.startRatio !== undefined
          ? `${element.loads.length} 件 ・ 最初の記録 ${(element.startRatio * 100).toFixed(1)}%`
          : `${element.loads.length} 件`;
        item.tooltip = "スキル起動とは別に、セッションの文脈として常に読み込まれる文書（steering など）"
          + (element.startRatio !== null && element.startRatio !== undefined
            ? `\n最初に記録されたコンテキストウィンドウ使用率: ${(element.startRatio * 100).toFixed(1)}%（プロンプト等も含むため、常時文脈だけの使用率は分かりません）` : "");
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
        item.description = [r.title ?? "", r.tool, r.failed ? "読取失敗" : ""].filter(Boolean).join(" ・ ");
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
      return this.sessions.slice(0, 30).map(session => ({ kind: "session", session } as SessionEl));
    }
    switch (element.kind) {
      case "session": {
        const trace = await this.getOrBuildTrace(element.session);
        if (!trace) return [{ kind: "note", session: element.session, text: "このセッションではスキル起動を検出できませんでした" } as NoteEl];
        const out: El[] = trace.skills.map(part => ({ kind: "skill", session: element.session, part } as SkillEl));
        if (trace.contextLoads?.length) out.push({ kind: "contextGroup", session: element.session, loads: trace.contextLoads, startRatio: firstContextUsageRatio(trace.contextUsageSeries) } as ContextGroupEl);
        if (trace.outsideReads.length) out.push({ kind: "outsideGroup", session: element.session, reads: trace.outsideReads } as OutsideGroupEl);
        // 記録では起動が確認できたのに、現在のワークスペースで見つからないスキル。
        // 何も出さないと「開いたのに空」という無言の失敗になるため、注記として出す
        for (const name of trace.undiscoveredSkills ?? []) {
          out.push({ kind: "note", session: element.session, text: `起動したスキル「${name}」は現在のワークスペースで見つかりませんでした` } as NoteEl);
        }
        // トレースはあるのに表示できる項目が無い場合も、空の展開で終わらせない
        if (!out.length) {
          out.push({ kind: "note", session: element.session, text: "このセッションには表示できる項目がありません（スキル起動・常時文脈・読み取りの記録なし）" } as NoteEl);
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
