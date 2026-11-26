# Reservestock 操作プラグイン（Claude Code 用）

Claude Code から、リザストのメルマガ・イベント・個別予約・顧客などをAPIで参照・操作できるようにするプラグインです。

## 必要なもの

- Claude Code（CLI またはデスクトップアプリ）
- リザストの API実行キー（管理画面「API設定」 https://www.reservestock.jp/api_config で発行）
  - 参照だけなら「参照専用」、作成・更新もさせるなら必要な機能に「変更・実行」を付けたキーにしてください。

## 入れ方

Claude Code で次を実行します。

```
/plugin marketplace add junpeisouma-hash/reservestock
/plugin install reservestock@reservestock
```

デスクトップアプリでは、入力欄の「＋」→「プラグイン」から追加することもできます。

有効化するときに「リザスト API実行キー」を聞かれるので、発行したキーを貼り付けます（OSの資格情報ストアに保存され、設定ファイルには書かれません）。入れた後は Claude Code を再起動するか `/reload-plugins` を実行してください。

## 使い方

普段どおりに頼むだけです。

- 「リザストのメルマガ一覧を見せて」
- 「来週のイベントの申込者数を教えて」
- 「◯◯メルマガに、このテーマで記事の下書きを作って」
- 「イベント12345の告知文の誤字を直して」

配信・メール送信・削除・入金確認・返金など取り消せない操作は、実行前に内容を示して確認を求めます。また Claude Code の許可設定で、変更系ツール（`api_post`）の実行ごとに許可を求めるようにできます。

## 中身

| ファイル | 役割 |
|---|---|
| `.claude-plugin/plugin.json` | プラグイン定義（APIキーの入力欄） |
| `.mcp.json` | リザストのMCP窓口（https://www.reservestock.jp/api/mcp）への接続設定 |
| `skills/reservestock/SKILL.md` | Claude への操作手順 |

MCPツール（リザスト側の窓口が提供）:

- `reference` … APIリファレンス（AIエージェント用）を検索
- `api_get` … GET で参照
- `api_post` … POST で作成・更新・削除・配信

このプラグイン自体はプログラムを含みません。APIキーは Authorization ヘッダーでリザストの窓口に送られ、窓口はキーの権限・月間回数の範囲で既存のAPIを呼びます。
