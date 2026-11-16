# 耐久の契約

2026-11-11 / D047・D048 / 契約: [0141](../work/issues/0141-durability-contract.md) / 実装: [0153](../work/issues/0153-r2-object-store.md)〜[0169](../work/issues/0169-journal-truncation.md)

Cloudflare 経路（0157 以降）では、`(C, J)` を正本とし、ack 済みの保存はプロセス crash / 電源断 / マシン喪失に耐える。agent の shell 変更は Run の終わりまで durable でない。
この文書は、何が正本か、どの故障まで耐えるか、どう戻すかを決める。実装は 0153〜0169 に分ける。

## 1. 正本の定義

あるワークスペースの正本は **`(C, J)`**。

- **C**: 最後の checkpoint commit（`refs/hns/checkpoints/<runId>`）。内容は R2。
- **J**: C の後に確定した Journal の並び。内容は Workspace DO（256KB 超の本文は R2、hash は DO）。
- **U**: どこにも確定していない変更。**durable ではない。**

作業ツリーは `C ⊕ J ⊕ U` の写像にすぎない。ツリーを失っても `(C, J)` から作り直せる。逆に U は戻らない。

「あるファイルの現在の版」= J を新しい順に見て、無ければ C のツリー。
「checkpoint」= U を C' に畳み、J を C' に吸収して J を切り詰める操作。

この定義から、次の3つが導かれる。

1. J の長さは checkpoint 間隔で決まる（ここが RPO の実体）
2. 復元は決定的（C を展開 → J を seq 順に再生）
3. J を切り詰めないと DO が無限に育つ（容量ではなく、復帰時間と課金に効く）

### 故障クラス

対象は Cloudflare 経路（0145 以降。ack は 0157 以降）。v0.1 のローカル経路は対象外で、ack 済みでも電源断で失われ得る（[workspace.md](workspace.md)）。

| 故障                                       | ack 済みの保存           | agent の shell / git 変更     | 会話・Journal | 戻し方                            |
| ------------------------------------------ | ------------------------ | ----------------------------- | ------------- | --------------------------------- |
| マシン上のプロセス crash（マシンは生存）   | 戻る                     | durable でない（次の checkpoint が拾うかは保証しない） | 戻る          | 同じマシンで再開。restore しない（U は保証しない） |
| 電源断（マシン）                           | 戻る（ack は DO の確定後） | 最後の checkpoint 以降は失われる | 戻る          | C + J から restore                |
| マシン喪失                                 | 戻る                     | 最後の checkpoint 以降は失われる | 戻る          | 新しいマシンへ C + J から restore |
| アカウント事故（停止・削除・侵害）         | 保証しない               | 保証しない                    | 保証しない    | [0164](../work/issues/0164-backup-restore-ops.md) の backup / export だけ |

Cloudflare 側の DO / R2 の故障は provider の耐久性に委ねる。この表はマシンと境界の故障を扱う。
電源断ではディレクトリの fsync をしないため、rename 自体が残らないことがある（プロセス crash はツリーが残る）。

### RPO

RPO 0 は hns が管理する故障クラス（プロセス / 電源 / マシン）に対する目標で、アカウント事故は含まない。

| 対象                       | 目標                     | 達成の条件                                                                 | 検証                                  |
| -------------------------- | ------------------------ | -------------------------------------------------------------------------- | ------------------------------------- |
| ack 済みのエディタ保存 / ツール書き込み | 0                        | ack は Workspace DO の outcome と同一トランザクション。>256KB は R2 → DO → ack | [0157](../work/issues/0157-versioned-write-remote.md) / [0167](../work/issues/0167-remote-fault-injection.md) |
| agent の shell / git 変更  | 1 Run（Run の終了まで）  | Run 終了時の checkpoint。中断・lease 解放・正常終了も同じ                   | [0154](../work/issues/0154-checkpoint-commit.md) / [0155](../work/issues/0155-restore.md) / [0167](../work/issues/0167-remote-fault-injection.md) |
| 未 ack のブラウザ編集      | 保証しない               | —                                                                          | —                                     |

## 2. データクラス

