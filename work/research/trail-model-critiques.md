# Trail モデルへの批判と課題（Entire / コミュニティ調査）

2026-11-17 / 対象: Entire の Trail、agent-native VCS、AI レビュー、intent-first、metrics 添付

## 0. 要約

- Trail の方向（意図を先に置き、変更・セッション・根拠・ゲートを1つにまとめる）は**支持されている**。特に「diff は安くなり、why がセッションと共に消える」という問題意識は HN でも同意が多い。
- ただし **10 の既知の失敗モード**がある。 (1) 意図の重複・drift、(2) セッションのプライバシーと容量、(3) eval スコアの信頼性、(4) レビューノイズと承認疲れ、(5) bot スレッドが人間のスレッドを埋める、(6) GitHub との二重ゲート、(7) 移行で Issue/PR/CI/権限が来ない、(8) ベンチマークとマーケティングの過大さ、(9) 公開 repo・セルフホスト不可、(10) メトリクス/FB 添付の因果と Goodhart。
- hns の Trail v1 は、このうち **(1)(2)(3)(4)(5)(10) を設計で避ける**必要がある。特に「eval スコアを既定にしない」「セッション全文を既定で repo に入れない」「メトリクスはゲートにしない」の3つは方針として固定したい。

## 1. Entire / Trail への反応

### 1.1 支持されている点

- 「PR は author が diff を説明できる前提。agent の code は diff が安く、why は session が閉じると消える。session を commit に付けるのは合理的」（HN aboreddev）。
- 「session には何をしたかだけでなく、why・dead-end・試して出さなかったものが入る」（HN lizziepika）。
- intent-first / changes / findings / gates の構造は、PR のタイムラインより判断しやすいという分析（Stackness）。

### 1.2 批判（引用）

| 批判 | 出典 |
| --- | --- |
| 「why は ticket や requirements にある。spec が明確なら code は implementation detail。Trail は既にある意図を二重に持つだけ」 | HN gabrieledarrigo |
| 「画面録画を PR に付けるようなもの。review の負担が増える。**artifacts は少ないほどよい**」 | HN argee |
| 「Trail を見たい場面が想像できない。マーケティングが強すぎて読みづらい」 | HN stryan |
| 「価格が書いていない」（後に $100 credit / agents のみ課金と回答） | HN shepherdjerred |
| 「私の proprietary な agent 情報を預ける理由は？ 文脈はどこにでも置ける」 | HN 0gs |
| 「VC 企業が『rebellion』と言うのは不誠実。self-host は？」（回答: CLI は MIT、保存層は将来 OSS） | HN salt-licker |
| 「session を commit に付けても、review 中に誰も見ない。見るのは incident のとき」 | HN aboreddev |

### 1.3 中立的な分析（Stackness, 2026-10-29）

- **料金**: ホスティング・Trails・memory・CLI は無料。レビュー agent は model 実費（$100 credit、4,000 行の diff で 1 run 約 $0.41）。
- **89x push**: Entire 自身の benchmark で、外部が再現していない。GitHub 側は rate limit の影響が疑われ、数字も 26x → 6.4x と変動。
- **GitHub ミラー**: Trail は CI/merge のために GitHub PR を併用。**Entire のレビューと GitHub のレビューは別**で、GitHub の branch rule は Entire の gate 通過後も merge を止め得る。
- **移行**: Git データ以外（Issue、PR、release、permissions、replicas、Actions）は移らない。LFS と submodule は別対応。
- **公開 repo**: 未対応。self-hosting も不可。
- **プライバシー**: checkpoint は repo 内の refs。**repo の read 権限がある人は誰でも読める。public repo なら公開**。redaction は「安全網であって保証ではない」。

## 2. モデル固有の失敗モード

### 2.1 意図（intent）の重複と drift

- 意図は既に ticket / spec / 会話にあることが多い。Trail に description と acceptance を必須にすると、**二重管理**になる。
- spec-first の既知の失敗: spec が code から離れて腐る（spec drift）。Martin Fowler の SDD 分析でも「spec-first は多いが、spec-anchored / spec-as-source の維持戦略は曖昧」と指摘。GitHub spec-kit でも「Spec Drift」が議論されている（Discussion #4001）。
- 対策: intent は**薄く・任意**にし、既存の ticket / conversation を参照できるようにする。intent の改訂は履歴で残し、変更が intent から離れたら「stale」と表示する（強制しない）。

### 2.2 セッションのプライバシー・容量・可読性

- Entire の security docs: 「repo の read 権限がある人は checkpoint を読める。public なら公開」。redaction はパターン/エントロピー検知で、**すべての secret を捕まえない**。画像・base64 は redaction の対象外。
- 生の transcript には PII・顧客データ・credential が入り得る。repo に push すると、履歴から消すのが難しい。
- 容量: transcript は大きい。全 commit に付けると repo が肥大する。
- 可読性: review 中に transcript を読む人は少ない（HN）。
- 対策: **既定は参照 + 要約 + redaction 済みの短い記録**。全文は opt-in、別 store（R2）に置き、repo には入れない。secret scanning を通し、画像は externalize。保持期間と削除を決める。

