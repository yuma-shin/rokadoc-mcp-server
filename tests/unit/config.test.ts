import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("有効な設定で正常にConfigを返す", () => {
    process.env.ROKADOC_API_KEY = "test-api-key";
    process.env.ROKADOC_BASE_URL = "https://example.com";
    const config = loadConfig();
    expect(config.apiKey).toBe("test-api-key");
    expect(config.baseUrl).toBe("https://example.com");
  });

  it("ROKADOC_BASE_URL未設定時はデフォルト値を使用する", () => {
    process.env.ROKADOC_API_KEY = "test-api-key";
    delete process.env.ROKADOC_BASE_URL;
    const config = loadConfig();
    expect(config.baseUrl).toBe("https://api.rokadoc.ntt.com");
  });

  it("ROKADOC_API_KEY未設定時はprocess.exitを呼ぶ", () => {
    delete process.env.ROKADOC_API_KEY;
    expect(() => loadConfig()).toThrow("process.exit called");
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("ROKADOC_API_KEYが空白のみの場合はprocess.exitを呼ぶ", () => {
    process.env.ROKADOC_API_KEY = "   ";
    expect(() => loadConfig()).toThrow("process.exit called");
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("不正なURL形式の場合はprocess.exitを呼ぶ", () => {
    process.env.ROKADOC_API_KEY = "test-api-key";
    process.env.ROKADOC_BASE_URL = "ftp://invalid.com";
    expect(() => loadConfig()).toThrow("process.exit called");
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("API Keyの前後空白をtrimする", () => {
    process.env.ROKADOC_API_KEY = "  my-key  ";
    process.env.ROKADOC_BASE_URL = "https://example.com";
    const config = loadConfig();
    expect(config.apiKey).toBe("my-key");
  });
});
