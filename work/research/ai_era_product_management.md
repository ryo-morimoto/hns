# AI時代のプロダクトマネジメント

## 生産が速くなった組織で、レビューを減らし、強みと完了を取り戻す

調査・作成日：2026年11月16日
対象：AIで開発・制作が速くなったプロダクト組織のPdM、EM、デザイン責任者、事業責任者

> **提案する方針：生成を増やす前に、判断を共有し、検証を自動化し、完了を証拠で定義する。効率化で浮いた時間は、成果物を増やすのではなく強み（Moat）へ再投資する。**
>
> レビューの量は、共有されていない判断の量に比例する。レビューが仕事の中心になっているなら、問題はレビューの速度ではなく、上流で決めきれていないことと、下流で確かめる手段がないことにある。

## このレポートの読み方

第1章で課題を数字で確認し、第2章で役割の変化、第3章で「強み」、第4章で「レビュー」、第5章で「完了」を扱う。第6章に90日プラン、第9章にそのまま使える問いとチェックリストを置いた。時間がない場合は、第1章の表、第3章の「プロダクト・テーゼ」、第5章の「Done ladder」だけを読めば実務に移せる。

**前提。** 対象は、AIコーディングエージェントや生成AIを日常的に使うプロダクト組織である。規制産業、受託開発、監査や品質保証が重い組織では、レビューの層と証拠の重さを調整する必要がある。ステージや業種によって最適解は変わる。

**出典の読み分け。** 本文の[Sxx]は末尾の一次資料に対応する。ベンダー調査（Qodo、Faros、Augment、CodeRabbit等）は自社製品に有利な設計になり得るため、方向性の参考にとどめ、数値は自チームで再計測する。DORAやSO調査は自己申告を含む。事例企業（Cursor、Linear、Anthropic等）は勝者の公開情報であり、生存者バイアスを持つ。本レポートの処方箋は、資料の組み合わせから導いた提案であり、因果効果の証明ではない。

---

## 1. 課題の正体：3つの非対称

### 1.1 数字で見る「レビュー詰まり」

| 観測 | 数値 | 出典 |
| --- | --- | --- |
| AI利用率（ソフトウェア開発） | 90%（前年比+14pt）、中央値で1日2時間 | [S01][S02] |
| 生産性が向上したと答えた割合 | 80%超 | [S02] |
| AI出力を「少し／まったく信頼しない」 | 30%（「大いに／かなり信頼」は24%） | [S02] |
| AIの正確性を信頼する開発者 | 29%（前年40%から低下） | [S11] |
| 「ほぼ正しいが微妙に違う」が最大の不満 | 45%、66%が修正に時間増 | [S11] |
| 最大の制約が「レビューと検証」 | 開発者25.8%、リーダー26% | [S09] |
| AI関連の本番インシデント経験 | 89% | [S09] |
| 既存プロセスで品質を保てるとするリーダー | 3.7% | [S09] |
| AI高活用チームのマージPR数 | +98%（タスク完了+21%） | [S12] |
| 同チームのPRレビュー時間 | +91% | [S12] |
| 2年間のテレメトリ（22,000人）での初回レビュー待ち | +156.6%、レビュー滞在+199.6%、無レビューマージ+31.3% | [S13] |
| 同・コードチャーン | +861%、PRあたり本番インシデント+242.7% | [S13] |
| 7日以上動きのない進行中タスク | +26% | [S13] |
| workslopを受け取った経験（直近1カ月） | 40%、受領workの15.4%、1件あたり1時間51分 | [S15][S16] |
| workslopのコスト | 1人月186ドル、1万人企業で年900万ドル | [S15] |
| AIで仕事が速くなったと答えた経営者 | 89%、しかし全社ROIを説明できるのは6% | [S08]（Atlassian調査の引用） |

Stack Overflow 2025では、84%がAIツールを利用中または利用予定で、プロ開発者の51%が毎日使う[S10]。

読み取るべきは、生産性が上がっていないことではない。**生産は上がり、検証と判断が追いついていない**ことである。

Farosの表現は的確だ。**"Throughput measures what was shipped, not what survived."**（スループットが測るのは出荷された量であり、生き残った量ではない）[S13]。そして**"AI made it easy to start work. It did not make it easy to finish it."**（AIは仕事を始めるのを楽にしたが、終わらせるのを楽にはしなかった）[S13]。企業の「2倍」号令を追った研究でも、PR数は約12%増えたがレビュアー1人あたりの負荷は倍増し、数カ月で自動レビューが人間レビューのカバレッジを超えた[S59]。

### 1.2 なぜレビューが膨らむのか

レビューが増える理由は、生産量だけではない。次の4つが重なっている。

1. **判断が共有されていない。** 何を良しとするか、どこまでで合格かが言語化されていないと、受け手は毎回ゼロから意図を推測する。レビューは「判断の未共有」への課税である。
2. **成果物が見た目で完成している。** 生成物は整形され、それらしく見える。中身の妥当性は別に確かめなければならない（workslop）[S15]。
3. **差分が大きすぎる。** Salesforceではコード量が約30%増え、PRが常態的に20ファイル・1,000行を超えた。そして**巨大PRのレビュー時間は横ばいか減少した**。これは「もはや実質的に読まれていない」シグナルだと同社は解釈している[S14]。AI支援コードではコードクローンが4倍に増え、コピー＆ペーストがコード移動を上回ったという分析もある[S17]。
4. **レビューの種類が混ざっている。** 意図の確認、設計の妥当性、実装の欠陥、成果の検証が、同じPRコメント欄や同じ会議で処理される。層が違うものを同じ速度で見ようとすると、必ずどれかが抜ける。

### 1.3 「強み」と「完了」が同時に見失われる構造

この3つは別々の問題ではない。

- 出力量が進捗の代理になると、**何が強みか**を問う時間が消える。今日の成果物を捌くことで一日が終わる。
- 完了の定義が「レビュー済み」「マージ済み」になると、**成果が出たか**は誰も見なくなる。
- 成果が出ているかを見ないまま生産だけ増えると、**間違った方向に速く進む**。Caganの引用するHilary Gridleyの言葉が痛い。**"It's never been faster to build, which means it's never been easier to run 10 times faster in the wrong direction."**[S08]

Cagan自身の総括も同じだ。**"we have never had the problem of abundant output yet scarce outcomes more than we do today"**（出力は豊富なのに成果が乏しいという問題を、今日ほど強く抱えたことはない）[S07]。

---

## 2. 役割はどう変わるか

### 2.1 3つのPM像と、AIが消すもの・残すもの

CaganはPMを1つの職種として語ることをやめ、オペレーティングモデルごとに3つに分ける[S06]。