### 2.3 eval スコアの信頼性

- LLM-as-judge の実測: 13 モデル中、最高でも human annotator より 12〜23% 劣る。35 の systematic misalignment（chat では長い説明を好む、など）。同じ case の反復評価で verdict が割れ、prompt の小さな変更で結果が揺れる（arXiv 2603.24586 / 2604.16790）。
- 同じ入力でも判定が揺れ（実務記事では 0.3〜0.5 のドリフト）、position / verbosity / self-preference bias を持つ。
- 「スコアが緑だから merge」は、**検証の外注**であり、根拠のない確信を作る。
- 対策: **スコアを既定で出さない**。deterministic な check（test / lint / type / schema）を先に。agent review は finding（file/line/根拠）として出し、severity と「なぜ重要か」を必須にする。点数は研究用に別扱い。

### 2.4 レビューノイズと承認疲れ

- AI レビューの最大の苦情は false positive。**noise は reviewer を再教育する**。9 件のうち 2 件が有用でも、残り 7 件の dismissal が次の comment への注意を下げる（Pyor）。
- 「AI reviewer を入れたら、人間の comment も読まれなくなった」。bot の comment を bulk resolve する習慣が、人間の comment にも移る（DEV, 2026-11）。
- GitHub の「conversation resolution 必須」は、bot の 20 スレッドと人間の 1 スレッドを同じ重さで数える。**ゲートがノイズを増幅する**。
- 対策: blocking だけ既定表示、deterministic を先、path / severity で絞る、bot の finding は会話スレッドにしない（annotation として出す）、dismissal rate を測る。

### 2.5 承認・ゲートの形骸化

- 単一ユーザーで「作者 ≠ 承認者」を必須にすると、自分で自分を承認する劇場になる。
- Gerrit の +2/+1 をそのまま持つと重すぎる。GitHub の個人 repo は保護なしが既定。
- bypass が常態化すると、ゲートは「理由を書く儀式」になる。Entire は bypass を Trail に記録する（良い）。
- 対策: 既定 Ask + リスク階層 + 証拠必須。承認者は owner 1 人。bypass は理由必須・監査・月次で見直し。

### 2.6 PR 置換のエコシステム問題

- Entire の Trail は、GitHub ミラーでは CI/merge に GitHub PR を併用する。**二重のレビュー状態**になり、GitHub の branch rule が後から止めることもある。
- 移行しても Issue / PR / release / permissions / Actions は来ない。**forge を替えると周辺が全部置き換わる**。
- 公開 repo が未対応、self-host 不可。
- 対策: hns は forge を置き換えない。git は transport、レビューは hns の UI、CI はマシン。外部 forge とは「commit を push するだけ」の関係に保つ。

### 2.7 マーケティングとベンチマーク

- 89x は自己 benchmark で未再現。数字が短期間で変わる。
- 「rebellion」「human developers no longer write most of the code」といった主張への反発。
- 対策: hns はベンチマークを主張しない。主張するなら条件と再現手順を出す。

### 2.8 その他の実務的な批判

- **self-preference**: 作者とレビュー agent が同じモデルだと、自分の出力を高く評価しやすい（LLM judge の既知の bias）。review agent は別モデル・別 prompt・deterministic check を混ぜる。
- **per-push のコスト**: レビュー agent は push ごとに model 実費がかかる（例: 4,000 行で約 $0.41/run）。agent が頻繁に push すると、レビュー費用が開発費用に近づく。
- **multi-repo の原子性**: 1つの Trail が複数 repo にまたがると、merge の順序・部分失敗・権限の整合が難しい。Entire も「changes を separately merge」としている。hns は当面 single-repo で、multi-repo は表示だけにする。
- **二重の台帳**: Issue tracker / Task / Trail のどれが正本かが曖昧になる。hns は Trail を正本にし、外部 tracker を持たない（相互運用しない）と決めているので、ここは有利。

## 3. hns の拡張（FB / metrics 添付）への批判

Entire には無い hns 独自の拡張なので、**ここは特に証拠が弱い**。既知の落とし穴:

### 3.1 因果と代理指標

- メトリクスは多くの要因で動く。Trail に紐づけると「この変更のおかげ」という**誤った因果**を生む。
- 代理指標の失敗例: 「summary viewed」が 94% スクロール通過だったのに、11 か月間「機能が使われている」と信じられた。**測定が主張になった**（Kuralok）。
- Goodhart / Campbell / surrogation: 指標が目標になると、指標自体が歪む。
- 対策: metric には **定義・窓・source・仮説**を必須にする。UI は「相関」と表示し、因果とは言わない。ゲートにしない（既定）。変更との対応は commit 時刻と窓で絞るが、断定しない。

