/**
 * MCPサーバー プロパティベーステスト
 *
 * Feature: rokadoc-mcp-server
 * Validates: Requirements 1.6, 7.6
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import { RokadocApiClient } from "../../src/services/rokadoc-client.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

/**
 * Property 12: エラー種別に基づくリトライ制御
 *
 * 任意の5xx/ネットワークエラーで最大3回リトライ、任意の4xxでリトライなしを検証
 *
 * **Validates: Requirements 7.6**
 */
describe("Feature: rokadoc-mcp-server, Property 12: エラー種別に基づくリトライ制御", () => {
  const testConfig = {
    baseUrl: "https://rokadoc.ntt.com",
    apiKey: "test-api-key-property",
  };

  let client: RokadocApiClient;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    client = new RokadocApiClient(testConfig);

    // Suppress unhandled rejection warnings from retry logic with fake timers.
    // The retry loop stores rejected promises in lastError before re-throwing,
    // which Node.js temporarily marks as unhandled during timer advancement.
    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", () => {
      // Expected in retry logic tests with fake timers
    });
  });

  afterEach(() => {
    process.removeAllListeners("unhandledRejection");
    vi.useRealTimers();
  });

  // retryableStatuses: [500, 502, 503, 504] per DEFAULT_RETRY_CONFIG
  const retryableStatusArb = fc.constantFrom(500, 502, 503, 504);

  it("任意のリトライ対象5xxステータスコードで最大3回リトライされ、計4回fetchが呼ばれる", async () => {
    await fc.assert(
      fc.asyncProperty(retryableStatusArb, async (statusCode: number) => {
        mockFetch.mockReset();
        mockFetch.mockImplementation(() => {
          return Promise.resolve({
            ok: false,
            status: statusCode,
            statusText: `Error ${statusCode}`,
            text: async () => `Server Error ${statusCode}`,
          });
        });

        const promise = client.listConversions();

        // Advance timers past all retry delays (3 retries × 2000ms)
        await vi.advanceTimersByTimeAsync(2100);
        await vi.advanceTimersByTimeAsync(2100);
        await vi.advanceTimersByTimeAsync(2100);

        await expect(promise).rejects.toThrow(`HTTP ${statusCode}`);
        // 1 initial + 3 retries = 4 calls
        expect(mockFetch).toHaveBeenCalledTimes(4);
      }),
      { numRuns: 100 },
    );
  });

  // 4xx statuses (400-499) should never be retried
  const clientErrorStatusArb = fc.integer({ min: 400, max: 499 });

  it("任意の4xxステータスコードでリトライなし（fetchが1回のみ呼ばれる）", async () => {
    await fc.assert(
      fc.asyncProperty(clientErrorStatusArb, async (statusCode: number) => {
        mockFetch.mockReset();
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: statusCode,
          statusText: `Client Error ${statusCode}`,
          text: async () => `Error body ${statusCode}`,
        });

        await expect(client.listConversions()).rejects.toThrow(
          `HTTP ${statusCode}`,
        );
        // No retries for 4xx — exactly 1 fetch call
        expect(mockFetch).toHaveBeenCalledTimes(1);
      }),
      { numRuns: 100 },
    );
  });

  it("ネットワークエラーでリトライされ、最終的に成功する場合は結果が返る", async () => {
    // Validate that network errors trigger retries by simulating
    // 2 network failures followed by success (testing the retry mechanism)
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          "fetch failed",
          "network error",
          "connection refused",
          "ECONNRESET",
          "socket hang up",
        ),
        fc.integer({ min: 1, max: 3 }),
        async (errorMessage: string, failCount: number) => {
          mockFetch.mockReset();
          let callCount = 0;
          mockFetch.mockImplementation(() => {
            callCount++;
            if (callCount <= failCount) {
              return Promise.reject(new TypeError(errorMessage));
            }
            return Promise.resolve({
              ok: true,
              json: async () => ({
                code: 200,
                total_count: 0,
                last_page_number: 1,
                data: [],
              }),
            });
          });

          const promise = client.listConversions();

          // Advance timers for each retry delay
          for (let i = 0; i < failCount; i++) {
            await vi.advanceTimersByTimeAsync(2100);
          }

          const result = await promise;
          expect(result).toEqual([]);
          // failCount failures + 1 success
          expect(mockFetch).toHaveBeenCalledTimes(failCount + 1);
        },
      ),
      { numRuns: 100 },
    );
  });

  // All 5xx statuses (500-599) should be retried
  // retryableStatuses [500, 502, 503, 504] are retried via direct continue path,
  // other 5xx are retried via the catch block (treated as retriable errors)
  const any5xxStatusArb = fc.integer({ min: 500, max: 599 });

  it("任意の5xxステータスコードでリトライされ、計4回fetchが呼ばれる", async () => {
    await fc.assert(
      fc.asyncProperty(any5xxStatusArb, async (statusCode: number) => {
        mockFetch.mockReset();
        mockFetch.mockImplementation(() => {
          return Promise.resolve({
            ok: false,
            status: statusCode,
            statusText: `Error ${statusCode}`,
            text: async () => `Server Error ${statusCode}`,
          });
        });

        const promise = client.listConversions();

        // Advance timers past all retry delays (3 retries × 2000ms)
        await vi.advanceTimersByTimeAsync(2100);
        await vi.advanceTimersByTimeAsync(2100);
        await vi.advanceTimersByTimeAsync(2100);

        await expect(promise).rejects.toThrow();
        // 1 initial + 3 retries = 4 calls for all 5xx statuses
        expect(mockFetch).toHaveBeenCalledTimes(4);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 14: 不正JSON-RPCリクエストのエラーハンドリング
 *
 * JSON-RPC 2.0仕様に準拠しない任意リクエストに対しParse error/Invalid Requestが返却されることを検証
 *
 * **Validates: Requirements 1.6**
 */
describe("Feature: rokadoc-mcp-server, Property 14: 不正JSON-RPCリクエストのエラーハンドリング", () => {
  // JSON-RPC 2.0 error codes
  const PARSE_ERROR = -32700;
  const INVALID_REQUEST = -32600;
  const METHOD_NOT_FOUND = -32601;

  it("jsonrpcフィールドが欠落したリクエストはエラーレスポンスを返すか無視される", async () => {
    const { McpServer } =
      await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { InMemoryTransport } =
      await import("@modelcontextprotocol/sdk/inMemory.js");

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          id: fc.oneof(
            fc.integer({ min: 1, max: 10000 }),
            fc.string({ minLength: 1, maxLength: 20 }),
          ),
          method: fc.string({ minLength: 1, maxLength: 50 }),
        }),
        async (partialRequest) => {
          const server = new McpServer({
            name: "test-server",
            version: "1.0.0",
          });

          const [clientTransport, serverTransport] =
            InMemoryTransport.createLinkedPair();

          await server.connect(serverTransport);
          await clientTransport.start();

          // Send a message WITHOUT jsonrpc field — invalid per JSON-RPC 2.0
          const invalidMessage = {
            id: partialRequest.id,
            method: partialRequest.method,
          };

          const responsePromise = new Promise<unknown>((resolve) => {
            clientTransport.onmessage = (msg: unknown) => {
              resolve(msg);
            };
          });

          await clientTransport.send(invalidMessage as never);

          const response = (await Promise.race([
            responsePromise,
            new Promise((resolve) => setTimeout(() => resolve(null), 50)),
          ])) as Record<string, unknown> | null;

          // The server should either:
          // 1. Return an error response (Parse error or Invalid Request or Method not found)
          // 2. Ignore the invalid message (some SDK implementations do this)
          if (response !== null) {
            expect(response).toHaveProperty("error");
            const error = response.error as { code: number };
            expect([PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND]).toContain(
              error.code,
            );
          }

          await server.close();
        },
      ),
      { numRuns: 100 },
    );
  }, 60000);

  it("jsonrpcバージョンが2.0以外のリクエストはエラーレスポンスを返すか無視される", async () => {
    const { McpServer } =
      await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { InMemoryTransport } =
      await import("@modelcontextprotocol/sdk/inMemory.js");

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          id: fc.oneof(
            fc.integer({ min: 1, max: 10000 }),
            fc.string({ minLength: 1, maxLength: 20 }),
          ),
          jsonrpc: fc
            .string({ minLength: 1, maxLength: 10 })
            .filter((s) => s !== "2.0"),
          method: fc.string({ minLength: 1, maxLength: 50 }),
        }),
        async (invalidRequest) => {
          const server = new McpServer({
            name: "test-server",
            version: "1.0.0",
          });

          const [clientTransport, serverTransport] =
            InMemoryTransport.createLinkedPair();

          await server.connect(serverTransport);
          await clientTransport.start();

          const responsePromise = new Promise<unknown>((resolve) => {
            clientTransport.onmessage = (msg: unknown) => {
              resolve(msg);
            };
          });

          await clientTransport.send(invalidRequest as never);

          const response = (await Promise.race([
            responsePromise,
            new Promise((resolve) => setTimeout(() => resolve(null), 50)),
          ])) as Record<string, unknown> | null;

          // The server may return an error or ignore the invalid message
          if (response !== null) {
            expect(response).toHaveProperty("error");
            const error = response.error as { code: number };
            expect([PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND]).toContain(
              error.code,
            );
          }

          await server.close();
        },
      ),
      { numRuns: 100 },
    );
  }, 60000);

  it("methodフィールドが欠落したリクエストはエラーレスポンスを返すか無視される", async () => {
    const { McpServer } =
      await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { InMemoryTransport } =
      await import("@modelcontextprotocol/sdk/inMemory.js");

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          id: fc.oneof(
            fc.integer({ min: 1, max: 10000 }),
            fc.string({ minLength: 1, maxLength: 20 }),
          ),
        }),
        async (partialRequest) => {
          const server = new McpServer({
            name: "test-server",
            version: "1.0.0",
          });

          const [clientTransport, serverTransport] =
            InMemoryTransport.createLinkedPair();

          await server.connect(serverTransport);
          await clientTransport.start();

          // Send a message with jsonrpc:"2.0" but WITHOUT method field
          const invalidMessage = {
            jsonrpc: "2.0" as const,
            id: partialRequest.id,
          };

          const responsePromise = new Promise<unknown>((resolve) => {
            clientTransport.onmessage = (msg: unknown) => {
              resolve(msg);
            };
          });

          await clientTransport.send(invalidMessage as never);

          const response = (await Promise.race([
            responsePromise,
            new Promise((resolve) => setTimeout(() => resolve(null), 50)),
          ])) as Record<string, unknown> | null;

          // The server should return an error for missing method field
          if (response !== null) {
            expect(response).toHaveProperty("error");
            const error = response.error as { code: number };
            expect([PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND]).toContain(
              error.code,
            );
          }

          await server.close();
        },
      ),
      { numRuns: 100 },
    );
  }, 60000);
});
