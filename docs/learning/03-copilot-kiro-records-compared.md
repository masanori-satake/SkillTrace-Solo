# 03. Copilot と Kiro のセッション記録を読み比べる

## この文書で分かること

- GitHub Copilot と Amazon Kiro が、セッションの記録をどこに、どんな形式で残すか
- 「スキルが起動した」「参照ファイルを辿った」「常時文脈が読み込まれた」が、
  それぞれの記録ではどう表れるか
- 実測の単位の違い（トークンとクレジット）と、コンテキストウィンドウ使用量の
  記録のされ方の違い
- 記録を対応付けるときの落とし穴（実機確認で実際に踏んだもの）

本書の内容は、2026-11-07〜08 に実機で両プラットフォームの記録を直接読んで
確認した事実に基づきます。数値はすべて実例セッションの実測です。

## 出発点の疑問

「スキルが SKILL.md から参照を辿って、どこまで読んだのか知りたい」——
SkillTrace が答えたい問いは、Copilot でも Kiro でも同じです。
ところが、答えの材料になるセッション記録は、置き場所も、形式も、
実測の単位も、プラットフォームごとにまったく違います。

同じ問いへの答え方がどう違うのかを、記録そのものを読み比べることで理解するのが
この文書の目的です。

## 1. 全体像

```mermaid
flowchart LR
    subgraph copilot[GitHub Copilot CLI]
        C1["~/.copilot/session-state/&lt;id&gt;/"] --> C2["events.jsonl<br>（イベント列）"]
        C1 --> C3["workspace.yaml<br>（cwd の記録）"]
    end
    subgraph kiro[Amazon Kiro（v3 ストア）]
        K1["~/.kiro/sessions/&lt;bucket&gt;/sess_&lt;uuid&gt;/"] --> K2["messages.jsonl<br>（封筒形式のイベント列）"]
        K1 --> K3["session.json<br>（メタ情報）"]
    end
```

| 観点 | GitHub Copilot | Amazon Kiro |
| --- | --- | --- |
| 保存場所 | `~/.copilot/session-state/<セッションID>/` | `~/.kiro/sessions/<バケット>/sess_<UUID>/` |
| 記録ファイル | `events.jsonl` | `messages.jsonl` |
| 1行の形 | イベントそのもの（`type` が最上位） | 封筒 `{id, timestamp, payload}`、本体は `payload` の中 |
| 種別のキー | `type`（ドット区切り: `skill.invoked` 等） | `payload.type`（スネークケース: `tool_call` 等） |
| メタ情報 | 同じフォルダの `workspace.yaml` に `cwd` | `session.json` に title / createdAt / modelId / agentMode |
| ワークスペース | `cwd` が1つだけ記録される | `workspacePaths` / `rootPaths` に複数記録（マルチルートが前提） |
| スキル起動 | `skill.invoked` イベント | `tool_call`（actionType = `disclose_context`、引数はスキル名） |
| 参照の辿り | `tool.execution_complete` の成功＋パス | `tool_call`（actionType = `read_files`、引数にパス）＋ `tool_result` |
| 常時文脈 | `skill.context_delivered_ref` 等の配送イベント | `steering_inclusion` の `documents`（file:// URI の一覧） |
| 実測 | トークン内訳（input / output / cache / reasoning） | クレジット（ターン単位、`usage_summary`） |
| 文脈使用量 | `context_current_tokens`（絶対量）と上限 | `contextUsage`（`usagePercentage`、割合のみ） |
| 呼び出しと結果の対応 | `toolCallId` | `toolCallId`（`executionId` はターン共通なので使えない） |
| 到達順の土台 | 行順（＋ timestamp） | 行順（＋ timestamp） |

## 2. Copilot の記録（events.jsonl）

### 形

1行 = 1イベントで、キーは `type` / `timestamp` / `id` / `parentId` / `data` です。
中身は `data` の中にあり、イベント種別ごとに形が変わります。

