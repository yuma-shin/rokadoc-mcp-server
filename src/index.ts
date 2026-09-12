#!/usr/bin/env node
/**
 * rokadoc MCPサーバー エントリーポイント
 *
 * 設定読み込み、McpServerインスタンスの作成とツール登録、
 * stdioトランスポート起動、シャットダウン処理を行う。
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { RokadocApiClient } from "./services/rokadoc-client.js";
import { createServer } from "./server.js";

async function main() {
  // 設定読み込みと検証（失敗時はプロセス終了）
  const config = loadConfig();

  // APIクライアント作成
  const apiClient = new RokadocApiClient(config);

  // MCPサーバーインスタンス作成（4つのツールを登録済み）
  const server = createServer(apiClient);

  // stdioトランスポートの作成とサーバー接続
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // グレースフルシャットダウン処理
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  process.stderr.write(
    `[起動エラー] MCPサーバーの起動に失敗しました: ${error}\n`,
  );
  process.exit(1);
});
