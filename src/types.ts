/**
 * rokadoc MCPサーバー 型定義
 */

// ─── サーバー設定 ───────────────────────────────────────────

/**
 * サーバー設定インターフェース
 * 環境変数から読み込まれ、正規化された設定値を保持する
 */
export interface ServerConfig {
  /** 正規化済みrokadoc API URL（末尾スラッシュなし、https://） */
  baseUrl: string;
  /** rokadoc API Key（空白除去済み） */
  apiKey: string;
}

// ─── ツール入出力型 ─────────────────────────────────────────

/**
 * convert_document ツール入力
 */
export interface ConvertDocumentInput {
  /** 必須: ファイルパス */
  file_path: string;
  /** 任意: 開始ページ（正の整数） */
  from_page?: number;
  /** 任意: 終了ページ（正の整数） */
  to_page?: number;
}

/**
 * convert_document ツール出力
 */
export interface ConvertDocumentOutput {
  code: number;
  status: string;
  conversion_id: string;
}

/**
 * list_conversions APIレスポンス全体
 */
export interface ListConversionsResponse {
  code: number;
  total_count: number;
  last_page_number: number;
  data: ConversionJob[];
}

/**
 * 変換ジョブ情報
 */
export interface ConversionJob {
  conversion_id: string;
  status: "Pending" | "Running" | "Succeeded" | "Failed" | "Retrying";
  document_name: string;
  /** 作成日時（例: "202502051314"） */
  created_date: string;
  /** 更新日時（例: "202502051315"） */
  updated_date: string;
}

/**
 * get_conversion_result ツール入力
 */
export interface GetConversionResultInput {
  /** 必須: 変換ジョブID */
  conversion_id: string;
}

/**
 * get_conversion_result ツール出力（APIレスポンス）
 */
export interface GetConversionResultResponse {
  code: number;
  data: {
    status: "Pending" | "Running" | "Succeeded" | "Failed" | "Retrying";
    conversion_id: string;
    document_name: string;
    roka_response: RokaResponse | null;
  };
}

/**
 * rokadocドキュメント解析結果
 */
export interface RokaResponse {
  meta: {
    separate_method: string;
  };
  document_summary: string;
  units: Array<{
    unit: number;
    title: string;
    body: string;
    chunk_context: string;
    elements: Array<{
      type: string;
      coordinates: number[][];
      text: string;
      page: number;
      reading_order: number;
    }>;
    description: string;
    width: number;
    height: number;
  }>;
}

/**
 * search_documents ツール入力
 */
export interface SearchDocumentsInput {
  /** 必須: 検索クエリ（1〜1000文字） */
  query: string;
  /** 任意: タグフィルタ（AND条件） */
  tags?: string[];
  /** 任意: 最大取得件数（デフォルト: 3、最大: 5） */
  max_results?: number;
  /** 任意: スペースID */
  space_id?: string;
}

/**
 * 検索結果（rokadoc APIレスポンスの各要素）
 */
export interface SearchResult {
  /** チャンク化されたテキスト */
  context: string;
  /** ユニット情報 */
  unit: {
    unit: number;
    title: string;
    body: string;
    chunk_context: string;
    elements: Array<{
      type: string;
      coordinates: number[][];
      text: string;
      page: number;
      reading_order: number;
    }>;
    description: string;
    width: number;
    height: number;
  };
  /** ドキュメント名 */
  pdf_name: string;
  /** ページ番号 */
  page_number: number;
  /** 使用されたアルゴリズム */
  roka_algorithm: string | null;
  /** 変換ジョブID */
  conversion_id: string;
  /** ユーザーID */
  user_id: string;
  /** タグ */
  tags: string[];
}

/**
 * 検索APIレスポンス全体
 */
export interface SearchResponse {
  search_result: SearchResult[];
}

// ─── スペース関連型 ─────────────────────────────────────────

/**
 * スペース情報
 */
export interface Space {
  space_id: string;
  space_name: string;
}

/**
 * スペース一覧APIレスポンス
 */
export interface ListSpacesResponse {
  code: number;
  data: Space[];
}

// ─── API通信モデル ──────────────────────────────────────────

/**
 * APIリクエスト共通ヘッダー
 */
export interface ApiRequestHeaders {
  "api-key": string;
  "Content-Type"?: string;
}

/**
 * リトライ設定
 */
export interface RetryConfig {
  maxRetries: number;
  /** ミリ秒 */
  retryDelay: number;
  retryableStatuses: readonly number[];
  nonRetryableStatuses: readonly number[];
}

/**
 * デフォルトリトライ設定値
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  retryDelay: 2000,
  retryableStatuses: [500, 502, 503, 504],
  nonRetryableStatuses: [400, 401, 403, 404, 409, 422],
} as const;

// ─── MCPエラーレスポンス ────────────────────────────────────

/**
 * MCPツール結果型
 */
export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * エラー種別列挙型
 */
export enum ErrorType {
  AUTH_ERROR = "認証エラー",
  TIMEOUT = "タイムアウト",
  CONNECTION_ERROR = "接続エラー",
  API_ERROR = "APIエラー",
  VALIDATION_ERROR = "バリデーションエラー",
}
