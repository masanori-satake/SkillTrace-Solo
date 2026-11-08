# Changelog

## [1.2.2] - 2026-11-08

### 修正 (Fixed)
- **Kiro のセッションで、起動したスキルが現在のワークスペースで見つからない
  場合に、ツリーが無言で空になり、起動スキルが「未判定」になっていた問題を
  修正。** 起動の判定が「発見できたスキル」との照合だけだったため、移動・
  改名・削除されたスキルの起動が記録から消えていた。記録にある起動名は
  そのまま残し、ツリーとサマリ（文書コピー含む）に「現在のワークスペースでは
  見つかりませんでした」と注記するようにした。表示できる項目が無いセッション
  でも、空の展開ではなく理由を注記する。セッションのツールチップでも、候補が
  無い場合に「未判定」とせず記録の起動名を示す。
- **Fixed Kiro sessions whose activated skills are no longer in the workspace
  rendering as a silently empty tree with skills shown as "undetermined".**
  Activation was judged only against skills discoverable in the current
  workspace, so activations of moved, renamed or deleted skills vanished
  from the record. Activated names are now kept from the record itself and
  noted in the tree and summaries (including document copies) as not found
  in the current workspace; a session with nothing to show explains why
  instead of expanding to nothing.

## [1.2.1] - 2026-11-08

### 追加 (Added)
- **学習ドキュメントの索引に「実例の出どころ」を追加。** 全編の実例である
  phase0-probe / kiro-probe は著者の検証用ダミースキルであり、この
  リポジトリに含まれないことを一か所に明記し、各文書（01〜04）の冒頭から
  参照するようにした（PR #10 のマージに間に合わなかった追補）。
