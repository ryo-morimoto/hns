# Golden Examples → UI generation flow

> **Intent is invariant.** 先に [INTENT.md](INTENT.md) を読む。
> このファイルのフローは **参考** であり、ゲートではない。手順と意図が衝突したら意図を取り、
> 逸脱を INTENT の「現在のドリフト」へ記録する。

参照を「雰囲気」ではなく、**状態・操作・情報設計の判断**に変換するための作業メモ。
対象は `work/poc/app/ui` の PoC で、製品 UI（0036）ではない。

## 0. 原則

- 画面をコピーしない。**判断**をコピーする。
- 1サーフェスにつき参照は3つまで。増やすとどれも効かなくなる。
- 先に **empty / loading / error / interrupt** を書く。正常系は最後。
- 参照元の見た目（色・ロゴ・レイアウト・イラスト）は持ち込まない。
- 実装したら、**マウス・キーボード・モバイル・長文/大量データ**で壊す。
- 「Canary flow」= 参照 → 研究ノート → 状態行列 → トークン → 薄い縦切り → 検証、の順で進める。
- **フローは参考。** 各ステップは意図に仕えるときだけ使う。飛ばしたら理由を書く。

## 1. 参照の分解

| 参照 | 借りた判断 | PoC のどこ | 借りなかったもの |
| --- | --- | --- | --- |
| Linear（AIG） | 仕事が主役。人間が所有者で、Agent は実行担当。コマンドメニュー、低コントラストのサイドバー、Undo で文脈ごと戻す | ワークスペース既定、`Running / Needs you / Completed`、`⌘K`、アーカイブ Undo | Issue の完全なモデル、チーム機能 |
| Cursor（Cloud Agents） | 複数セッションを並べ、**成果物と検証結果**で判断する。途中経過は深掘り時だけ | Completed カードの結果要約、run 詳細、editor の差分 | エージェント実行映像、クラウド VM |
| Manus | 見えない自律作業を「今なにをしているか」に変える。Live progress と replay | 進捗バー、`考え中 / ツール実行中 / 待ち`、ツール結果の折りたたみ | コンピューター画面の録画・再生 |
| Claude / Cowork | ゴールから始める委任。Artifacts と Steering | `仕事を頼む`（ゴール → 会話 → 実行）、会話中の追加指示 | ファイル成果物ギャラリー |
| Replit Agent 4 | 成果物を直接触る。会話に戻らず直す | 右パネルの editor、diff、競合の上書き | 無限キャンバス、ライブプレビュー |
| Rauno / Craft | 操作途中の1フレーム。Interruptibility、Spatial continuity、Input precision | 停止、下書き保持、パネルの連続的な開閉、press feedback | カスタムカーソル、Tooltip の変形芸 |
| Krea Realtime | 待たせない。最初の入力に即座に反応する | 送信前に composer を空にする、即時の進捗、楽観的なカード | 生成キャンバス |
| Vercel Dashboard | 状態をタブにも出す。ログは必要なときだけ | タブタイトルの `(N)` / `●`、status bar | Vercel の情報設計そのもの |
| Stripe Checkout | 入力の不安を減らす。エラーを先に防ぐ | ダイアログの focus、429 の待ち時間、競合の明示 | Checkout のフォーム |
| FigJam / Excalidraw / Milanote | 空間と道具の状態を明示。覚えやすいショートカット | サイドバーの選択状態、`H/N/J/K`、`⌘K` | キャンバス、描画 |
| Are.na / Cosmos | コンテンツが強いとき UI は下がる | 低コントラスト、余白、カードの情報密度 | 画像グリッド、キュレーション |
| Rive / Aceternity | Motion は状態遷移の一部。要素の連続性 | menu の pop、editor の slide、画面の fade | Gooey morph、3D |
| Observable | 入力と結果を近づける | editor と diff の同居、会話と進捗の同居 | Notebook |
| Stripe Press / Readymag | タイポグラフィと余白で優先順位を作る | 24px のワークスペース見出し、10–13px の本文階層 | 3D 商品演出、Editorial アニメーション |

## 2. Canary flow（次の画面を作るとき）

### Step 1: Job を1文で書く

「誰が、どの仕事を、どこで判断し、どこで手を動かすか」。
例: *運用者が、Agent に任せた仕事のうち判断が必要なものだけを開き、その場で入力し、成果物は右で直す。*

### Step 2: 参照を3つ選ぶ

- Workflow: Linear / Cursor / Cowork
- Interaction: Rauno / Krea / Rive
- State/Visual: Vercel / Stripe / Are.na

選んだ参照ごとに **借りる判断** と **借りない表面** を1行ずつ書く。

### Step 3: Interaction Research Note（意図に効く挙動だけ）

```
対象:
目的:
観察する挙動: （押下直後 / ドラッグ中 / 遷移中 / 中断時 / 連打時）
仮説:
失敗モード: （二重送信 / 下書き消失 / スクロール位置 / 戻れない / 待ちが見えない）
検証: （マウス / キーボード / モバイル / 長文 / 0件 / 100件）
```

### Step 4: 状態行列

