# 14. 投稿（YouTube・TikTok）

最終更新: 2026-10-11（TikTok の API は 2026-10 時点の公式ドキュメントで確認）

## 目指すこと

「動画ができて、人がチェックして OK すれば投稿される。細かいところは Claude Code がやる。」

```
動画が完成（renders/youtube/final.mp4）
  → エージェントが publish.json（タイトル・説明・タグ・投稿先・サムネイル）を書く
  → 人が「投稿」画面で動画・サムネイル・publish.json の中身を見る
      直したいところは「AI に直してもらう」に一言書いて送る
  → 「OK・投稿する」→ アプリが `publish` プロンプトをエージェントに送る
  → エージェントが publish.json を見直し、`solocut publish upload` を実行
  → アプリが自分のトークンで YouTube / TikTok にアップロードし、結果を返す
  → 結果は画面に出て、timeline.json の outputs[].publish に記録される
```

投稿は1本ずつ。1本の 16:9 の動画を YouTube と TikTok（任意）に上げる。Instagram・X・Threads・Facebook・告知・投稿履歴の画面・縦型の別版（Shorts / TikTok 用の派生）はない。

## publish.json

プロジェクト直下。AI（エージェント）が書き、アプリは読むだけ（サムネイルを選んだときだけ `thumbnail` を書き換える。ほかの項目はそのまま残す）。

```json
{
  "video": "renders/youtube/final.mp4",
  "thumbnail": "thumbnails/thumb-1.png",
  "title": "…", "description": "…", "tags": ["…"],
  "youtube": { "categoryId": "28", "privacy": "private|unlisted|public", "publishAt": "ISO（任意）",
               "madeForKids": false, "containsSyntheticMedia": false, "chapters": true },
  "tiktok": { "enabled": false, "caption": "…", "privacy": "SELF_ONLY|MUTUAL_FOLLOW_FRIENDS|FOLLOWER_OF_CREATOR|PUBLIC_TO_EVERYONE",
              "allowComment": false, "allowDuet": false, "allowStitch": false, "isAigc": false }
}
```

- パスはプロジェクトからの相対パス。プロジェクトの外を指すものは使わない。
- `youtube.enabled`（省略時 true）で YouTube をオフにできる。`tiktok.enabled` の省略時は false。
- 読み込みは `apps/desktop/src/shared/publish.ts` の `parsePublishJson`。例外を投げず、問題は「直すところ（error）」と「お知らせ（warning）」で返す。

| 項目 | 決まり | 違反したとき |
|---|---|---|
| title | 必須、100 文字（コードポイント）まで、`<` `>` 不可 | YouTube だけ止まる |
| description | 5000 バイト（UTF-8）まで、`<` `>` 不可 | YouTube だけ止まる |
| tags | 合計 500 文字まで（YouTube の数え方: 区切りと、空白を含むタグの引用符も数える）。`#` は外し、重複は除く | YouTube だけ止まる |
| youtube.privacy | 省略・不明な値は設定の `publish.youtube.privacy`（既定 private） | お知らせ |
| youtube.publishAt | 未来の日時。指定すると private で上げて指定日時に公開 | 過去・不正は YouTube が止まる |
| tiktok.caption | 2200 文字（UTF-16）まで。空ならタイトル＋ハッシュタグ | TikTok だけ止まる |
| tiktok.privacy | 省略・不明な値は設定の `publish.tiktok.privacy`（既定 SELF_ONLY）。アカウントが選べない値なら SELF_ONLY に下げる | お知らせ |
| video | ファイルがないと全部止まる | |
| thumbnail | PNG / JPEG。ないときはサムネイルなしで上げる | お知らせ |

投稿画面では投稿先ごとに公開範囲を選べる（選ぶとこの動画の publish.json に書く。書かれていなければ「設定の既定値」と表示）。投稿の直前には「YouTube に『非公開』で投稿します」「TikTok に『自分のみ』で投稿します」のように、公開範囲を必ず出す。

画面の「OK・投稿する」は、直すところがあっても押せる（投稿プロンプトでエージェントが先に直す）。押せないのは、動画がない・投稿先がない・YouTube に未接続・アップロード中・この動画を投稿済みのとき。

## アップロードの受け渡し（CLI ⇄ アプリ）

OAuth のトークンはアプリ（safeStorage）にしかないので、エージェントはアプリにアップロードを頼む。

```
solocut publish upload [--target youtube|tiktok] [--force] [--timeout <秒>] [--json]
```

