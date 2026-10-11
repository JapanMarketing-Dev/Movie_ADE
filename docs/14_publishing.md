# 14. 投稿（YouTube・TikTok と、SNS での告知）

最終更新: 2026-10-11（各社の API・規約は 2026-10 時点の調査）

## 目指すこと

完成した動画を、エディタから YouTube と TikTok に投稿し、続けて X / Instagram / Threads / Facebook に「動画を投稿しました」を告知する。**投稿は必ず人が内容を確認・承認してから行う。**

```
「投稿して」（用意済みのプロンプト、またはボタン）
  → 投稿の確認画面（出力先ごとのタイトル・説明文・タグ・サムネイル・公開範囲・予約日時・開示の項目）
  → 承認 → 投稿のキュー → YouTube / TikTok にアップロード
  → 公開の URL が決まったら、告知の確認画面（SNS ごとの文面・画像・縦型動画）
  → 承認 → X / Instagram / Threads / Facebook へ
  → 投稿の履歴に記録（URL、公開範囲、開示の項目、日時）
```

## 方式は「審査の状態」で自動で切り替える

機能はすべて最初から作る。ただし各社の API は、運営（Solocut）のアプリが審査を通っているかで使える範囲が変わる。そこで、プラットフォームごとに使える一番良い方式を自動で選ぶ。審査が通れば、アプリを更新しなくても、配信する設定（`publish-capabilities.json`、署名付き）を切り替えるだけで方式が上がる。

| 出力先 | API（審査済み） | 審査前・API なしの方式 | 利用者が自分の開発者アプリを持ち込む（BYO） |
|---|---|---|---|
| **YouTube** | YouTube Data API v3（`videos.insert`、`thumbnails.set`、`captions.insert`）。公式のクライアント ID | ― | **可**: 自分の Google Cloud プロジェクトのクライアント ID を設定に入れる（テスト状態では7日ごとに再ログインが必要） |
| **TikTok** | Content Posting API の Direct Post | 下書きとして送る（`video.upload`。審査前は人数の制限あり）、または「書き出し → TikTok を開く」の案内 | 不可（個人用ツールは監査が通らないと明記されている） |
| **X** | X API v2（投稿とメディアのアップロード）。**従量課金**（URL 付きの投稿は1件 $0.20） | **Web Intent（既定）**: 文面を入れた投稿画面を開き、本人が「投稿」を押す。無料・審査不要 | 可: 自分の X の開発者アプリ（PKCE）。課金は本人 |
| **Instagram** | Graph API で Reels を投稿（プロアカウントが必要） | 「書き出し → Instagram を開く」の案内（Web Intent がない） | 可だが難しい（Meta のアプリ作成など）。上級者向け |
| **Threads** | Threads API（テキスト＋リンク、動画） | **Web Intent**（`threads.com/intent/post`） | 可（同上） |
| **Facebook** | Pages API（ページへの投稿、Reels） | Share Dialog（リンクとハッシュタグ） | 可（同上） |

- 個人のプロフィール（Facebook）には API で投稿できない（2018年に廃止）。ページに投稿するか、Share Dialog を使う
- Intent は OS の標準のブラウザで開く（ログインの状態を共有でき、Google のようにアプリ内のブラウザでのログインがブロックされる問題もない）

## 認証

| 出力先 | 方法 | シークレット |
|---|---|---|
| YouTube | OS の標準のブラウザ＋PKCE＋ループバック（`http://127.0.0.1:<任意のポート>`） | 不要（インストール型アプリ） |
| X | OAuth 2.0 PKCE、Native App（ループバックは固定ポート） | 不要 |
| TikTok | Login Kit for Desktop、PKCE（S256、hex）＋ループバック | **必要** → 運営の交換サーバーで |
| Instagram / Threads / Facebook | 各社の OAuth | **必要** → 運営の交換サーバーで |

**トークン交換サーバー**（Cloudflare Worker）: `/oauth/{tiktok,meta,threads}/exchange` と `/refresh` だけを持つ。シークレットはサーバーだけが持ち、**トークンは保存しない**（通過させるだけ）。動画はサーバーを通さない。

**一時置き場**（R2）: Instagram と Threads は、動画を「公開 URL から取り込ませる」方式のため、期限付きの URL で一時的に置く。投稿が終わったらすぐに消す。

トークンは OS の安全な保管庫（Keychain / DPAPI / libsecret）に入れる。保管庫がない Linux では保存せず、毎回ログインしてもらう。連携を解除するときは、各社の取り消しの API を呼んでから手元を消す。

