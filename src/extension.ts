import { existsSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { buildGraph } from "./core/graph";
import { parseEventsFile } from "./core/events";
import { buildSessionTrace, firstHeading, type SessionTrace } from "./core/trace";
import { renderSessionHtml, renderSkillHtml } from "./core/report";
import { defaultSessionStateDir, discoverSkills, listSessions, scanInvokedSkillNames, type SessionInfo } from "./core/sessions";
import { buildKiroSessionTrace, defaultKiroHome, listKiroSessions, parseKiroMessagesFile, scanKiroActivationNames } from "./core/kiro";
import { detectSkillsForSession } from "./core/autodetect";
import { renderSessionCopy } from "./core/copy";
import { renderSessionMarkdown, renderSkillMarkdown } from "./core/document";
import { TraceTreeProvider, elementKey, type El, type NodeEl, type SkillEl } from "./treeProvider";
import { langFromEnv, type Lang } from "./core/common";

// 0.4.0 の状態モデル:
// - セッションは「取り込む」ものではなく、履歴として常時並ぶ（手動取り込みは廃止）
// - 表示中のセッションは1つ。自動追尾は follow-tail 方式: 最新セッションを表示して
//   いる間だけ新しいセッションへ表示が移り、過去セッションを見ている間は
//   新着は履歴への追加とバッジだけで、開いている中身を差し替えない
/** 表示言語（ホストの表示言語から決まる。日本語以外は英語に寄せる） */
const LANG = langFromEnv(vscode.env.language);
/** 表示言語で出し分ける短い文言 */
const L = (ja: string, en: string): string => (LANG === "en" ? en : ja);

/** 文書コピーに「読み方の注意」と「用語の説明」を含めるか（設定。既定は含めない） */
const docOptions = (): { includeNotes: boolean; lang: Lang } => ({
  includeNotes: vscode.workspace.getConfiguration("skilltrace").get<boolean>("documentIncludeNotes") ?? false,
  lang: LANG,
});

export function activate(context: vscode.ExtensionContext): void {
  const sessionStateDir = (): string => {
    const cfg = vscode.workspace.getConfiguration("skilltrace").get<string>("sessionStateDir") ?? "";
    return cfg.trim() ? cfg.trim().replace(/^~(?=$|\/|\\)/, homedir()) : defaultSessionStateDir();
  };

  // Kiro: スキル探索はセッションの全ワークスペース（マルチルート）と
  // ユーザー全局（~/.kiro/skills 等）に対して行い、見つけたルートも一緒に返す
  const kiroSkillCandidates = (session: SessionInfo): { name: string; dir: string; root: string }[] => {
    const roots = session.workspacePaths?.length ? session.workspacePaths : (session.workspaceHint ? [session.workspaceHint] : []);
    const seen = new Set<string>();
    const out: { name: string; dir: string; root: string }[] = [];
    for (const root of [...roots, homedir()]) {
      if (!root || !existsSync(root)) continue;
      for (const s of discoverSkills(root)) {
        const key = s.dir.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...s, root });
      }
    }
    return out;
  };

  // セッションのトレース構築（parse → スキル判定（複数）→ グラフ → SessionTrace）
  const buildCache = new Map<string, { mtimeMs: number; trace: SessionTrace | null }>();
  const buildTraceFor = async (session: SessionInfo): Promise<SessionTrace | null> => {
    const cached = buildCache.get(session.id);
    if (cached && cached.mtimeMs === session.mtimeMs) return cached.trace;
    let trace: SessionTrace | null = null;
    try {
      if (session.source === "kiro") {
        const parsed = await parseKiroMessagesFile(session.eventsPath);
        const activated = new Set(parsed.activations.map(a => a.name));
        const parts = kiroSkillCandidates(session)
          .filter(s => activated.has(s.name))
          .map(s => ({ graph: buildGraph(s.dir, s.root), skillDirAbs: s.dir, disclosed: true }));
        // スキル起動が無くても、常時文脈・クレジット・読み取りの記録があれば
        // トレースを構築する（仕様駆動などのセッションでも中身が見えるように）。
        // 起動の記録だけがある場合も対象に含める（スキルが見つからなくても
        // 起動の事実は注記として表示するため）
        const hasContent = parsed.inclusions.length > 0 || parsed.creditsTotal > 0 || parsed.toolExecutions.length > 0 || parsed.activations.length > 0;
        if (parts.length || hasContent) {
          const workspaceAbs = session.workspacePaths?.[0] ?? session.workspaceHint ?? "";
          trace = buildKiroSessionTrace(parsed, parts, { sessionId: session.id, workspaceAbs, lang: LANG });
        }
        buildCache.set(session.id, { mtimeMs: session.mtimeMs, trace });
        return trace;
      }
      const workspaceDir = (session.workspaceHint && existsSync(session.workspaceHint))
        ? session.workspaceHint
        : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "");
      if (workspaceDir) {
        const parsed = await parseEventsFile(session.eventsPath);
        const skills = detectSkillsForSession(parsed, workspaceDir);
        if (skills.length) {
          const parts = skills.map(skill => {
            let rootHeading: string | null = null;
            try { rootHeading = firstHeading(readFileSync(join(skill.dir, "SKILL.md"), "utf8")); } catch { /* 見出しなし */ }
            return { graph: buildGraph(skill.dir, workspaceDir), skillDirAbs: skill.dir, rootHeading };
          });
          trace = buildSessionTrace(parsed, parts, { sessionId: session.id, workspaceAbs: workspaceDir, lang: LANG });
        }
      }
    } catch { trace = null; }
    buildCache.set(session.id, { mtimeMs: session.mtimeMs, trace });
    return trace;
  };

  // 履歴ラベル用の軽量スキャン（結果は id+mtime でキャッシュ）
  const scanCache = new Map<string, string[] | null>();
  const invokedLabel = (session: SessionInfo): string[] | null => {
    const key = `${session.id}:${session.mtimeMs}`;
    const hit = scanCache.get(key);
    if (hit !== undefined) return hit;
    let result: string[] | null = null;
    if (session.source === "kiro") {
      // ラベルは「記録で何が起動したか」を示すものなので、候補（現在のワーク
      // スペースで見つかるスキル）の有無に左右されず、記録の起動名をそのまま使う。
      // 候補で絞ると、無関係なスキルが1つでも発見できる環境で、未発見スキルの
      // 起動だけがあるセッションが「スキル未使用」と食い違って表示される
      result = scanKiroActivationNames(session.eventsPath);
    } else if (session.workspaceHint && existsSync(session.workspaceHint)) {
      result = scanInvokedSkillNames(session.eventsPath, discoverSkills(session.workspaceHint));
    }
    scanCache.set(key, result);
    return result;
  };

  const provider = new TraceTreeProvider(buildTraceFor, invokedLabel, LANG);
  // 折りたたみは自前のトグルボタンで担うため、組み込みの「すべて折りたたむ」は出さない
  const treeView = vscode.window.createTreeView("skilltrace-tree", { treeDataProvider: provider, showCollapseAll: false });
  context.subscriptions.push(treeView);

  treeView.onDidExpandElement(e => {
    provider.setExpanded(elementKey(e.element), true);
    provider.clearCollapsed(e.element.session.id);
  }, null, context.subscriptions);
  treeView.onDidCollapseElement(e => {
    provider.setExpanded(elementKey(e.element), false);
  }, null, context.subscriptions);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusBar.command = "skilltrace.toggleAutoFollow";
  context.subscriptions.push(statusBar);

  let autoFollow = vscode.workspace.getConfiguration("skilltrace").get<boolean>("autoFollowLatest") ?? true;
  let sessions: SessionInfo[] = [];
  let displayedId: string | null = null;
  let prevNewestId: string | null = null;
  let lastSignature = "";
  let debounce: NodeJS.Timeout | null = null;
  let baseWatcher: FSWatcher | null = null;
  let kiroWatcher: FSWatcher | null = null;
  let sessionWatcher: FSWatcher | null = null;
  let watchedSessionDir: string | null = null;

  const effectivelyFollowing = (): boolean => autoFollow && sessions.length > 0 && displayedId === sessions[0].id;

  const refreshStatus = (): void => {
    if (!sessions.length) {
      statusBar.text = "$(pulse) SkillTrace";
      statusBar.tooltip = L("セッションがまだありません。", "No sessions yet.");
    } else if (effectivelyFollowing()) {
      statusBar.text = L("$(pulse) SkillTrace 追尾中", "$(pulse) SkillTrace Following");
      statusBar.tooltip = L("最新のセッションを表示し、新しいセッションへ自動で移ります。クリックで自動追尾をオフにします。", "Showing the latest session; new sessions take over automatically. Click to turn auto-follow off.");
    } else if (autoFollow) {
      statusBar.text = L("$(eye) SkillTrace 過去を表示中", "$(eye) SkillTrace Viewing history");
      statusBar.tooltip = L("過去のセッションを表示中です（自動追尾はオン。最新のセッションを選ぶと追尾に戻ります）。クリックで自動追尾をオフにします。", "Viewing a past session (auto-follow is on; select the latest session to resume following). Click to turn auto-follow off.");
    } else {
      statusBar.text = L("$(pause) SkillTrace 追尾オフ", "$(pause) SkillTrace Follow off");
      statusBar.tooltip = L("自動追尾はオフです。クリックでオンにし、最新のセッションへ移ります。", "Auto-follow is off. Click to turn it on and jump to the latest session.");
    }
    statusBar.show();
  };

  const updateBadge = (): void => {
    if (!sessions.length || displayedId === null) { treeView.badge = undefined; return; }
    const idx = sessions.findIndex(s => s.id === displayedId);
    if (idx > 0) {
      treeView.badge = { value: idx, tooltip: L(`表示中より新しいセッションが ${idx} 件あります`, `${idx} session(s) newer than the displayed one`) };
    } else {
      treeView.badge = undefined;
    }
  };

  const ensureSessionWatcher = (session: SessionInfo | undefined): void => {
    if (!session) return;
    if (watchedSessionDir === session.dir && sessionWatcher) return;
    sessionWatcher?.close();
    sessionWatcher = null;
    watchedSessionDir = session.dir;
    try {
      sessionWatcher = watch(session.dir, (_event, filename) => {
        if (!filename || filename === "events.jsonl" || filename === "messages.jsonl") scheduleRefresh();
      });
      sessionWatcher.on("error", () => { /* ポーリングで代替 */ });
    } catch { /* ポーリングで代替 */ }
  };

  const refreshSessions = (): void => {
    // Copilot と Kiro のセッションを同じ履歴に混ぜ、新しい順に並べる
    const kiroList: SessionInfo[] = listKiroSessions(defaultKiroHome()).map(k => ({
      id: k.id, dir: k.dir, eventsPath: k.eventsPath, mtimeMs: k.mtimeMs,
      workspaceHint: k.workspacePaths[0] ?? k.rootPaths[0] ?? null,
      source: "kiro", title: k.title,
      workspacePaths: k.workspacePaths.length ? k.workspacePaths : k.rootPaths,
    }));
    const list = [...listSessions(sessionStateDir()), ...kiroList].sort((a, b) => b.mtimeMs - a.mtimeMs);
    const newest = list[0];
    // 表示の決定（follow-tail）
    let newDisplayed = displayedId;
    if (!newest) newDisplayed = null;
    else if (displayedId === null) newDisplayed = newest.id;
    else if (autoFollow && displayedId === prevNewestId && newest.id !== prevNewestId) newDisplayed = newest.id;
    else if (!list.some(s => s.id === displayedId)) newDisplayed = newest.id;

    const signature = list.map(s => `${s.id}:${s.mtimeMs}`).join("|") + `#${newDisplayed ?? ""}#${autoFollow}`;
    const displayedChanged = newDisplayed !== displayedId;
    sessions = list;
    displayedId = newDisplayed;
    prevNewestId = newest?.id ?? null;
    if (signature === lastSignature && !displayedChanged) { refreshStatus(); return; }
    lastSignature = signature;

    if (!list.length) {
      treeView.message = L("セッションがまだありません。Copilot / Kiro でスキルを使うセッションを実行すると、ここに履歴として自動で並びます。", "No sessions yet. Run a session that uses skills in Copilot / Kiro and it will appear here automatically.");
    } else {
      treeView.message = undefined;
    }
    if (displayedChanged) provider.resetExpandedFor(displayedId ?? "");
    const displayed = list.find(s => s.id === displayedId);
    if (displayed) {
      // 表示中セッションの記録が伸びていたら、再描画より先に古いトレースを捨てる
      const built = buildCache.get(displayed.id);
      if (built && built.mtimeMs !== displayed.mtimeMs) provider.invalidateTrace(displayed.id);
    }
    provider.setSessions(list, displayedId);
    updateBadge();
    refreshStatus();
    ensureSessionWatcher(displayed);
    if (displayed) void provider.getOrBuildTrace(displayed);
  };

  const scheduleRefresh = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(refreshSessions, 300);
  };

  const startWatching = (): void => {
    try {
      baseWatcher?.close();
      baseWatcher = watch(sessionStateDir(), () => scheduleRefresh());
      baseWatcher.on("error", () => { /* ポーリングで代替 */ });
    } catch { /* ポーリングで代替 */ }
    try {
      kiroWatcher?.close();
      kiroWatcher = watch(join(defaultKiroHome(), "sessions"), () => scheduleRefresh());
      kiroWatcher.on("error", () => { /* ポーリングで代替 */ });
    } catch { /* Kiro 未使用環境では監視なし（ポーリングで代替） */ }
  };

  // 自動追尾のオン/オフは「1つのスイッチ」: ビューのボタン・ステータスバー・設定の
  // どれを操作しても同じ状態が全箇所に反映される。設定への書き込みが一時的に
  // 失敗しても切り替え自体は成立させる（0.3.2 の堅牢化を継続）。
  const setAutoFollow = async (value: boolean, opts: { persist?: boolean } = {}): Promise<void> => {
    autoFollow = value;
    await vscode.commands.executeCommand("setContext", "skilltrace.autoFollow", value);
    if (opts.persist !== false) {
      try {
        await vscode.workspace.getConfiguration("skilltrace").update("autoFollowLatest", value, vscode.ConfigurationTarget.Global);
      } catch { /* スキーマ登録ラグ時はメモリ上の状態を正とする */ }
    }
    if (value && sessions.length) {
      // 追尾に戻るときは最新のセッションへ表示を移す
      displayedId = sessions[0].id;
      provider.resetExpandedFor(displayedId);
    }
    lastSignature = "";
    refreshSessions();
  };

  const asElement = (arg: unknown): El | undefined => {
    if (!arg || typeof arg !== "object") return undefined;
    if ("el" in arg) return (arg as { el: El }).el;
    if ("kind" in arg) return arg as El;
    return undefined;
  };

  // ツールバーのボタンは「表示中のセッション」に、履歴項目のホバーボタンは
  // 「その項目のセッション」に適用する。どちらも対象セッションを1回の操作で
  // 特定できるよう、コマンド引数（ツリー要素）から対象を解決する。
  const sessionFromArg = (arg: unknown): SessionInfo | undefined => {
    const el = asElement(arg);
    if (el) return el.session;
    return sessions.find(s => s.id === displayedId);
  };
  const traceFromArg = async (arg: unknown): Promise<{ session: SessionInfo; trace: SessionTrace } | null> => {
    const session = sessionFromArg(arg);
    if (!session) return null;
    const trace = await provider.getOrBuildTrace(session);
    return trace ? { session, trace } : null;
  };

  const expandSession = async (session: SessionInfo): Promise<void> => {
    const trace = await provider.getOrBuildTrace(session);
    // トレースが無いセッション（スキル起動なし）でも、セッション自体は
    // 開ける（子は注記項目）。ここで何もしないと、表示中で開いて描かれて
    // いるセッションを項目側トグルで閉じることが永久にできなくなる
    provider.clearCollapsed(session.id);
    // まずセッション自体とスキルを開く。子ノードの reveal だけに頼ると、
    // 参照のない SKILL.md（開く対象のノードがない）のときにセッションが
    // 開かないまま「展開済み」と記録され、次のトグルが空振りする
    const sessionEl: El = { kind: "session", session };
    try {
      await treeView.reveal(sessionEl, { expand: true, select: false, focus: false });
      provider.setExpanded(elementKey(sessionEl), true);
    } catch { /* ビューに見えていないときは記録もしない（次の操作で再試行できる） */ }
    if (!trace) return;
    for (const part of trace.skills) {
      const skillEl: El = { kind: "skill", session, part };
      try {
        await treeView.reveal(skillEl, { expand: true, select: false, focus: false });
        provider.setExpanded(elementKey(skillEl), true);
      } catch { /* 見えていないスキルは展開できなくても続行 */ }
      for (const gnode of part.graph.order) {
        if (!gnode.children.length || gnode.cycle) continue;
        const el: NodeEl = { kind: "node", session, part, gnode };
        try {
          await treeView.reveal(el, { expand: true, select: false, focus: false });
          provider.setExpanded(elementKey(el), true);
        } catch { /* 見えていないノードは展開できなくても続行 */ }
      }
    }
  };

  let summaryPanel: vscode.WebviewPanel | null = null;
  const showHtmlPanel = (title: string, html: string): void => {
    try {
      if (summaryPanel) {
        summaryPanel.title = title;
        summaryPanel.webview.html = html;
        summaryPanel.reveal(vscode.ViewColumn.Beside);
        return;
      }
      summaryPanel = vscode.window.createWebviewPanel(
        "skilltraceSummary", title, vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      summaryPanel.onDidDispose(() => { summaryPanel = null; });
      summaryPanel.webview.html = html;
    } catch (err) {
      void vscode.window.showErrorMessage(`SkillTrace: ${L("サマリを表示できませんでした", "Could not display the summary")} — ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("skilltrace.displaySession", (sessionId: string) => {
      if (!sessions.some(s => s.id === sessionId)) return;
      // クリックして表示対象にしたセッションは、畳んだままにせず開く。
      // フラグ解除だけでは、同じ項目 ID の開閉状態を保持する VS Code 側に
      // 閉じたままにされることがあるため、項目を作り直して開いた状態を反映させる
      provider.clearCollapsed(sessionId);
      provider.recreateSessionItems(sessionId);
      displayedId = sessionId;
      provider.resetExpandedFor(sessionId);
      lastSignature = "";
      refreshSessions();
    }),
    vscode.commands.registerCommand("skilltrace.toggleAutoFollow", async () => { await setAutoFollow(!autoFollow); }),
    vscode.commands.registerCommand("skilltrace.enableAutoFollow", async () => { await setAutoFollow(true); }),
    vscode.commands.registerCommand("skilltrace.pauseAutoFollow", async () => { await setAutoFollow(false); }),
    // タイトルバーの「すべて展開」「すべて折りたたむ」: 履歴の全セッションを
    // 対象にする。かつては1つのトグルボタンだったが、閉じたいつもりで押して
    // 高コストな「すべて展開」が走る事故があったため、2ボタンに分離した
    // （2026-11-08 の要望）。押した結果は常にボタンどおりの動作になる
    vscode.commands.registerCommand("skilltrace.expandAllSessions", () => {
      provider.setAllSessionsExpanded(true);
    }),
    vscode.commands.registerCommand("skilltrace.collapseAllSessions", () => {
      provider.setAllSessionsExpanded(false);
      // 「すべて折りたたむ」は表示中セッションも含めて明示的に畳む。
      // 通常状態（表示中だけ展開）に戻すだけでは、1つだけ開いたまま
      // 残って見える（2026-11-07 の不具合報告）
      provider.collapseAllSessions();
    }),
    vscode.commands.registerCommand("skilltrace.toggleExpandCollapse", async (arg?: unknown) => {
      const session = sessionFromArg(arg);
      if (!session) return;
      // 項目単位の操作をしたら、全セッション展開モードは解除して通常の状態に戻す
      if (provider.isAllSessionsExpanded()) provider.setAllSessionsExpanded(false);
      await provider.getOrBuildTrace(session);
      // 判定はセッション自体が開いているかだけを見る（配下の全要素の状態に
      // 引きずられると、畳む側に倒れなくなる）
      if (provider.isSessionExpanded(session.id)) provider.collapseSession(session.id);
      else await expandSession(session);
    }),
    vscode.workspace.onDidChangeConfiguration(async e => {
      if (e.affectsConfiguration("skilltrace.autoFollowLatest")) {
        const v = vscode.workspace.getConfiguration("skilltrace").get<boolean>("autoFollowLatest") ?? true;
        if (v !== autoFollow) await setAutoFollow(v, { persist: false });
      }
    }),
    vscode.commands.registerCommand("skilltrace.refresh", () => {
      if (displayedId) { buildCache.delete(displayedId); provider.invalidateTrace(displayedId); }
      lastSignature = "";
      refreshSessions();
    }),
    vscode.commands.registerCommand("skilltrace.showSummary", async (arg?: unknown) => {
      const resolved = await traceFromArg(arg);
      if (!resolved) { void vscode.window.showWarningMessage(L("SkillTrace: 対象セッションでスキル起動を検出できませんでした。", "SkillTrace: No skill activation was detected in the target session.")); return; }
      showHtmlPanel(L("セッションサマリ", "Session summary"), renderSessionHtml(resolved.trace, docOptions()));
    }),
    vscode.commands.registerCommand("skilltrace.openSkillSummary", async (arg: unknown) => {
      const el = asElement(arg);
      if (!el || el.kind !== "skill") return;
      const skillEl = el as SkillEl;
      const trace = provider.getTrace(skillEl.session.id) ?? (await provider.getOrBuildTrace(skillEl.session));
      if (!trace) return;
      const part = trace.skills.find(p => p.skillName === skillEl.part.skillName) ?? skillEl.part;
      showHtmlPanel(`${L("スキルサマリ", "Skill summary")} — ${part.skillName}`, renderSkillHtml(trace, part, docOptions()));
    }),
    vscode.commands.registerCommand("skilltrace.openSummaryInBrowser", async (arg?: unknown) => {
      try {
        const resolved = await traceFromArg(arg);
        if (!resolved) { void vscode.window.showWarningMessage(L("SkillTrace: 対象セッションでスキル起動を検出できませんでした。", "SkillTrace: No skill activation was detected in the target session.")); return; }
        const file = join(tmpdir(), `skilltrace-session-${resolved.trace.session.id}.html`);
        writeFileSync(file, renderSessionHtml(resolved.trace, docOptions()), "utf8");
        await vscode.env.openExternal(vscode.Uri.file(file));
      } catch (err) {
        void vscode.window.showErrorMessage(`SkillTrace: ${L("ブラウザでサマリを開けませんでした", "Could not open the summary in the browser")} — ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
    vscode.commands.registerCommand("skilltrace.copyTreeAll", async (arg?: unknown) => {
      const resolved = await traceFromArg(arg);
      if (!resolved) { void vscode.window.showWarningMessage(L("SkillTrace: 対象セッションがありません。", "SkillTrace: No target session.")); return; }
      await vscode.env.clipboard.writeText(renderSessionCopy(resolved.trace, { kind: "all" }, LANG));
      void vscode.window.showInformationMessage(L("SkillTrace: セッション全体のツリーをコピーしました。", "SkillTrace: Copied the whole session tree."));
    }),
    vscode.commands.registerCommand("skilltrace.copyTreeVisible", async (arg?: unknown) => {
      const resolved = await traceFromArg(arg);
      if (!resolved) { void vscode.window.showWarningMessage(L("SkillTrace: 対象セッションがありません。", "SkillTrace: No target session.")); return; }
      const sid = resolved.session.id;
      await vscode.env.clipboard.writeText(renderSessionCopy(resolved.trace, {
        kind: "visible",
        isExpanded: (skillName, absId) => provider.isNodeExpanded(sid, skillName, absId),
      }, LANG));
      void vscode.window.showInformationMessage(L("SkillTrace: 表示中のツリーをコピーしました。", "SkillTrace: Copied the visible tree."));
    }),
    vscode.commands.registerCommand("skilltrace.copyNodeSubtree", async (arg: unknown) => {
      const el = asElement(arg);
      if (!el || el.kind !== "node") return;
      const nodeEl = el as NodeEl;
      const trace = provider.getTrace(nodeEl.session.id) ?? (await provider.getOrBuildTrace(nodeEl.session));
      if (!trace) return;
      const part = trace.skills.find(p => p.skillName === nodeEl.part.skillName) ?? nodeEl.part;
      await vscode.env.clipboard.writeText(renderSessionCopy(trace, { kind: "subtree", part, rootId: nodeEl.gnode.id }, LANG));
      void vscode.window.showInformationMessage(L(`SkillTrace: ${nodeEl.gnode.relToSkill} 以下をコピーしました。`, `SkillTrace: Copied ${nodeEl.gnode.relToSkill} and below.`));
    }),
    vscode.commands.registerCommand("skilltrace.copySessionSummaryMarkdown", async (arg?: unknown) => {
      const resolved = await traceFromArg(arg);
      if (!resolved) { void vscode.window.showWarningMessage(L("SkillTrace: 対象セッションがありません。", "SkillTrace: No target session.")); return; }
      await vscode.env.clipboard.writeText(renderSessionMarkdown(resolved.trace, docOptions()));
      void vscode.window.showInformationMessage(L("SkillTrace: セッションサマリを Markdown でコピーしました。", "SkillTrace: Copied the session summary as Markdown."));
    }),
    vscode.commands.registerCommand("skilltrace.copySkillSummaryMarkdown", async (arg: unknown) => {
      const el = asElement(arg);
      if (!el || el.kind !== "skill") return;
      const skillEl = el as SkillEl;
      const trace = provider.getTrace(skillEl.session.id) ?? (await provider.getOrBuildTrace(skillEl.session));
      if (!trace) return;
      const part = trace.skills.find(p => p.skillName === skillEl.part.skillName) ?? skillEl.part;
      await vscode.env.clipboard.writeText(renderSkillMarkdown(trace, part, docOptions()));
      void vscode.window.showInformationMessage(L(`SkillTrace: スキルサマリ（${part.skillName}）を Markdown でコピーしました。`, `SkillTrace: Copied the skill summary (${part.skillName}) as Markdown.`));
    }),
    vscode.commands.registerCommand("skilltrace.openNodeFile", async (absPath: string) => {
      try { await vscode.window.showTextDocument(vscode.Uri.file(absPath), { preview: true }); }
      catch { void vscode.window.showWarningMessage(L(`SkillTrace: ファイルを開けませんでした: ${absPath}`, `SkillTrace: Could not open the file: ${absPath}`)); }
    }),
    vscode.commands.registerCommand("skilltrace.openLearning", async () => {
      const docPath = join(context.extensionPath, "docs", "learning", "README.md");
      if (!existsSync(docPath)) { void vscode.window.showWarningMessage(L("SkillTrace: 学習ドキュメントが見つかりません。", "SkillTrace: Learning documents not found.")); return; }
      await vscode.window.showTextDocument(vscode.Uri.file(docPath), { preview: false });
    }),
  );

  // 起動時: 履歴を並べ、自動追尾（follow-tail）を始める
  refreshStatus();
  void vscode.commands.executeCommand("setContext", "skilltrace.autoFollow", autoFollow);
  startWatching();
  refreshSessions();
  const poll = setInterval(refreshSessions, 3000);
  context.subscriptions.push({ dispose: () => clearInterval(poll) });
  context.subscriptions.push({ dispose: () => { baseWatcher?.close(); kiroWatcher?.close(); sessionWatcher?.close(); if (debounce) clearTimeout(debounce); } });
}

export function deactivate(): void { /* 購読は context.subscriptions で破棄される */ }