### 3.2 遅延データと再開のチャーン

- リリース後の feedback / metric は遅れて来る。Trail を自動で reopen すると、通知と状態遷移が増える。
- 対策: 既定は**手動 reopen**。自動 reopen は閾値とクールダウンを設定した opt-in。observing の期間を明示し、期間終了で閉じる。

### 3.3 FB の質と偏り

- 声の大きいユーザー、サポートに来た人だけの feedback は biased。sentiment は事実ではない。
- 対策: channel と source を必須にし、原文（quote）を保持。sentiment はタグ。件数と分布を出し、単一の声を信号にしない。

### 3.4 プライバシーと保持

- feedback には PII・顧客名・契約情報が入り得る。
- 対策: project スコープ、保持期間、redaction、削除要求に備える。外部連携は anonymous id のみ。

### 3.5 データモデルの肥大

- 「何でも attach」は metadata dump になり、検証・UI・保持が破綻する。
- 対策: kind を閉じる（feedback / metric / eval / note）。型付きテーブル。1 Trail あたりの件数上限と rate limit。external_id で冪等。

## 4. hns Trail v1 への反映（設計変更）

| 批判 | v1 での扱い |
| --- | --- |
| intent の二重管理 | description / acceptance は任意。conversation / ticket を参照。改訂履歴を持つ。stale 表示（強制しない） |
| session のプライバシー | 既定は redaction 済み要約 + 参照。全文は opt-in で R2、repo に入れない。画像は externalize |
| eval スコア | 既定で出さない。deterministic check を先。agent は finding として file/line/根拠付き |
| ノイズ | blocking のみ既定表示。bot finding は会話スレッドにしない。dismissal rate を測る |
| 承認の形骸化 | owner 1 人の明示承認。四人眼を必須にしない。bypass は理由 + 監査 |
| PR 置換 | forge を置き換えない。git は transport。CI はマシン。外部 forge と二重ゲートを作らない |
| metrics の因果 | 定義・窓・source・仮説必須。相関として表示。ゲートにしない。手動 reopen |
| FB の偏り | channel / source / 原文を必須。sentiment はタグ。分布を見る |
| データ肥大 | kind を閉じる。型付きテーブル。件数上限・rate limit・冪等キー |
| ベンチマーク | 主張しない。条件と再現手順を出す |

## 5. 設計原則（追加）

1. **Artifacts は少なく、根拠は強く**。session 全文・スコア・メトリクスを既定で積まない。
2. **Deterministic first**。test / lint / type / schema で決まることを AI に聞かない。
3. **スコアより finding**。点数は説明できない。file / line / 根拠 / severity を持つ finding にする。
4. **相関と因果を分ける**。metric は observation。因果は実験（A/B、feature flag）でしか言わない。
5. **ゲートは注意力を守る**。blocking だけ出し、ノイズで承認を訓練しない。
6. ** forge を置き換えない**。git の互換性を保ち、外部ツールと共存する。

## 6. 未解決の問い

- session の全文をどこまで見せるか（review 時 / incident 時 / 監査時）。
- metric の因果をどこまで扱うか（相関のみか、実験と紐づけるか）。
- observing の期間と自動 reopen の閾値。
- feedback / metric の保持期間と削除要求。
- マルチユーザー時の承認者割当（RBAC をどこまで作るか）。

## 7. 参考

- Entire: Trails https://docs.entire.com/guides/trails/overview / Gates https://docs.entire.com/guides/trails/gates / Security https://docs.entire.com/security / Migration https://docs.entire.com/migration/migrate-from-github / 発表 https://entire.com/blog/the-git-forge-for-agent-human-collaboration
- HN: https://news.ycombinator.com/item?id=50247453 / Cursor Origin: https://news.ycombinator.com/item?id=49334209
- Stackness: https://stackness.dev/blog/entire-git-forge-trail-vs-pull-request-what-changes-and-what-stays
- LLM judge: https://arxiv.org/html/2603.24586v1 / https://arxiv.org/html/2604.16790 / https://startdebugging.net/2026/06/llm-as-judge-vs-rule-based-evals-for-a-coding-agent/
- Review noise: https://pyor.review/blog/ai-review-alert-fatigue / https://dev.to/asael_shinder_9f53bdca840/your-team-added-an-ai-reviewer-and-now-nobody-reads-the-human-comments-34le
- Spec drift: https://www.martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html / https://github.com/github/spec-kit/discussions/4001
- Metric proxy: https://kuralok.com/p/we-shipped-a-feature-nobody-used-for-eleven-months-because-the-metric-loved-it
- hns: [Trail モデル v1](trail-model-v1.md) / [Trail 採否とゲート](trail-and-gates-decision.md)
