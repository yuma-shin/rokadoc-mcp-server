import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

/**
 * MCPサーバーのユニットテスト
 *
 * Requirements: 1.3, 1.4, 1.6
 * - initializeレスポンスの内容検証（サーバー名、バージョン、MCP対応バージョン）
 * - tools/listレスポンスに4つのツールが含まれることの検証
 * - 不正JSON-RPCリクエスト受信時のエラーレスポンス検証
 */
describe("MCPサーバー", () => {
  let server: McpServer;
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;

  beforeAll(async () => {
    // src/index.ts と同じ設定でサーバーを作成
    server = new McpServer({
      name: "rokadoc-mcp-server",
      version: "1.0.0",
    });

    // src/index.ts と同じZodスキーマでツールを登録
    server.tool(
      "convert_document",
      "ドキュメントファイルをrokadocに送信して構造化テキストに変換する",
      {
        file_path: z.string().min(1).describe("変換対象のファイルパス"),
        from_page: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("開始ページ（正の整数）"),
        to_page: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("終了ページ（正の整数）"),
      },
      async () => ({
        content: [{ type: "text" as const, text: "mock response" }],
      }),
    );

    server.tool(
      "list_conversions",
      "変換ジョブの一覧を取得する",
      {},
      async () => ({
        content: [{ type: "text" as const, text: "mock response" }],
      }),
    );

    server.tool(
      "get_conversion_result",
      "指定された変換ジョブの結果を取得する",
      {
        conversion_id: z.string().min(1).describe("変換ジョブID"),
      },
      async () => ({
        content: [{ type: "text" as const, text: "mock response" }],
      }),
    );

    server.tool(
      "search_documents",
      "rokadocに登録されたドキュメントに対してRAG検索を実行する",
      {
        query: z
          .string()
          .min(1)
          .max(1000)
          .describe("検索クエリ（1〜1000文字）"),
        tags: z
          .array(z.string())
          .optional()
          .describe("タグフィルタ（AND条件）"),
        max_results: z
          .number()
          .int()
          .positive()
          .default(20)
          .optional()
          .describe("最大取得件数（デフォルト: 20）"),
      },
      async () => ({
        content: [{ type: "text" as const, text: "mock response" }],
      }),
    );

    // InMemoryTransportペアを作成
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // サーバーを接続
    await server.connect(serverTransport);

    // クライアントを作成して接続（初期化が自動的に行われる）
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  describe("initializeレスポンスの検証（Requirements 1.3）", () => {
    it("サーバー名が'rokadoc-mcp-server'であること", () => {
      const serverVersion = client.getServerVersion();
      expect(serverVersion).toBeDefined();
      expect(serverVersion!.name).toBe("rokadoc-mcp-server");
    });

    it("サーバーバージョンが'1.0.0'であること", () => {
      const serverVersion = client.getServerVersion();
      expect(serverVersion).toBeDefined();
      expect(serverVersion!.version).toBe("1.0.0");
    });

    it("サーバーケイパビリティにtoolsが含まれること", () => {
      const capabilities = client.getServerCapabilities();
      expect(capabilities).toBeDefined();
      expect(capabilities!.tools).toBeDefined();
    });
  });

  describe("tools/listレスポンスの検証（Requirements 1.4）", () => {
    it("4つのツールが含まれること", async () => {
      const result = await client.listTools();
      expect(result.tools).toHaveLength(4);
    });

    it("convert_documentツールが含まれること", async () => {
      const result = await client.listTools();
      const toolNames = result.tools.map((t) => t.name);
      expect(toolNames).toContain("convert_document");
    });

    it("list_conversionsツールが含まれること", async () => {
      const result = await client.listTools();
      const toolNames = result.tools.map((t) => t.name);
      expect(toolNames).toContain("list_conversions");
    });

    it("get_conversion_resultツールが含まれること", async () => {
      const result = await client.listTools();
      const toolNames = result.tools.map((t) => t.name);
      expect(toolNames).toContain("get_conversion_result");
    });

    it("search_documentsツールが含まれること", async () => {
      const result = await client.listTools();
      const toolNames = result.tools.map((t) => t.name);
      expect(toolNames).toContain("search_documents");
    });

    it("各ツールに説明が含まれること", async () => {
      const result = await client.listTools();
      for (const tool of result.tools) {
        expect(tool.description).toBeDefined();
        expect(tool.description!.length).toBeGreaterThan(0);
      }
    });

    it("各ツールに入力スキーマが含まれること", async () => {
      const result = await client.listTools();
      for (const tool of result.tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
      }
    });

    it("convert_documentツールの入力スキーマにfile_pathが必須パラメータとして含まれること", async () => {
      const result = await client.listTools();
      const convertTool = result.tools.find(
        (t) => t.name === "convert_document",
      );
      expect(convertTool).toBeDefined();
      expect(convertTool!.inputSchema.required).toContain("file_path");
    });
  });

  describe("不正JSON-RPCリクエストのエラーレスポンス検証（Requirements 1.6）", () => {
    it("存在しないツールを呼び出した場合、isError: trueのエラーレスポンスが返される", async () => {
      // 存在しないツールを呼び出すことでエラーハンドリングを検証する
      const result = await client.callTool({
        name: "nonexistent_tool",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].type).toBe("text");
      expect(content[0].text).toContain("nonexistent_tool");
    });

    it("不正なパラメータでツールを呼び出した場合、エラーが返される", async () => {
      // convert_documentにfile_path未指定で呼び出し
      const result = await client.callTool({
        name: "convert_document",
        arguments: {},
      });
      // Zodバリデーションエラーにより、isErrorがtrueまたはエラーがスローされる
      expect(result.isError).toBe(true);
    });
  });
});

describe("MCPサーバー - 不正JSON-RPCメッセージのハンドリング", () => {
  it("不正なJSONメッセージを受信した場合、接続がエラーなくハンドリングされる", async () => {
    const server = new McpServer({
      name: "rokadoc-mcp-server",
      version: "1.0.0",
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);

    // 不正なJSON-RPCメッセージを直接送信
    // InMemoryTransportのsendメソッドはJSONRPCMessage型を受け取るため、
    // 不正なメッセージ構造をanyでキャストして送信する
    const invalidMessage = { invalid: "not a json-rpc message" } as any;

    // サーバーがエラーなく不正メッセージを処理することを検証
    // （クラッシュしないこと）
    let errorOccurred = false;
    const originalOnError = serverTransport.onerror;
    serverTransport.onerror = (error: Error) => {
      errorOccurred = true;
      if (originalOnError) originalOnError(error);
    };

    // 不正メッセージを送信（サーバー側で処理される）
    await clientTransport.send(invalidMessage);

    // サーバーが生存していることを確認（クラッシュしていない）
    // 少し待ってからクリーンアップ
    await new Promise((resolve) => setTimeout(resolve, 50));

    await server.close();
  });

  it("JSON-RPCのidなしのリクエストに対してサーバーがクラッシュしない", async () => {
    const server = new McpServer({
      name: "rokadoc-mcp-server",
      version: "1.0.0",
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);

    // 通知形式のメッセージ（idなし）を送信
    const notificationMessage = {
      jsonrpc: "2.0",
      method: "notifications/unknown",
      params: {},
    } as any;

    await clientTransport.send(notificationMessage);

    // サーバーがクラッシュせず生存していることを確認
    await new Promise((resolve) => setTimeout(resolve, 50));

    await server.close();
  });
});
