# rokadoc MCP Server

NTTドコモビジネスが提供するRAGサービス「rokadoc」の機能を、Model Context Protocol (MCP) を介してAIアシスタントから利用可能にするサーバーです。

VS Code、Kiro、Claude Desktop等のMCPクライアントから、ドキュメント変換やRAG検索をツールとして直接呼び出せます。

## 配布形態の選択

DockerイメージとNPMパッケージの2形態で配布しています。どちらもMCPサーバーとしての機能は同一です。

| 観点                              | Dockerイメージ                                                      | NPMパッケージ                                           |
| --------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------- |
| 前提条件                          | Docker                                                              | Node.js `>=22`                                          |
| 共通の前提条件                    | rokadoc API Key                                                     | rokadoc API Key                                         |
| 起動方法                          | `docker run -i --rm ...`                                            | `npx -y rokadoc-mcp-server`                             |
| `convert_document` のファイルパス | コンテナ内パス（`-v` でマウントし、パスの読み替えが必要）           | ホストの絶対パスをそのまま指定（マウント不要）          |
| 環境変数の渡し方                  | `docker run` の `-e` オプション                                     | MCPクライアント設定の `env`                             |
| 更新方法                          | イメージの再取得（`docker pull`）                                   | バージョン指定の変更、または `@latest` で自動取得       |
| 配布ページ                        | [Docker Hub](https://hub.docker.com/r/snackpans/rokadoc-mcp-server) | [npm](https://www.npmjs.com/package/rokadoc-mcp-server) |

- ローカルファイルを頻繁に変換する場合は、パスの読み替えが不要なNPMパッケージが扱いやすいです
- 実行環境をコンテナに隔離したい場合や、Node.jsを用意したくない場合はDockerイメージを選択してください

npmレジストリのパッケージページ向けの説明（npx中心の導入手順のみを記載）は [NPM.md](NPM.md) にあります。

## 前提条件

Dockerイメージを利用する場合:

- **Docker**: コンテナの実行に必要
- **rokadoc API Key**: rokadocサービスへの認証に使用するAPIキー

NPMパッケージを利用する場合:

- **Node.js**: `>=22`（`node --version` で確認できます）
- **rokadoc API Key**: rokadocサービスへの認証に使用するAPIキー

## イメージの取得

Docker Hub または GitHub Container Registry のどちらからでも利用可能です。

### Docker Hub

イメージのページは [Docker Hub](https://hub.docker.com/r/snackpans/rokadoc-mcp-server) にあります。

```bash
docker pull snackpans/rokadoc-mcp-server
```

### GitHub Container Registry (GHCR)

```bash
docker pull ghcr.io/yuma-shin/rokadoc-mcp-server:latest
```

### タグ一覧

| タグ     | 説明                                   |
| -------- | -------------------------------------- |
| `latest` | 最新リリース                           |
| `1`      | v1系の最新（メジャーバージョン追従）   |
| `1.0`    | v1.0系の最新（マイナーバージョン追従） |
| `1.0.0`  | 特定バージョン固定                     |

安定運用にはメジャーバージョンタグ（例: `1`）の利用を推奨します。

## ソースからビルドする場合

```bash
docker build -t rokadoc-mcp-server .
```

## コンテナの起動

Docker Hub のイメージを使用する場合:

```bash
docker run -i --rm -e ROKADOC_API_KEY=<your-api-key> snackpans/rokadoc-mcp-server
```

GHCR のイメージを使用する場合:

```bash
docker run -i --rm -e ROKADOC_API_KEY=<your-api-key> ghcr.io/yuma-shin/rokadoc-mcp-server
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
  snackpans/rokadoc-mcp-server
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
        "snackpans/rokadoc-mcp-server"
      ],
      "env": {
        "ROKADOC_API_KEY": "${input:rokadoc-api-key}"
      }
    }
  }
}
```

GHCRを使う場合は `"snackpans/rokadoc-mcp-server"` を `"ghcr.io/yuma-shin/rokadoc-mcp-server"` に置き換えてください。

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
        "snackpans/rokadoc-mcp-server"
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
        "snackpans/rokadoc-mcp-server"
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
        "snackpans/rokadoc-mcp-server"
      ],
      "env": {
        "ROKADOC_API_KEY": "${input:rokadoc-api-key}"
      }
    }
  }
}
```

## NPMパッケージで利用する

Node.js `>=22` があれば、Dockerなしで `npx` から直接起動できます。パッケージ名は `rokadoc-mcp-server` です。パッケージのページは [npm](https://www.npmjs.com/package/rokadoc-mcp-server) にあります。

```bash
ROKADOC_API_KEY=<your-api-key> npx -y rokadoc-mcp-server
```

Windows (PowerShell) の場合:

```powershell
$env:ROKADOC_API_KEY="<your-api-key>"; npx -y rokadoc-mcp-server
```

MCPサーバーは標準入出力（stdio）でMCPクライアントと通信します。通常は手動起動せず、後述の設定例のとおりMCPクライアントに登録してください。

### バージョンの指定

| 指定方法               | コマンド例                           | 説明                           |
| ---------------------- | ------------------------------------ | ------------------------------ |
| 特定バージョン固定     | `npx -y rokadoc-mcp-server@1.0.7`    | `@<version>` で固定            |
| 最新リリース           | `npx -y rokadoc-mcp-server@latest`   | 常に最新版を取得               |
| メジャーバージョン追従 | `npx -y "rokadoc-mcp-server@^1.0.0"` | v1系の最新（破壊的変更を除外） |
| マイナーバージョン追従 | `npx -y "rokadoc-mcp-server@~1.0.0"` | v1.0系の最新（パッチ更新のみ） |

安定運用にはメジャーバージョン追従（`^1.0.0`）を推奨します。範囲指定（`^` / `~`）はシェルが解釈しないよう引用符で囲んでください。

### 環境変数

Dockerイメージ経由の場合と同じ環境変数を使用します。

| 環境変数           | 必須   | デフォルト値                  | 説明                   |
| ------------------ | ------ | ----------------------------- | ---------------------- |
| `ROKADOC_API_KEY`  | はい   | -                             | rokadoc APIの認証キー  |
| `ROKADOC_BASE_URL` | いいえ | `https://api.rokadoc.ntt.com` | rokadoc APIのベースURL |

