export interface FieldExtractor {
  name: string;
  selector?: string | undefined;
  role?: string | undefined;
  attribute?: string | undefined; // 如 'href', 'src', 'title', 'data-id' 等，默认获取 text/innerText
  trim?: boolean | undefined;
  defaultValue?: string | undefined;
}

export interface ExtractionSchema {
  /** 容器选择器（例如 'div.card', 'tr', 'li.item', 'article'） */
  containerSelector: string;
  /** 字段映射规则 */
  fields: FieldExtractor[];
  /** 最大提取条数（默认 100） */
  maxItems?: number | undefined;
}

/**
 * Server-owned extraction limits. Callers may lower these values for a
 * particular extraction, but the extractor always clamps them to its hard
 * upper bounds. They are deliberately separate from the public MCP schema so
 * a caller cannot turn a resource limit into an unbounded request.
 */
export interface ExtractionLimits {
  maxFieldChars?: number | undefined;
  maxResultBytes?: number | undefined;
}

export interface ExtractResult {
  count: number;
  items: Array<Record<string, string | null>>;
  durationMs: number;
}