| 役割 | モデル | AIの影響 |
| --- | --- | --- |
| アジャイルのプロダクトオーナー | プロジェクトモデル | スプリント手続き自体が空洞化し、**すでに段階的に廃止** |
| フィーチャーチームのPM | プロジェクトモデル | ソフトウェア工場化で需要減。残るとしても監督役 |
| エンパワードチームのPM | プロダクトモデル | **需要が高い**。ボトルネックがデリバリーから「何を作るか」へ移ったため |

決定的な一文はこれだ。**"the bottleneck is no longer product delivery"**[S06]。生産が安くなった世界で希少なのは、作る能力ではなく、**何を作り、何を作らないかを決める能力**である。

ただしCaganは、AIがPMを不要にするのではなく、**PMの仕事をより難しくする**とも書いている。強いプロダクトセンスを持つ人と生成AIの組み合わせには期待できる一方、基礎のない人に同じ道具を渡すことには警戒している[S05]。道具は判断力を代替しない。判断力の差を増幅する。Shreyas Doshiも、**道具そのものがalphaの源になることはない**と述べている[S48]。

### 2.2 AIネイティブ企業の実際

公開情報から見える組織の形は、従来とかなり違う。

- **OpenAI Codex**：2人のPM、1人のデザイナー、約40人のエンジニアで10〜12のプロダクト面を担当[S46]。従来なら面ごとに15〜20人の squad が付く規模。
- **Cursor**：40人のエンジニア、PMは1人で、ARR40億ドル超へ[S46]。
- **Linear**：新規issueの約25%をエージェントが起案し、エージェントの作業シェアは3%から50%へ。狙いは**"People can spend more time on intent, judgment, and taste"**[S58]。
- **Anthropic**：エンジニアがPMやデザイナーに相談せずに何百ものプロトタイプを作り、出荷する[S47]。

数字だけを真似すると危険だが、共通する原則は明確だ。**成果物を管理する人を減らし、判断する人と作れる人を近づける。** そして、レビューの対象を「ドキュメント」から「動くもの」へ移す。

### 2.3 PMの4つの仕事

AI時代のPMの仕事を、レビュー中心の働き方から組み替えるとこうなる。

1. **問いを定義する。** 誰の、どの瞬間の、どの課題を、どの制約で解くのか。ここが曖昧だと、レビューは永久に終わらない。
2. **評価関数を設計する。** 何をもって合格とするか。受入基準、eval、品質の閾値、やらないことの基準。Marily Nikaの「MVQ（minimum viable quality）」のように、品質の下限を先に決める発想が要る[S57]。モデルを顧客のようにインタビューし、evalを書くことも、この設計に含まれる[S43]。
3. **レビューの交通整理をする。** 何を、誰が、どの層で、どの頻度で見るか。全部を同じ熱量で見ない。
4. **判断を蓄積する。** 決めたこと、却下したこと、その理由を残し、次の判断のコストを下げる。Mercariの表現を借りれば、**機構は外から買えるが、判断基準は自前で持つしかない**[S28]。

### 2.4 人間の役割は「レビュー」から「ハーネス設計」へ

Addy Osmaniは**「生成ではなく検証が新しいボトルネック」**と書いた[S21]。Simon Willisonは、LLMは既存の良い実践を報いると指摘し、**「レビューが速い人はAIで幸福になり、書くことが好きな人は不幸になる」**と述べている[S22]。

これは、人間がレビューから逃げられないという意味ではない。**人間の仕事が、個別の成果物を検査することから、検査の仕組み（評価関数、ガードレール、CI、テンプレート、ルール）を設計することへ移る**という意味だ。

Googleはこれを「ハーネスエンジニアリング」として、エージェントの行動評価（曖昧な依頼に質問するか、完了宣言前に検証を走らせるか）まで含めて設計対象にしている[S61]。

---

## 3. 「何を強みにするのか」を取り戻す

### 3.1 最初に置く問い

強い問いはこれだ。**「もし明日、競合がまったく同じプロダクトを出してきたら、どう勝つのか」**[S51]。即答できるならMoatはある。詰まるなら、まだ築けていない。

AI時代にこの問いが重要になったのは、機能・UI・実装速度という従来の差別化要因が、短期間で模倣可能になったからだ。a16zのDavid Haberは明快に言う。**"AI is an extraordinary engine for product differentiation. But it's not a moat."**（AIは製品差別化の並外れたエンジンだが、堀ではない）[S41]。堀は、**ワークフローを端から端まで握る、顧客システムに深く埋め込む、システム・オブ・レコードになる、時間をかけて信頼を獲得する**ことから生まれる[S41]。

### 3.2 Moatの現在地

城田真琴の整理[S60]（LayerX CTO松本勇気の書評経由[S52]）は5つを挙げる。**マスターデータ、ワークフロー、ディストリビューション、エコシステム、スケール**[S52]。Safieの石川貴夫はこれに**規制、ネットワーク効果、物理インフラ**を加えた8つを示し、単体ではなく**連鎖**させることで模倣難度が跳ね上がると説明する[S51]。

| Moat | 問い | AI時代の変化 |
| --- | --- | --- |
| 独自データ | ネット上にない閉じたデータに、到達できる位置にいるか | モデルはコモディティ化するが、現場の非構造データはAPI連携では取れない[S51] |
| ワークフロー | 業務の最後までを閉じているか。剥がすのにどれだけ苦労するか | 「機能」より「業務の完遂」が防御になる[S41][S44] |
| ディストリビューション | 顧客基盤・販売チャネル・パートナーシップの優位はあるか | 生成コストが下がるほど、届ける力の相対価値が上がる |
| エコシステム | 外部開発者・企業が依存する platform か | アプリの模倣は容易でも、エコシステムの再現は困難 |
| スケール | 誰も同じ土俵に立てない規模か | 学習コスト・運用コストの差が効く |
| 規制・信頼 | 許認可・監査・責任を引き受けられるか | AIの出力に責任を負える主体が希少になる |
| ネットワーク効果 | 使う人・店・データが増えるほど全員の価値が上がるか | 変わらず強い |
| 物理インフラ | 現場・設備・人の配置を押さえているか | AIが現実に作用する最後の地点として再評価[S52] |

補足すると、a16zは「同じものを作るAIスタートアップの19/20は死ぬ」としつつ、**地味な業務ソフトほど防御的**だと論じる[S42]。Bessemerは**モデル自体はMoatにならない**として、垂直のワークフローとROIを重視する[S44]。ICONIQの調査でも、**実ワークフローに埋め込まれた製品は、モデルの一層上に座る汎用製品より外しにくい**と報告されている[S45]。Sarah Tavelは**狭さ、フィードバックループ、蓄積するデータ資産**を挙げ[S49]、Elad Gilは**初期のAIプロダクトはデフォルトで非防御**であり、堀は後から積むものだと述べる[S50]。

