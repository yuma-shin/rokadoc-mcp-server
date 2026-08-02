# rokadoc MCP Server

NTTドコモビジネスが提供するRAGサービス「rokadoc」の機能を、Model Context Protocol (MCP) を介してAIアシスタントから利用可能にするサーバーです。

VS Code、Kiro、Claude Desktop等のMCPクライアントから、ドキュメント変換やRAG検索をツールとして直接呼び出せます。

## 前提条件

- **Docker**: コンテナのビルドおよび実行に必要
- **rokadoc API Key**: rokadocサービスへの認証に使用するAPIキー

## Docker Imageのビルド

```bash
docker build -t rokadoc-mcp-server .
```

## コンテナの起動

```bash
docker run -i --rm -e ROKADOC_API_KEY=<your-api-key> rokadoc-mcp-server
```

### 環境変数

| 環境変数           | 必須   | デフォルト値                  | 説明                   |
| ------------------ | ------ | ----------------------------- | ---------------------- |
| `ROKADOC_API_KEY`  | はい   | -                             | rokadoc APIの認証キー  |
| `ROKADOC_BASE_URL` | いいえ | `https://api.rokadoc.ntt.com` | rokadoc APIのベースURL |

### オンプレミス環境でのBase URL変更

オンプレミス環境のrokadocインスタンスに接続する場合は、`ROKADOC_BASE_URL` を設定してください。

```bash
docker run -i --rm \
  -e ROKADOC_API_KEY=<your-api-key> \
  -e ROKADOC_BASE_URL=https://rokadoc.your-company.com \
  rokadoc-mcp-server
```

注意事項:

- URLは `https://` で始まる必要があります
- `http://` を指定した場合、自動的に `https://` に変換されます（警告メッセージが出力されます）
- 末尾のスラッシュは自動的に除去されます

## MCPクライアント設定

### VS Code / Kiro

`.vscode/mcp.json` または `.kiro/settings/mcp.json` に以下を追加します。

`convert_document` でローカルファイルを変換する場合は、`-v` オプションでホストのディレクトリをコンテナにマウントしてください。以下の例ではホストのホームディレクトリ全体を `/workspace` にマウントしています:

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
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "ROKADOC_API_KEY",
        "-v",
        "${userHome}:/workspace",
        "rokadoc-mcp-server"
      ],
      "env": {
        "ROKADOC_API_KEY": "${input:rokadoc-api-key}"
      }
    }
  }
}
```

この設定では、ホスト上の `~/Documents/report.pdf` をコンテナ内で `/workspace/Documents/report.pdf` としてアクセスできます。`convert_document` ツールには **コンテナ内のパス** を指定してください。

例:

- ホスト: `C:\Users\username\Documents\report.pdf`
- コンテナ内（ツールに渡すパス）: `/workspace/Documents/report.pdf`

ファイル変換が不要でRAG検索のみ利用する場合はボリュームマウントなしで動作します:

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
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "ROKADOC_API_KEY",
        "rokadoc-mcp-server"
      ],
      "env": {
        "ROKADOC_API_KEY": "${input:rokadoc-api-key}"
      }
    }
  }
}
```

### Claude Desktop

`claude_desktop_config.json` に以下を追加します（Claude Desktopは `mcpServers` キーを使用します）:

```json
{
  "mcpServers": {
    "rokadoc": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "ROKADOC_API_KEY=<your-api-key>",
        "-v",
        "C:\\Users\\<username>:/workspace",
        "rokadoc-mcp-server"
      ]
    }
  }
}
```

### オンプレミス環境の場合

Base URLを変更する場合は `args` に環境変数を追加します:

```json
{
  "servers": {
    "rokadoc": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "ROKADOC_API_KEY",
        "-e",
        "ROKADOC_BASE_URL=https://rokadoc.your-company.com",
        "-v",
        "${userHome}:/workspace",
        "rokadoc-mcp-server"
      ],
      "env": {
        "ROKADOC_API_KEY": "${input:rokadoc-api-key}"
      }
    }
  }
}
```

## 提供ツール

全ツールは `space_id` または `space_name` パラメータを受け付けます。スペースを指定するとそのスペース内に限定して操作を行います。未指定時は全スペースが対象です。`space_name` を指定した場合、内部でスペース一覧API（`GET /v1/user/spaces/join`）を呼び出し、対応する `space_id` を自動的に解決します。

### convert_document

ドキュメントファイルをrokadocに送信し、構造化テキストへの変換を開始します。

**パラメータ:**

| パラメータ   | 型     | 必須   | 説明                                       |
| ------------ | ------ | ------ | ------------------------------------------ |
| `file_path`  | string | はい   | 変換対象のファイルパス                     |
| `from_page`  | number | いいえ | 変換開始ページ（正の整数）                 |
| `to_page`    | number | いいえ | 変換終了ページ（正の整数）                 |
| `space_id`   | string | いいえ | スペースID                                 |
| `space_name` | string | いいえ | スペース名（space_id未指定時に名前で解決） |

