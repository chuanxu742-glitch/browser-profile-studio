import { describe, expect, it } from 'vitest';
import { calculateTextSimilarity, scoreCandidate, findAdaptiveTarget } from '../../src/browser/adaptive-locator.js';
import type { SemanticNode, SemanticTarget } from '../../src/browser/semantic-snapshot.js';

describe('自适应定位与选择器引擎', () => {
  it('应当准确计算字符串相似度', () => {
    expect(calculateTextSimilarity('Sign In', 'Sign In')).toBe(1.0);
    expect(calculateTextSimilarity('Sign In', 'Sign in now')).toBeGreaterThanOrEqual(0.7);
    expect(calculateTextSimilarity('Submit Order', 'Submit order')).toBe(1.0);
    expect(calculateTextSimilarity('Search', 'Cancel')).toBeLessThan(0.3);
  });

  it('应当在属性发生轻微改变时正确评分', () => {
    const target: SemanticTarget = {
      role: 'button',
      name: '立即登录',
    };

    const node: SemanticNode = {
      ref: 'ref_1',
      generation: 1,
      role: 'button',
      tag: 'button',
      name: '立即登录 >',
    };

    const { score, reasons } = scoreCandidate(target, node);
    expect(score).toBeGreaterThan(0.7);
    expect(reasons.length).toBeGreaterThan(0);
  });

  it('应当在精确匹配失败时自适应命中最佳候选元素', () => {
    const target: SemanticTarget = {
      role: 'button',
      name: '确认支付',
    };

    const nodes: SemanticNode[] = [
      {
        ref: 'ref_other',
        generation: 1,
        role: 'button',
        tag: 'button',
        name: '取消订单',
      },
      {
        ref: 'ref_target',
        generation: 1,
        role: 'button',
        tag: 'button',
        name: '确认支付 (¥99.00)',
      },
    ];

    const match = findAdaptiveTarget(nodes, target);
    expect(match).toBeDefined();
    expect(match?.node.ref).toBe('ref_target');
    expect(match?.confidence).toBe('HIGH');
  });

  it('当存在两个高度相似且得分相近的候选时应避免歧义误点', () => {
    const target: SemanticTarget = {
      role: 'button',
      name: '删除',
    };

    const nodes: SemanticNode[] = [
      {
        ref: 'ref_del_1',
        generation: 1,
        role: 'button',
        tag: 'button',
        name: '删除条目 1',
      },
      {
        ref: 'ref_del_2',
        generation: 1,
        role: 'button',
        tag: 'button',
        name: '删除条目 2',
      },
    ];

    const match = findAdaptiveTarget(nodes, target, { scoreMargin: 0.15 });
    expect(match).toBeUndefined();
  });
});