### 3.3 効率化は強みではない

ここが依頼者の課題に最も直結する。松本は書評でこう書く。**「AIによる自社の効率化それ自体も、競争優位ではありません。誰もが同じモデルと同じ機能を使える世界では、効率化で空いた時間と人と金を何に再投資したかが差になります」**[S52]。

つまり、AIで浮いた時間をそのまま「もっと作る」「もっとレビューする」に使うと、差は縮まらない。**浮いた時間をMoatに再投資する**という意思決定が、経営とプロダクトの仕事になる。

同時に、松本は**「持っていること」と「効いていること」の差**を突く[S52]。データを持っているだけでは意味がない。それがAIの判断を支えるナレッジになり、業務を最後まで完了させるワークフローになり、顧客との継続接点として機能しているか。既存資産は安泰の証拠ではなく、**Moatへ再設計すべき素材**である。

### 3.4 実務：プロダクト・テーゼ1枚とMoat台帳

四半期に1度、次の1枚を書く。長くしない。

**プロダクト・テーゼ（1枚）**

| 項目 | 書くこと | 失敗のサイン |
| --- | --- | --- |
| WHO | 誰の、どの業務・瞬間か | 「中小企業」など広すぎる |
| WHAT | 何を変えるか。どの指標がどう動くか | 機能名になっている |
| WHY US | 明日同じものが現れても勝つ理由 | 「品質が高い」「AIを使っている」 |
| ACCUMULATES | 使うほど何が溜まるか（データ、ワークフロー、信頼、エコシステム） | 何も溜まらない |
| NOT | やらないこと・捨てる機能 | 空欄 |

**Moat台帳（四半期）**

| Moat候補 | 今四半期に増えた証拠（1行） | 投下した時間・予算 | 来四半期の一手 |
| --- | --- | --- | --- |
| 例：現場データ | 3社の現場オペレーションを週次で同席し、例外処理ログを構造化 | エンジニア2名×20% | 例外処理の分類を製品に組み込む |
| 例：ワークフロー | 見積→請求の完了率が52%→71% | デザイン1名×30% | 請求後の入金消込まで閉じる |

証拠が書けないMoatは、願望である。

### 3.5 戦略のストレステスト

Aakash GuptaとTim Herbigは、Hamilton Helmerの7 Powersに戻り、**「AIは、顧客がすでに自分たちのところに来ている核価値に使う資源」**と整理する[S53]。そしてRoger Martinのテストを勧める。**「その戦略を反対にしても、馬鹿げていないか」**。誰も反対しない標語は戦略ではなく、優先順位付けの失敗を生む[S53]。

「AIで生産性を上げる」は、反対にしても馬鹿げていないので、戦略ではない。**「我々は現場の例外処理データで勝つ。だから機能の広さは捨てる」**は、反対にすると馬鹿げているので、戦略になり得る。

---

## 4. レビュー過多を解く4つのレバー

### 4.1 原則

レビューを減らす方法は、気合いではなく4つしかない。

1. **上流に移す**（判断を先に共有する）
2. **小さく出す**（1回あたりの判断量を減らす）
3. **機械に寄せる**（人間がやらなくてよい確認を自動化する）
4. **成果で置き換える**（成果物ではなく、動くもの・証拠で判断する）

この順番が重要だ。1と2を飛ばして3だけ導入すると、ノイズの多いAIレビューが増え、レビューはむしろ増える。

### 4.2 レバー1：上流に移す

仕様駆動開発（SDD）は、コードを仕様に従わせることで、意図と実装のずれを減らす。GitHub Spec Kitは、**/specify → /plan → /tasks → /implement** の流れと、プロジェクト憲章（constitution）で判断基準を成果物にする[S33]。Kiroは**requirements.md / design.md / tasks.md**の3点セットで、タスクを依存関係で並列実行する[S34]。AWSのAI-DLCは、**Inception / Construction / Operations**の3フェーズと、チームでAIの提案を検証する「Mob Elaboration / Mob Construction」を置く[S31]。

国内的には、CanlyがAI-DLCを保守チーム向けに再構成し、**人間のレビューは設計書に絞り、実装のチェックはAIレビューと全項目の動作確認に任せる**運用にした[S25]。設計書とコードコメントにPBI番号を残すことで、バグの記録と追跡の質が変わったという[S25]。SpiderPlusは、公式仕様書・新規設計書・実装コードの3者をAIに比較させ、**行番号と優先度付きのCSVで論点を出す**運用にした。仕様レビューは1件2〜3日から1日以内に短縮し、企画担当者が自分で論点を出せるようになった[S26]。

効果は大きいが、限界もはっきりしている。

- **仕様は腐る。** CMUとGoogleの大規模研究（73,030リポジトリ、470,795 specファイル）では、実装詳細を書きすぎると仕様が陳腐化し、specとコードの整合は「完了時」にしか確認されない[S36]。
- **保守戦略が未定義。** Böckelerは、spec-first、spec-anchored、spec-as-sourceの3層を整理し、**仕様をどう保守するかが未解決**だと指摘する[S35]。
- **探索的な領域には向かない。** UIや新規事業の初期は、仕様がコードを規定しきれない。
- **AIプロダクトは確率的である。** 同じ入力でも出力が変わるため、受入基準そのものを設計対象にする必要がある[S04]。

したがって、上流に移す対象は「判断が重い変更」に絞る。すべてを仕様化すると、レビュー地獄が仕様地獄に変わるだけだ。

### 4.3 レバー2：小さく出す

Zennの実践者は、SDDのレビュー地獄を**「価値のスライス」**で解く。ログイン機能を、認証、遷移、エラー表示、ロック処理に分け、小さく生成し、小さくレビューし、小さく積み上げる[S27]。Googleのエンジニアリングプラクティスも、**1つの自己完結した変更**を推奨し、大きすぎるCLはレビュアーが拒否してよいと明記する[S18]。DORAは**小さなバッチ**を、AI時代にこそ効果が増す能力として挙げる[S03]。

実務では、次の3つを機械的に決めると効く。

- PRの上限（例：400行、10ファイル）。超えたら分割を必須にする。
- レビュー待ち時間の上限（例：営業日4時間）。超えたらレビューを中断してでも先に返す。
- 同時レビュー件数（WIP）の上限。レビュアーの容量を計画に組み込む。

