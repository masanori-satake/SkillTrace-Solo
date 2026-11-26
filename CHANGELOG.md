# Changelog

## [1.17.0] - 2026-11-26

### Added

- Skills activated outside the session's workspace — for example in a dedicated skills repository — can now be located from the paths left in the record (Issue #60). When an activated skill is not found by the usual discovery, the paths appearing in the record (read paths, invocation strings, inclusion documents) are searched for a `<skill root>/skills/<name>` location; if that folder exists and contains SKILL.md, the skill is treated as found, so its reference tree, arrivals and token totals are shown as usual. The session summary and the history tree note that the skill was located from the record and show where it lives. Only paths that actually appear in the record are used; no additional directories are scanned, and skills that still cannot be located keep the existing "not found" note.

### 追加 (Added)

- セッションのワークスペース外で起動したスキル（スキル専用リポジトリにあるスキルなど）を、記録に残るパスから特定できるようにした（Issue #60）。通常の探索で見つからない起動スキルについて、記録内のパス（読み取りパス、起動イベントの文字列、取り込み文書のパス）から「<スキルルート>/skills/<名前>」の所在を探し、そのフォルダが実在して SKILL.md を含む場合に、そのスキルとして扱う。参照ツリー・到達の内訳・推定トークン合計が通常どおり表示される。セッションサマリと履歴ツリーには、記録から特定したことと所在を注記する。使うのは記録に実際に現れたパスだけで、追加のディレクトリ走査はしない。特定できなかったスキルは従来どおり「見つかりませんでした」の注記のままになる。

## [1.16.2] - 2026-11-22

### Fixed

- Development-configuration alignment: `.markdownlint.json` is now excluded from the version-bump check in `scripts/check-version.js` (the same treatment as `.pre-commit-config.yaml`), and missing final newlines in `package.nls.json`, `package.nls.ja.json` and two test-fixture JSON files were fixed via the pre-commit hooks.

### 修正 (Fixed)

- 開発用設定の整備。`scripts/check-version.js` の版バンプ判定で `.markdownlint.json` を対象外にした（`.pre-commit-config.yaml` と同じ扱い）。あわせて、`package.nls.json`、`package.nls.ja.json` とテスト用フィクスチャの JSON 2件に不足していた末尾の改行を、pre-commit フックで直した。

## [1.16.1] - 2026-11-22

### Fixed

- Hardening from the 2026-11-22 security audit (no high-severity findings; two medium and five low items, all closed). (1) The remaining unbounded full-file reads now go through the shared limited reader: the Kiro session metadata and the VS Code workspace hint are read with the record size limit, the Copilot workspace.yaml hint reads only the file prefix, and the trace builder no longer re-reads SKILL.md — it reuses the title the graph builder already obtained under the graph file limit. (2) Reference-graph traversal now has total caps (500 nodes, 64 MB read in total); when a cap is reached the walk stops and the reason is recorded in the graph result, and references that resolve outside the allowed roots (the skill directory and the workspace) no longer have their headings fetched — only the path is shown. (3) The summary Webview panel now declares `localResourceRoots: []` explicitly, matching the fact that its HTML references no local resources. (4) Untrusted strings embedded into tree tooltips (session titles, graph node titles, skill names, workspace paths) are now escaped so Markdown link or image syntax in a record or file heading cannot become a clickable link or a remote image. (5) The `skilltrace.sessionStateDir` setting is now machine-scoped, so a workspace folder can no longer point session enumeration at an arbitrary directory, and session listing no longer propagates an exception if the directory cannot be enumerated. (6) The fallback session polling interval is relaxed from 3 seconds to 30 seconds; live updates remain covered by the file watchers. (7) The manifest now declares Workspace Trust support explicitly (`untrustedWorkspaces: supported: false`), matching the extension's actual behaviour of reading workspace files, following references outside the skill, and writing annotations to a possibly shared folder. Displays for ordinary records are unchanged.

### 修正 (Fixed)

- 2026-11-22 のセキュリティ監査対応の堅牢化（高重大度の指摘はなし。中2件・低5件をすべて解消）。(1) 上限なしの全文読みが残っていた箇所を、共通の上限付きリーダー経由に統一した。Kiro のセッションメタと VS Code のワークスペースヒントは記録ファイルのサイズ上限付きで読み、Copilot の workspace.yaml ヒントは先頭だけを読む。トレース構築では SKILL.md を再読せず、グラフ構築が上限付きで取得済みのタイトルを再利用する。(2) 参照グラフの走査に総量の上限（ノード数500・読み取り総量64 MB）を設けた。上限に達したら走査を打ち切り、理由をグラフの結果に注記として残す。あわせて、許可ルート（スキルディレクトリとワークスペース）の外へ解決される参照先は見出しを取得せず、パスの表示のみに留める。(3) サマリ Webview のパネルに `localResourceRoots: []` を明示した（HTML は外部リソースを参照しないという実態に合わせる）。(4) ツリーのツールチップへ埋め込む未信頼文字列（セッションタイトル、グラフノードのタイトル、スキル名、ワークスペースのパス）をエスケープし、記録や見出しに書かれた Markdown のリンク・画像記法がクリック可能なリンクやリモート画像にならないようにした。(5) 設定 `skilltrace.sessionStateDir` に machine スコープを付け、ワークスペース側からセッション列挙先を任意ディレクトリへ向けられないようにした。あわせて、セッション列挙でディレクトリを読めない場合に例外が伝播しないようにした。(6) セッションのポーリング間隔を3秒から30秒へ緩めた（ライブ更新はファイル監視が担う）。(7) Workspace Trust の宣言を manifest に明示した（`untrustedWorkspaces: supported: false`。ワークスペース内ファイルの読み取り、スキル外への参照追随、共有されうるフォルダへの注釈書き込みを行う実態に合わせる）。通常の記録での表示は従来どおり。

## [1.16.0] - 2026-11-21

### Added