```json
{"type":"session.usage_record","timestamp":"2026-11-07T09:20:44.000Z","id":"e24","parentId":null,"data":{"usage":{"inputTokens":8200,"outputTokens":120,"cacheReadTokens":4000,"cacheWriteTokens":300,"reasoningTokens":0},"context_current_tokens":9100,"context_token_limit":200000}}
```

### 主なイベント種別

| type | 意味 |
| --- | --- |
| `session.start` / `session.end` | セッションの開始と終了 |
| `user.message` / `assistant.message` | 利用者の発言とモデルの応答 |
| `assistant.turn_start` / `assistant.turn_end` | ターン（1回の依頼処理）の区切り |
| `skill.invoked` | スキル起動。SKILL.md の見出しが文字列として含まれるため、「起動時に本文が読み込まれた」ことまで裏付けられる |
| `skill.invoked_ref` | 起動に伴う参照の言及 |
| `skill.context_delivered_ref` | 参照ファイルの内容がコンテキストへ読み込まれた（配送された）記録 |
| `tool.execution_start` / `tool.execution_complete` | ツール呼び出しの開始と完了。完了側に成否（`success`）がある |
| `session.usage_record` | ターンごとの実測（トークン内訳と、その時点のコンテキスト使用量） |
| `hook.start` / `hook.end`、`permission.requested` / `permission.completed` | フックと権限確認の記録 |

### 特徴

- **スキルに関する専用イベントがある**。起動（`skill.invoked`）と
  コンテキストへの読み込み（`skill.context_delivered_ref`）が別イベントとして
  明示されるため、「読んだ」と「読み込まれた」の区別（01 のテーマ）が
  記録の上で直接できます
- **実測はトークンの内訳で残る**。入力・出力・キャッシュ読取・キャッシュ書込・
  推論が分かれ、`context_current_tokens`（現在の使用量・絶対量）と
  `context_token_limit`（上限）も同じ行にあります
- **ワークスペースは `cwd` が1つ**。マルチルートワークスペースのセッションでは、
  どのフォルダの記録かは `cwd` からしか分かりません

## 3. Kiro の記録（v3 セッションストア）

### 形

セッションは `~/.kiro/sessions/<16桁のバケット>/sess_<UUID>/` に置かれ、
`session.json`（メタ情報）と `messages.jsonl`（記録本体）からなります。

`messages.jsonl` の1行は封筒形式で、`{id, timestamp, payload}` の
`payload` の中に本体があります。本体の種別は `payload.type` です。

`session.json` には使用量は含まれず、代わりにワークスペースの情報が
しっかり記録されます。実測したセッションでは `workspacePaths` が3件、
`rootPaths` が12件（Solo 系リポジトリ一式）入っていました。
マルチルートが前提の設計です。

### 主な payload.type

実測した2セッションの内訳は、ほぼ次の顔ぶれでした。

| payload.type | 意味 |
| --- | --- |
| `session_start` / `session_event` | セッションの開始と境界イベント |
| `user` / `assistant` | 利用者の発言とモデルの応答。`user` 側にも `documents`（取り込まれた文書）が付くことがある |
| `turn_start` / `turn_end` | ターンの区切り |
| `tool_call` / `tool_result` | ツール呼び出しと結果。呼び出し側に `actionType` と `args`、結果側に `success`（真偽値）がある |
| `steering_inclusion` | そのターンでコンテキストに取り込まれた文書の一覧（`documents`、file:// URI） |
| `usage_summary` | ターン単位の実測。クレジットと使用ツールが残る |
| `session_metadata` | キー・バリュー形式のスナップショット。`key = contextUsage` で文脈使用率が残る |
| `pending_interaction` / `interaction_resolved` | 確認待ちと、その解決 |

### スキル起動は disclose_context

Kiro にはスキル専用のイベント種別がありません。スキル起動はツール呼び出しの
一種として記録されます。

- `tool_call` の `actionType` が `disclose_context`、引数が `{"name": "<スキル名>"}`
  —— これがスキル起動（activation）の記録です
- `disclose` は progressive disclosure（段階的開示）の「開示」そのもので、
  起動したスキルの内容をコンテキストへ開示するための仕組みです