Salesforceの警告を忘れない。**巨大PRのレビュー時間が短くなったら、それは効率化ではなく形骸化**である[S14]。

### 4.4 レバー3：機械に寄せる

OpenAIは、コードレビュー用のエージェントを訓練する際、**precision（誤検知の少なさ）をrecall（見逃しの少なさ）より優先**した。ノイズの多いレビュアーは使われなくなるからだ。**"We optimize for signal-to-noise first"**[S19]。そして、リポジトリ全体の文脈と実行権限を与えることが、精度と再現率の両方に効くと報告している[S19]。

AIレビューツールの実力は、まだ限定的だ。Augmentの公開ベンチマークでは、最高のF-scoreは59%、Cursor Bugbot 49%、Greptile 45%、CodeRabbit 39%だった[S20]。Claude Codeはrecall 51%だがprecision 23%で、ノイズが多い[S20]。**AIレビューは一次スクリーニングと要約に使い、設計意図とリスクの判断は人間に残す**のが現実的である。

Pydanticの実践は示唆に富む。4,668件のレビューコメントからAGENTS.mdを自動生成し、**150ルール程度に蒸留**した。巨大な指示ファイルではなく、レビューで実際に指摘されたことの蓄積が効く[S24]。そして、**「AIコードを確認しました」というチェックボックスはほぼ無効**だったと明言している[S24]。

Plaidは、Claude Codeをチーム運用するために、AGENTS.md、rules、docs、Permission、Hooks、Skills、Subagentsをすべてリポジトリにコミットした。結果、5人程度のチームでPR数が月150本から600本へ増えても破綻しなかった[S23]。重要なのは、**「何を知っているべきか」「やってはいけないこと」「どうやるか」をリポジトリに固定した**ことだ。個人のプロンプト依存をなくしている。

### 4.5 レバー4：成果で置き換える

差分ではなく、動くものを見る。Böckelerは「まず動かす、次にレビュー」という反復レビューを提案する[S35]。仕様と実装がずれたら、プロンプトとコードを同時に更新する運用である。動くものを先に合わせ、細部は後から詰める。

Product CompassのPaweł Hurynは、**出荷が最も安い実験になった以上、「speed multiplies waste」**だと指摘し、**10本の自動ユーザージャーニーを通過することを本番デプロイの条件**にしている[S56]。これは「完了の定義」をレビューからゲートへ移す実例だ。ただし、出力1つは評価ではなく事例にすぎない。代表入力で反復実行し、ばらつきを見る必要がある[S39]。非決定的なシステムでは、デザイナーの仕事も「正確な挙動の指定」から**「何が良いか」の評価基準の定義**へ移る[S40]。Visionalは、コーディングを速くしてもボトルネックがレビュー・要件定義・QAに移ると指摘し、業務を模してブラウザを操作する「Agentic UAT」で品質を確かめる運用を作った[S29]。

### 4.6 レビュー4層の分担表

レビューを1つの行為として扱うのをやめ、4層に分ける。

| 層 | 問い | 合格条件 | 主担当 | 頻度・道具 |
| --- | --- | --- | --- | --- |
| 意図 | 誰のどの課題を解くのか。なぜ今か | テーゼと整合し、やらないことが言える | PdM・事業責任者 | 週次、1枚＋デモ |
| 設計 | どう解くか。制約と代替案は妥当か | ADRに決定・理由・捨てた案がある | テックリード・PdM | 重要変更のみ、設計書30分 |
| 実装 | 意図どおり動くか。壊していないか | 型・lint・テスト・AI一次レビュー・リスク箇所の人間確認 | エンジニア | 常時、CI＋PR |
| 結果 | 成果が出たか。学びは残ったか | 指標・顧客証拠・デモ・判断ログ | PdM | 隔週、デモ＋指標 |

国内でも、AIプロトタイプは「AIっぽい見た目」への指摘に終始しやすく、機能追加の容易さが使われない蛇足プロダクトを生むと指摘されている[S30]。意図の層を空欄にしたまま実装の層だけ厚くすると、この罠にはまる。

この表を埋めると、たいてい**「意図」と「結果」が空欄**になる。そこが、強みと完了を見失う穴である。

### 4.7 やってはいけないこと

- レビューの高速化ツールから導入する（判断が未共有なら量が増えるだけ）
- すべての変更を同じ深さでレビューする（リスクベースの選別がない）
- AIレビューの指摘を全部人間が追う（ノイズで本物が埋もれる）
- 「AIコードを確認しました」のチェックボックスで統制する[S24]
- レビュー時間の短縮を成果として喜ぶ（形骸化の可能性）[S14]
- 完了を「PRマージ」で数える

---

## 5. 「何がどこまで完了しているか」を取り戻す

### 5.1 なぜ「マージ済み」は完了ではないのか

AIは、それらしい成果物を安く作る。だから「成果物がある」ことは、進捗の証拠にならない。仕様書があることは、決まったことを意味しない。デモが動くことは、顧客の課題を解いたことを意味しない。

Proof of Done manifestoは、この問題をこう定式化する。**"The bottleneck moved from production to assurance."**（ボトルネックは生産から保証へ移った）[S37]。そして、進捗の単位を「生成されたコード」ではなく**「証拠を伴う変更（evidence-carrying change）」**とし、**未確認・部分・保留・不明を、doneの裏に隠さず工学の状態として扱う**ことを求める[S37]。

### 5.2 Done ladder

完了を1つの点ではなく、6段のはしごで扱う。

| レベル | 状態 | 証拠 | よくある偽の完了 |
| --- | --- | --- | --- |
| L0 | 生成された | 成果物の存在 | 「AIが作りました」 |
| L1 | 意図が合意された | テーゼとの整合、やらないことの確認 | 仕様書が長い |
| L2 | 受入基準を満たす | 自動テスト、eval、受入条件の通過[S38] | テストが通る（条件が緩い） |
| L3 | 統合され、動く | プレビュー、デモ、ステージング | ローカルで動く |
| L4 | 成果が観測された | 指標、顧客行動、業務完了率 | リリースしました |
| L5 | 学習が蓄積された | 判断ログ、更新されたルール・eval | 振り返り会をした |

**探索（build to learn）と納品（build to earn）で、合格ラインを変える。** Caganはこの2つを明確に分け、探索ではプロトタイプで学習し、納品では商業品質（信頼性、正確性、スケーラビリティ、性能）を満たすとしている[S08]。探索でL4を要求すると何も進まないし、納品でL2を合格にすると事故る。

### 5.3 Evidence pack

1つの変更・機能について、次の5点を1ページにまとめる。これが「どこまで完了か」の最小単位になる。