- **Added a "Where the examples come from" section to the learning-doc
  index.** The running examples, phase0-probe / kiro-probe, are the author's
  own verification dummy skills and are not part of this repository; each
  document (01–04) now points to that single explanation. (Follow-up that
  missed the PR #10 merge.)

## [1.2.0] - 2026-11-08

### 追加 (Added)
- **サマリに「消費の構造」を表示する（Issue #9）。** Copilot の入力トークンの
  内訳を、新規入力 / キャッシュ読取 / キャッシュ書込の3分解で表示する
  （従来は2分解で、キャッシュ書込が新規入力の中に埋もれていた）。
  あわせて、キャッシュ書込が発生したターンを観測として示す（初回ターン
  以外で最大の書込も併記）。Kiro では、常時文脈の節（サマリ）とツリーの
  常時文脈グループに、最初に記録されたコンテキストウィンドウ使用率
  （常時文脈の重さの目安）を併記する。表示するのは実測とその構成比のみで、
  単価・換算値は扱わない。
- **学習ドキュメント 04「サマリの読み方 — 『どこに払っているか』を読む」を
  追加。** 3分解と書込の発生ターンの読み方、Kiro の最初の記録の使用率が示す
  常時文脈の重さなど、サマリの実測の読み解きを担う。
- **Show the "structure of consumption" in summaries (Issue #9).** Copilot's
  input breakdown is now three-way (new input / cache read / cache write;
  cache writes used to be lumped into "new input"), and the turns in which
  cache writes occurred are shown as an observation. For Kiro, the
  always-loaded context section (and the tree group) now also shows the
  first recorded context-window usage, as a guide to how
  heavy the always-loaded context is. Only measured values and their
  proportions are shown — no rates or converted values. Learning
  document 04, "Reading the summary", covers how to interpret them.

## [1.1.0] - 2026-11-08

### 追加 (Added)
- **Amazon Kiro に対応。** Kiro の v3 セッションストア（`~/.kiro/sessions/`）の
  記録を読み取り、Copilot のセッションと同じ履歴ツリーに混ぜて表示する
  （Kiro のセッションには「Kiro」と表示）。スキル起動は `disclose_context`、
  参照の辿りは `read_files` の成功、常時文脈は `steering_inclusion` の
  documents から判定し、到達の確度の物差しは Copilot と共通。実測は
  クレジット（`usage_summary`）とコンテキストウィンドウ使用率（%）で表示する
  （Kiro の記録にはトークン数がないため）。ワークスペースは記録の
  `workspacePaths` / `rootPaths` を使うため、マルチルートにもそのまま対応する。
  実機のプローブセッションで検証済み（起動・2段の辿り・0.82 credits）。
- **スキルが起動しなかったセッションでも、常時文脈と実測を表示。**
  仕様駆動（Specs）などスキル起動のないセッションでも、常時文脈
  （steering / AGENTS.md）、クレジット、読み取りのいずれかが記録にあれば
  開けるようにし、ツリーに「常時文脈」のグループ、サマリにも同名の節を
  追加した。スキル起動が検出されなかったことはサマリに明記する。
- **Added Amazon Kiro support.** SkillTrace now reads Kiro's v3 session
  store (`~/.kiro/sessions/`) and shows Kiro sessions in the same history
  tree as Copilot sessions (labelled "Kiro"). Activation is detected from
  `disclose_context`, reference traversal from successful `read_files`,
  and always-loaded context from `steering_inclusion` documents, using the
  same certainty scale as Copilot. Usage is shown in credits
  (`usage_summary`) and context-window usage as a percentage, because
  Kiro's records carry no token counts. Workspace roots come from the
  record's `workspacePaths` / `rootPaths`, so multi-root workspaces work
  as recorded. Sessions with no skill activation (e.g. spec-driven work)
  now also open when always-loaded context, credits, or reads are
  recorded, with an always-loaded context group in the tree and section
  in the summary.

## [1.0.2] - 2026-11-08

### 追加 (Added)
- **学習ドキュメント 03「Copilot と Kiro のセッション記録を読み比べる」を追加。**
  両プラットフォームのセッション記録（保存場所、形式、スキル起動と参照の辿りの
  記録、常時文脈、実測の単位、コンテキストウィンドウ使用量）を、実機で確認した
  実例セッションの数値とともに対比し、SkillTrace での到達の確度の対応付けと、
  記録を読む際の落とし穴（対応付けキーの違い、単位の非対称性など）をまとめた。
  あわせて学習ドキュメントの索引に Kiro 側の基礎データを追記した。
- **Added learning document 03, "Comparing Copilot and Kiro session records"**,
  contrasting how the two platforms record sessions (storage, format, skill
  activation and reference traversal, always-loaded context, measured units,
  context-window usage), with SkillTrace's certainty mapping and the pitfalls
  found while reading the records on a real machine.

## [1.0.1] - 2026-11-07

### Fixed

- **Per-session expand/collapse toggle now collapses reliably.** The
  toggle used to decide by whether *every* element under the session was
  expanded, so a single manually collapsed node (or one expand that the
  view dropped) made it choose "expand" forever. It now toggles on the
  session's own open/closed state.
- **"Collapse all sessions" now includes the displayed session.**
  Turning the all-sessions toggle off used to return to the normal
  state, in which the displayed session stays open — leaving exactly
  one session visibly expanded. An explicit collapse now wins over the
  displayed session's default-open behaviour; sessions that arrive
  later still open as usual.

### 修正 (Fixed)

- **セッション毎の展開/折りたたみトグルで、確実に折りたためるようにした**:
  以前は「セッション配下の全要素が展開されているか」で開閉を判定していた
  ため、手で1つでも畳んでいたり、展開の取りこぼしが1つでもあると常に
  「未展開」と判定され、展開側に倒れ続けて畳むことができなかった。
  判定を「セッション自体が開いているか」だけに変更した。
- **「すべてのセッションを折りたたむ」で表示中セッションも畳むようにした**:
  全セッショントグルをオフにすると通常状態に戻るだけだったため、既定で
  開く表示中セッションが1件だけ開いたまま残っていた。明示的な折りたたみ
  操作が既定の表示より優先されるようにし、表示中も含めてすべて畳む。
  後から到着した新しいセッションは従来どおり開く。

## [1.0.0] - 2026-11-07

First release.

- **Session history tree**: Copilot sessions appear automatically as a
  history in the Explorer (newest first) — session → invoked skills
  (multiple per session, in invocation order) → the skill's reference
  tree. No manual import and no target switching. Auto-follow is
  follow-tail: the view tracks the newest session only while you are
  looking at it; inspecting a past session is never interrupted.
- **Arrival certainty per file**: 確度高 (the record confirms the
  content was loaded into the model's context), 確度中 (a read tool
  call succeeded), 確度低 (mentioned only), and 記録なし for files
  with no record — which never claims the file was not read. Arrival
  order numbers run across the whole session and can be replayed in
  the summaries, lighting each file in order.
- **Measured tokens and context window usage**: per-turn and total
  usage from the session record (input / output / cache read / cache
  write / reasoning), an input breakdown showing cache reuse vs new
  input, and a context window usage graph with axes, percentage
  gridlines and the limit line.
- **Two-layer summaries**: a session summary (per-skill digest,
  measured tokens, context usage, cross-skill arrival trees) and
  per-skill summaries (node details with certainty, arrival order,
  first-seen time and evidence). Both open with a pointer to a
  glossary section at the end of the same page; wording follows the
  Agent Skills community's standard terminology (activation,
  progressive disclosure, loaded into context, context window usage).
- **Sharing**: copy the arrival tree as text (whole / visible /
  subtree), and copy either summary as a self-contained document in
  Markdown or HTML for pasting into Microsoft Loop, PowerPoint,
  GitHub or Notion. The setting `skilltrace.documentIncludeNotes`
  (default off) controls whether the reading notes and the glossary
  are included in document copies.
- **Learning docs** bundled under `docs/learning/`: "read" vs
  "loaded into context", and token kinds and credits, explained with
  real session numbers.
- Skills are discovered in `.github/skills`, `.kiro/skills` and
  `.agents/skills`; files referenced from outside the skill directory
  (e.g. `.kiro/steering/`) are shown as スキル外， with failed reads
  marked as such.
- 100% local, no tracking, read-only. Currently Copilot only (no
  equivalent load trace exists for Kiro). Static analysis of skills
  is covered by SkillMap-Solo; SkillTrace is its dynamic counterpart.
