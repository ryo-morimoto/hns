# 設計: UI と UX（Agentic Workspace）

UI を作る前に読む。レビュー時の確認は [../review/ux.md](../review/ux.md)。他の設計領域は [../design.md](../design.md)。
hns の画面は「AI と会話する場所」ではなく、**人間が仕事を委任し、進み具合を見て、成果物をレビューする場所**として設計する。
原則は 5 つの実例（[Linear AIG](https://linear.app/developers/aig) / [Cursor](https://cursor.com) / [Manus](https://manus.im) /
[Claude Cowork](https://claude.com/product/cowork) / [Replit Agent](https://replit.com)）から抽出した。

## 1. 仕事を主役にする

- **条件**: 画面を会話ログ中心に設計しようとしている。チャットをトップレベルに置こうとしている
- **命令**: 仕事（タスク・実行・成果物・承認）を単位にし、会話はその中の1ビューにする。一覧の先頭は「今の仕事」
- **補足**: hns: Conversation は進捗と成果物に紐づく。単独のチャット画面を中心にしない
- **Ref**: [Linear AIG](https://linear.app/developers/aig) / [Linear](https://linear.app) / [Claude Cowork](https://claude.com/product/cowork)

## 2. 委任しても責任の所在を残す

- **条件**: Agent に実行させる。承認を求める
- **命令**: 誰が始めたか・誰が承認するか・誰の権限で動くかを表示し、記録に残す。委任は所有権の移転ではない
- **補足**: hns: Run と Task に起動者と承認者を持たせる。監査ログと同じ情報を画面にも出す
- **Ref**: [Linear AIG](https://linear.app/developers/aig) / [Linear](https://linear.app)

## 3. 今、人間の注意が必要なものを最初に見せる

- **条件**: ダッシュボード・一覧・ホームを作る
- **命令**: **Needs you（承認・判断待ち）→ Running → Completed** の順に出す。バッジの件数は、その一覧の実数と一致させる
- **補足**: 監視ダッシュボードにしない。「今、何を決めれば進むか」を最初に見せる。空のときは空と分かる文言を出す
- **Ref**: [Linear AIG](https://linear.app/developers/aig) / [Cursor Cloud Agents](https://cursor.com)

## 4. 透明性は、要求されたときだけ深く

- **条件**: 実行ログ・思考・ツール呼び出しを表示する
- **命令**: 既定は要約（何をしているか1行・進捗・残り時間の目安）。詳細は開いた人だけに出す
- **補足**: 全部を流すと注意が散る。**エラーと判断待ちは既定で出す**。隠すのは正常系の詳細だけ
- **Ref**: [Manus](https://manus.im) / [Cursor](https://cursor.com)

## 5. 完了後は、成果物と検証結果でレビューさせる

- **条件**: Agent の完了を表示する。確認を求める
- **命令**: diff・テスト結果・変更ファイル・未解決事項を1つのレビュー面にまとめる。過程の再生を主役にしない
- **補足**: 「Review changes / Ask agent to revise」の2択を必ず出す。証拠が無い完了は完了と呼ばない
- **Ref**: [Cursor](https://cursor.com) / [Manus](https://manus.im)

## 6. 成果物を直接編集できる

- **条件**: 生成物（コード・文書・設定）を見せる
- **命令**: プロンプトを書き直させず、その場で編集・却下・部分採用できる。編集は次の実行の入力になる
- **補足**: hns: ファイル編集は Workspace の版チェックを通す。画面の編集を正本にしない
- **Ref**: [Replit Agent](https://replit.com) / [tldraw flash](https://flash.tldraw.com)

## 7. 非同期を既定にする

- **条件**: 実行に時間がかかる。複数の仕事を並行できる
- **命令**: 完了を待たずに別の仕事へ移れる。戻ったときに状態と結果が分かる。キャンセル・中断・再開を同じ場所に置く
- **補足**: 待たせる画面を作らない。進捗は一覧と詳細の両方から見える
- **Ref**: [Claude Cowork](https://claude.com/product/cowork) / [Linear](https://linear.app)

## 8. 操作は中断と逆行に耐える

- **条件**: アニメーション・画面遷移・ドラッグ・展開
- **命令**: 途中で逆方向へ操作しても破綻しない。要素が移動・変形しても同じものだと分かる連続性を保つ
- **補足**: 演出は装飾ではなく状態遷移の一部。終了を待たせて操作をブロックしない
- **Ref**: [Rauno — Craft](https://rauno.me/craft) / [tldraw flash](https://flash.tldraw.com) / [Rive](https://rive.app)

## 9. 入力の精度と遅延を設計する

- **条件**: スライダー・ドラッグ・数値入力・微調整がある
- **命令**: 大きく動かすときと微調整で感度を変える。最初の入力に即座に反応し、結果は後から更新してよい
- **補足**: Loading を美しくするより、最初の反応を速くする方が効く。処理待ちを前提にしない
- **Ref**: [Rauno — Craft](https://rauno.me/craft) / [Krea Realtime](https://www.krea.ai)

## 10. 毎日の操作に演出をかけすぎない

- **条件**: 頻繁に使う操作（一覧移動・保存・送信・切替）
- **命令**: 頻度の高い操作は短くする。演出は初回・完了・異常に寄せる
- **補足**: 1日に100回使う操作へ毎回1秒の演出を入れない。頻度×時間で予算を決める
- **Ref**: [FigJam](https://www.figma.com/figjam/) / [Linear](https://linear.app)

## 11. キーボードと支援技術で同じことができる

- **条件**: 主要な操作を設計する
- **命令**: フォーカス順・ショートカット・ラベルを用意する。マウスでしかできない操作を作らない
- **補足**: 覚えやすいキー（例: コマンドパレット、E/S のような単鍵）と、フォーカスの可視化を両方
- **Ref**: [FigJam](https://www.figma.com/figjam/) / [Linear](https://linear.app)

## 12. 状態を全部設計する

- **条件**: 画面・部品を設計する
- **命令**: loading / empty / error / 権限なし / 保存中 / 競合 / undo を書く。楽観更新の戻し方も決める
- **補足**: 状態の抜けは実装後に見つかる。設計時に一覧にして、テストで固定する
- **Ref**: [Linear](https://linear.app) / [Observable](https://observablehq.com)

## 参考: Agentic Workspace の5例

| 例 | 取るもの | リンク |
| --- | --- | --- |
| Linear | 仕事・Activity・Inbox に Agent を統合。委任と所有権の分離。組織に紐づくセッション | [AIG](https://linear.app/developers/aig) / [実装](https://linear.app/blog/how-we-built-linear-agent) |
| Cursor | 複数 Agent の並行実行、diff・テスト・操作の証拠をレビュー面に集約 | [cursor.com](https://cursor.com) |
| Manus | 実行の実在感（computer view・進捗・再生）。透明性の見せ方 | [manus.im](https://manus.im) |
| Claude Cowork | 目的から委任し、途中で方向修正できる。会話と仕事の境界を薄く | [claude.com](https://claude.com/product/cowork) |
| Replit Agent | 成果物を中心に、その場で直接編集する | [replit.com](https://replit.com) |

## 参考: Web UI の15例（テーマ別に2つずつ見る）

| テーマ | 見る組 |
| --- | --- |
| Hover・Tooltip・Button の質感 | [Rauno — Craft](https://rauno.me/craft) + [Aceternity Labs](https://ui.aceternity.com) |
| Drag・Selection・Canvas | [tldraw flash](https://flash.tldraw.com) + [Excalidraw](https://excalidraw.com) |
| Motion と状態遷移 | [Rive](https://rive.app) + [Spline](https://spline.design) |
| 非同期とリアルタイム | [Krea](https://www.krea.ai) + [Observable](https://observablehq.com) |
| 情報の密度と階層 | [Are.na](https://www.are.na) + [Cosmos](https://www.cosmos.so) |
| ブランドと操作性 | [Stripe Press](https://press.stripe.com) + [Readymag](https://readymag.com) |
| 共同作業の快適さ | [FigJam](https://www.figma.com/figjam/) + [Milanote](https://milanote.com) |
| 3D と段階的な設定 | [Qudrix](https://qudrix.com) |

見た目が似ていても、対象・頻度・情報量・権限が違えばそのまま使えない。「どの問題を、どう解いているから参考か」を一文で残す。