1. **Intent**：誰のどの課題を、なぜ今解くのか
2. **Evidence**：受入条件を満たす証拠（テストログ、eval結果、デモURL、顧客の反応）
3. **Limits**：この証拠が保証しないこと（性能、セキュリティ、例外ケース）
4. **Decision**：誰が、いつ、何をもって受け入れたか
5. **Invalidation**：この証拠が無効になる条件（前提の変更、モデルの更新、仕様の変更）[S37]

5番目が特に効く。証拠は腐る。モデルが変わればevalの意味も変わる。前提が変わったときに「完了」を取り消せる仕組みがないと、完了状態はすぐ嘘になる。

### 5.4 状態の語彙を増やす

「完了／未完了」の2値では足りない。少なくとも次を区別する。

- 未着手
- 生成済み（未検証）
- 部分（受入条件の一部のみ）
- 保留（判断待ち・依存待ち）
- 不明（前提が確認できていない）
- 受け入れ済み（証拠あり）

Proof of Doneは、**unchecked、abstained、partial、deferred、unknown**を明示的な状態として扱うことを求める[S37]。曖昧な「だいたいできた」を減らすには、語彙を増やすのが一番安い。

### 5.5 運用に落とす

- **PR・チケットのテンプレート**に、Intent / Evidence / Limits / Decision を入れる。
- **tasks.md や aidlc-state.md のような状態ファイル**を正とする。Kiroはtasks.mdの進捗をリアルタイムに更新し[S34]、AI-DLCはaidlc-state.mdとauditログで判断を追跡する[S32]。
- **週次のデモレビュー**（30分）。資料ではなく動くものを見る。差分レビューの量を減らす。
- **隔週の判断ログレビュー**。決めたこと、捨てたこと、その理由を15分で読み返す。
- **月次の「殺すリスト」**。続けないと決めたものを明示する。やらないことを決めないと、強みに時間が戻らない。

### 5.6 計測

| 指標 | 定義 | 何を見るか |
| --- | --- | --- |
| レビュー待ち時間 | 依頼から一次返答まで | 容量の詰まり |
| PRサイズ | 行数・ファイル数 | 判断のしやすさ |
| 証拠付き完了率 | L2以上の完了 / 全完了 | 完了の質 |
| 成果観測率 | L4に到達した数 / 出荷数 | 成果への接続 |
| Moat配分 | Moat作業に使った時間 / 総時間 | 再投資の実行 |
| 判断リードタイム | 論点が出てから決まるまで | 意思決定の詰まり |
| 手戻り率 | 差し戻し・再作業の割合 | 上流の質 |

指標は増やしすぎない。上の7つで十分だ。

---

## 6. 90日で組み替える

### 6.1 4フェーズ

| 期間 | やること | 成果物 |
| --- | --- | --- |
| 第1〜2週 | 現状測定。レビュー待ち、PRサイズ、レビュー時間、手戻り、workslopの発生源を1週間分 | ベースライン表 |
| 第3〜4週 | プロダクト・テーゼとMoat台帳を作る。やらないことを決める | 1枚＋台帳 |
| 第5〜8週 | レビュー4層の分担を決め、PR上限・WIP上限・AI一次レビュー・CI移管を実施。仕様／受入基準テンプレを導入 | 運用ルール |
| 第9〜12週 | Done ladderとEvidence packを運用。週次デモと判断ログを開始。Moat再投資の時間を確保 | 定例と記録 |

### 6.2 最初の1週間でやる7つ

1. 直近20件のPRについて、サイズ、レビュー待ち、レビュー時間、手戻りを出す。
2. レビューに使った時間を、4層（意図・設計・実装・結果）に分類する。
3. 「明日同じものが出たら勝てる理由」を1行で書く。書けなければ、それが最優先の課題。
4. 直近1カ月の「完了」のうち、証拠があるものを数える。
5. PRサイズとWIPの上限を仮決めする。
6. AI一次レビューを試験導入し、自チームのゴールデンセットでprecision/recallを測る[S20]。
7. 週次デモレビューの枠をカレンダーに入れる。

### 6.3 会議体

| 会議 | 頻度 | 目的 | 禁止事項 |
| --- | --- | --- | --- |
| デモレビュー | 週次30分 | 動くものを見て、殺すか残すかを決める | 資料の読み上げ |
| 判断ログレビュー | 隔週15分 | 決定の質を振り返る | 進捗報告 |
| Moatレビュー | 月次45分 | 強みに時間が使われたか確認 | 機能リストの確認 |
| 四半期戦略レビュー | 四半期 | テーゼの更新、撤退の決定 | 予算の積み上げ |

---

## 7. アンチパターン

1. **生産性ツールを先に入れる。** 判断が未共有のまま生産だけ増えると、レビュー負債が増える[S12][S13]。
2. **レビューの高速化を成果にする。** 巨大PRが読まれなくなる形骸化を招く[S14]。
3. **AIレビューに人間の承認を重ねる。** 責任が空洞化し、ノイズだけが増える[S20][S24]。
4. **ドキュメントの完成度を進捗にする。** 仕様は腐る[S36]。動くものと証拠を見る。
5. **AI利用量を評価する。** DuolingoはAI活用度を年次評価に入れる方針を示して反発を招き、CEOが説明を修正した[S55]。workslopの生産を報酬化するだけになる。
6. **効率化の果実を追加機能に使う。** 差が縮まらない。Moatに再投資する[S52]。
7. **全部を仕様化する。** 仕様地獄に変わる[S35][S36]。
8. **完了をマージで数える。** 成果と学習が見えなくなる[S37]。

---

## 8. 反論と限界

- **生存者バイアス。** Codexの2 PM、Cursorの1 PMは勝者の公開情報であり、失敗した組織の運営は見えない[S46]。
- **ベンダーデータの偏り。** Qodo、Faros、Augment、CodeRabbitの調査は、自社製品の価値を高める方向に設計され得る。独立した比較研究は不足している[S09][S12][S20]。
- **因果と相関。** Farosの数値はテレメトリの相関であり、チャーン増をAIだけに帰すことはできない[S13]。DORAもAIを「増幅器」と呼び、因果を断定しない[S01]。
- **生産性の逆説。** METRのRCTでは、経験豊富なOSS開発者がAI利用で19%遅くなった。しかも本人は「20%速くなった」と誤認した[S54]。ただしMETR自身が後に「この結果は古い」と更新している。自己認識と実測は一致しない。
- **AIレビューの上限。** F-scoreは60%前後が現実的な線で、人間の判断を置き換えられない[S20]。
- **AI生成物の品質は改善している。** curlのStenbergは2026年10月、AI支援の脆弱性報告は「正確だが冗長」であり、無視するわけにはいかないと述べた[S63]。単純な「AI生成物＝低品質」論は成り立たない。
- **日本の組織文脈。** 稟議、監査、受託構造、品質保証部門の存在は、ここで引いた米国企業の事例と条件が違う。移植には調整が要る（推測）。
- **レビューを減らすことは、確認しないことではない。** 減らすのは人間の注意力を使う場所であり、検証そのものではない。

