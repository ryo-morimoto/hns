# 設計: UI と UX（Agentic Workspace）

UI を作る前に読む。レビュー時の確認は [../review/ux.md](../review/ux.md)。他の設計領域は [../design.md](../design.md)。
hns の画面は「AI と会話する場所」ではなく、**人間が仕事を委任し、進み具合を見て、成果物をレビューする場所**として設計する。
チャットとの違いは5点: 単位は1ターンではなく**1タスク**、時間は秒ではなく**分〜時間**、人間は**不在がち**、
失敗は答えではなく**行動**（戻せることが要る）、信頼は返答ではなく**実行の監査**から来る。
原則は 5 つの実例（[Linear AIG](https://linear.app/developers/aig) / [Cursor](https://cursor.com) / [Manus](https://manus.im) /
[Claude Cowork](https://claude.com/product/cowork) / [Replit Agent](https://replit.com)）から抽出した。

## 1. 仕事を主役にする

- **条件**: 画面を会話ログ中心に設計しようとしている。チャットをトップレベルに置こうとしている
- **命令**: 仕事（タスク・実行・成果物・承認）を単位にし、会話はその中の1ビューにする。一覧の先頭は「今の仕事」
- **補足**: hns: Conversation は進捗と成果物に紐づく。単独のチャット画面を中心にしない
- **Ref**: [Linear AIG](https://linear.app/developers/aig) / [Linear](https://linear.app) / [Claude Cowork](https://claude.com/product/cowork)

## 2. 委任しても責任の所在を残す

- **条件**: Agent に実行させるとき。承認を求めるとき
- **命令**: 誰が始めたか・誰が承認するか・誰の権限で動くかを表示し、記録に残す。委任は所有権の移転ではない
- **補足**: hns: Run と Task に起動者と承認者を持たせる。監査ログと同じ情報を画面にも出す
- **Ref**: [Linear AIG](https://linear.app/developers/aig) / [Linear](https://linear.app)

## 3. 今、人間の注意が必要なものを最初に見せる

- **条件**: ダッシュボード・一覧・ホームを作るとき
- **命令**: **Needs you（承認・判断待ち）→ Running → Completed** の順に出す。バッジの件数は、その一覧の実数と一致させる
- **補足**: 監視ダッシュボードにしない。「今、何を決めれば進むか」を最初に見せる。空のときは空と分かる文言を出す
- **Ref**: [Linear AIG](https://linear.app/developers/aig) / [Cursor Cloud Agents](https://cursor.com)

## 4. 透明性は、要求されたときだけ深く

- **条件**: 実行ログ・思考・ツール呼び出しを表示するとき
- **命令**: 既定は要約（何をしているか1行・進捗・残り時間の目安）。詳細は開いた人だけに出す
- **補足**: 全部を流すと注意が散る。**エラーと判断待ちは既定で出す**。隠すのは正常系の詳細だけ
- **Ref**: [Manus](https://manus.im) / [Cursor](https://cursor.com)

## 5. 完了後は、成果物と検証結果でレビューさせる

- **条件**: Agent の完了を表示するとき。確認を求めるとき
- **命令**: diff・テスト結果・変更ファイル・未解決事項を1つのレビュー面にまとめる。過程の再生を主役にしない
- **補足**: 「Review changes / Ask agent to revise」の2択を必ず出す。証拠が無い完了は完了と呼ばない
- **Ref**: [Cursor](https://cursor.com) / [Manus](https://manus.im)

## 6. 成果物を直接編集できる

- **条件**: 生成物（コード・文書・設定）を見せるとき
- **命令**: プロンプトを書き直させず、その場で編集・却下・部分採用の手段を置く。編集は次の実行の入力にする
- **補足**: hns: ファイル編集は Workspace の版チェックを通す。画面の編集を正本にしない
- **Ref**: [Replit Agent](https://replit.com) / [tldraw flash](https://flash.tldraw.com)

## 7. 非同期を既定にする

- **条件**: 実行に時間がかかるとき。複数の仕事を並行できるとき
- **命令**: 完了を待たずに別の仕事へ移れるようにする。戻ったときに状態と結果が分かるようにする。キャンセル・中断・再開を同じ場所に置く
- **補足**: 待たせる画面を作らない。進捗は一覧と詳細の両方から見える
- **Ref**: [Claude Cowork](https://claude.com/product/cowork) / [Linear](https://linear.app)

## 8. 操作は中断と逆行に耐える

- **条件**: アニメーション・画面遷移・ドラッグ・展開を設計するとき
- **命令**: 途中で逆方向へ操作しても破綻しないようにする。要素が移動・変形しても同じものだと分かる連続性を保つ
- **補足**: 演出は装飾ではなく状態遷移の一部。終了を待たせて操作をブロックしない
- **Ref**: [Rauno — Craft](https://rauno.me/craft) / [tldraw flash](https://flash.tldraw.com) / [Rive](https://rive.app)

## 9. 入力の精度と遅延を設計する

- **条件**: スライダー・ドラッグ・数値入力・微調整があるとき
- **命令**: 大きく動かすときと微調整で感度を変える。最初の入力に即座に反応し、結果は後から更新してよい
- **補足**: Loading を美しくするより、最初の反応を速くする方が効く。処理待ちを前提にしない
- **Ref**: [Rauno — Craft](https://rauno.me/craft) / [Krea Realtime](https://www.krea.ai)

## 10. 毎日の操作に演出をかけすぎない

- **条件**: 頻繁に使う操作（一覧移動・保存・送信・切替）を設計するとき
- **命令**: 頻度の高い操作は短くする。演出は初回・完了・異常に寄せる
- **補足**: 1日に100回使う操作へ毎回1秒の演出を入れない。頻度×時間で予算を決める。自律度は可逆性と影響範囲で決め、
  不可逆・広範囲ほど人に確認する
- **Ref**: [FigJam](https://www.figma.com/figjam/) / [Linear](https://linear.app)

## 11. キーボードと支援技術で同じことができる

- **条件**: 主要な操作を設計するとき
- **命令**: フォーカス順・ショートカット・ラベルを用意する。マウスでしかできない操作を作らない
- **補足**: 覚えやすいキー（例: コマンドパレット、E/S のような単鍵）と、フォーカスの可視化を両方
- **Ref**: [FigJam](https://www.figma.com/figjam/) / [Linear](https://linear.app)

## 12. 状態を全部設計する

- **条件**: 画面・部品を設計するとき
- **命令**: loading / empty / error / 権限なし / 保存中 / 競合 / undo を書く。楽観更新の戻し方も決める
- **補足**: 状態の抜けは実装後に見つかる。設計時に一覧にして、テストで固定する
- **Ref**: [Linear](https://linear.app) / [Observable](https://observablehq.com)

## 13. Agent であることを示し、プラットフォームの作法に従う

- **条件**: Agent の発言・操作・実行を表示するとき
- **命令**: 人間と誤認されない表示にする（名前・アイコン・「Agent」）。既存の操作と画面パターンを使い、専用画面を増やさない
- **補足**: hns: 実行主体（人間 / Agent / システム）をイベントと画面の両方に出す
- **Ref**: [Linear AIG](https://linear.app/developers/aig)

## 14. 即座に反応し、内部状態を隠さない

- **条件**: 依頼を受け取るとき。実行を始めるとき
- **命令**: 受領を即座に返す（邪魔にならない範囲）。状態（受付・計画・実行・承認待ち・完了・失敗）を常に表示する
- **補足**: 無反応は不安になる。出すのは詳細ログではなく、状態と次の行動
- **Ref**: [Linear AIG](https://linear.app/developers/aig)

## 15. 情報密度を設計する

- **条件**: 一覧・詳細・設定を設計するとき
- **命令**: 重要度で強弱を付け、補助を後退させる。同じ強さの文字と枠を並べない
- **補足**: 密度は高くてよい。優先順位が無いと読めない
- **Ref**: [Are.na](https://www.are.na) / [Linear](https://linear.app)

## 16. 人間がいつでも引き継げる・方向を変えられる

- **条件**: 計画段階・実行中に、人へ渡す・止める・指示を変える必要があるとき
- **命令**: Take Control（停止して人間が操作）、Interrupt & Redirect（中断して指示を変える）、Handoff（別の人へ渡す）を用意する
- **補足**: 委任は主導権の放棄ではない。いつでも戻れることが委任の前提
- **Ref**: [Cursor](https://cursor.com) / [Linear AIG](https://linear.app/developers/aig) / [Claude Cowork](https://claude.com/product/cowork)

## 委任タスクの6段階と16パターン

委任された仕事は **意図 → 計画 → 実行 → チェックポイント → 結果 → 監査** の6段階を通る。
多くの製品は意図と実行だけを作り、チェックポイント・結果・監査が弱い。hns はそこを最初から設計する。

| 段階 | パターン | 何をするか |
| --- | --- | --- |
| 意図 | 1. 目的の確認質問 | 1〜3個だけ、既定値つきで聞く。曖昧なときだけ |
| 意図 | 2. スコープのチップ | 触ってよい範囲（パス・環境）を入力の上に明示する |
| 計画 | 3. 編集できる計画 | 実行前に手順を見せ、その場で直せる |
| 計画 | 4. 工数・費用の見積り | 時間・トークン・費用の目安を出す |
| 計画 | 5. ドライラン | 変更を適用せずに結果を予測する |
| 実行 | 6. 実行台帳 | 何をしたかを1行ずつ積む。開けば詳細 |
| 実行 | 7. ツール呼び出しカード | 引数と結果を1枚に。失敗は既定で開く |
| 実行 | 8. 推論の開示 | 「N秒考えた」程度。詳細は要求時だけ |
| 実行 | 9. バックグラウンドと進捗面 | タブを閉じても進む。戻ると状態と結果がある |
| 確認 | 10. 段階的な権限ゲート | 危険度に比例して止まる。すべて同じ強さで止めない |
| 確認 | 11. まとめて承認 | 同種の承認を束ねる（1件ずつ聞かない） |
| 確認 | 12. 中断と方向修正 | 実行中に止めて指示を変えられる |
| 結果 | 13. 差分優先の要約 | 物語ではなく変更の footprint を先に |
| 結果 | 14. 確信度と未解決 | できたこと・怪しいこと・決めていないことを分ける |
| 監査 | 15. 操作履歴と Undo | 各操作が見つかり、戻せる |
| 監査 | 16. 人間への引き継ぎ | 担当者・承認者・次の人へ渡せる |

## その他の頻出パターン（最初に覚える12）

- 実行計画のチェックリスト（to-do が実行に合わせて進む）
- 折りたためるツール呼び出しの行
- 範囲を絞った承認（「はい、今後は聞かない」）
- 自律度のモード（計画だけ / 編集まで許可 / 自動）
- Agent のブラウザを人間が引き継ぐ
- Agent の受信箱（Needs input / Working / Completed）
- バックグラウンド/クラウドのセッションと PR 状態
- 生成 UI（会話の中のアプリ部品）
- ハンク単位の diff レビュー（Keep / Undo / Apply）
- チェックポイントとロールバック
- 「N秒考えた」の開示
- コマンドパレットの併用（⌘K で「移動」か「AI に聞く」）

## 入口と周辺のパターン（採否は画面ごと）

| パターン | hns の扱い |
| --- | --- |
| Sparkle（AI の入口） | 入力欄とコマンドで足りるなら専用ボタンを増やさない。置くなら文脈（選択範囲・ファイル）を持つ |
| プロンプト例・続きの提案 | 空のときだけ出す。常時出すと注意を奪う |
| @-mention と文脈チップ | 採用。何を文脈に入れたかを常に表示する |
| ツール・コネクタのメニュー | 採用。選べるツールは権限と一致させる |
| モデル選択・effort・Agent の階層 | 採用。費用と能力の差を表示し、既定は安全側 |
| 文脈長・費用のメーター | 採用。limits と接続し、上限に近づいたら知らせる |
| 音声モード | 今は対象外（後で要件になったら考える） |
| 引用と出典パネル | 調査・要約の実行で採用。主張と出典を対応させる |
| 深掘り調査のフィード | 実行台帳で代替できるなら専用画面を作らない |
| 状態を表す動詞と割り込みのヒント | 文言は短く。「止められる」ことを示す |
| Agent の computer pane・実行トレース・再生 | 実在感のために採用。既定は要約、開いたら詳細 |

## 避ける形（アンチパターン）

- 300行の会話ログを進捗として出す
- すべての操作に許可を求める（または一度も求めない）
- 計画を見せずに実行する
- 終わらないスピナー
- 取り消せない実行
- 正常系の詳細を既定で全部出す
- 人間と Agent の区別がつかない

参考: [Linear AIG](https://linear.app/developers/aig) / [AI Design Guide — 39 patterns](https://www.aidesign.guide/agentic-ux-patterns) /
[Setproduct — 16 patterns](https://www.setproduct.com/blog/ai-agent-ui-design-patterns)

## 13. タッチとスワイプは補助にする

- **条件**: モバイル・タブレット向けの操作（dismiss・drawer・一覧の行操作・タブ切替）を設計する
- **命令**: スワイプを主操作にしない。同じ操作をボタン/メニュー/キーボードでも用意する。縦スクロールや画面端の戻るジェスチャと競合させない。閾値・速度・キャンセルを決め、破壊的操作には Undo か確認を付ける
- **補足**: hns: モバイル/タブレット利用の増加を見込む。タップ領域は 44px を目安にし、hover 前提の操作を作らない
- **Ref**: [Apple HIG — Gestures](https://developer.apple.com/design/human-interface-guidelines/gestures) / [Material 3 — Gestures](https://m3.material.io/foundations/interaction/gestures) / [WCAG 2.5.1](https://www.w3.org/WAI/WCAG22/Understanding/pointer-gestures.html) / [WCAG 2.5.7](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)

## 14. フッターは composer を主にする（汎用の下部バーを作らない）

- **条件**: モバイル・タブレットの操作やフッターを設計するとき
- **命令**: フッターの主役は入力欄（composer）。汎用の下部ナビバーで頻繁操作を並べない。頻繁な操作（コンテキスト/タスク切替、Needs you、コマンド）は、composer と共存できる形（入力欄への併置・近接）で届かせる。共存の設計ができない間は、上部・drawer・キーボードに置く
- **補足**: hns: 2026-11-07 のユーザーレビューで shell の下部バーは「この操作感なら不要」と判断され、0102 から削除した。composer と頻繁操作を共存させる UI はアイデアが出るまで低優先度。スワイプは補助で、代替操作を必ず持つ（原則13・WCAG 2.5.1/2.5.7）
- **Ref**: [Material 3 — Navigation bar](https://m3.material.io/components/navigation-bar/overview)（下部バーの一般論。hns は採らない） / [Linear AIG](https://linear.app/developers/aig)

## 参考: Agentic Workspace の5例

| 例 | 取るもの | リンク |
| --- | --- | --- |
| Linear | 仕事・Activity・Inbox に Agent を統合。Delegation / Human Ownership / Agent Activity。組織に紐づくセッション | [AIG](https://linear.app/developers/aig) / [実装](https://linear.app/blog/how-we-built-linear-agent) |
| Cursor | Agent Sessions / Changes / Demo / Take Control。並行実行と証拠のレビュー | [cursor.com](https://cursor.com) |
| Manus | 実行の実在感（computer view・進捗・再生）。透明性の見せ方 | [manus.im](https://manus.im) |
| Claude Cowork | Task Delegation / Artifacts / Projects / Steering。目的から委任し、途中で方向修正 | [claude.com](https://claude.com/product/cowork) |
| Replit Agent | Design Canvas / Live Preview / Direct Manipulation。成果物をその場で編集 | [replit.com](https://replit.com) |

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