## 投稿の確認画面（各社の必須の表示を含む）

| 出力先 | 画面で必ず扱う項目 |
|---|---|
| YouTube | タイトル（100字）、説明文（5000 **バイト**、日本語なら約1666字）、タグ、カテゴリ、公開範囲（公開・限定公開・非公開）、予約日時（`publishAt`）、**子ども向けかどうか（必須）**、**改変・合成されたコンテンツの開示**（`containsSyntheticMedia`）、サムネイル、字幕（SRT）、チャプター |
| TikTok | 投稿先のニックネームの表示、**公開範囲はプルダウンで既定値なし**、コメント・Duet・Stitch は**未チェックから**、商用コンテンツの開示（既定はオフ。オンにしたら「自分のブランド」か「ブランドコンテンツ」の選択が必須）、音楽の利用確認への同意文、プレビュー、AI 生成のラベル（`is_aigc`）、投稿後の処理状況の表示 |
| X | 本文（日本語は1字を2と数え、280まで。URL は23字扱い）、画像または動画、API を使う場合は費用の事前表示 |
| Instagram | キャプション、カバー、縦型動画（Reels） |
| Threads | 本文（500字）、リンク、トピックタグ（1つ・50字まで）、動画（最長300秒） |
| Facebook | ページの選択、本文、リンク、Reels（3〜90秒・9:16） |

文面はエージェントが下書きする（用意済みのプロンプト `metadata` と `announce`。SNS ごとの文字数と雰囲気はテンプレートのプロンプトで決める）。人は確認画面で直してから承認する。

## 投稿のキュー

- SQLite に `jobs(id, platform, account, payload, state, attempt, nextAt, remoteId, error)` を持つ。state は `queued → uploading → processing → published` か `failed` / `needs-user`
- アップロードは再開できる方式を使う（YouTube の resumable、TikTok のチャンク、X の append）
- 429 と 5xx は指数バックオフで最大5回まで再試行する。ポリシー・スパム・クォータの系統のエラーは**再試行せず**、人に知らせる
- `remoteId` が付いたら二度と送らない（二重投稿の防止）
- 告知は、YouTube / TikTok の公開 URL が決まってから動く（依存関係）
- 予約投稿: YouTube と Facebook のページは API の予約機能を使う。それ以外はアプリのキューで予約する（その時刻にアプリが起動している必要があることを表示する）

## クォータと費用

| 出力先 | 内容 |
|---|---|
| YouTube | `videos.insert` は1日100回（2026-06 から別枠）。そのほかは1日 10,000 ユニット（サムネイル約50、字幕400） |
| X | API は従量課金。既定の Intent なら費用なし |
| TikTok / Instagram / Threads / Facebook | 無料（1日あたりの投稿数に上限あり） |

## 投稿の履歴

`~/.solocut/publish-history.jsonl` とプロジェクトの `timeline.json` の `outputs[].publish` に、出力先・URL・公開範囲・開示の項目（AI 生成、合成コンテンツ、子ども向け、ブランドコンテンツ）・日時・使った方式（公式 API / BYO / Intent）を記録する。

## 運営側で用意するもの

アカウントはすべて `takumi.endoh@japan-marketing.co.jp` で作る。

- **共通**: solocut.app のプライバシーポリシーと利用規約（YouTube の利用規約・Google のプライバシーポリシー・取り消し方法・データの削除手順を含む）、1024px のアイコン、サポートの連絡先
- **Google Cloud**: 本番用のプロジェクト、YouTube Data API v3、OAuth の同意画面（外部・本番）、デスクトップのクライアント ID、Search Console でのドメインの確認、デモ動画、OAuth の検証の申請、YouTube API の監査とクォータの増枠の申請。**未監査のプロジェクトからの投稿が非公開に限定されるか**は、ドキュメントの記述が食い違っているため実機で確認する
- **TikTok for Developers**: 組織とアプリ（デスクトップ）、Login Kit、Content Posting API、サンドボックス、必須の表示を満たした画面とデモ動画、審査と Direct Post の監査
- **Meta for Developers**: ビジネスポートフォリオとビジネス認証、アプリ（Instagram・Threads・Facebook Login for Business）、権限ごとの画面録画、App Review
- **X Developer**: Native App（PKCE）。Intent を既定にするので、運営としての課金は不要
- **インフラ**: トークン交換の Worker、一時置き場の R2（自動で消す）
