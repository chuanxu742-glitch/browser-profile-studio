import type { ExtractionLimits, ExtractionSchema, ExtractResult } from './types.js';

/** Keep each extracted string small enough for a useful structured response. */
export const DEFAULT_MAX_FIELD_CHARS = 4_096;
/** Hard server-side cap; per-call limits can never exceed this value. */
export const HARD_MAX_FIELD_CHARS = 10_000;
export const DEFAULT_MAX_ITEMS = 100;
export const HARD_MAX_ITEMS = 1_000;
/** Structured extraction is kept below the MCP/Redis payload budget. */
export const DEFAULT_MAX_RESULT_BYTES = 1 * 1024 * 1024;
/** Hard server-side cap; per-call limits can never exceed this value. */
export const HARD_MAX_RESULT_BYTES = 1 * 1024 * 1024;

const RESULT_LIMIT_ERROR = '__EXTRACTION_RESULT_LIMIT__';

/** A stable error that can be mapped by the browser/MCP layers. */
export class ExtractionResourceError extends Error {
  public readonly code = 'RESOURCE_EXHAUSTED' as const;
  public readonly retryable = false;
  public readonly details: { limitBytes: number };

  public constructor(limitBytes: number) {
    super('Extracted result exceeds the server response limit');
    this.name = 'ExtractionResourceError';
    this.details = { limitBytes };
  }
}

function boundedInteger(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * 在当前页面上执行结构化批量数据抽取
 */
export async function extractBatchData(
  page: any,
  schema: ExtractionSchema,
  limits: ExtractionLimits = {},
): Promise<ExtractResult> {
  const start = Date.now();
  const maxItems = boundedInteger(schema.maxItems, 1, HARD_MAX_ITEMS, DEFAULT_MAX_ITEMS);
  const maxFieldChars = boundedInteger(limits.maxFieldChars, 1, HARD_MAX_FIELD_CHARS, DEFAULT_MAX_FIELD_CHARS);
  const maxResultBytes = boundedInteger(limits.maxResultBytes, 1, HARD_MAX_RESULT_BYTES, DEFAULT_MAX_RESULT_BYTES);

  if (!page || typeof page.evaluate !== 'function') {
    throw new Error('A valid page with evaluate capability is required');
  }

  let result: Array<Record<string, string | null>>;
  try {
    result = await page.evaluate(
      ({ containerSelector, fields, maxCount, maxFieldChars: fieldLimit, maxResultBytes: resultLimit, resultLimitError }: {
        containerSelector: string;
        fields: any[];
        maxCount: number;
        maxFieldChars: number;
        maxResultBytes: number;
        resultLimitError: string;
      }) => {
        const containers = Array.from(document.querySelectorAll(containerSelector)).slice(0, maxCount);
        const items: Array<Record<string, string | null>> = [];
        const encoder = new TextEncoder();
        // JSON.stringify(items) is `[` + records separated by commas + `]`.
        // Track the same representation incrementally so a page with many
        // large records is rejected before Playwright serializes a huge value.
        let serializedBytes = 2;

        const limitCharacters = (value: string): string => {
          if (value.length <= fieldLimit) return value;
          let offset = 0;
          let count = 0;
          while (offset < value.length && count < fieldLimit) {
            const codePoint = value.codePointAt(offset);
            offset += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
            count += 1;
          }
          return value.slice(0, offset);
        };

        const boundValue = (value: unknown): string | null => {
          if (typeof value !== 'string') return null;
          return limitCharacters(value);
        };

        for (const container of containers) {
          const record: Record<string, string | null> = {};
          for (const field of fields) {
            let value: string | null = typeof field.defaultValue === 'string' ? field.defaultValue : null;
            let el: Element | null = container;

            if (field.selector) {
              el = container.querySelector(field.selector);
            }

            if (el) {
              if (field.attribute) {
                value = el.getAttribute(field.attribute);
              } else {
                // `innerText` is available on HTML elements. Checking the
                // property instead of using `instanceof HTMLElement` also
                // keeps the evaluator safe in non-HTML/XML documents.
                const candidate = 'innerText' in el && typeof (el as Element & { innerText?: unknown }).innerText === 'string'
                  ? (el as Element & { innerText: string }).innerText
                  : el.textContent;
                value = candidate;
              }
              if (typeof value === 'string' && field.trim !== false) {
                value = value.trim();
              }
            }

            record[field.name] = boundValue(value);
          }

          const recordBytes = encoder.encode(JSON.stringify(record)).byteLength;
          const nextBytes = serializedBytes + (items.length > 0 ? 1 : 0) + recordBytes;
          if (nextBytes > resultLimit) {
            throw new Error(resultLimitError);
          }
          items.push(record);
          serializedBytes = nextBytes;
        }

        return items;
      },
      {
        containerSelector: schema.containerSelector,
        fields: schema.fields,
        maxCount: maxItems,
        maxFieldChars,
        maxResultBytes,
        resultLimitError: RESULT_LIMIT_ERROR,
      },
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes(RESULT_LIMIT_ERROR)) {
      throw new ExtractionResourceError(maxResultBytes);
    }
    throw error;
  }

  if (!Array.isArray(result)) {
    throw new Error('The extraction evaluator returned an invalid result');
  }

  const output: ExtractResult = {
    count: result.length,
    items: result,
    durationMs: Date.now() - start,
  };
  let serializedOutput: string;
  try {
    serializedOutput = JSON.stringify(output);
  } catch (error) {
    throw new Error('The extraction result could not be serialized', { cause: error });
  }
  if (utf8ByteLength(serializedOutput) > maxResultBytes) {
    throw new ExtractionResourceError(maxResultBytes);
  }

  return output;
}
