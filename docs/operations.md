# 設定・運用の詳細

<div align="center">
<h1>Discord通知Self-Bot</h1>

[![Node.js](https://img.shields.io/badge/Node.js-22-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![discord.js-selfbot-v13](https://img.shields.io/badge/discord.js--selfbot--v13-5865F2?style=flat-square&logo=discord&logoColor=white)](https://github.com/aiko-chan-ai/discord.js-selfbot-v13)
[![Angelic-Angel](https://img.shields.io/badge/X-Web%20Push-000000?style=flat-square&logo=x&logoColor=white)](https://github.com/sh1ma/Angelic-Angel)
[![Build](https://github.com/y-exe/notice-selfbot/actions/workflows/ghcr-publish.yml/badge.svg)](https://github.com/y-exe/notice-selfbot/actions/workflows/ghcr-publish.yml)

Discordのイベント・VC入室・Xの投稿を、指定チャンネルにお知らせするSelf-Botです。<br>
自宅サーバーのk3s上で稼働し、GitHub ActionsとArgo CDで更新します。
</div>
<br/>

## なんのためにつくった...?

イベントの追加やステージ・作業配信の開始、対象ユーザーの投稿をDiscordのひとつのチャンネルで確認するために作りました。
通知ごとにロールメンションを設定できます。

## 軽い説明

`index.js` から `src/app.js` を起動し、各機能のモジュールがDiscordのイベントを監視します。Xの投稿通知は [Angelic-Angel](https://github.com/sh1ma/Angelic-Angel) がWeb Pushを受信し、ローカルWebhookへ転送します。
受信側が `config.json` の対象ユーザーを照合し、投稿へのリンクをDiscordに送信します。

通知を受け取るXアカウントで、対象ユーザーのフォローと投稿通知の有効化が必要です。
ホームTL全体の取得ではなく、Xが配信した通知の受信です。Bot検知されないことや、全投稿の配送は保証しません。

## 特徴など...

* **イベント通知:** 指定サーバーでイベントが作成されると、リンクを通知します。
* **VC入室通知:** 指定ユーザーが対象チャンネルに入ると通知します。同じ対象チャンネルへの通知には3分のクールダウンがあります。
* **X投稿通知:** 投稿URLをDiscordに通知し、直近1000件の投稿IDを保存して重複を除外します。
* **YouTube通知:** WebSubのPush(即時)とRSSポーリング(補完)の併用で動画・ライブ配信を通知します。URLは `youtu.be` の最短形、動画ID単位で重複除外するためライブ終了後のアーカイブ化で2重通知しません。
* **外形監視:** `WATCHER_PUSH_URL` を設定すると、1分ごとにハートビートを送ります。

配信の自動開始・停止、シーンやソースの切り替えには対応していません。
コマンド操作はなく、設定ファイルで監視対象を指定します。

## 設定

### config.json

| 項目 | 内容 |
| --- | --- |
| `NOTIFICATION_CHANNEL_ID` | Discordの通知先チャンネル |
| `EVENT_CREATION` | イベント通知の有効化・サーバー・ロール |
| `VOICE_STATE_UPDATES` | VC通知の対象ユーザー・サーバー・チャンネル・ロール |
| `TWITTER_UPDATES` | Xの対象ユーザー・有効化・ロール |
| `TWITTER_SOURCE` | 標準 `angelic-angel`。従来方式 `graphql` |
| `CHECK_INTERVAL_MIN_SECONDS` / `CHECK_INTERVAL_MAX_SECONDS` | GraphQL・YouTube RSS取得間隔。標準180〜300秒 |
| `YOUTUBE_UPDATES` | YouTubeの対象ハンドル・チャンネルID・有効化・ロール |
| `YOUTUBE_CHECK_INTERVAL_MIN_SECONDS` / `YOUTUBE_CHECK_INTERVAL_MAX_SECONDS` | YouTube RSS取得間隔(未設定時はCHECK_INTERVALを使用) |
| `YOUTUBE_WEBSUB_BASE_URL` | WebSubコールバックの公開HTTPSベースURL。未設定時はRSSのみ |

`TWITTER_UPDATES` は配列で複数のユーザーを登録できます。`enabled: false` の対象は通知しません。
`roleId: null` ならメンションしません。`state.json` は再起動後も保持してください。

### 環境変数

| 名前 | 用途 |
| --- | --- |
| `DISCORD_TOKEN` | Self-Botがログインするアカウントのトークン |
| `TWITTER_AUTH_TOKEN` / `TWITTER_CT0` | 通知をオンにしたXアカウントのCookie |
| `TWITTER_SOURCE` | 設定ファイルより優先する取得方式 |
| `WEBHOOK_ENDPOINT` | Angelic-Angelの送信先 |
| `ANGELIC_CONFIG_PATH` | 登録情報の保存先。標準 `/data/angelic-angel.toml` |
| `TWITTER_PUSH_HOST` / `TWITTER_PUSH_PORT` | Botの受信先。標準 `127.0.0.1:8787` |
| `YOUTUBE_API_KEY` | 任意。設定するとData APIでライブ状態(開始/予定)とタイトルを補強 |
| `YOUTUBE_WEBSUB_BASE_URL` | 任意。設定ファイルより優先するWebSubコールバックの公開ベースURL |
| `YOUTUBE_WEBSUB_HOST` / `YOUTUBE_WEBSUB_PORT` | WebSub受信先。標準 `127.0.0.1:8788` |
| `YOUTUBE_WEBSUB_SECRET` | 任意。WebSub通知のHMAC署名検証用 |
| `YOUTUBE_WEBSUB_LEASE_SECONDS` | 任意。購読期間(秒)。標準432000(5日)、8割経過で自動再登録 |
| `WATCHER_PUSH_URL` | 任意のハートビート送信先 |

トークン・Cookie・登録情報はGitに含めません。

## 本番の更新

構成は [vpsリポジトリ](https://github.com/y-exe/vps) の `apps/notifier` と `cluster/apps/notifier.yaml` で管理します。
k3sはyexeserverが管理し、Podの実行ノードは永続ボリュームの配置に従います。2026年10月9日の確認ではyexeserver2で稼働していました。

1. このリポジトリの `main` にpushすると、GitHub Actionsがテストし、BotとAngelic-Angelを含むイメージをGHCRへ公開します。
2. Argo CD Image Updaterが `ghcr.io/y-exe/notice-selfbot:latest` のdigest変更を検出し、Argo CDが更新します。
3. Kubernetes設定の変更は `vps` の `master` にpushすると同期されます。

READMEだけの変更ではイメージをビルドしません。
BotとAngelic-Angelは同じPodで起動し、Webhookは `127.0.0.1` で通信します。Service・Ingressでの外部公開は不要です。
既存の `notifier-env` Secretから認証情報を読み、`notifier-data` PVCに登録情報を保存します。
初回は受信側の起動を待って自動登録し、再起動時は保存済みの登録を再利用します。

本番の `config.json` と `state.json` はPVC上のファイルを使用します。
このリポジトリの `config.json` を編集してpushしても、既存PVCの設定は上書きされません。
監視対象の変更はPVC上の設定を変更してPodを再起動します。取得方式はDeploymentの環境変数で指定します。

```bash
# yexeserver上で確認
sudo -n kubectl -n apps get pods -l app=notifier -o wide
sudo -n kubectl -n apps logs deployment/notifier -c notifier --tail=50
sudo -n kubectl -n apps logs deployment/notifier -c angelic --tail=50
sudo -n kubectl -n argocd get application notifier
```

## ローカルで試す場合

Dockerを起動し、`.env` に以下を設定します。

```env
DISCORD_TOKEN=your_discord_token
TWITTER_AUTH_TOKEN=your_x_auth_token
TWITTER_CT0=your_x_ct0
YOUTUBE_API_KEY=your_youtube_api_key
```

`config.json` の通知先と対象ユーザーを設定し、Xでフォロー・投稿通知をオンにしてください。

```powershell
if (!(Test-Path state.json)) { '{}' | Set-Content -Encoding ascii state.json }
docker compose --profile twitter-push up -d --build
docker compose --profile twitter-push logs -f notifier angelic
```

初回登録は自動です。登録情報は `angelic-data` に保存します。
Webhookのポートはホストに公開せず、Compose内部からだけ接続します。

Node.jsで受信側だけ試す場合は `npm ci` → `npm start` で起動できます。Angelic-Angelは別途必要です。
受信処理のテストは `npm test` です。

## YouTube通知の仕組み

WebSub(即時Push)を本命、RSSポーリング(180〜300秒)を補完に使います。`YOUTUBE_WEBSUB_BASE_URL` 未設定のローカル・現行PodではRSSのみで動作します。

* 通知URLは常に `https://youtu.be/動画ID` の最短形です。
* 動画ID単位(直近1000件)で重複除外するため、ライブ終了後に同じIDでアーカイブ公開されても再通知しません。
* `YOUTUBE_API_KEY` があると開始/予定/投稿を区別します。なければRSSの情報で汎用文になります。
* 初回観測時は最新を基準として保存だけし、過去分を遡って通知しません。
* RSSは1秒連打せず、条件付き取得(`If-None-Match`等)+取得失敗時のバックオフで取得します。
* YouTubeがレート制限時に返す仮フィード(HTTP 200の静的XML)は異常扱いで再試行し、基準保存しません。

本番でWebSubを使う場合は `vps` 側に公開HTTPSのIngressと `YOUTUBE_WEBSUB_BASE_URL` の設定が必要です(現行はX同様に外部公開なし)。

## X通知の制限

上流は復号した通知JSONをそのまま転送します。受信側はJSON内のX/Twitterの `/ユーザー名/status/投稿ID` 形式のURLを扱います。
ユーザー名のない `/i/web/status/ID` などは照合できず無視します。未対応形式はトップレベルのキー名だけログに記録します。
実際の通知形式によっては受信処理の調整が必要です。

通知だけではリプライ・リポストを確実に判別できないため、その除外は保証しません。
Xが通知しない投稿や停止中の投稿をTL取得で補完しません。
上流はWebhookのHTTPエラーに対して再送しないため、Discord送信失敗時に通知が失われる可能性があります。

従来方式へ戻す場合は本番Deploymentの `TWITTER_SOURCE` を `graphql` に変更し、Angelic-Angelのコンテナを外します。
旧Nitter取得用のPythonスクリプトは削除済みです。アプリケーションの実装はJavaScriptに統一しています。

---

© 2026 yexe
