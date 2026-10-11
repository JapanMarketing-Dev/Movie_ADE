# 07. 配布・自動更新・サイト

最終更新: 2026-10-11

## 全体像

```
GitHub Actions（タグを push）
  ├─ 3つのOSでビルド（mac: dmg / zip、win: NSIS、linux: AppImage / deb）
  ├─ SHA256SUMS を作り、Ed25519 で署名する（署名の鍵は R2 の書き込み権限とは別に保管）
  └─ GitHub Releases に置く（ソースと一緒に、誰でも検証できる）
          │
          ▼  公開スクリプト（stage → 確認 → promote）
Cloudflare R2（downloads.solocut.app）
  ├─ releases/<version>/  インストーラー、更新用のファイル、manifest.json、SHA256SUMS(.sig)
  ├─ latest.json          最新の正式版
  ├─ toolchain.json(.sig) ツールの推奨バージョン（ffmpeg、whisper.cpp など）とハッシュ値
  ├─ agents.json(.sig)    エージェントCLIの一覧（起動・更新のコマンド）
  ├─ library-terms.json(.sig)      素材サイトの規約の要約（[16](./16_asset_library.md)）
  ├─ publish-capabilities.json(.sig) 各 SNS の審査の状態と使える投稿方式（[14](./14_publishing.md)）
  ├─ library-catalog.json(.sig)   素材の目録（id、タグ、ライセンス、ハッシュ値、場所）
  └─ library/             効果音・BGM・イラストの素材を1つずつ（再配布が許されたものだけ。都度ダウンロード）
          │
          ▼
Cloudflare Workers の静的アセット（solocut.app）  ダウンロードページ。latest.json を読んで、OS ごとのボタンを出す
Cloudflare Worker（auth.solocut.app）  SNS の OAuth のトークン交換だけ（[14](./14_publishing.md)）。トークンは保存しない
```

サーバー側の処理は、SNS のトークン交換の Worker だけ（トークンも動画も保存しない）。あとは静的サイトと R2 なので、費用はほぼかからない。

## アプリの自動更新

- 起動から少し経ったとき・6時間ごと・スリープからの復帰時に、`latest.json` を確認する
- 新しい版があれば、`SHA256SUMS.sig` をアプリに埋め込んだ公開鍵で検証し、ファイルのハッシュ値が一致したものだけを入れる。R2 だけを書き換えられても、偽の版は入らない
- ダウンロードは裏で行い、**アプリを閉じるとき**に入れ替える。撮影中・書き出し中は再起動を促さない
- OSごとの入れ替え方法:
  - macOS: Squirrel.Mac（zip）。Apple の Developer ID による署名と公証が必要。Apple のアカウントは `takumi.endoh111@gmail.com`
  - Windows: NSIS のインストーラーを静かに実行する。コード署名は当面なし（SmartScreen の警告の対処をサイトで案内する）
  - Linux: AppImage はファイルを置き換える。deb は新しい版の案内だけ出す

## ツールとエージェントの一覧の更新

- `toolchain.json` と `agents.json` も同じ鍵で署名し、アプリの更新とは別に、1日1回確認する
- ツールの新しい版は、**新しいプロジェクトから**使う。既存のプロジェクトは `solocut.json` に記録したバージョンのまま書き出す（結果が変わらないように）。利用者が明示したときだけ上げる

## サイト（solocut.app）

- Cloudflare Workers の静的アセット（Worker 名 `solocut-site`、`wrangler.jsonc`）。Pages は Workers に統合されたため、こちらを使う。ビルドの工程はなし（`node tools/site/build.mjs` で HTML を生成し、`site/` をそのまま公開する）
- 公開済み: https://solocut.app（英語）、https://solocut.app/ja（日本語）
- `www.solocut.app` も Worker のカスタムドメインにつなぎ、ゾーンのリダイレクトルール（`http_request_dynamic_redirect`）で `https://solocut.app` へ 301 で転送する（パスとクエリは引き継ぐ）。ゾーンの「常に HTTPS を使用」は有効
- 構成: トップ（何ができるか、デモ動画、ダウンロードボタン）、ダウンロード（OS ごと、チェックサム）、ドキュメント（テンプレート、CLI、判定モデル）、プライバシー、ライセンス
- 日本語と英語
- `_headers` で CSP とキャッシュを設定する

## リリースの手順

1. `package.json` のバージョンを上げ、リリースノートを書く
2. タグを push すると CI がビルドし、GitHub Releases に下書きを作る
3. 公開スクリプトで R2 の `releases/<version>/` に置く（stage）。GitHub Releases の SHA256SUMS と一致しない場合は止まる
4. 自分の端末で、stage した版を入れて確認する
5. promote で `latest.json` を差し替える（このとき初めて利用者に届く）

## クラッシュレポート

- Sentry（`takumi.endoh@japan-marketing.co.jp` の組織）。既定はオンで、設定から切れる
- 送るのはスタックトレースと環境の情報だけ。動画・音声・文字起こし・ファイルのパスは送らない