**対応ファイル形式:** PDF (.pdf), Word (.doc, .docx), Excel (.xls, .xlsx), PowerPoint (.ppt, .pptx)

**使用例:**

```
convert_document でファイル /path/to/document.pdf を変換してください
```

```
convert_document で /path/to/report.docx の1〜5ページを「営業部」スペースに変換してください
```

**レスポンス例:**

```json
{
  "code": 202,
  "status": "Pending",
  "conversion_id": "xxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

### list_conversions

変換ジョブの一覧を取得します。

**パラメータ:**

| パラメータ   | 型     | 必須   | 説明                                       |
| ------------ | ------ | ------ | ------------------------------------------ |
| `space_id`   | string | いいえ | スペースID                                 |
| `space_name` | string | いいえ | スペース名（space_id未指定時に名前で解決） |

**使用例:**

```
list_conversions で変換ジョブの状態を確認してください
```

```
list_conversions で「営業部」スペースのジョブ一覧を確認してください
```

**レスポンス例:**

```json
{
  "conversions": [
    {
      "conversion_id": "xxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "status": "Succeeded",
      "document_name": "sample.pdf",
      "created_date": "202501151030",
      "updated_date": "202501151031"
    }
  ]
}
```

### get_conversion_result

完了した変換ジョブの結果ドキュメントを取得します。

**パラメータ:**

| パラメータ      | 型     | 必須   | 説明                                       |
| --------------- | ------ | ------ | ------------------------------------------ |
| `conversion_id` | string | はい   | 変換ジョブID                               |
| `space_id`      | string | いいえ | スペースID                                 |
| `space_name`    | string | いいえ | スペース名（space_id未指定時に名前で解決） |

**使用例:**

```
get_conversion_result で conversion_id "xxxx" の結果を取得してください
```

**レスポンス例:**

```json
{
  "conversion_id": "xxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "document_name": "sample.pdf",
  "status": "Succeeded",
  "roka_response": {
    "meta": { "separate_method": "page" },
    "document_summary": "",
    "units": [
      {
        "unit": 1,
        "elements": [
          {
            "type": "text",
            "text": "変換されたテキスト内容...",
            "page": 1,
            "reading_order": 1
          }
        ],
        "description": "変換されたテキスト内容..."
      }
    ]
  }
}
```

### search_documents

rokadocに登録されたドキュメントに対してRAG検索を実行します。

**パラメータ:**

| パラメータ    | 型       | 必須   | 説明                                       |
| ------------- | -------- | ------ | ------------------------------------------ |
| `query`       | string   | はい   | 検索クエリ（1〜1000文字）                  |
| `tags`        | string[] | いいえ | タグフィルタ（AND条件）                    |
| `max_results` | number   | いいえ | 最大取得件数（デフォルト: 3、最大: 5）     |
| `space_id`    | string   | いいえ | スペースID                                 |
| `space_name`  | string   | いいえ | スペース名（space_id未指定時に名前で解決） |

**使用例:**

```
search_documents で「セキュリティポリシー」について検索してください
```

```
search_documents で「営業部」スペースから「売上報告」を検索してください
```

**レスポンス例:**

```json
{
  "results": [
    {
      "document_name": "セキュリティガイドライン.pdf",
      "context": "パスワードは最低12文字以上とし、英大文字・小文字・数字・記号を含める...",
      "page_number": 3,
      "conversion_id": "xxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "tags": ["セキュリティ"]
    }
  ]
}
```

## トラブルシューティング

### 認証エラー（HTTP 401/403）

```
[認証エラー] rokadoc APIへの認証に失敗しました。
```

**対処法:**

- 環境変数 `ROKADOC_API_KEY` に正しいAPIキーが設定されているか確認
- APIキーの有効期限が切れていないか確認
- APIキー前後に不要な空白が含まれていないか確認

### 接続エラー

```
[接続エラー] rokadoc APIに接続できません。
```

**対処法:**

- ネットワーク接続が正常か確認
- `ROKADOC_BASE_URL` が正しいURLを指しているか確認
- ファイアウォールやプロキシの設定を確認
- DNSが正しく解決できているか確認

### タイムアウト

```
[タイムアウト] rokadoc APIからの応答がありません。
```

**対処法:**

- rokadocサービスが稼働中か確認
- ネットワークの遅延が大きくないか確認
- 大きなファイルの変換の場合は時間がかかることがあります
- リクエストは自動的に最大3回リトライされます

### コンテナ起動エラー

**APIキー未設定:**

```
Error: 環境変数 ROKADOC_API_KEY が設定されていません。
```

→ `-e ROKADOC_API_KEY=<your-api-key>` を `docker run` コマンドに追加してください。

**不正なBase URL:**

```
Error: ROKADOC_BASE_URL の形式が不正です。http:// または https:// で始まるURLを指定してください。
```

→ `ROKADOC_BASE_URL` に有効なURL（`https://` で始まる）を設定してください。

## ライセンス

MIT