| データ                                   | 正本                      | 派生・キャッシュ        | 失ってよいか       |
| ---------------------------------------- | ------------------------- | ----------------------- | ------------------ |
| Run（実行中）                            | Session DO（PiHarness）   | D1 の索引（会話と run） | 失っては困る       |
| 版 / 認可 / lease                        | Workspace DO              | —                       | 失っては困る       |
| ワークスペースの内容                     | `(C, J)`                  | マシンの作業ツリー      | ツリーは失ってよい |
| Journal（intent / outcome / audit）      | Workspace DO（256KB 超の本文は R2、hash は DO） | —                       | checkpoint まで    |
| イベント（Progress / 観測）              | Session DO                | —                       | 保持期間の後       |
| 会話（transcript / inbox）               | Session DO（PiHarness）   | D1 の索引               | 失っては困る       |
| 一覧・検索                               | —                         | **D1**                  | 再構築できる       |
| Project / Task / Workflow 定義 / Machine | **D1**                    | —                       | 失っては困る       |
| 未保存の編集                             | ブラウザ                  | —                       | 失ってよい         |
| `.git` の ref                            | R2（commit として）       | マシン                  | ツリーから再生成   |

手元にしか無い正本は無い。例外は U だけで、U は正本ではない。

**制御データ（定義・台帳）は D1、実行中の状態と会話は DO。** D1 に実行中の状態を書かず、DO に定義や台帳を置かない。
一覧のために D1 に置くのは「会話と run の索引」だけ（D049・D053）。イベントは DO に置き、D1 には複製しない。

### DO の分け方

- **Session DO**（PiHarness）: pi-durable の Harness、transcript、inbox、run。1 ワークスペースに 1 つで、複数の会話を持つ（D049）。
- **Workspace DO**: Journal、版、lease、認可の判断。1 ワークスペースに 1 つ。
- 分ける理由: 寿命と粒度が違う。会話を消しても版は残る。同じファイルを2つの会話から触っても、版の直列化点が1つになる。
  会話ごとに DO を作らない（pi-durable の Session が複数会話を持つため、作る必要が無い）。
- 費用は DO→DO のホップ1つ（推定 ~1ms。未計測）。

## 3. 書き込みの3経路

### 3.1 エディタ保存（RPO 0）

```text
browser → Worker → Workspace DO: intent（operationId, path, expectedVersion, contentHash, 本文 or 参照）
                 → machine: 親を dirfd で解決 → 再ハッシュ → 同一ディレクトリに temp → rename
                 → Workspace DO: outcome + 新しい版 → ack
```

ack は Workspace DO の outcome と同じトランザクション。R2 を使うのは本文が 256KB を超える場合だけで、そのときだけ R2 → DO の順にする。

本文の置き場所はサイズで決める。

| サイズ  | 本文             | 理由                                                            |
| ------- | ---------------- | --------------------------------------------------------------- |
| ≤ 256KB | DO の行          | ack が 1 トランザクションで閉じる。費用は行課金だけで無視できる |
| > 256KB | R2（hash は DO） | DO のメモリ上限 128MB と、復帰時のロードを避ける                |

大きい場合だけ **R2 → DO outcome → ack** の順にする。逆にすると、ack したのに R2 に無い状態が作れる。

死んだ窓は3つ。どれも照合で閉じる。

| 死んだ場所           | 残るもの                    | 再送時                                                 |
| -------------------- | --------------------------- | ------------------------------------------------------ |
| intent の後、送信前  | intent                      | 再送。機械のハッシュが intent と違えば適用             |
| 適用後、outcome 前   | intent + 適用済みのファイル | ハッシュ == contentHash なら applied、違えば `unknown` |
| outcome の後、応答前 | 確定                        | 同じ operationId なら同じ結果                          |

`unknown` を applied にも conflict にも丸めない。

### 3.2 ツール呼び出し

同じ経路。違うのは `expectedVersion` の出どころだけ（直前の read の版）。

### 3.3 agent の shell

経路が無い。**Run の終わりの checkpoint で初めて確定する。** U の寿命 = Run の長さ。

Run の途中でプロセスが死ぬと、その Run の未確定変更は durable でない（同じマシンに残ったツリーを次の checkpoint が拾い得るが、保証しない）。これは受け入れた RPO の帰結であり、
cover するには checkpoint の契機を増やすしかない（しない、と決めた）。