| 状態 | 画面 | 次の行動 |
| --- | --- | --- |
| empty | 何もない | 仕事を頼む / 会話 |
| loading | skeleton | 待つ（レイアウトを動かさない） |
| running | 進捗 + 停止 | 別の仕事へ / 開く / 停止 |
| needs you | 入力待ち / 停止 / 中断 / 未完 | その場で返す / 状態変更 / 開く |
| completed | 結果要約 | 結果 / 開く / 差分 |
| error | 理由 + 再試行 | 再試行 |
| offline | 上部バナー + polling | 再試行 |
| conflict | 外部変更 | 再読込 / 上書き |

この表に無い状態を実装しない。表にある状態を画面に出さないなら、理由を書く。

### Step 5: トークンとコンポーネント

- 先にトークン: 背景・面・境界・本文・補助・accent・danger・warn・ok・hover・focus・motion。
- コンポーネントは **2箇所以上** で使うものだけ。
- 1画面に新しい概念を2つ以上入れない（例: 「Needs you」と「Ack」を同時に発明しない）。

### Step 6: 薄い縦切り

1つの操作を、UI → API → 状態 → 検証まで通す。
例: *waiting run を Needs you に出し、モーダルで入力を返し、Completed に移る*。
横に広げるのは、この縦切りが通ってから。

### Step 7: 検証と UX レビュー

**壊し方**

- マウスだけでなく `Tab` / `Enter` / `Esc` / `J K` で同じ操作。
- 390px でサイドバー、scrim、editor、composer。
- 長いタイトル、100件の会話、0件、空のファイル、巨大ファイル。
- 送信中に会話切替、下書き、戻る、リロード、二重 Enter。
- オフライン、429、409、aborted。

**UX レビュー（7項目）**

1. Interruptibility — 実行中に別操作をしても破綻しないか
2. Spatial continuity — 開閉・遷移で同じものだと分かるか
3. Input precision — 誤クリック・微調整・連打に耐えるか
4. Perceived latency — 完了を待たずに反応するか
5. Interaction frequency — 毎日使う操作に長い演出を入れていないか
6. Information density — 主役と補助が視覚的に分かれているか
7. Keyboard parity — マウスの主要操作がキーボードでもできるか

## 3. PoC の現在地

| サーフェス | 状態 | 実装 |
| --- | --- | --- |
| ワークスペース | empty / loading / needs / running / completed / error / offline | `#/p/<project>`、3指標、full-width の判断/実行、2カラムの完了 |
| 会話 | streaming / waiting / aborted / incomplete / error | 進捗の人間語、停止、下書き、中断の表示 |
| Run | waiting / running / completed / failed | Needs you の入力、結果モーダル、ノード一覧 |
| Editor | clean / dirty / conflict / read error | 右パネル、保存、再読込、差分、上書き、破棄確認 |
| Ack | Needs you の会話 | 「確認済み」でキューから外す（local、updated_at に紐づく） |
| Global | palette / menu / toast / theme / mobile | `⌘K`、フォーカス、ダーク、390px、scrim |

### キーボード

| キー | 動作 |
| --- | --- |
| `⌘K` / `Ctrl+K` | コマンドパレット |
| `H` | ワークスペース |
| `N` | 新しい会話 |
| `J` / `K` | ワークスペースの仕事カードを移動 |
| `Enter` | カードの主要アクション |
| `/` | 会話検索 |
| `Enter` / `Shift+Enter` | 送信 / 改行 |
| `⌘E` / `⌘S` | エディタ / 保存 |
| `?` | ショートカット |

## 4. レビュー結果（この PoC）

- **Interruptibility 4/5** — 停止、下書き、二重送信の防止。実行中の会話切替はまだ状態がグローバル。
- **Spatial continuity 4/5** — パネルと画面の遷移。Run 詳細はモーダルで、URL を戻る対象にしていない。
- **Input precision 3/5** — ボタンは十分。ドラッグ/リサイズは無い。
- **Perceived latency 4/5** — 送信前クリア、進捗、skeleton。長いストリームの実測は未。
- **Interaction frequency 4/5** — 150ms。頻繁操作に演出を足していない。
- **Information density 4/5** — 判断/実行を full-width、完了を2カラム。完了が下に落ちるのは意図。
- **Keyboard parity 4/5** — `H/N/J/K/Enter/⌘K/⌘E/⌘S/?` は可能。会話一覧の矢印移動は未。

## 5. 次に Golden から借りるもの

1. **Cursor の Review** — 完了カードから差分・テスト結果・プレビューへ。いまは会話/結果モーダルまで。
2. **Linear の Undo 文脈復元** — アーカイブだけでなく、一括操作の選択状態まで戻す。
3. **Manus の Replay** — 実行ログを後から読む面。いまは transcript とノード一覧が別。
4. **Rauno の Input precision** — エディタのリサイズ、差分の行選択、コマンドのあいまい検索。
5. **Vercel のタブ状態** — 実行中 `(N)` は入れた。失敗/判断待ちの区別は未。
6. **Ack の永続化** — いまは localStorage。会話の updated_at が変われば再表示される。

## 6. 借りないもの

- 3D / WebGL / カスタムカーソル / 無限キャンバス（このプロダクトの主画面ではない）。
- Dribbble 的な装飾、グラデーション、過剰なモーション。
- 参照元のブランド色・ロゴ・レイアウト。
- 「Agent が賢そうに見える」だけの演出。