`ROKADOC_API_KEY` はシェルの環境変数として渡すか、MCPクライアント設定の `env` に指定します。`ROKADOC_BASE_URL` は未設定の場合に既定値 `https://api.rokadoc.ntt.com` が適用されます。オンプレミス環境に接続する場合のみ設定してください。

### MCPクライアント設定（VS Code / Kiro）

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

### MCPクライアント設定（Claude Desktop）

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

### ファイルパスの扱い

NPMパッケージ経由の場合、MCPサーバーはMCPクライアントと同じホスト上のプロセスとして動作します。`convert_document` の `file_path` には **ホストの絶対パスをそのまま** 指定でき、Dockerイメージ経由で必要となるボリュームマウント（`-v`）とコンテナ内パスへの読み替えは不要です。

Windows の例:

```
C:\Users\username\Documents\report.pdf
```

macOS / Linux の例:

```
/Users/username/Documents/report.pdf
```

## GitHub Packagesから取得する

公開npmレジストリと同一の内容を、GitHub Packagesにも `@yuma-shin/rokadoc-mcp-server` として公開しています。GitHub認証のみでパッケージを取得したい場合はこちらを利用してください。

1. スコープの参照先をGitHub Packagesに向けます。プロジェクトルート（またはホームディレクトリ）の `.npmrc` に以下を記述します。

   ```ini
   @yuma-shin:registry=https://npm.pkg.github.com
   ```

2. GitHub Packagesの認証情報（`read:packages` スコープを持つPersonal Access Token）を設定します。トークンは `.npmrc` に直接書かず、環境変数を参照させることを推奨します。

   ```ini
   @yuma-shin:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
   ```

   ```bash
   export GITHUB_TOKEN=<your-personal-access-token>
   ```

   `npm login --scope=@yuma-shin --registry=https://npm.pkg.github.com` で対話的に認証情報を保存することもできます。