例外として、次は「Run の終わり」と同じ扱いにする。

- Run の中断・キャンセル（後始末として checkpoint を打つ）
- lease の解放（別マシンに渡す前に U を畳む。畳まないと渡せない）
- プロセスの正常終了（SIGTERM を拾える範囲）

定期的な checkpoint はしない。

プロセスの crash はこの「中断」に含まれない。後始末の checkpoint を打つプロセスが死んでいるため、U は durable でない。同じマシンに作業ツリーが残っていれば次の Run の checkpoint が拾い得るが、保証はしない（§1 の process crash 行）。

### 3.4 lease と fencing（版チェックの委譲）

書き込みの権利は、Workspace DO が発行する lease で 1 台のマシンに閉じる（[0142](../work/issues/0142-lease-fencing.md)）。

- lease の型は core の `WorkspaceLease`（`workspaceId` / `machineId` / `epoch` / `expiresAt`）。
- 取得・更新・解放は Workspace DO。`epoch` は発行のたびに増え、1 ワークスペースで有効な lease は 1 本だけ。
- 保持中は、書き込みのたびに DO へ問い合わせない。ローカルの版チェック（dirfd + hash、ヘルパーが無ければ `checks`）をそのまま使う。lease は版チェックを外すのではなく、置き場所をマシンに移す。
- 期限切れ・未取得では書かない。マシンは DO に届かないとき、自分の lease がまだ有効か確かめられないので fail closed にする。拒否は閉じた語彙（`LEASE_REFUSALS`）で返す。
- 別マシンからの書き込みは `epoch` で拒否する。古い epoch の intent は適用せず、`unknown` として照合する（INV-04）。
- 読み取りは lease を要さない。
- 同じ workspace を2台から同時に編集することは要件2（複数マシンで Agent を動かす）に含まない。1 台に閉じる。

## 4. 読みの経路

- ファイル: **マシンから読む**。R2 は読みの経路に入れない（U が見えない）
- 会話: Session DO（PiHarness）
- 一覧・検索: D1（遅れる）。開いている会話だけ DO
- オフライン: 書けない・読めない。古い内容を出すより「繋がっていない」と言う

## 5. checkpoint と J の切り詰め

Run の終わりに:

1. 作業ツリーを commit にし、`refs/hns/checkpoints/<runId>` を進める（`.gitignore` は含めない）
2. その commit が参照する object を R2 に送る（pack 1個）
3. Workspace DO に「seq ≤ N は C' に含まれる」という watermark を書く
4. watermark 以前の intent / outcome / 本文を消す。audit とイベントは残す

checkpoint 自体の保持（何個残し、いつ捨てるか）は [0168](../work/issues/0168-retention-gc.md)。

これをやらないと DO が育つ。行の削除にも課金があるが、`$1/100万行` のオーダーで、放置のコストより安い。

## 6. restore

1. C を R2 から展開（object を引く）
2. J を seq 順に再生（256KB 超の本文は R2 から引く）
3. 未確定の intent は `unknown` として照合（INV-04）
4. 復元先の root 同一性を `.hns/root.json` で確認（INV-02 の類推）

**戻らないもの**: U（最後の checkpoint 以降の agent の shell 変更）、未送信のブラウザ編集。
**戻るもの**: ack 済みの保存（byte 一致）、Run 終了時点までのツリー、会話、Journal の確定分。

## 7. 費用の見方

単一ユーザーの規模では、**DO と R2 のどちらでも無料枠に収まる**。差が出るのは行数と書き込み回数で、容量ではない。

| 前提: 月 1万保存・平均 8KB | DO に本文                           | R2 に本文           |
| -------------------------- | ----------------------------------- | ------------------- |
| 行書き込み                 | 5 行/保存 = 5万行（無料枠 5,000万） | 4 行/保存           |
| Class A                    | 0                                   | 1万（無料枠 100万） |
| 保存容量                   | checkpoint まで（数 MB）            | 80MB/月 → $0.0012   |
| 追加の往復                 | なし                                | 1 RTT               |
| 月額                       | $0                                  | $0                  |