---

## 9. 付録

### A. 強みを言語化する10問

1. 明日、競合が同じプロダクトを出したら、顧客はなぜ我々を選ぶのか。
2. その理由は、機能・UI・価格以外で説明できるか。
3. 使うほど何が溜まるか。それは競合が3カ月で再現できないか。
4. 我々だけがアクセスできるデータ・現場・関係は何か。
5. 顧客の業務のどこまでを閉じているか。途中で他社に切り替わると何が止まるか。
6. 顧客が我々を信頼する理由は何か。事故ったときに責任を負えるか。
7. この四半期、強みを強くするために何に時間を使ったか。
8. 今やっている作業のうち、強みに寄与しないものは何割か。
9. 捨てる機能・止める施策は何か。
10. その戦略を反対にしても、馬鹿げていないか[S53]。

### B. 完了判定チェックリスト

- [ ] Intent（誰のどの課題を、なぜ今）が書かれている
- [ ] 受入条件が、検証可能な形で書かれている
- [ ] 受入条件を満たす証拠がある（テスト、eval、デモ、顧客反応）
- [ ] 証拠が保証しないこと（限界）が書かれている
- [ ] 誰が、いつ、何をもって受け入れたかが残っている
- [ ] 証拠が無効になる条件が書かれている
- [ ] 探索か納品かで、合格ラインが使い分けられている
- [ ] 学び（判断ログ、ルール、evalの更新）が残っている

### C. レビュー設計シート

| 項目 | 記入 |
| --- | --- |
| レビューの層 | 意図／設計／実装／結果 |
| 対象 | 何を見るか（資料ではなく動くものか） |
| 合格条件 | 何があれば合格か |
| 主担当 | 誰が最終判断するか |
| 頻度 | 毎回／週次／重要変更のみ |
| 道具 | PR、デモ、ADR、eval、CI |
| やらないこと | この層で扱わない論点 |

### D. 参考実装パターン

- **AGENTS.md / rules**：レビューコメントから蒸留した判断基準を置く。150ルール程度に保つ[S24][S23]。
- **tasks.md / aidlc-state.md**：作業の状態と判断をファイルで追跡する[S34][S32]。
- **PRテンプレート**：Intent / Evidence / Limits / Decision / Invalidation。
- **evalスイート**：AI機能の受入条件を自動検証する。手動チェックをskill化してエージェント自身にフィードバックループを閉じさせる実装もある[S62][S56]。
- **判断ログ**：日付、論点、選択肢、決定、理由、無効条件。

---

## 10. 出典

