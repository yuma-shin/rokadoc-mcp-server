# rokadoc MCP Server

NTTドコモビジネスが提供するRAGサービス「[rokadoc](https://rokadoc.ntt.com)」の機能を、Model Context Protocol (MCP) を介してAIアシスタントから利用可能にするサーバーです。

VS Code、Kiro、Claude Desktop等のMCPクライアントから、ドキュメント変換やRAG検索をツールとして直接呼び出せます。

## クイックスタート

```bash
ROKADOC_API_KEY=<your-api-key> npx rokadoc-mcp-server
```

Windows (PowerShell) の場合:

```powershell
$env:ROKADOC_API_KEY="<your-api-key>"; npx rokadoc-mcp-server
```

MCPサーバーは標準入出力（stdio）でMCPクライアントと通信します。通常は手動で起動せず、後述の「MCPクライアント設定例」のとおりクライアント側に登録してください。

## バージョン指定

| 指定方法                        | コマンド例                          | 説明                             |
| ------------------------------- | ----------------------------------- | -------------------------------- |
| 特定バージョン固定              | `npx rokadoc-mcp-server@1.0.7`      | `@<version>` で固定              |
| 最新リリース                    | `npx rokadoc-mcp-server@latest`     | 常に最新版を取得                 |
| メジャーバージョン追従 (`^`)    | `npx "rokadoc-mcp-server@^1.0.0"`   | v1系の最新（破壊的変更を除外）   |
| マイナーバージョン追従 (`~`)    | `npx "rokadoc-mcp-server@~1.0.0"`   | v1.0系の最新（パッチ更新のみ）   |

安定運用にはメジャーバージョン追従（`^1.0.0`）の利用を推奨します。破壊的変更はメジャーバージョンアップ時のみ行われます。範囲指定（`^` / `~`）はシェルが解釈しないよう引用符で囲んでください。

## 前提条件

- **Node.js**: `>=22`（`node --version` で確認できます）
- **rokadoc API Key**: rokadocサービスへの認証に使用するAPIキー

Node.jsのバージョンが不足している場合、インストール時に `EBADENGINE` の警告が出力されます。

## 環境変数

| 環境変数           | 必須   | デフォルト値                  | 説明                   |
| ------------------ | ------ | ----------------------------- | ---------------------- |
| `ROKADOC_API_KEY`  | はい   | -                             | rokadoc APIの認証キー  |
| `ROKADOC_BASE_URL` | いいえ | `https://api.rokadoc.ntt.com` | rokadoc APIのベースURL |

`ROKADOC_API_KEY` が未設定の場合、サーバーは標準エラー出力にエラーメッセージを出力して終了コード1で終了します。

オンプレミス環境のrokadocインスタンスに接続する場合は `ROKADOC_BASE_URL` を設定してください。URLは `https://` で始まる必要があり、`http://` は自動的に `https://` に変換され、末尾のスラッシュは除去されます。

## 提供ツール

| ツール                  | 説明                               | 種別         |
| ----------------------- | ---------------------------------- | ------------ |
| `convert_document`      | ドキュメントを構造化テキストに変換 | 書き込み     |
| `list_conversions`      | 変換ジョブ一覧を取得               | 読み取り専用 |
| `get_conversion_result` | 変換結果を取得                     | 読み取り専用 |
| `search_documents`      | RAG検索を実行                      | 読み取り専用 |

全ツールで `space_id` または `space_name` によるスペース指定が可能です。

各ツールはMCP仕様のアノテーションヒント（`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`）を宣言しており、MCPクライアントが実行前にユーザーへ影響範囲を提示できます。いずれのツールも既存データの削除・上書きは行いません。詳細は[GitHubのREADME](https://github.com/yuma-shin/rokadoc-mcp-server#ツールアノテーション)を参照してください。

## MCPクライアント設定例

### VS Code / Kiro

`.vscode/mcp.json` または `.kiro/settings/mcp.json` に以下をそのまま追加します。

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "rokadoc-api-key",
      "description": "rokadoc API Key",
      "password": true
    }
  ],
  "servers": {
    "rokadoc": {
      "command": "npx",
      "args": ["-y", "rokadoc-mcp-server"],
      "env": {
        "ROKADOC_API_KEY": "${input:rokadoc-api-key}"
      }
    }
  }
}
```

バージョンを固定する場合は `args` を `["-y", "rokadoc-mcp-server@1.0.7"]` に置き換えてください。

### Claude Desktop

`claude_desktop_config.json` に以下をそのまま追加します（Claude Desktopは `mcpServers` キーを使用します）。

```json
{
  "mcpServers": {
    "rokadoc": {
      "command": "npx",
      "args": ["-y", "rokadoc-mcp-server"],
      "env": {
        "ROKADOC_API_KEY": "<your-api-key>"
      }
    }
  }
}
```

オンプレミス環境に接続する場合は `env` に `ROKADOC_BASE_URL` を追加します。

```json
{
  "mcpServers": {
    "rokadoc": {
      "command": "npx",
      "args": ["-y", "rokadoc-mcp-server"],
      "env": {
        "ROKADOC_API_KEY": "<your-api-key>",
        "ROKADOC_BASE_URL": "https://rokadoc.your-company.com"
      }
    }
  }
}
```

`args` には必ず `-y` を含めてください。未インストール時に `npx` が確認プロンプトを表示すると、MCPのハンドシェイクが成立しません。

## ファイルパスの扱い

`convert_document` の `file_path` には、**ホストの絶対パスをそのまま**指定できます。パスの読み替えやボリュームマウントの設定は不要です。

Windows の例:

```
C:\Users\username\Documents\report.pdf
```

macOS / Linux の例:

```
/Users/username/Documents/report.pdf
```

MCPサーバーはクライアントと同じホスト上のプロセスとして動作するため、ファイルシステムはそのまま見えます。

## プロンプト例

MCPクライアント設定後、AIアシスタントのチャットに以下のように入力するだけで各ツールが呼び出されます。

### ドキュメントを変換する

```
C:\Users\username\Documents\提案書.pdf をrokadocで変換してください
```

スペースを指定する場合:

```
/Users/username/reports/月次報告.pdf を「営業部」スペースに変換してください
```

ページ範囲を指定する場合:

```
/Users/username/docs/仕様書.docx の1〜5ページを変換してください
```

### 変換ジョブの状態を確認する

```
rokadocの変換ジョブ一覧を確認してください
```

### 変換結果を取得する

```
変換が完了したジョブの結果を取得してください
```

### 社内ドキュメントを検索する

```
rokadocで「リモートワークの申請方法」について検索してください
```

タグで絞り込む場合:

```
タグ「人事」に絞って「有給休暇の取得条件」を検索してください
```

特定のスペースから検索する場合:

```
「総務部」スペースから「出張精算の手順」を検索してください
```

### ドキュメント登録から検索までの一連の流れ

```
1. /Users/username/docs/新入社員ガイド.pdf を変換してください
2. ジョブの状態を確認してください
3. 完了したら「入社手続きに必要な書類」について検索してください
```

## 対応ファイル形式

PDF (.pdf), Word (.doc, .docx), Excel (.xls, .xlsx), PowerPoint (.ppt, .pptx)

## ソースコード

[GitHub](https://github.com/yuma-shin/rokadoc-mcp-server)

## ライセンス

MIT
