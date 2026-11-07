---
name: phase0-probe
description: SkillTrace Phase 0 の確認用ダミースキル。「ホシホゲ計画」の合言葉・儀式・外のメモについて聞かれたときに使う。
---

# Phase0 Probe Skill

このスキルは、エージェントが SKILL.md のポインタに従って references を
どこまで読むかを確認するためだけのダミーです。実在の業務とは関係ありません。

## 回答のルール

- 推測で答えないこと。答えは必ず下記の参照先ファイルに書かれているので、
  該当するファイルを実際に読んでから答えること。
- 合言葉とコード番号 A について聞かれたら [references/alpha.md](references/alpha.md) を読む。
- 儀式の手順とコード番号 B について聞かれたら [references/beta.md](references/beta.md) を読む。
- 「外のメモ」について聞かれたら、まず beta.md を読み、その指示に従って
  スキルディレクトリの外にあるメモまで辿ること。
- 回答には、根拠にしたコード番号（A/B/S）を必ず含めること。

- 合言葉その2について聞かれたら [references/gamma.md](references/gamma.md) を読む。