- **[S01]** DORA / Google Cloud — *State of AI-assisted Software Development 2025*。2025年。採用した論点：AIは増幅器であり、組織の強みも弱みも増幅する。https://dora.dev/research/2025/dora-report/
- **[S02]** Google Cloud Blog — *How are developers using AI? Inside our 2025 DORA report*。2025年9月23日。採用した論点：利用率90%、生産性80%超、信頼のパラドックス（24%対30%）。https://blog.google/innovation-and-ai/technology/developers-tools/dora-report-2025/
- **[S03]** Google Cloud Blog — *Introducing DORA's inaugural AI Capabilities Model*。2025年9月23日。採用した論点：7つの能力。とくにユーザー中心性が欠けるとAIが逆効果になること、小さなバッチ。https://cloud.google.com/blog/products/ai-machine-learning/introducing-doras-inaugural-ai-capabilities-model
- **[S04]** Marty Cagan & Marily Nika / SVPG — *AI Product Management*。2024年4月16日。採用した論点：AIプロダクトの実現可能性リスク、確率的システム、データ品質。https://www.svpg.com/ai-product-management/
- **[S05]** Marty Cagan / SVPG — *AI Product Management 2 Years In*。2024年12月30日。採用した論点：変化はまだ限定的。PMの仕事は易しくならず、難しくなる。https://www.svpg.com/ai-product-management-2-years-in/
- **[S06]** Marty Cagan / SVPG — *AI and the Future of the Product Role*。2026年11月6日。採用した論点：3つのPM像。プロダクトオーナーの廃止。ボトルネックはデリバリーではない。https://www.svpg.com/ai-and-the-future-of-the-product-role/
- **[S07]** Marty Cagan / SVPG — *Predictability vs Outcomes*。2026年10月12日。採用した論点：出力過剰・成果不足。真のトレードオフは予測可能性と成果。https://www.svpg.com/predictability-vs-outcomes/
- **[S08]** Marty Cagan / SVPG — *The AI Productivity Paradox*。2026年7月23日。採用した論点：AIは古い働き方を速くするだけ。build to learn と build to earn の区別。Atlassian調査の引用（89%対6%）。https://www.svpg.com/the-ai-productivity-paradox/
- **[S09]** Qodo — *State of AI Code Quality Report 2026*。採用した論点：レビューと検証が最大の制約（26%）、信頼税36.4%、AI関連インシデント89%、プロセス十分は3.7%。https://www.qodo.ai/state-of-ai-code-quality-report/
- **[S10]** Stack Overflow — *2025 Developer Survey: AI*。採用した論点：利用率84%、毎日51%。https://survey.stackoverflow.co/2025/ai
- **[S11]** Stack Overflow Blog — *Developers remain willing but reluctant to use AI*。2025年12月29日。採用した論点：信頼29%、almost-right 45%、修正時間増66%、人間に聞く75%。https://stackoverflow.blog/2025/12/29/developers-remain-willing-but-reluctant-to-use-ai-the-2025-developer-survey-results-are-here/
- **[S12]** Faros AI — *AI Software Engineering Report*。2025年7月。採用した論点：マージPR+98%、レビュー時間+91%。https://www.faros.ai/blog/ai-software-engineering
- **[S13]** Faros AI — *Ten takeaways from the AI Engineering Report 2026: The Acceleration Whiplash*。2026年4月12日。採用した論点：チャーン+861%、インシデント+242.7%、初回レビュー+156.6%、無レビューマージ+31.3%、停滞タスク+26%。https://www.faros.ai/blog/ai-acceleration-whiplash-takeaways
- **[S14]** Salesforce Engineering — *Scaling Code Reviews: Adapting to a Surge in AI-Generated Code*。2026年1月29日。採用した論点：コード量+30%、20ファイル・1,000行超のPR、巨大PRのレビュー時間の頭打ち＝形骸化。https://engineering.salesforce.com/scaling-code-reviews-adapting-to-a-surge-in-ai-generated-code/
- **[S15]** BetterUp Labs — *The hidden cost of AI workslop*。2025年9月29日。採用した論点：40%が受領、15.4%、1時間51分、月186ドル、1万人で年900万ドル。https://www.betterup.com/blog/hidden-costs-workslop
- **[S16]** Harvard Business Review — *AI-Generated "Workslop" Is Destroying Productivity*。2025年9月。採用した論点：workslopの定義と組織コスト。https://hbr.org/2025/09/ai-generated-workslop-is-destroying-productivity
- **[S17]** GitClear — *AI Copilot Code Quality: 2025*。採用した論点：コードクローンの4倍増、コピー＆ペーストが移動を上回る。https://www.gitclear.com/ai_assistant_code_quality_2025_research
- **[S18]** Google — *Small CLs*（eng-practices）。採用した論点：自己完結した小さな変更。大きすぎる変更は拒否してよい。https://google.github.io/eng-practices/review/developer/small-cls.html
- **[S19]** OpenAI Alignment — *A Practical Approach to Verifying Code at Scale*。2025年12月1日。採用した論点：precision優先、signal-to-noise、リポジトリ全体の文脈、AGENTS.mdで調整可能。https://alignment.openai.com/scaling-code-verification/
- **[S20]** Augment Code — *We Benchmarked 7 AI Code Review Tools on Real-World PRs*。2025年12月11日（2026年6月18日更新）。採用した論点：最高F-score 59%、ツール別のprecision/recall。https://www.augmentcode.com/blog/we-benchmarked-7-ai-code-review-tools-on-real-world-prs-here-are-the-results
- **[S21]** Addy Osmani — *The "Trust, But Verify" Pattern For AI-Assisted Engineering*。2025年6月9日。採用した論点：検証が新しいボトルネック。https://addyo.substack.com/p/the-trust-but-verify-pattern-for
- **[S22]** Simon Willison — *Vibe engineering*。2025年10月7日。採用した論点：LLMは既存のよい実践を報いる。レビューが速い人が幸福になる。https://simonwillison.net/2025/Oct/7/vibe-engineering/
- **[S23]** Plaid — *PR数4倍でも破綻しない、Claude Codeをチーム運用する仕組み*。2026年2月18日。採用した論点：AGENTS.md/rules/Permission/Hooks/Skillsのリポジトリ管理、PR 150→600本/月。https://tech.plaid.co.jp/claude-code-scalable-team-operation
- **[S24]** Pydantic — *Scaling open source with AI*。採用した論点：4,668件のレビューコメントからAGENTS.mdを蒸留、150ルール、チェックボックスの無効性。https://pydantic.dev/articles/scaling-open-source-with-ai
- **[S25]** Canly — *人間が見るのは設計書だけ*。2026年10月28日。採用した論点：設計書にレビューを絞る、AIレビュー＋全項目動作確認、PBI番号による追跡。https://zenn.dev/canly/articles/85dc645c252832
- **[S26]** SpiderPlus — *プロダクトマネージャーとの仕様レビューをAIで「民主化」した話*。2026年5月29日。採用した論点：3者比較、行番号・優先度付きCSV、2〜3日から1日以内。https://techblog.spiderplus.co.jp/entry/2026/05/29/120000
- **[S27]** trskd / Zenn — *仕様駆動開発はレビュー地獄？──価値のスライスで天国に行こう*。2025年9月21日。採用した論点：価値のスライス、小さく生成・レビュー・積み上げ。https://zenn.dev/trskd/articles/86d2e3a2bbe6ca
- **[S28]** Mercari Engineering — *AI-Native な開発の実践に向けて*。2026年6月30日。採用した論点：機構は外から、判断基準は自前。正解・観測・停止の3役割。https://engineering.mercari.com/blog/entry/20260630-b22667b4d6/
- **[S29]** Visional Engineering — *開発プロセス全体を「AI前提」へと再構築*。2026年4月23日。採用した論点：レビュー・要件定義・QAへのボトルネック移動、Agentic UAT、10万行・人間のコード0行。https://engineering.visional.inc/blog/765/ai-product-studio-introduction/
- **[S30]** Goodpatch — *AI時代、PdMの役割はどう変わる？*。2026年6月19日。採用した論点：見た目レビューへの引っ張られ、蛇足プロダクト、レビューなき出力の無意味さ。https://goodpatch.com/blog/2026-06-pdm-vol1
- **[S31]** AWS — *AI-Driven Development Life Cycle: Reimagining Software Engineering*。2025年7月31日。採用した論点：Inception/Construction/Operations、Mob Elaboration/Construction、永続コンテキスト。https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/
- **[S32]** AWS Labs — *AI-DLC Workflows: Introduction*。採用した論点：aidlc-state.md、auditログ、承認ゲート、33ステージ。https://awslabs.github.io/aidlc-workflows/guide/00-introduction/
- **[S33]** GitHub — *Spec-driven development with AI: Spec Kit*。採用した論点：specify/plan/tasks/implement、constitution、仕様を一次成果物にすること。https://github.blog/ai-and-ml/generative-ai/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit/
- **[S34]** Kiro — *Specs*。採用した論点：requirements/design/tasksの3点、タスクの依存関係とwave実行、進捗のリアルタイム更新。https://kiro.dev/docs/specs/
- **[S35]** Birgitta Böckeler / martinfowler.com — *Exploring Gen AI: SDD with three tools*。2025年10月15日。採用した論点：spec-first/spec-anchored/spec-as-source、仕様の保守戦略の未解決。https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html
- **[S36]** Agarwal et al. — *Spec-Driven Development as Prescribed and as Practiced*。arXiv:2608.25202。2026年。採用した論点：470,795 specファイル、計画とレビューのコスト増、仕様の腐敗、整合確認は完了時のみ。https://arxiv.org/abs/2608.25202
- **[S37]** Proof of Done — *The Agentic Software Development Manifesto*。2026年8月17日。採用した論点：証拠を伴う変更、生産から保証への移動、未確認・部分・保留・不明の明示、証拠の無効化。https://podmanifesto.org/
- **[S38]** Hamel Husain — *Your AI Product Needs Evals*。2024年3月29日。採用した論点：evalを単体テストとして3層で設計する。https://hamel.dev/blog/posts/evals/
- **[S39]** Nielsen Norman Group — *Evaluating AI Output*。2026年8月14日。採用した論点：1つの出力は事例にすぎない。代表入力×反復で測る。https://www.nngroup.com/articles/eval-ai-output/
- **[S40]** Nielsen Norman Group — *AI-Era Critique*。2026年6月12日。採用した論点：非決定的システムでは「何が良いか」の基準定義が仕事になる。https://www.nngroup.com/articles/ai-era-critique/
- **[S41]** David Haber / a16z — *Context is King*。2025年8月18日。採用した論点：AIは差別化のエンジンだがMoatではない。文脈・ワークフロー・信頼が堀。https://a16z.com/context-is-king/
- **[S42]** a16z — *Why AI Moats Still Matter (And How They've Changed)*。2025年12月3日。採用した論点：同じものを作る19/20は死ぬ。地味なソフトウェアほど防御的。https://a16z.com/podcast/why-ai-moats-still-matter-and-how-theyve-changed/
- **[S43]** a16z — *5 Principles for Product Managers Fending Off Obsolescence in the AI Era*。2025年5月6日。採用した論点：モデルを顧客のようにインタビューする、evalを書く、極端な価格を恐れない。https://a16z.com/stay-relevant-in-ai/
- **[S44]** Bessemer — *Ten principles for building strong vertical AI businesses*。2025年1月28日。採用した論点：モデルはMoatにならない。ワークフロー、ROI、垂直のニュアンス。https://www.bvp.com/atlas/part-iv-ten-principles-for-building-strong-vertical-ai-businesses
- **[S45]** ICONIQ — *State of AI 2026: The Builder's Economy*。2026年。採用した論点：実ワークフローに埋め込まれた製品は外しにくい。品質保証は事後対応型。https://www.iconiq.com/growth/reports/state-of-ai-2026
- **[S46]** Aakash Gupta — *The AI Product Operating Model: How AI-Native Companies Win*。2026年6月17日。採用した論点：Codexの2 PM/40エンジニア、Cursorの1 PM/40エンジニア。https://www.news.aakashg.com/p/ai-product-operating-model
- **[S47]** Aakash Gupta — *There's a New PM Skill. It's Called Taste at Speed*。2026年3月13日。採用した論点：動くものを速く評価し、大半を殺し、残ったものを出す。https://www.news.aakashg.com/p/taste-at-speed
- **[S48]** Shreyas Doshi — *Why Product Sense is the Only Product Skill That Matters*。2026年3月5日。採用した論点：道具はalphaの源ではない。製品センスとtaste。https://shreyasdoshi.substack.com/p/why-product-sense-is-the-only-product
- **[S49]** Sarah Tavel — *How to Escape Competition: Building Defensible AI Companies*。2023年4月24日。採用した論点：狭さ、フィードバックループ、蓄積するデータ資産。https://www.sarahtavel.com/p/how-to-escape-competition-building
- **[S50]** Elad Gil — *Defensibility and Competition*。2023年2月16日。採用した論点：初期はデフォルト非防御。堀は後から積む。https://blog.eladgil.com/p/defensibility-and-competition
- **[S51]** mattsershaw / Qiita — *AI時代のMoatとは*。2026年5月11日。採用した論点：Moat 8分類、連鎖するMoat、現場データへのアクセス。https://qiita.com/mattsershaw/items/e6205673598cdb1ff14d
- **[S52]** 松本勇気 / 日経BOOKプラス — *LayerX 松本勇気が推す「AI時代に自社の強みを見直すための本」*。2026年9月17日。採用した論点：5つのMoat、持っていることと効いていることの差、効率化は優位ではない。https://bookplus.nikkei.com/atcl/column/041100040/083100080/
- **[S53]** Aakash Gupta × Tim Herbig — *How the Best PMs Think About Product Strategy*。2026年10月14日。採用した論点：7 Powers、AIは資源、反対にしても馬鹿げていないかテスト。https://www.news.aakashg.com/p/how-the-best-pms-think-about-product-strategy
- **[S54]** METR — *Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity*。2025年7月10日。採用した論点：19%の遅延と本人の誤認。https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/
- **[S55]** Fortune — *Duolingo AI-first employees*。2025年5月24日。採用した論点：AI活用度を評価に入れた反発と説明の修正。https://fortune.com/2025/05/24/duolingo-ai-first-employees-ceo-luis-von-ahn/
- **[S56]** Paweł Huryn / Product Compass — *Product Discovery 2026*。2026年7月22日。採用した論点：speed multiplies waste、10本の自動ジャーニーをデプロイ条件にする。https://www.productcompass.pm/p/product-discovery-2026
- **[S57]** Marily Nika / Lenny's Newsletter — *Building AI Product Sense, Part 2*。2026年2月10日。採用した論点：MVQ（minimum viable quality）と3つの閾値、品質バーを上下させる戦略的文脈。https://www.lennysnewsletter.com/p/building-ai-product-sense-part-2-0aa
- **[S58]** Linear — *Linear Next*。2026年。採用した論点：新規issueの約25%をエージェントが起案、作業シェア50%、intent・judgment・tasteへの時間。https://linear.app/next
- **[S59]** arXiv:2607.01904 — *AI Writes Faster Than Humans Can Review: A Longitudinal Study of an Enterprise 2x Mandate*。2026年。採用した論点：PR数+12%、レビュアー1人あたり負荷倍増、自動レビューが人間レビューのカバレッジを超える。https://arxiv.org/abs/2607.01904
- **[S60]** 城田真琴『AIに潰されないための競争戦略 5つの武器（モート）』日経BP。2026年。採用した論点：マスターデータ、ワークフロー、ディストリビューション、エコシステム、スケール。
- **[S61]** Google Developers Blog — *The Anatomy of Harness Engineering*。2026年9月9日。採用した論点：行動評価でエージェントの振る舞いを検証する。https://developers.googleblog.com/the-anatomy-of-harness-engineering-how-to-evaluate-iterate-and-guard-ai-coding-agents/
- **[S62]** Anthropic — *Building verification loops in Claude Code with skills*。2026年7月22日。採用した論点：手動チェックをskill化し、検証ループをエージェントに閉じさせる。https://claude.com/resources/articles/building-verification-loops-in-claude-code-with-skills
- **[S63]** Daniel Stenberg — *ignore the slop*。2026年10月22日。採用した論点：AI支援の脆弱性報告は正確だが冗長。無視はできない。https://daniel.haxx.se/blog/2026/10/22/ignore-the-slop/

---

**残課題。** 日本企業の稟議・監査・受託構造に合わせたレビュー設計、探索フェーズでのDone ladderの軽量化、AIレビューツールの自チームでの評価セット整備は、このレポートでは十分に扱えていない。次の調査候補である。