小さいファイルでは **DO のほうが安い**（行課金は Class A より単価が低く、往復も無い）。
R2 を使う理由は金額ではなく、**128MB のメモリ上限と復帰時間**。

本当に効く費用の罠は別にある。

1. token 単位の commit（行数が 100〜500 倍）
2. J を切り詰めない（容量が単調増加）
3. イベントごとに D1 を同期更新する（もう1つの行課金）
4. 小さな DO を大量に作る（リクエストが増える）

## 8. セキュリティ・観測・運用

- 正本への経路は Worker / DO / machine の署名付き経路だけ。R2 と DO を公開しない。root の同一性は `.hns/root.json` で確認する（INV-02 の類推）。
- Journal に秘密を入れない。本文の暗号化は provider に委ね、鍵は [0143](../work/issues/0143-secret-placement.md) に従う。
- 観測: `workspaceId` / `runId` / `operationId` / `seq` / watermark を相関 ID に載せる。ack の p95、Journal の行数、checkpoint の成否、restore 演習の結果を記録する（[0162](../work/issues/0162-observability-hops.md) / [0163](../work/issues/0163-cost-and-limits.md)）。
- ack の p95 が 150ms を超える、Journal が単調に増える、checkpoint が失敗する、のいずれかで §10 の撤退条件を検討する。

## 9. 不変条件

| ID     | 条件                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------- |
| INV-03 | 版付き書き込みは古い内容を黙って上書きしない。比較は Workspace DO の直列化とマシンの再ハッシュの二段    |
| INV-04 | 再送は既存結果を返すか照合する。**intent が先、outcome が後**                                           |
| INV-05 | checkpoint と外部 Mutation は別トランザクション。**U は Run 境界で commit 化されるまで durable でない** |
| INV-06 | Progress は永続化済みの事実（J とイベント）から復元できる                                               |
| INV-09 | 正本は `(C, J)`。ツリーは写像であり、失ってよい                                                         |
| INV-10 | ack は単一システムで閉じる（DO の 1 トランザクション、または R2 → DO の順）                             |
| INV-13 | 書き込みの権利は lease で 1 台に閉じる。未取得・期限切れ・古い epoch は fail closed                      |

## 10. 撤退条件

p95 が 150ms を超える / DO のメモリ上限に当たる / 月 $50 を超える / Journal が単調に増える / checkpoint が失敗する、のいずれかで ExecutionEnv と Storage の境界でローカルに戻す
（[0166](../work/issues/0166-migration-rollback.md)）。このとき `(C, J)` の定義と restore の手順はそのまま使える。

## 11. 互換性・移行・ロールバック

- ローカル実装の `Workspace` API と `MutationResult` は変えない。変わるのは ack の意味で、[0157](../work/issues/0157-versioned-write-remote.md) が DO 経由にする。
- 保存形式の変更はない。core への追加は型と語彙だけで、既存の呼び出しに影響しない。
- DO を経由しない書き込み経路は 0157 で閉じる。混在時の拒否は lease / epoch（[0142](../work/issues/0142-lease-fencing.md)）で行う。
- 戻すときは ExecutionEnv と Storage の境界でローカルに戻す（0166）。`(C, J)` の定義と restore の手順はそのまま使える。

## 12. 未確定

- U-26: アカウント事故からの復旧経路 / [0164](../work/issues/0164-backup-restore-ops.md) の backup・export / 影響: 契約は「保証しない」で固定 / 責任者: user / トリガー: 0164。
- U-27: checkpoint の保持数と R2 の GC / [0168](../work/issues/0168-retention-gc.md) / 影響: RPO ではなく費用と復帰時間 / 責任者: user / トリガー: 0168。

## 13. やらないこと

- R2 / checkpoint / restore / Journal の実装（[0153](../work/issues/0153-r2-object-store.md)〜[0169](../work/issues/0169-journal-truncation.md)）。
- 定期的な checkpoint（U-25 でしないと決定）。
- アカウント事故からの自動復旧、別リージョンへの自動フェイルオーバー、exactly-once。
- provider の鍵（[0143](../work/issues/0143-secret-placement.md)）。