- ただし結果（`tool_result`）の `content` は短い受領情報で、SKILL.md の本文
  そのものではありませんでした（実測 104 文字）。本文は、起動の直後に続く
  `read_files` で改めて読まれていました

### 参照の辿りは read_files

- `tool_call` の `actionType` が `read_files`、引数が
  `{path, offset, limit}` —— 読み取り対象のパスがそのまま残ります
- 対応する `tool_result` の `success` で成否が分かります
- 呼び出しと結果の対応付けは **`toolCallId`** で行います。
  `executionId` はターン内の全イベントで共通の値なので、対応付けには使えません
  （実機確認で踏んだ落とし穴の1つです。§6）

### 常時文脈は steering_inclusion

`steering_inclusion` の `documents` には、そのターンでコンテキストに
取り込まれた文書の file:// URI が並びます。実測したセッションでは
AGENTS.md と `.kiro/steering/` の3文書、計5件が入っていました。
スキル起動とは別に「常にかかっている文脈」がどれかが、この一覧で分かります。
steering のないワークスペースでは、このイベント自体が現れません
（プローブで対照確認済み）。

### 実測は usage_summary（クレジット）

`usage_summary` の `promptTurnSummaries` に、ターン単位の実測が入ります。

```json
{"unit":"credit","unitPlural":"credits","usage":0.8200442711442787,"usedTools":["disclose_context","list_directory","read_file","read_file","read_file"]}
```

- 単位は **credit（クレジット）** で、トークンの内訳は記録されません
- `usedTools` に、そのターンで使ったツールが並びます
- あわせて `elapsedTime`（所要時間）と `status` も残ります

### 文脈使用量は contextUsage（割合のみ）

`session_metadata` はキー・バリュー形式のスナップショットで、
`key` が `contextUsage` のものの `value` が `{usagePercentage: 4.1247}` の形です。

- 残るのは **割合（%）だけ** で、トークンの絶対量も上限も記録されません
- ターンの途中でも何度も記録されるため、使用率の推移は追えます
## 4. 実例で読み比べる

同じ役割のプローブ（SKILL.md → references 2段の合言葉探し）を、
両プラットフォームで実行した記録の対比です。

| | Copilot（phase0-probe） | Kiro（kiro-probe） |
| --- | --- | --- |
| ターン数 | 4 | 1 |
| ツール実行 | 5回 | 8回（探索4・開示1・読み取り3） |
| 実測 | 入力 71,271 / 出力 770 / キャッシュ読取 52,862 / キャッシュ書込 18,397 / 推論 355 トークン | 0.82 credits |
| 文脈使用量 | 最終 19,561 トークン（上限 200,000） | 4.1247% → 4.2921% と推移 |

読み取れること:

- Copilot は「何トークン使ったか」が細かく残る代わりに、ワークスペースの
  情報は薄い。Kiro は「何クレジット使ったか」と「どのワークスペースか」が
  残る代わりに、トークンの内訳は残らない
- Kiro のプローブでツール呼び出しの半分が「探索」（`search`）だったのは、
  スキルの置き場所を探してから開示する、という Kiro の動きが記録に
  そのまま表れているためです
- どちらも「起動 → SKILL.md → 参照を順に辿る」という progressive disclosure の
  動き自体は、記録から同じように追跡できます

もう1つ、Kiro 側の対照データとして、12ルートのワークスペース
（AGENTS.md と steering が大量に常時読み込まれる環境）での1ターンは
**19.88 credits** でした。最小構成のプローブ（0.82）の約24倍です。
常時文脈の量がクレジットを支配する、という構図が実測で見えます
（Copilot 側で入力トークンが膨らむ話と同型です。02 を参照）。

## 5. SkillTrace での対応付け

SkillTrace は、プラットフォームごとに違う記録を、共通の物差し
（到達の確度: 高・中・低）に読み替えて表示します。対応付けは次のとおりです。

| 確度 | Copilot | Kiro |
| --- | --- | --- |
| 高（読み込みを確認） | `skill.context_delivered_ref` で言及／`skill.invoked` に SKILL.md の見出し | `steering_inclusion` 等の `documents` に列挙／`disclose_context` で開示された SKILL.md |
| 中（読み取り成功） | `tool.execution_complete` の成功 | `read_files` の `tool_result` が成功 |
| 低（言及のみ） | 上記以外のイベントでの言及 | 上記以外のイベントでの言及 |

