<div align="center">
<h1>Discord通知Self-Bot</h1>

[![Node.js](https://img.shields.io/badge/Node.js-22-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![discord.js-selfbot-v13](https://img.shields.io/badge/discord.js--selfbot--v13-5865F2?style=flat-square&logo=discord&logoColor=white)](https://github.com/aiko-chan-ai/discord.js-selfbot-v13)
[![Angelic-Angel](https://img.shields.io/badge/X-Web%20Push-000000?style=flat-square&logo=x&logoColor=white)](https://github.com/sh1ma/Angelic-Angel)

Discordのイベント・VC入室・Xの投稿を、指定チャンネルにお知らせするSelf-Botです。
</div>
<br/>

## なんのためにつくった...?

イベントの追加やステージ・作業配信の開始、対象ユーザーの投稿をDiscordでまとめて確認するために作りました。
通知ごとにロールをメンションできます。

## 軽い説明

Discordのイベントを監視し、設定したユーザーの活動を通知します。
Xの投稿は [Angelic-Angel](https://github.com/sh1ma/Angelic-Angel) 経由でWeb Pushを受信します。
使用するXアカウントで対象ユーザーをフォローし、投稿通知をオンにしてください。

## 特徴など...

* **イベント通知:** 指定サーバーの新しいイベントをリンク付きで通知します。
* **VC入室通知:** 指定ユーザーの入室を通知します。通知のクールダウンは3分です。
* **X投稿通知:** 対象ユーザーの投稿リンクを通知し、投稿IDで重複を除外します。
* **外形監視:** 任意の監視先へ1分ごとにハートビートを送ります。

配信の自動開始・停止には対応していません。
X通知はホームTL全体の取得ではなく、全投稿の配送やリプライ・リポスト除外は保証しません。

## セットアップ

`.env` に `DISCORD_TOKEN`・`TWITTER_AUTH_TOKEN`・`TWITTER_CT0` を設定し、`config.json` に通知先と監視対象を指定します。
`state.json` がなければ `{}` を内容とするファイルを作成してください。

```bash
docker compose --profile twitter-push up -d --build
```

Angelic-Angelの初回登録は自動です。認証情報と登録情報はGitに含めません。
設定項目やログの確認方法は [運用ドキュメント](docs/operations.md) にまとめています。

## 本番の更新

`main` へのpush → GitHub ActionsでGHCRにイメージ公開 → Image Updater / Argo CDでk3sへ反映します。
本番のマニフェストは [vpsリポジトリ](https://github.com/y-exe/vps) で管理しています。
本番の監視対象はPVC上の設定を使用するため、このリポジトリの `config.json` をpushしても上書きされません。

## ファイル構成

`src/discord` にイベント・VC通知、`src/twitter` にX通知、`src/storage` に状態保存、`src/monitoring` に監視処理をまとめています。
`src/app.js` が各機能を組み立て、ルートの `index.js` は起動だけを担当します。テストは `tests` にあります。

---

© 2026 yexe
