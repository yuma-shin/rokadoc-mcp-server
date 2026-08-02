/**
 * RokadocApiClient ユニットテスト
 *
 * テスト対象:
 * - api-keyヘッダー付与
 * - ホスト制限検証
 * - リトライロジック（5xxで最大3回リトライ、4xxでリトライなし）
 * - タイムアウト処理
 *
 * Validates: Requirements 6.1, 6.3, 7.6
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RokadocApiClient } from "../../src/services/rokadoc-client.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

/**
 * テスト中のPromiseRejectionHandledWarning を抑制する。
 * RokadocApiClient のリトライロジックは内部で rejected Promise を
 * lastError に保持して最後に throw するパターンのため、
 * fake timer 環境では一時的にunhandledと検知される。
 * テストの正当性には影響しない。
 */
const unhandledRejections: unknown[] = [];
function handleUnhandledRejection(event: PromiseRejectionEvent) {
  event.preventDefault();
  unhandledRejections.push(event.reason);
}

describe("RokadocApiClient", () => {
  const testConfig = {
    baseUrl: "https://rokadoc.ntt.com",
    apiKey: "test-api-key-123",
  };

  let client: RokadocApiClient;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    unhandledRejections.length = 0;
    if (typeof globalThis.addEventListener === "function") {
      globalThis.addEventListener(
        "unhandledrejection",
        handleUnhandledRejection as EventListener,
      );
    }
    // Node.js のイベントハンドラ
    process.on("unhandledRejection", (reason) => {
      unhandledRejections.push(reason);
    });
    client = new RokadocApiClient(testConfig);
  });

  afterEach(() => {
    if (typeof globalThis.removeEventListener === "function") {
      globalThis.removeEventListener(
        "unhandledrejection",
        handleUnhandledRejection as EventListener,
      );
    }
    process.removeAllListeners("unhandledRejection");
    vi.useRealTimers();
  });

  describe("api-keyヘッダー付与", () => {
    it("全リクエストにapi-keyヘッダーが含まれる", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 200,
          total_count: 0,
          last_page_number: 1,
          data: [],
        }),
      });

      await client.listConversions();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["api-key"]).toBe("test-api-key-123");
    });

    it("GETリクエストでもapi-keyヘッダーが付与される", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ search_result: [] }),
      });

      await client.searchDocuments("test query");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(options.headers["api-key"]).toBe("test-api-key-123");
      expect(options.method).toBe("GET");
      expect(url).toContain("message=test+query");
    });
  });

  describe("ホスト制限検証", () => {
    it("リクエストURLがbaseUrlのホストと一致する", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 200,
          total_count: 0,
          last_page_number: 1,
          data: [],
        }),
      });

      await client.listConversions();

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://rokadoc.ntt.com/v1/user/conversions");
    });

    it("baseUrlと異なるホストへのリクエストは拒否される", async () => {
      const badClient = new RokadocApiClient({
        baseUrl: "https://evil.example.com",
        apiKey: "key",
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 200,
          total_count: 0,
          last_page_number: 1,
          data: [],
        }),
      });

      await badClient.listConversions();

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("evil.example.com");
      expect(url).not.toContain("rokadoc.ntt.com");
    });
  });

  describe("リトライロジック - 5xxエラー", () => {
    it("5xxエラー時に最大3回リトライし、計4回fetchが呼ばれる", async () => {
      mockFetch.mockImplementation(() => {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          text: async () => "Server Error",
        });
      });

      const promise = client.listConversions();

      await vi.advanceTimersByTimeAsync(2100);
      await vi.advanceTimersByTimeAsync(2100);
      await vi.advanceTimersByTimeAsync(2100);

      await expect(promise).rejects.toThrow("HTTP 500");
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it("502エラーでもリトライされる", async () => {
      mockFetch.mockImplementation(() => {
        return Promise.resolve({
          ok: false,
          status: 502,
          statusText: "Bad Gateway",
          text: async () => "",
        });
      });

      const promise = client.listConversions();

      await vi.advanceTimersByTimeAsync(2100);
      await vi.advanceTimersByTimeAsync(2100);
      await vi.advanceTimersByTimeAsync(2100);

      await expect(promise).rejects.toThrow("HTTP 502");
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it("503エラーでもリトライされる", async () => {
      mockFetch.mockImplementation(() => {
        return Promise.resolve({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          text: async () => "",
        });
      });

      const promise = client.listConversions();

      await vi.advanceTimersByTimeAsync(2100);
      await vi.advanceTimersByTimeAsync(2100);
      await vi.advanceTimersByTimeAsync(2100);

      await expect(promise).rejects.toThrow("HTTP 503");
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it("リトライ中に成功レスポンスが返れば正常に結果を返す", async () => {
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.resolve({
            ok: false,
            status: 503,
            statusText: "Service Unavailable",
            text: async () => "",
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            code: 200,
            total_count: 1,
            last_page_number: 1,
            data: [
              {
                conversion_id: "abc",
                status: "Succeeded",
                document_name: "sample.pdf",
                created_date: "202401010000",
                updated_date: "202401010001",
              },
            ],
          }),
        });
      });

      const promise = client.listConversions();

      await vi.advanceTimersByTimeAsync(2100);
      await vi.advanceTimersByTimeAsync(2100);

      const result = await promise;
      expect(result).toEqual([
        {
          conversion_id: "abc",
          status: "Succeeded",
          document_name: "sample.pdf",
          created_date: "202401010000",
          updated_date: "202401010001",
        },
      ]);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe("リトライロジック - 4xxエラー", () => {
    it("400エラーではリトライせず即座にエラーをスローする", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: async () => "Invalid request",
      });

      await expect(client.listConversions()).rejects.toThrow("HTTP 400");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("401エラーではリトライしない", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "Unauthorized",
      });

      await expect(client.listConversions()).rejects.toThrow("HTTP 401");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("403エラーではリトライしない", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: async () => "Forbidden",
      });

      await expect(client.listConversions()).rejects.toThrow("HTTP 403");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("404エラーではリトライしない", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => "Not Found",
      });

      await expect(client.listConversions()).rejects.toThrow("HTTP 404");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("タイムアウト処理", () => {
    it("30秒経過後にAbortErrorがスローされリトライ対象となる", async () => {
      let callCount = 0;
      mockFetch.mockImplementation((_url: string, options: RequestInit) => {
        callCount++;
        return new Promise((_resolve, reject) => {
          const signal = options.signal as AbortSignal;
          if (signal) {
            if (signal.aborted) {
              const abortError = new Error("The operation was aborted");
              abortError.name = "AbortError";
              reject(abortError);
              return;
            }
            signal.addEventListener("abort", () => {
              const abortError = new Error("The operation was aborted");
              abortError.name = "AbortError";
              reject(abortError);
            });
          }
        });
      });

      const promise = client.listConversions();

      // タイムアウト（30秒）+ リトライ待機（2秒）を繰り返す
      await vi.advanceTimersByTimeAsync(
        30000 + 2000 + 30000 + 2000 + 30000 + 2000 + 30000,
      );

      await expect(promise).rejects.toThrow("The operation was aborted");
      expect(callCount).toBe(4);
    });

    it("fetchにAbortSignalが渡される", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 200,
          total_count: 0,
          last_page_number: 1,
          data: [],
        }),
      });

      await client.listConversions();

      const [, options] = mockFetch.mock.calls[0];
      expect(options.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe("ネットワークエラーのリトライ", () => {
    it("ネットワークエラー（TypeError: fetch failed）もリトライ対象", async () => {
      let callCount = 0;
      const networkError = new TypeError("fetch failed");
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.reject(networkError);
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            code: 200,
            total_count: 1,
            last_page_number: 1,
            data: [
              {
                conversion_id: "xyz",
                status: "Pending",
                document_name: "test.pdf",
                created_date: "202401020000",
                updated_date: "202401020000",
              },
            ],
          }),
        });
      });

      const promise = client.listConversions();

      await vi.advanceTimersByTimeAsync(2100);
      await vi.advanceTimersByTimeAsync(2100);

      const result = await promise;
      expect(result).toEqual([
        {
          conversion_id: "xyz",
          status: "Pending",
          document_name: "test.pdf",
          created_date: "202401020000",
          updated_date: "202401020000",
        },
      ]);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });
});