実測の表示も供給源で切り替えます。Copilot はトークン実測と
コンテキストウィンドウ使用量（トークン）、Kiro はクレジット実測と
コンテキストウィンドウ使用率（%）です。Kiro でスキル起動のないセッション
（仕様駆動など）でも、常時文脈（`documents` の一覧）とクレジットは
記録から表示できます。

## 6. 落とし穴（実機確認で踏んだもの）

- **Kiro の `executionId` はターン共通**。呼び出しと結果を `executionId` で
  対応付けると全部同じ相手にくっつきます。対応キーは `toolCallId`
- **Kiro の disclose の結果は `success: false` だった**。それでもスキルは
  起動し、合言葉まで正しく返りました。起動の成否を結果フラグで判断すると
  誤ります。起動の事実は `tool_call` 側で確定させます
- **disclose の結果は本文ではない**（104文字）。「開示されたら本文も
  記録にあるはず」という前提で探すと迷子になります。本文の到達は
  続く `read_files` で裏付けます
- **file:// URI はエンコードされている**。`file:///c%3A/Users/...` のように
  ドライブレターのコロンが `%3A` になります。通常のパスと突き合わせる前に
  デコードが必要です
- **単位は換算できない**。0.82 credits と 71,271 トークンは、どちらも
  「1回のプローブ実行の実測」ですが、土台が違うので大小比較はできません。
  比較できるのは、それぞれの単位の中での相対的な変化だけです
- **Copilot のマルチルートは記録が弱い**。`cwd` が1つしか残らないため、
  2つ目以降のフォルダのセッションでは基準を取り違える可能性があります。
  Kiro は `workspacePaths` / `rootPaths` がある分、この点は確実です

## 7. 自分で覗く方法（再現実験）

両方のストアはただのテキストファイルなので、エディタや PowerShell で
直接覗けます。

### Copilot

```powershell
# 最新セッションのイベント種別の内訳
$f = (Get-ChildItem "$env:USERPROFILE\.copilot\session-state" -Recurse -Filter events.jsonl | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
Get-Content $f -Encoding UTF8 | ForEach-Object { ($_ | ConvertFrom-Json).type } | Group-Object | Select-Object Count, Name
# スキル起動の記録だけ見る
Get-Content $f -Encoding UTF8 | Where-Object { $_ -match 'skill\.' }
```

### Kiro

```powershell
# 最新セッションの種別内訳（payload.type を見る）
$f2 = (Get-ChildItem "$env:USERPROFILE\.kiro\sessions" -Recurse -Filter messages.jsonl | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
Get-Content $f2 -Encoding UTF8 | ForEach-Object { ($_ | ConvertFrom-Json).payload.type } | Group-Object | Select-Object Count, Name
# スキル起動（disclose_context）の確認
$kl = Get-Content $f2 -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json }
$kl | Where-Object { $_.payload.type -eq 'tool_call' -and $_.payload.actionType -eq 'disclose_context' } | ForEach-Object { $_.payload.args }
# クレジット実測
$kl | Where-Object { $_.payload.type -eq 'usage_summary' } | ForEach-Object { $_.payload.promptTurnSummaries } | Format-List
```

注意: PowerShell 5.1 の `Get-Content` は UTF-8 を文字化けさせることが
あるため、`-Encoding UTF8` を付けてください（ファイル自体は正常です）。

## まとめ

- 問いは同じでも、記録の設計はプラットフォームの考え方を映します。
  Copilot は「モデルの消費（トークン）」を細かく残し、Kiro は
  「作業の対価（クレジット）」と「作業場所（ワークスペース）」を残します
- スキルの読み込みを追う鍵は、Copilot ではスキル専用イベント、
  Kiro では `disclose_context` と `steering_inclusion` です
- 記録を読むときは、単位と対応キーの前提を最初に確認すること。
  それを怠ると、§6 のような誤読をします