3. スコープ付きパッケージ名を指定してインストールします。

   ```bash
   npm install @yuma-shin/rokadoc-mcp-server
   ```

インストール後は `npx @yuma-shin/rokadoc-mcp-server` で起動できます。`.npmrc` と認証情報の設定が必要なため、MCPクライアント設定例のように `npx` から直接取得する用途では、公開npmレジストリの `rokadoc-mcp-server` を利用してください。

## 提供ツール

全ツールは `space_id` または `space_name` パラメータを受け付けます。スペースを指定するとそのスペース内に限定して操作を行います。未指定時は全スペースが対象です。`space_name` を指定した場合、内部でスペース一覧API（`GET /v1/user/spaces/join`）を呼び出し、対応する `space_id` を自動的に解決します。

### ツールアノテーション

各ツールにはMCP仕様のアノテーションヒントを宣言しています。MCPクライアントはこの情報をもとに、実行前の確認ダイアログ表示などの判断を行います。

| ツール                  | readOnlyHint | destructiveHint | idempotentHint | openWorldHint |
| ----------------------- | ------------ | --------------- | -------------- | ------------- |
| `convert_document`      | `false`      | `false`         | `false`        | `true`        |
| `list_conversions`      | `true`       | `false`         | `true`         | `true`        |
| `get_conversion_result` | `true`       | `false`         | `true`         | `true`        |
| `search_documents`      | `true`       | `false`         | `true`         | `true`        |

- `convert_document` は変換ジョブを新規作成するため書き込み系です。既存データの削除・上書きは行いませんが、呼び出しごとに新しい `conversion_id` が払い出されるため冪等ではありません
- 他の3ツールはrokadoc APIに対して参照のみを行い、状態を変更しません
- 全ツールが外部サービス（rokadoc API）と通信するため `openWorldHint` は `true` です

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

### NPMパッケージ起動エラー

**APIキー未設定（`ROKADOC_API_KEY`）:**

`npx -y rokadoc-mcp-server` の標準エラー出力に次のメッセージが出力され、MCPハンドシェイクを開始せずに終了コード1で終了します。

```
[設定エラー] 環境変数 ROKADOC_API_KEY が設定されていないか、空白のみです。有効なAPIキーを設定してください。
```

MCPクライアント経由の場合は、サーバーが起動直後に終了するため「接続できない」「サーバーが終了した」旨の表示になります。詳細はクライアントのMCPサーバーログ（標準エラー出力）で確認してください。

**対処法:**

- MCPクライアント設定の `env` に `ROKADOC_API_KEY` を指定する（前述の設定例を参照）
- 手動起動時は `ROKADOC_API_KEY=<your-api-key> npx -y rokadoc-mcp-server` のように環境変数を渡す
- 空文字列や空白のみの値を設定していないか確認する（前後の空白は自動的に除去されます）

**Node.jsのバージョン不足（`EBADENGINE`）:**

Node.js `22` 未満の環境では、パッケージ取得時に標準エラー出力へ次のような警告が出力されます。

```
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: 'rokadoc-mcp-server@1.0.7',
npm warn EBADENGINE   required: { node: '>=22' },
npm warn EBADENGINE   current: { node: 'v20.11.0', npm: '10.2.4' }
npm warn EBADENGINE }
```

警告のまま起動を試みても、実行時に構文エラーやAPI未定義エラーで異常終了する場合があります。

**対処法:**

- `node --version` で実行中のバージョンを確認する
- Node.js `22` 以降へ更新する（nvm等のバージョン管理ツールを利用している場合は、MCPクライアントが参照するNode.jsも切り替わっているか確認する）
- Node.jsを更新できない場合は、Dockerイメージでの利用を検討する

### npm向けREADME

npmレジストリのパッケージページに掲載しているnpx中心の導入手順は [NPM.md](NPM.md) を参照してください。環境変数（`ROKADOC_API_KEY` / `ROKADOC_BASE_URL`）、`ROKADOC_BASE_URL` の既定値、Node.js最小バージョン `>=22` は本ドキュメントと同一の値です。

## ライセンス

MIT