- Session annotations, phase 3: aggregation (Issue #49). The Skill totals view now joins the sessions' measured usage with the verdicts and notes recorded in phase 2. The totals table gains two columns — verdict counts (good / ok / bad) per skill and the good ratio (share of "good" among rated sessions, shown as "—" when a skill has no ratings) — and, when any session was rated "bad", a section below the table ranks those skills (most bad ratings first, then by the measured consumption of their bad sessions) and lists each bad session with its date, its measured consumption with the unit labelled, and the memos attached to it. Only the latest session-level verdict counts; turn-level verdicts are not counted as session verdicts (turn-level notes do appear among the memos, marked with their turn number). Retracted annotations and superseded revisions are excluded, exactly as the specification's aggregation rules require. Everything stays measured-only and read-only: verdicts and consumption are attributed to each skill activated in the session without apportioning (the same session verdict and total count toward every skill it activated), values in different units (Kiro credits, Copilot Chat credits, Copilot tokens) are never added together, nothing is converted to money or tokens, and neither the session records nor the annotation files are ever written. When no session was rated "bad", the view says so; when no annotations exist yet, it notes that instead. The view presents facts only and offers no improvement suggestions.

### 追加 (Added)

- セッション注釈のフェーズ3（集計。Issue #49）。スキル別集計で、セッションの実測の消費と、フェーズ2で記録した評価・メモを突き合わせて表示するようにした。集計表に2つの列が増える。スキルごとの評価件数（良かった／普通／悪かった）と、上手くいった率（評価のあったセッションに対する「良かった」の割合。評価が無いスキルでは「—」）である。さらに、「悪かった」と評価されたセッションがある場合は、表の下に節を設け、対象スキルを順位付きで（「悪かった」の件数が多い順、次いでそのセッション群の実測消費が多い順）並べ、スキルごとに該当セッションを、日付・単位を明記した実測消費・付いたメモとともに一覧する。数えるのはセッション全体への最新の評価だけで、ターン対象の評価はセッション評価として数えない（ターン対象のメモは、ターン番号を付けてメモの中に表示する）。取り消された注釈と改訂前の行は、仕様の集計規則どおり除外する。実測のみ・読み取り専用という原則は従来どおりで、評価と消費は、そのセッションで起動した各スキルへ按分せずに数え（同じ評価と同じセッション合計が各スキルに入る）、単位の異なる値（Kiro のクレジット、Copilot Chat のクレジット、Copilot のトークン）は合算せず、金額やトークンへの換算もしない。セッション記録にも注釈ファイルにも書き込まない。「悪かった」評価が無い場合はその旨を、注釈自体がまだ無い場合はその旨を表示する。表示は事実の提示だけとし、改善案の提案は含めない。

## [1.15.2] - 2026-11-20

### Fixed

- Follow-up hardening for the record-file size limits added in 1.15.1 (CodeRabbit review of the audit fixes). The checks are now bound to the opened file handle instead of the path, and the amount actually read is itself capped, so replacing a file after the check — with a larger regular file or with a FIFO — can no longer bypass the limit or stall the extension host: the shared reader and the graph builder open the file with O_NONBLOCK where supported, verify the opened descriptor, and read at most the limit; the Kiro parser does the same through a single file handle; the Copilot events parser now counts raw bytes before decoding and line splitting (the previous count used decoded character length, which undercounts multibyte text, and a single newline-less line could accumulate inside the line reader past the limit). Three gaps in coverage were closed: VS Code chat session enumeration now skips files over the record limit before the lightweight scan reads them in full; appending an annotation that would push SkillTrace's own annotation file over the read limit is now refused with an error instead of making all existing annotations in that file invisible to the reader; and a VS Code delta-log line whose key path is rejected (for example an index over the cap at the end of the path) no longer mutates the state on its way — the whole path is validated before anything is written, so an existing user message survives such a line. Behaviour for ordinary records is unchanged.

### 修正 (Fixed)

- 1.15.1 で入れた記録ファイルのサイズ上限のフォローアップ堅牢化（監査修正への CodeRabbit レビュー対応）。確認をパスではなく開いたファイル記述子に対して行い、読み取る量自体にも上限を付けた。これにより、確認後にファイルを差し替えても（より大きな通常ファイルでも、FIFO でも）上限を迂回したり拡張ホストを止めたりできなくなった。共通の読み取り口とグラフ構築は、対応 OS では O_NONBLOCK を付けて開き、開いた記述子で種別・サイズを確認して上限までだけ読む。Kiro のパーサも単一のハンドルで同じことを行う。Copilot イベントのパーサは、デコードと行分割の前の生バイト数で数えるようにした（従来はデコード後の文字数で数えており、マルチバイト文字を含む記録で超過を見逃し、改行のない巨大な行が行分割の内部バッファに上限を超えて溜まるおそれがあった）。適用漏れも3件閉じた。VS Code チャットセッションの列挙で、上限を超えるファイルを軽量スキャンが全文読む前に除外するようにした。自分の注釈ファイルが読み取り上限を超える追記は、既存の注釈まで読み取り対象から外してしまう代わりに、書かずにエラーとして返すようにした。VS Code 差分ログで、キー経路が拒否される行（例: 経路末尾の上限超えの添字）が、途中で親の値を書き換えたままにならないようにした（経路全体を事前に検証し、既存のユーザーメッセージがその行で消えない）。通常の記録での挙動は従来どおり。

## [1.15.1] - 2026-11-20

### Fixed

- Hardening against crafted or oversized record files (security audit 2026-11-20; all four findings were cases where an imported record — someone else's session record or a shared annotation file — could stall the extension host or make it read unbounded amounts of data). (1) VS Code chatSessions delta logs: a numeric key path is now capped as an array index (100,000) and a single append is capped in elements, so a line such as `{"kind":1,"k":["requests",30000000]}` no longer inflates an array (measured before the fix at roughly 9.5 s and 488 MB of heap for one such line); lines over the cap are ignored. (2) Path extraction from Copilot event strings no longer uses the backtracking-prone regular expression whose cost grew quadratically with input length (about 4.8 s at 48 KB); it is now a linear scan that returns the same matches. (3) Every read of a session record or annotation file (Copilot / Kiro / VS Code scans, full parses, per-skill and per-file aggregation, annotation loading and lookup) now checks beforehand that the target is a regular file within a size limit (256 MB); oversized or non-regular files are treated as unreadable and skipped. (4) Titles of files outside the skill are no longer read in full: the three duplicated implementations were unified, and only the first 64 KB is read to find the first heading. Graph building likewise treats a referenced file over 16 MB (or not a regular file) as missing instead of reading it. Displays for ordinary records are unchanged.

### 修正 (Fixed)

- 細工された記録ファイルや巨大な記録ファイルへの堅牢化（2026-11-20 のセキュリティ監査対応。全4件とも、他人のセッション記録や共有注釈ファイルといった「取り込んだ記録」で拡張ホストが止まったり、無制限に読み込んだりする問題）。(1) VS Code chatSessions の差分ログで、キー経路の数値を配列インデックスとして使う際に上限（100,000）を設け、1回の追記で増える要素数にも上限を付けた。`{"kind":1,"k":["requests",30000000]}` のような1行で配列が膨らむことはなくなる（修正前は実測で約9.5秒・ヒープ約488 MB）。上限を超える行は無効として読み飛ばす。(2) Copilot イベントの文字列からパスを取り出す処理を、入力長に対して二乗の計算量になる正規表現（48 KB で約4.8秒）から、同じ一致結果を返す線形な走査に置き換えた。(3) セッション記録・注釈ファイルの読み込み全箇所（Copilot / Kiro / VS Code のスキャン、全文パース、スキル別・ファイル別集計、注釈の読み込みと検索）で、読む前に「通常ファイルであること」とサイズ上限（256 MB）を確認するようにした。上限超過や通常ファイルでないものは「読めなかった」ものとして対象外になる。(4) スキル外ファイルのタイトル取得で全文を読まなくなった。3か所に重複していた実装を共通化し、先頭見出しを探すために先頭 64 KB だけを読む。グラフ構築でも、参照先が 16 MB を超える（または通常ファイルでない）場合は読まずに missing として扱う。通常の記録での表示は従来どおり。

## [1.15.0] - 2026-11-18

### Added

- Session annotations, phase 2: write side (Issue #49). SkillTrace can now record verdicts and notes itself, from the history tree (session item context menu) or the Command Palette, without ever writing into the Copilot / Kiro / VS Code session records. "Add or Change Session Verdict" attaches a three-level verdict (good / ok / bad) plus an optional note to a whole session; "Add or Change a Verdict or Note on a Turn" does the same for a single turn (turn numbers follow the summary's counting), and notes can be revised the same way as verdicts — choosing an existing note appends a revision line with the same id; "Retract My Annotation" appends a retraction record for your own annotation. Changing a verdict appends a new line with the same annotation id (the previous line stays as history), exactly as the specification's revision rules require. Annotations are appended only to SkillTrace's own file (`ann-skilltrace-solo.jsonl`); the default destination is the personal folder (`~/.skilltrace-annotations/`), and writing to a shared workspace folder happens only when you choose it, after a confirmation that the content may be managed by Git. After writing, the history (including the verdict shown in the row label) and an open summary refresh immediately. Revisions and retractions of annotations that live in a shared folder ask for the same confirmation, are never redirected into a different workspace's folder, and carry a timestamp at or after the original line, so they take effect even if the machine clock has moved backwards. The specification document (docs/session-annotations.md) now records this writer support and the decided input UI.

### 追加 (Added)

- セッション注釈のフェーズ2（書き手側。Issue #49）。SkillTrace 自身が評価とメモを記録できるようになった。履歴ツリーのセッション項目（コンテキストメニュー）またはコマンドパレットから操作し、Copilot / Kiro / VS Code のセッション記録には一切書き込まない。「セッションの評価を追加／変更」はセッション全体へ3段階の評価（good / ok / bad）と任意のメモを付け、「ターンに評価・メモを追加／変更」はターン単位（ターン番号はサマリ表示の数え方）で同じことができ、メモも評価と同じく、既存のものを選んで同じ id の新しい行で変更できる。「自分の注釈を取り消す」は自分の注釈へ取り消しの記録を追記する。評価の変更は、仕様の改訂規則どおり、同じ注釈 id で新しい行を追記して行う（前の行は履歴として残る）。追記先は SkillTrace 自身のファイル（`ann-skilltrace-solo.jsonl`）だけに限られ、既定の書き込み先は個人用フォルダ（`~/.skilltrace-annotations/`）。共有用（ワークスペース）フォルダへは、利用者が選んだ場合のみ、Git 管理されうる旨の確認を挟んで書く。書き込み後は履歴（行ラベルに表示される評価を含む）と、開いているサマリの表示がその場で更新される。共有用フォルダにある注釈の改訂・取り消しでも同じ確認を挟み、別のワークスペースのフォルダへ振り替えることはない。改訂・取り消しの行の時刻は元の行以上に保たれるため、時計が後退していても有効になる。仕様書（docs/session-annotations.md）にも、書き手対応と決定した入力 UI を反映した。

## [1.14.1] - 2026-11-13

### Added

- Learning documents: a video explainer on the mechanisms behind the series — how information is loaded into the context, how tokens and credits are consumed, why accuracy degrades as context grows (context rot, lost in the middle), and the countermeasures (prompt caching, compaction, layered memory). The video was generated with Gemini Notebook (NotebookLM) and is published on YouTube; its slides ship with the documents as PDF and PowerPoint under docs/learning/media/, linked from the learning index (docs/learning/README.md).

### 追加 (Added)

- 学習ドキュメントに動画解説を追加。シリーズの背景にある LLM のコンテキストの仕組み（コンテキストへの読み込み、トークンとクレジットの消費、長くなるほど精度が落ちる問題（Context Rot、Lost in the Middle）と、その対処（プロンプトキャッシュ、compaction、階層メモリ））を扱う。動画は Gemini Notebook（NotebookLM）で生成し YouTube で公開、スライドは PDF と PowerPoint を docs/learning/media/ に同梱した。索引（docs/learning/README.md）からリンクしている。

## [1.14.0] - 2026-11-11

### Added

- Session annotations, phase 1: read and display (Issue #49). Verdicts and notes about a session (or a single turn) can be kept in annotation files — `.skilltrace-annotations/ann-<producer>.jsonl`, in the home folder (personal) and/or the workspace folder (shared) — without ever writing into the Copilot / Kiro / VS Code session records themselves. The specification is published in the repository as docs/session-annotations.md, so other extensions and external tools can append their own information (for example typed values such as an acceptance rate) in the same format. The history shows the latest session verdict in the row label and tooltip (good / ok / bad), and the session summary gains an "Annotations" section — session-level entries plus a per-turn list — in both the on-screen summary and the document copy, with values formatted by their declared type (percent shown as a percentage, durations as minutes/seconds, and so on) and a legend for the verdict colours. Sessions without annotations display exactly as before.

### 追加 (Added)

- セッション注釈のフェーズ1（読み取りと表示。Issue #49）。セッション（またはその中のターン）への評価やメモを、Copilot / Kiro / VS Code のセッション記録には一切書き込まず、注釈ファイル（`.skilltrace-annotations/ann-<producer>.jsonl`。個人用はホームフォルダ、共有用はワークスペースフォルダ）に記録できるようにした。仕様は docs/session-annotations.md としてリポジトリに公開し、他の拡張機能や外部ツールも同じ形式で情報（合格率のような型つきの値など）を追記できる。履歴ではセッション全体への最新の評価（good / ok / bad）を行のラベルとツールチップに表示し、セッションサマリには「注釈」の節（セッション全体への注釈＋ターンごとの一覧）を追加した。画面サマリと文書コピーの両方に含まれ、値は宣言された型に従って整形される（percent はパーセント表示、duration は分秒表示など）。評価の色には凡例を付けた。注釈の無いセッションの表示は従来と完全に同じ。

## [1.13.1] - 2026-11-10

### Added

- Learning documents, part 2 (Issue #5; Japanese only, as with part 1). Two new documents take the user's point of view — the inconveniences felt when a skill does not deliver its intended benefit — instead of the maker's structural view. 06 "Start from symptoms" is an index from nine symptoms (context already pressured before starting, heavy on every use, everything read when only a part is needed, documents that are never actually loaded, consumption that varies, context overflow, not reproducible in another environment, a skill that will not activate, a vague sense of declining quality) to the first display to check. 07 "Troubleshooting by symptom" works each symptom through as symptom / how to tell from the displays / what to do, including how to hand the findings to the skill's maker with tree and document copies.

### 追加 (Added)

- 学習ドキュメント第2弾（Issue #5。日本語のみは第1弾と同じ）。2本を追加した。作り手の構造の視点ではなく、利用者が感じる不便さ（提供したい効用が出ていない現象）から入る構成。06「現象から引く」は、現象9件（使い始める前からの圧迫、使うたびに重い、一部だけ知りたいのに全部読み込まれる、読んでくれない、消費のばらつき、あふれ、環境で再現しない、起動しない、精度が落ちた気がする）から最初に見る表示へ案内する索引。07「現象別のトラブルシューティング」は、現象ごとに「現象／判別／対処」で切り分け、判別結果をツリーコピーや文書コピーで作り手へ渡す方法までをまとめた。

## [1.13.0] - 2026-11-10

### Added

- Reference structure diagram (Issue #40). The skill summary now opens with a node-link diagram of the designed reference structure: files referenced from several places converge on a single node (unlike the arrival-flow tree, which expands them repeatedly), and cycles appear as loops. Nodes are layered by distance from SKILL.md; node colour is the certainty of arrival (with a legend), node size is estimated tokens, and the number above a node is its arrival order. Edges between two arrived files are drawn darker. Outside-skill and missing targets are dashed. When a skill has more than 40 files, the diagram is omitted for legibility; every file is still listed in Node details (the tree may stop at cycles). Wide diagrams are shown at natural size with horizontal scrolling instead of being shrunk. Together with the co-reading graph (Issue #42), the designed structure and the structure of actual use can now be compared side by side.

### 追加 (Added)

- 参照構造の図（Issue #40）。スキルサマリの先頭に、設計した参照構造のノードリンク図を追加した。複数箇所から参照されるファイルは1つの円に集まり（到達の流れのツリーが繰り返し展開するのと対照的）、循環は輪として見える。円は SKILL.md からの距離で段に並び、色は到達の確度（凡例つき）、大きさは推定トークン、円の上の数字は到達順。両端とも到達した参照の線は濃く描く。スキル外と参照先なしは破線で示す。ファイルが40件を超えるスキルでは見やすさのため図を省略する（全件はノード明細に載る。ツリーは循環箇所で展開を止める場合がある）。横幅の大きい図は縮小せず、実寸で横スクロール表示にする。同時読み込みグラフ（Issue #42）と並べることで、「設計した構造」と「実際に使われた構造」を比較できる。

## [1.12.0] - 2026-11-10

### Added

- History filter to the current workspace (Issue #44). A new setting `skilltrace.filterToCurrentWorkspace` (default off) and a filter button in the history view title bar — one switch, like auto-follow, so the setting and the button always agree. While it is on, the history shows only sessions certainly related to the open workspace folders (the recorded workspace matches a folder, or is inside it / contains it; multi-root workspaces match on any root). Sessions whose workspace cannot be determined from their records are hidden while the filter is on, so the list becomes exactly the sessions worth checking; they reappear when the filter is turned off. The filter is applied before the per-source newest-30 cap, so related sessions are not crowded out, and the skill totals and per-file reach are computed over the filtered (displayed) sessions.

### 追加 (Added)

- 履歴を現在のワークスペースに絞るモード（Issue #44）。設定 `skilltrace.filterToCurrentWorkspace`（既定オフ）と、履歴ビューのタイトルバーのフィルターボタンを追加した。自動追尾と同じ「1つのスイッチ」で、設定とボタンは常に連動する。オンの間は、開いているワークスペースフォルダーに確実に関係するセッションだけを表示する（記録のワークスペースがフォルダーと一致、またはその配下／上位。マルチルートはいずれかのルートで照合）。ワークスペースが記録から分からないセッションはオンの間は表示されないため、確認すべきセッションが明確になる。オフにすれば全セッションが戻る。絞り込みは供給源ごとの新しい順30件の上限より前に適用するため、関係するセッションが上限で押し出されることはなく、スキル別集計とファイル別到達も絞り込み後の表示中セッションを対象に計算する。

## [1.11.0] - 2026-11-10

### Added

- Co-reading graph (Issue #42). The per-file reach view now also shows which reference files were read together in the same session: a node-link diagram (files as nodes, lines for pairs read together, line thickness mapped to the number of sessions, with a legend) plus a pair table. SKILL.md is excluded because it is read on every activation. Pairs that are always read together are merge candidates, and files that are always read alone show that the split is working — the diagram shows the structure of actual use, complementing the reference structure. When there are too many files to draw legibly, the diagram is omitted and the pairs are listed in the table only.

### 追加 (Added)

- 同時読み込みグラフ（Issue #42）。ファイル別の到達の表示に、同じセッションで一緒に読み込まれたファイル同士の関係を追加した。ノードリンク図（ファイルがノード、一緒に読み込まれた組み合わせが線、線の太さはセッション数に対応し凡例つき）と、組み合わせの表で示す。SKILL.md は起動のたびに読み込まれるため除いている。常に一緒に読み込まれる組み合わせは統合候補、常に単独で読み込まれるファイルは分割が機能している証拠であり、設計した参照構造に対して「実際に使われた構造」を見せるもの。対象ファイルが多い場合は図を省略し、組み合わせは表のみで示す。

## [1.10.0] - 2026-11-10

### Added

- Per-file reach across sessions (Issue #41). The skill totals view now links each skill to a per-file table counting, across the sessions shown in the history, in how many sessions each reference file was read, was only mentioned, or had no recorded reach, with the last-read date. The file list comes from the reference graph of the skill as found in the currently open workspace; reach is matched by the paths recorded in each session, so sessions recorded in another location still count. When skills with the same name exist in more than one location, the results are split per location so that different skills are never mixed (placements within one location count as copies of one skill, and sessions whose recorded folder cannot be attributed are left uncounted and reported). "Read" rests on structural evidence in the records (tool arguments, read URIs, always-loaded context inclusions) and is coarser than the per-session traces; "no recorded reach" does not prove a file is never read — it may be read in sessions outside the aggregated set, so such files are candidates to check individually, not to fold back on the counts alone. The counts are per file and do not show which files were read together in the same session. Files not referenced from the skill do not appear in the list. This is the evidence base for deciding how a skill's referenced information should be split and distributed.

### 追加 (Added)

- ファイル単位の横断集計（Issue #41）。スキル別集計の各スキルから、参照ファイルごとの表を開けるようにした。履歴に表示中のセッションを横断して、ファイルごとに「読み込まれた／言及のみ／到達なし」のセッション数と最終到達日を示す。ファイルの一覧は、今開いているワークスペースで見つかったスキルの参照グラフから取り、到達は各セッションの記録に残るパスで突き合わせるため、別の場所で記録されたセッションも数えられる。同名のスキルが複数の場所にある場合は場所ごとに分けて集計し、別々のスキルを混ぜない（同じ場所の中の各配置はコピーとしてまとめ、記録のフォルダから場所を特定できないセッションは数えずにその旨を示す）。「読み込まれた」は記録の構造的な証拠（ツールの引数、読み取り URI、常時文脈への取り込み）に基づく判定で、セッション単位のトレースより粗く、「到達なし」は読まれていないことの証明ではない（集計対象外のセッションで読まれている可能性があるため、件数だけで畳み戻さず個別に確認する候補として扱う）。件数はファイル単位で、同じセッションで一緒に読まれた組み合わせは示さない。スキルから参照されていないファイルは一覧に出ない。スキルの参照情報をどのように分割し、どの分量で分散させるかを判断する材料とする。

## [1.9.0] - 2026-11-09

### Added

- Token-weight bars (Issue #32). Each file in the history tree and the summary trees (on screen and in copied documents) now carries a bar showing its share of the skill's total estimated tokens across all its files, with the basis stated next to the tree. In copied documents the node details table carries the bar as well; the node details table exists only in documents, and the on-screen skill summary shows the bars in its tree instead. The values are the same per-file estimates already shown with ~; the bars only make the distribution visible, and no per-file measured values are fabricated where the record has none.

### 追加 (Added)

- トークンの重み付けバー（Issue #32）。履歴ツリー、サマリのツリー（画面と文書コピーの両方）の各ファイルに、そのスキルの全ファイルの推定トークン合計に対する割合をバーで添えた。母数はツリーの脇に明記する。文書コピーではノード明細の表にもバーを添える（ノード明細は文書コピーのみの表で、画面のスキルサマリではツリー側にバーが付く）。値は従来から ~付きで表示しているファイル単体の推定そのもので、バーは分布を見えるようにするだけであり、記録に無いファイル単体の実測を作ることはしない。

## [1.8.0] - 2026-11-09

### Added

- The context window usage transition now travels with copied documents (Issue #30). The on-screen session summary already drew the transition as a line chart; the document copy (session and skill summaries) showed only the final value. Document HTML now embeds the same transition as an inline SVG chart with the peak marked, and Markdown shows it as a block-character sparkline with the peak position and value. Series are measured values only, never interpolated: per-turn tokens over the limit for Copilot and Copilot Chat, recorded usage-ratio snapshots for Kiro. When the limit is not recorded, ratios are computed against the maximum token count in the series, and the documents say so — in that case 100% does not represent usage against the actual limit.

### 追加 (Added)

- コンテキストウィンドウ使用量の推移を、文書コピーにも載せるようにした（Issue #30）。画面のセッションサマリには従来から折れ線グラフがあったが、文書コピー（セッション／スキル両サマリ）では最終値だけだった。文書 HTML には最大の位置を示した SVG グラフを、Markdown にはブロック文字のスパークラインと最大の位置・値を入れる。系列は実測のみで補間しない（Copilot と Copilot Chat はターンごとのトークン ÷ 上限、Kiro は記録された使用率スナップショット）。上限が記録されていない場合は系列の最大トークン数で割って算出し、その旨を文書に明記する（この場合の100%は、実際の上限に対する使用率を示さない）。

## [1.7.0] - 2026-11-09

### Added

- Per-skill totals across the history (Issue #31). A "Skill totals" entry at the top of the history aggregates the sessions shown there (up to 30 most recent per source) by skill: session count, activation count, and measured consumption — credits for Kiro and Copilot Chat, input/output tokens for Copilot — with different units never added together. Credits and tokens are whole-session measurements, not apportioned per skill; when several skills were activated in one session, the same session total counts toward each of them, and the panel says so. For Copilot Chat, activations are counted per session, as its records do not distinguish repeated activations.

### 追加 (Added)

- 履歴をまたいだスキル別集計（Issue #31）。履歴の先頭に「スキル別集計」の入口を追加し、履歴に表示中のセッション（供給源ごとに新しい順30件まで）をスキル単位に集計する。セッション数、起動回数、実測の消費（Kiro と Copilot Chat はクレジット、Copilot は入力／出力トークン）で、単位の異なる値は合算しない。クレジットとトークンはセッション全体の実測でスキルへの按分はしておらず、複数のスキルが起動したセッションでは同じセッション合計が各スキルに入る旨をパネルに明記した。Copilot Chat の起動回数は、記録の性質上セッション単位の有無で数える。

## [1.6.3] - 2026-11-09

### Changed

- Wording only: replaced the term used for the user's other environment in the README and a test comment (no behavior change).

### 変更 (Changed)

- 表記のみの変更: README とテストコメントで、もう一方の利用環境を指す語を「他環境」に統一した（挙動の変更なし）。

## [1.6.2] - 2026-11-09

### Fixed

- Kiro skill discovery for multi-root sessions now searches the union of the recorded `workspacePaths` and `rootPaths`. When the two records disagreed, skills living under a root listed in only one of them were reported as not found, leaving the summary's activated-skills table empty.
- When activated skills cannot be found, the note in summaries and in the tree now names the workspace the session ran in and guides the user to open it to see the reference tree, instead of leaving an unexplained empty table.

### 修正 (Fixed)

- マルチルートの Kiro セッションで、スキル探索の対象を記録の workspacePaths と rootPaths の和集合にした。2つの記録が食い違うと、片方にしか無いルートのスキルが「見つからない」になり、サマリの「起動したスキル」の表が空になっていた。
- 起動したスキルが見つからないときの注記（サマリとツリー）に、そのセッションを実行したワークスペースを示し、開くと参照ツリーを表示できる旨を案内するようにした。空の表だけが残って理由が分からない状態を避けるため。

## [1.6.1] - 2026-11-09

### Fixed

- Sessions recorded by newer Copilot runtimes no longer trigger the "unknown event types" warning: the model-call layer (`model.*`, 8 types) plus `session.model_change`, `session.permissions_changed`, and `system.notification` — 263 of 1,230 events (21%) in a sampled real session — are now recognized. Skill, read, and usage evidence continues to come from the established event types.

### 修正 (Fixed)

- 新しい Copilot ランタイムが記録したセッションで「未知のイベント種別」の警告が出ないようにした。モデル呼び出し層（model.* の8種）と session.model_change / session.permissions_changed / system.notification を既知に加えた（実セッションの採取では 1,230 件中 263 件・21% がこの層だった）。スキル起動・読み取り・使用量の証拠は従来の種別側に残っている。

## [1.6.0] - 2026-11-09

### Changed

- History labels shorten multi-root workspace files: `name.code-workspace` is shown as `name ⧉` (the full path remains in the tooltip).
- Copilot CLI sessions now show their summaries even when the skills they used are no longer in the workspace (moved, renamed, or deleted). Measured turns, token totals, tool executions, and outside reads are rebuilt from the record alone, and invocations whose skill cannot be found are noted by name — the same treatment Kiro and Copilot Chat sessions already had. History labels for Copilot sessions also read invocation names from the record itself.

### 変更 (Changed)

- 履歴ラベルで、マルチルートのワークスペースファイル（`名前.code-workspace`）を「名前 ⧉」と短く表示するようにした（フルパスはツールチップに残る）。
- Copilot CLI のセッションで、使ったスキルが現在のワークスペースに無くなっていても（移動・改名・削除）、サマリが表示されるようにした。ターン・トークン実測・ツール実行・スキル外の読み取りは記録だけで復元し、見つからないスキルの起動は名前の注記として残す。Kiro / Copilot Chat と同じ扱い。履歴ラベルも、記録そのものが持つ起動名を読むようにした。

## [1.5.1] - 2026-11-09

### Changed

- The history label for sessions recorded by VS Code's Copilot Chat now reads "Copilot Chat" instead of "VS Code", naming the agent surface rather than the editor. The same rename applies to the tooltip and the credit notes in summaries.

### 変更 (Changed)

- VS Code の Copilot Chat が記録したセッションの履歴ラベルを「VS Code」から「Copilot Chat」に変更した。エディタではなくエージェントの名前で示すため。ツールチップとサマリ内のクレジット注記も同じ表記に揃えた。

### Fixed

- VS Code chat sessions with no requests (files VS Code creates as soon as a chat is opened) are no longer listed in the history. They carried no content and kept appearing as "No skill used" entries.

### 修正 (Fixed)

- VS Code のチャット履歴で、リクエストの無いセッション（チャットを開いただけで作られるファイル）を履歴に載せないようにした。中身が無く、「スキル未使用」の履歴だけが増えていた。

## [1.5.0] - 2026-11-09

### Added

- **Sessions from VS Code's built-in Copilot Chat now appear in the
  history** (Issue #22). VS Code stores chat sessions as a delta log
  under the user data folder's `workspaceStorage/<hash>/chatSessions/`;
  SkillTrace replays the log, recovers each request's tool calls, and
  traces skill usage from the recorded file reads. A SKILL.md recorded
  as a skill read (`vscodeLinkType=skill`) counts as certainty High;
  other recorded reads count as Medium. The records carry both token
  usage (prompt / completion per request) and Copilot credits
  (`copilotCredits` per request), and both are shown. Sessions are
  labelled "VS Code" in the history and capped per source like the
  other sources.

### 追加 (Added)

- **VS Code 標準の Copilot チャットのセッションが履歴に並ぶように
  なった**（Issue #22）。VS Code はチャットのセッションを差分ログ
  としてユーザーデータフォルダ配下の
  `workspaceStorage/<ハッシュ>/chatSessions/` に保存する。
  SkillTrace はそのログを再生して各リクエストのツール呼び出しを
  復元し、記録されたファイル読み取りからスキルの辿りを組み立てる。
  「スキルとして読み込まれた」記録（`vscodeLinkType=skill`）のある
  SKILL.md は到達の確度「高」、その他の読み取りは「中」とする。
  記録にはトークン実測（リクエストごとの prompt / completion）と
  Copilot クレジット（`copilotCredits`）の両方が残るため、両方を
  表示する。履歴では「VS Code」と表示し、表示上限は他の供給源と
  同じく供給源ごとに数える。

## [1.4.4] - 2026-11-09

### Changed

- **Regression coverage for sessions recorded through VS Code.** In
  environments where VS Code delegates agent runs to the Copilot CLI
  host, sessions are recorded in the CLI format under
  `~/.copilot/session-state` and were already traced correctly; a real
  probe session (activation, traversal order, token totals) is now
  pinned as a test fixture so this keeps working. No behaviour change.
  Support for the other VS Code storage format (chatSessions) is
  tracked in Issue #22.

### 変更 (Changed)

- **VS Code 経由で記録されるセッションへの回帰テストを追加。**
  VS Code のエージェント実行が Copilot CLI ホストに委ねられる環境では、
  記録は CLI 形式で `~/.copilot/session-state` に残り、従来から正しく
  辿れていた。その実セッション（起動・到達順・トークン実測）を
  テストフィクスチャとして固定し、今後も壊れないようにした。
  挙動の変更はない。もう一方の保存形式（chatSessions）への対応は
  Issue #22 で追跡中。

## [1.4.3] - 2026-11-09

### Fixed

- **Session history: the display cap is now per source.** The history
  showed the newest 30 sessions across Copilot and Kiro combined, so in
  an environment with many Kiro sessions (hundreds), older Copilot
  sessions could be crowded out and never appear. The cap now keeps
  the newest 30 of each source, so both stay visible.

### 修正 (Fixed)

- **セッション履歴の表示上限を、供給源ごとに数えるよう直した。**
  従来は Copilot と Kiro を合算して新しい順に30件までだったため、
  Kiro のセッションが多い環境（数百件）では、古い Copilot の
  セッションが押し出されて1件も表示されなかった。これからは
  供給源ごとに新しい順30件までを表示する。

## [1.4.2] - 2026-11-08

### Fixed

- **Path traversal prevention in temporary file creation.** In `skilltrace.openSummaryInBrowser`,
  session IDs used to create temporary HTML files under `os.tmpdir()` are now sanitized
  with `sanitizeFilenamePart` to restrict characters to alphanumeric, dash, and underscore,
  preventing potential directory traversal or file manipulation.

### 修正 (Fixed)

- **ブラウザでサマリを開く際の一時ファイル作成におけるパストラバーサル防止。**
  `skilltrace.openSummaryInBrowser` で一時ディレクトリ配下に HTML ファイルを書き出す際、
  セッションIDに含まれうるパス区切り文字や相対パス表記（`../` 等）を `sanitizeFilenamePart`
  でサニタイズ（英数字・ハイフン・アンダースコアのみを許可）し、安全なファイル名のみを
  結合するように修正した。

## [1.4.1] - 2026-11-08

### Fixed

- **Tool grouping in the credit-usage matrix: `fs_append` is now in the
  "Write / edit" group** (it was classified as "Other"). Appending to a
  file changes its content, so it belongs with the write operations;
  "append" was added to that group's keywords.

### 修正 (Fixed)

- **クレジット実測のマトリクスで、`fs_append` を「書き込み・編集」
  グループに分類するよう直した**（従来は「その他」だった）。
  ファイルへの追記は内容の変更なので書き込み系が適切で、同グループの
  キーワードに「append」を追加した。

## [1.4.0] - 2026-11-08

### Added

- **English display support.** All user-facing text now follows the host's
  display language: the session tree (labels, descriptions, tooltips), the
  summaries (webview pages and browser output), document copies
  (Markdown / HTML), tree text copies, the status bar, and messages.
  Summaries include the glossary, the tool-matrix legend (tool groups),
  evidence strings, and observations such as cache-write turns, all in
  English. Languages other than Japanese fall back to English, matching
  how VS Code resolves extension display languages. Japanese rendering is
  unchanged.
- **The bundled learning documents remain Japanese only.** They are
  not translated in this release.

### 追加 (Added)

- **英語表示に対応した。** 利用者が目にする文言のすべてが、ホスト
  （VS Code / Kiro）の表示言語に追随する: セッションツリー（ラベル・
  説明・ツールチップ）、サマリ（Webview と ブラウザ出力）、文書コピー
  （Markdown / HTML）、ツリーのテキストコピー、ステータスバー、
  各種メッセージ。用語集、ツールマトリクスの凡例（ツールのグループ）、
  根拠の文、キャッシュ書込の発生ターンなどの観測文も英語になる。
  日本語以外の言語では英語に寄せる（VS Code の表示言語の解決と同じ
  考え方）。日本語の表示は従来どおりで変わらない。
- **学習ドキュメントは日本語のみのまま。** 同梱の学習ドキュメント
  （docs/learning）は今回の版では翻訳していない。

## [1.3.0] - 2026-11-08

### Changed

- **Reworked the Kiro credit table's "tools used" into a turn × tool
  matrix.** Each tool gets its own column and each cell holds only that
  turn's call count (blank when zero), so rows and columns compare at a
  glance. Columns are ordered by role group (read/explore, write/edit,
  execute, sub-agents, progress/dialogue, other), then by session total;
  HTML views colour the column headers by group and add a legend below
  the table, and a totals row follows the last turn. Applies to the
  on-screen summary and both document copies (Markdown / HTML); Markdown
  cannot express the spanning header or colours, so grouping is conveyed
  by column order there.

### 変更 (Changed)

- **Kiro のクレジット実測の「使用したツール」を、ターン×ツールの
  マトリクス表に変更。** これまではターンごとに「read_file ×56」のような
  文字列が並び、行同士の比較が難しかった。ツールごとに列を立て、セルには
  そのターンの呼び出し回数だけを入れる（0回は空白）。列の並びは役割の
  グループ（読み取り・探索／書き込み・編集／実行／サブエージェント／
  進行・対話／その他）→ グループ内は合計の多い順で、全行に共通。HTML
  表示では列見出しをグループ色で塗り、色とグループの対応を示す凡例を
  表の下に付けた。最終ターンの下にはツールごとの合計行も追加した。
  画面サマリと文書コピー（Markdown / HTML）のすべてに適用。Markdown
  では列またがりと色が表現できないため、列の並び順でグループが分かる
  形にしている。

## [1.2.4] - 2026-11-08

### Fixed

- **Fixed sessions without a trace (no skill activation) being impossible
  to close from the item button.** A displayed session is drawn expanded,
  but the expansion record was only seeded when a trace was built, so the
  toggle always fell to the "expand" side. Expansion bookkeeping is now
  independent of trace existence, expanding works for trace-less sessions,
  and "collapse all" recreates items so the collapsed state always lands.
- **Split the "Expand/Collapse All Sessions" toggle into two buttons,
  "Expand All Sessions" and "Collapse All Sessions",** placed side by
  side. Pressing the old toggle intending to close could trigger the
  expensive expand-all instead; each button now always does what it says.
  Titles follow the display language via nls.

### 修正 (Fixed)

- **トレースが無いセッション（スキル起動なし）を、項目のボタンで閉じられ
  なかった問題を修正。** 表示中セッションは開いて描かれるのに、展開状態の
  記録がトレース構築時にしか作られなかったため、開閉ボタンが常に「開く」
  側に倒れ続けていた。開閉の記録をトレースの有無から切り離し、開く処理も
  トレースが無くてもセッション自体は開くようにした。「すべて折りたたむ」
  でも、各セッションの項目を作り直して畳んだ状態が確実に反映されるように
  した。
- **ビューの「すべてのセッションを展開／折りたたむ」トグルを、「すべて
  展開」と「すべて折りたたむ」の2つのボタンに分離。** 閉じたいつもりで
  押すと、時間のかかる「すべて展開」が走ることがあった。押した結果は
  常にボタンどおりの動作になる。タイトルは nls で表示言語に追随する
  （英語: Expand All Sessions / Collapse All Sessions、日本語:
  すべてのセッションを展開 / すべてのセッションを折りたたむ）。

## [1.2.3] - 2026-11-08

### Added

- **Added learning document 05, "Cheaper skills — cutting cost while
  keeping the results".** A practical guide to deciding, from SkillTrace's
  measurements, where and how to change your own skills: the three payment
  timings (always-loaded context / SKILL.md / references), an
  observation-to-fix decision table and diagnostic flow (two Mermaid
  diagrams), how to verify the effect, and what not to do. Written to be
  actionable on its own, before reading documents 01–04.

### 追加 (Added)

- **学習ドキュメント 05「スキルを安くする — 同じ成果でコストを下げる
  直し方」を追加。** SkillTrace の実測から、自分のスキルのどこをどう
  直すかの方針と判断をまとめた実務編。支払いのタイミング3種（常時文脈 /
  SKILL.md / references）、観測から直し方を引く判断表と診断フロー
  （Mermaid 図2点）、効果の確かめ方と「やってはいけないこと」を記載。
  01〜04 を読んでいなくても、この文書だけで判断して行動に移せる構成にした。

## [1.2.2] - 2026-11-08

### Fixed

- **Fixed Kiro sessions whose activated skills are no longer in the workspace
  rendering as a silently empty tree with skills shown as "undetermined".**
  Activation was judged only against skills discoverable in the current
  workspace, so activations of moved, renamed or deleted skills vanished
  from the record. Activated names are now kept from the record itself and
  noted in the tree and summaries (including document copies) as not found
  in the current workspace; a session with nothing to show explains why
  instead of expanding to nothing.

### 修正 (Fixed)

- **Kiro のセッションで、起動したスキルが現在のワークスペースで見つからない
  場合に、ツリーが無言で空になり、起動スキルが「未判定」になっていた問題を
  修正。** 起動の判定が「発見できたスキル」との照合だけだったため、移動・
  改名・削除されたスキルの起動が記録から消えていた。記録にある起動名は
  そのまま残し、ツリーとサマリ（文書コピー含む）に「現在のワークスペースでは
  見つかりませんでした」と注記するようにした。表示できる項目が無いセッション
  でも、空の展開ではなく理由を注記する。セッションのツールチップでも、候補が
  無い場合に「未判定」とせず記録の起動名を示す。

## [1.2.1] - 2026-11-08

### Added

- **Added a "Where the examples come from" section to the learning-doc
  index.** The running examples, phase0-probe / kiro-probe, are the author's
  own verification dummy skills and are not part of this repository; each
  document (01–04) now points to that single explanation. (Follow-up that
  missed the PR #10 merge.)

### 追加 (Added)

- **学習ドキュメントの索引に「実例の出どころ」を追加。** 全編の実例である
  phase0-probe / kiro-probe は著者の検証用ダミースキルであり、この
  リポジトリに含まれないことを一か所に明記し、各文書（01〜04）の冒頭から
  参照するようにした（PR #10 のマージに間に合わなかった追補）。

## [1.2.0] - 2026-11-08

### Added

- **Show the "structure of consumption" in summaries (Issue #9).** Copilot's
  input breakdown is now three-way (new input / cache read / cache write;
  cache writes used to be lumped into "new input"), and the turns in which
  cache writes occurred are shown as an observation. For Kiro, the
  always-loaded context section (and the tree group) now also shows the
  first recorded context-window usage, as a guide to how
  heavy the always-loaded context is. Only measured values and their
  proportions are shown — no rates or converted values. Learning
  document 04, "Reading the summary", covers how to interpret them.

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

## [1.1.0] - 2026-11-08

### Added

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

## [1.0.2] - 2026-11-08

### Added

- **Added learning document 03, "Comparing Copilot and Kiro session records"**,
  contrasting how the two platforms record sessions (storage, format, skill
  activation and reference traversal, always-loaded context, measured units,
  context-window usage), with SkillTrace's certainty mapping and the pitfalls
  found while reading the records on a real machine.

### 追加 (Added)

- **学習ドキュメント 03「Copilot と Kiro のセッション記録を読み比べる」を追加。**
  両プラットフォームのセッション記録（保存場所、形式、スキル起動と参照の辿りの
  記録、常時文脈、実測の単位、コンテキストウィンドウ使用量）を、実機で確認した
  実例セッションの数値とともに対比し、SkillTrace での到達の確度の対応付けと、
  記録を読む際の落とし穴（対応付けキーの違い、単位の非対称性など）をまとめた。
  あわせて学習ドキュメントの索引に Kiro 側の基礎データを追記した。

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