1. CLI が `.solocut/publish-request.json` を書く: `{ "id": "<uuid>", "targets": [], "at": "ISO", "force"?: true }`（`targets` が空なら publish.json でオンの投稿先すべて）。
2. アプリは開いているプロジェクトを監視していて（fs.watch ＋ 2 秒ごとの確認）、受け取るとすぐ `.solocut/publish-result.json` に `{ id, state: "running", progress? }` を書き、終わると `{ id, state: "done", results: [{ target, ok, url?, status?, error?, alreadyPublished?, warnings? }], error? }` を書く。
3. CLI は同じ id の結果を待って表示する。失敗が1つでもあれば終了コード 1（`publish-failed`、結果は details に入る）。
4. 30 秒たってもアプリが受け取らなければ「Solocut アプリが応答しません。起動してこのプロジェクトを開いてください」（`app-not-running`）。頼みは取り下げる（後でアプリを開いたときに勝手に投稿されないように）。
5. `--timeout`（既定 3600 秒）を過ぎても終わらなければ `timeout`。

二重投稿を防ぐ仕組み:

- 同じ id の頼みは二度と実行しない（アプリを再起動しても、結果ファイルに同じ id があれば実行しない）。
- アップロードは `.solocut/publish-log.json` に記録する（投稿先・動画のパス・サイズ・URL）。同じファイル（パスとサイズが同じ）を同じ投稿先へは上げ直さず、前の URL を `alreadyPublished: true` で返す。上げ直すときは `--force`。
- 同じプロジェクトで同時に2つは走らない。途中で来た頼みは、今のアップロードが終わってから処理する。
- 10 分以上前の頼み（受け取られないまま）は無視する。
- アプリが途中で終了して `running` のまま残った結果は、次に見たときに「中断されました」で閉じる（自動では上げ直さない）。

結果は `solocut publish record`（timeline.json の outputs[].publish と publish の手順）にも記録する。TikTok の受信トレイ送り（下書き）は `draft` として記録する。

## アカウントの接続（ボタン1つ）

設定 → アカウントに YouTube と TikTok の行がある（`components/PublishAccounts.tsx`）。「接続」を押すとブラウザで同意画面が開き、戻れば終わり。接続したチャンネル名・表示名を出す。

### YouTube

- Solocut 自身の Google OAuth クライアント（デスクトップアプリ型）を同梱する。利用者が Google Cloud でクライアントを作る必要はない。
- ビルド時に main へ埋め込む（`electron.vite.config.ts` の `define` → `import.meta.env.MAIN_VITE_SOLOCUT_*`、`main/publish/buildEnv.ts`）。値の取り方は、環境変数 `SOLOCUT_YOUTUBE_CLIENT_ID` / `SOLOCUT_YOUTUBE_CLIENT_SECRET` → `MAIN_VITE_SOLOCUT_*` → なければ Google のクライアント JSON（`~/.solocut-release/google-oauth-client.json`、場所は `SOLOCUT_GOOGLE_OAUTH_JSON` で変えられる）。値はリポジトリに入れない。開発中は実行時の環境変数 `SOLOCUT_YOUTUBE_CLIENT_ID` / `_SECRET`、または以前の設定で保存したクライアント ID でも動く。どれもないときは、ボタンの代わりに「この版には YouTube 接続の設定が入っていません」と表示する。
- システムのブラウザ ＋ PKCE（S256）＋ ループバック（`http://127.0.0.1:<空きポート>`）。スコープは `youtube.upload` と `youtube.force-ssl`（チャンネル名の取得 `channels.list mine=true` にも使う）。
- アップロードは再開可能アップロード（`videos.insert`、8 MiB ごと、429 / 5xx は指数バックオフで再開）。その後 `thumbnails.set`（2 MB まで）。サムネイルの失敗は警告で、動画は上げ直さない。
- リフレッシュトークンは safeStorage（`youtube.refreshToken`）。解除で取り消す。
- Google の審査（機密スコープ）が通るまではテストユーザーだけが使え、7 日ごとに再接続が要る。

### TikTok

- Login Kit for Desktop: `https://www.tiktok.com/v2/auth/authorize/`、PKCE（TikTok のデスクトップ版はチャレンジを SHA-256 の **16 進**で渡す）。リダイレクトは固定で `http://127.0.0.1:47823/tiktok/callback`（開発者ポータルには `http://localhost:47823/tiktok/callback` と2つ登録済み）。ポート 47823 が使われていると「ポート 47823 が他のアプリに使われています」と出す。スコープは `user.info.basic,video.upload`（Direct Post を使うときは `video.publish` も）。
- トークンの交換にはクライアントシークレットが要るので、アプリには入れない。交換は Solocut の Cloudflare Worker（`tools/oauth-worker`、名前 `solocut-oauth`、ルート `solocut.app/oauth/*`）が行う:
  - `POST /oauth/tiktok/token`（form: `client_key`・`code`・`code_verifier`・`redirect_uri`。登録した2つのリダイレクト以外は 400）
  - `POST /oauth/tiktok/refresh`（form: `client_key`・`refresh_token`）
  - `POST /oauth/tiktok/revoke`（form: `client_key`・`token`。解除のとき）
  - アプリが送る `client_key` で本番（`TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET`）かサンドボックス（`TIKTOK_SANDBOX_CLIENT_KEY` / `TIKTOK_SANDBOX_CLIENT_SECRET`）かを選ぶ。どちらでもないキーは 400。
  - Worker が `client_key` / `client_secret` を足して `https://open.tiktokapis.com/v2/oauth/token/`（取り消しは `/v2/oauth/revoke/`）へ送り、TikTok の JSON を状態コードごとそのまま返す。ログも保存もしない（`Cache-Control: no-store`、observability オフ）。シークレットは wrangler の secret。
