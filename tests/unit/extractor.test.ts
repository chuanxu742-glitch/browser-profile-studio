import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_FIELD_CHARS,
  DEFAULT_MAX_RESULT_BYTES,
  HARD_MAX_FIELD_CHARS,
  HARD_MAX_RESULT_BYTES,
  ExtractionResourceError,
  extractBatchData,
} from '../../src/extractor/batch-extractor.js';

type EvaluateArgs = {
  containerSelector: string;
  fields: unknown[];
  maxCount: number;
  maxFieldChars: number;
  maxResultBytes: number;
  resultLimitError: string;
};

describe('结构化批量数据抽取引擎', () => {
  it('应当在页面上根据 Schema 正确批量提取数据', async () => {
    const fakePage = {
      evaluate: async (_fn: any, args: any) => {
        // 模拟浏览器内部 evaluate 返回的数据
        return [
          { title: '商品 A', price: '¥99.00', link: '/product/a' },
          { title: '商品 B', price: '¥199.00', link: '/product/b' },
        ];
      },
    };

    const schema = {
      containerSelector: '.product-card',
      fields: [
        { name: 'title', selector: '.title' },
        { name: 'price', selector: '.price' },
        { name: 'link', selector: 'a', attribute: 'href' },
      ],
      maxItems: 50,
    };

    const result = await extractBatchData(fakePage, schema);
    expect(result.count).toBe(2);
    expect(result.items.length).toBe(2);
    expect(result.items[0]?.title).toBe('商品 A');
    expect(result.items[1]?.price).toBe('¥199.00');
  });

  it('在 evaluate 内限制字段字符数，并保留 trim 与空值语义', async () => {
    const fieldElement = {
      innerText: '  你好😀世界abc  ',
      getAttribute: () => null,
    };
    const attributeElement = {
      textContent: null,
      getAttribute: () => 'x'.repeat(100),
    };
    const container = {
      querySelector: (selector: string) => selector === '.title' ? fieldElement : selector === 'a' ? attributeElement : null,
      textContent: 'unused',
    };
    const originalDocument = (globalThis as { document?: unknown }).document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { querySelectorAll: () => [container] },
    });

    try {
      const fakePage = {
        evaluate: async (fn: (args: EvaluateArgs) => unknown, args: EvaluateArgs) => fn(args),
      };
      const result = await extractBatchData(fakePage, {
        containerSelector: '.card',
        fields: [
          { name: 'title', selector: '.title' },
          { name: 'href', selector: 'a', attribute: 'href', trim: false },
          { name: 'missing', selector: '.missing', defaultValue: 'default' },
        ],
      }, { maxFieldChars: 5, maxResultBytes: 4096 });

      // Five Unicode code points are retained without splitting 😀.
      expect(result.items[0]?.title).toBe('你好😀世界');
      expect(result.items[0]?.href).toBe('xxxxx');
      expect(result.items[0]?.missing).toBe('defau');
    } finally {
      if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    }
  });

  it('在 evaluate 内发现累计结果超过上限时返回稳定 RESOURCE_EXHAUSTED', async () => {
    const container = {
      innerText: 'x'.repeat(200),
      querySelector: () => ({ innerText: 'x'.repeat(200) }),
    };
    const originalDocument = (globalThis as { document?: unknown }).document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { querySelectorAll: () => [container, container] },
    });

    try {
      const fakePage = {
        evaluate: async (fn: (args: EvaluateArgs) => unknown, args: EvaluateArgs) => fn(args),
      };
      await expect(extractBatchData(fakePage, {
        containerSelector: '.card',
        fields: [{ name: 'title' }],
      }, { maxFieldChars: 200, maxResultBytes: 128 })).rejects.toMatchObject({
        code: 'RESOURCE_EXHAUSTED',
        retryable: false,
      });
    } finally {
      if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    }
  });

  it('在服务端限制最终 JSON UTF-8 字节数，即使 evaluate 返回未受限结果', async () => {
    const fakePage = {
      evaluate: async () => [{ title: 'x'.repeat(500) }],
    };

    await expect(extractBatchData(fakePage, {
      containerSelector: '.card',
      fields: [{ name: 'title' }],
    }, { maxResultBytes: 128 })).rejects.toBeInstanceOf(ExtractionResourceError);
  });

  it('不会因调用方传入超大限制而放宽服务端硬上限', async () => {
    let capturedArgs: EvaluateArgs | undefined;
    const fakePage = {
      evaluate: async (_fn: unknown, args: EvaluateArgs) => {
        capturedArgs = args;
        return [];
      },
    };

    await extractBatchData(fakePage, {
      containerSelector: '.card',
      fields: [{ name: 'title' }],
      maxItems: Number.MAX_SAFE_INTEGER,
    }, {
      maxFieldChars: Number.MAX_SAFE_INTEGER,
      maxResultBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(capturedArgs).toMatchObject({
      maxCount: 1_000,
      maxFieldChars: HARD_MAX_FIELD_CHARS,
      maxResultBytes: HARD_MAX_RESULT_BYTES,
    });
    expect(DEFAULT_MAX_FIELD_CHARS).toBeLessThanOrEqual(HARD_MAX_FIELD_CHARS);
    expect(DEFAULT_MAX_RESULT_BYTES).toBeLessThanOrEqual(HARD_MAX_RESULT_BYTES);
  });
});