- アクセストークン 24 時間、リフレッシュトークン 365 日（更新時に変わることがある）。safeStorage の `tiktok.tokens` に保存。
- ビルド時の設定: `SOLOCUT_TIKTOK_CLIENT_KEY`。なければ `~/.solocut-release/tiktok-<SOLOCUT_TIKTOK_ENV>.env` の `TIKTOK_CLIENT_KEY` だけを読む（`SOLOCUT_TIKTOK_ENV=sandbox|production`、既定 sandbox。TikTok の審査が通ったらリリースのビルドで production。ファイルの場所は `SOLOCUT_TIKTOK_ENV_FILE` でも指定できる。シークレットは読まない）。交換先は `SOLOCUT_TIKTOK_TOKEN_URL`（既定 `https://solocut.app/oauth/tiktok`。開発中は `wrangler dev` の `http://127.0.0.1:8787/oauth/tiktok` も可）。審査後は `SOLOCUT_TIKTOK_DIRECT_POST=1`。
- Worker のデプロイ（`tools/oauth-worker` で）: `npx wrangler login`（takumi.endoh@japan-marketing.co.jp）→ `npx wrangler secret put` を `TIKTOK_CLIENT_KEY`・`TIKTOK_CLIENT_SECRET`・`TIKTOK_SANDBOX_CLIENT_KEY`・`TIKTOK_SANDBOX_CLIENT_SECRET` の4つ → `npx wrangler deploy`。手元の確認は `npx wrangler dev`（`.dev.vars` に値。コミットしない）。
- 投稿の既定は受信トレイ送り（`/v2/post/publish/inbox/video/init/`、`video.upload`）。動画は TikTok アプリの受信トレイに届き、本人がアプリで仕上げて投稿する。審査後は Direct Post（`/v2/post/publish/video/init/`、先に `creator_info/query` で選べる公開範囲を確かめる）。未審査のアプリは非公開（SELF_ONLY）でしか投稿できない。
- アップロードは分割: 1 つ 5 MB 以上 64 MB 以下、個数は `floor(サイズ / チャンクサイズ)`、余りは最後に足す（最後は 128 MB まで）、5 MB 未満は1回、最大 1000 個。その後 `status/fetch` で `SEND_TO_USER_INBOX` / `PUBLISH_COMPLETE` / `FAILED` を待つ。
- 設定が入っていない間は「TikTok との接続は準備中です」と出し、「TikTok を開いてアップロード」（動画を Finder で表示して TikTok Studio のアップロード画面を開く）で、ボタン1つで手で上げられるようにする。

## サムネイル

- 動画のフレームをそのまま使う必要はない。動画の内容から、エージェントが Codex（ChatGPT のサブスクの画像生成）か Gemini CLI（Gemini のサブスク）で作り、`thumbnails/` に保存する。アプリに API キーでの画像生成はない。
- 「サムネイル」画面は `thumbnails/` の PNG / JPEG（1 階層下まで）を新しい順に並べる。クリックで選ぶと publish.json の `thumbnail` になる（もう一度クリックで外す）。
- 「サムネを作ってもらう」はエージェントに短い依頼を送る（3 枚、1280x720、thumbnails/thumb-1.png〜、一番良いものを publish.json に入れる）。

## 実装の場所

| 何 | どこ |
|---|---|
| publish.json の解析・制限・受け渡しファイルの形・OK ボタンの状態 | `apps/desktop/src/shared/publish.ts` |
| 受け渡し（監視・二重投稿の防止・結果の書き込み） | `apps/desktop/src/main/publish/handoff.ts` |
| 画面のデータ・サムネイルの書き込み | `apps/desktop/src/main/publish/publish.ts`、`main/services/thumbs.ts` |
| YouTube / TikTok | `main/publish/youtube.ts`、`tiktok.ts`（純粋な部分は `oauth.ts`、`tiktokApi.ts`）、ループバック `loopback.ts`、設定 `config.ts`・ビルド時 `buildEnv.ts` |
| TikTok のトークン交換 | `tools/oauth-worker`（Cloudflare Worker） |
| 画面 | `renderer/src/screens/Publish.tsx`、`Thumbnails.tsx`、`components/PublishAccounts.tsx` |
| CLI | `packages/cli/src/commands/publish.ts`（`upload` / `record`） |
