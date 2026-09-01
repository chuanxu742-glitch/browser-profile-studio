import type { RegistryLocatorLike, RegistryPageLike } from './target-registry.js';
import type { SemanticTarget, SemanticTargetMetadata, SemanticNode } from './semantic-snapshot.js';

export interface AdaptiveMatchResult {
  score: number;
  node: SemanticNode;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  matchedReasons: string[];
}

export interface AdaptiveLocatorOptions {
  minScoreThreshold?: number;
  scoreMargin?: number;
}

/**
 * 字符串相似度计算 (0.0 ~ 1.0)
 */
export function calculateTextSimilarity(a: string, b: string): number {
  const str1 = a.trim().toLowerCase();
  const str2 = b.trim().toLowerCase();
  if (str1 === str2) return 1.0;
  if (!str1 || !str2) return 0.0;

  const minLen = Math.min(str1.length, str2.length);
  const maxLen = Math.max(str1.length, str2.length);

  // 如果一方完整包含另一方（例如 "立即登录" 包含在 "立即登录 >" 或 "立即登录 (按钮)" 中）
  if (str1.includes(str2) || str2.includes(str1)) {
    return Math.min(1.0, 0.8 + 0.2 * (minLen / maxLen));
  }

  const m = str1.length;
  const n = str2.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i += 1) {
    const row = dp[i];
    if (row) row[0] = i;
  }
  const firstRow = dp[0];
  if (firstRow) {
    for (let j = 0; j <= n; j += 1) firstRow[j] = j;
  }

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const prevRow = dp[i - 1];
      const currRow = dp[i];
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      if (prevRow && currRow) {
        const del = (prevRow[j] ?? 0) + 1;
        const ins = (currRow[j - 1] ?? 0) + 1;
        const sub = (prevRow[j - 1] ?? 0) + cost;
        currRow[j] = Math.min(del, ins, sub);
      }
    }
  }

  const lastRow = dp[m];
  const distance = lastRow ? (lastRow[n] ?? 0) : 0;
  return Math.max(0, 1 - distance / maxLen);
}

/**
 * 自适应匹配评分引擎
 */
export function scoreCandidate(
  target: SemanticTarget,
  candidate: SemanticNode | SemanticTargetMetadata,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  const expectedName = target.name ?? target.label;
  const candName = candidate.name ?? candidate.text ?? '';

  // 1. Role 匹配 (基础权重 0.4)
  if (target.role) {
    if (candidate.role && candidate.role.toLowerCase() === target.role.toLowerCase()) {
      score += 0.4;
      reasons.push(`role matches '${target.role}'`);
    } else if (candidate.tag && candidate.tag.toLowerCase() === target.role.toLowerCase()) {
      score += 0.3;
      reasons.push(`tag matches '${target.role}'`);
    }
  }

  // 2. Name / Label / Text 相似度匹配 (基础权重 0.5)
  if (expectedName) {
    if (candName) {
      if (candName === expectedName) {
        score += 0.5;
        reasons.push(`exact name matches '${expectedName}'`);
      } else {
        const sim = calculateTextSimilarity(expectedName, candName);
        if (sim >= 0.5) {
          const textScore = 0.5 * sim;
          score += textScore;
          reasons.push(`fuzzy name similarity ${sim.toFixed(2)} with '${candName}'`);
        }
      }
    }
  }

  // 3. TestId 匹配 (基础权重 0.1)
  if (target.testId && candidate.testId) {
    if (candidate.testId === target.testId) {
      score += 0.1;
      reasons.push(`testId matches '${target.testId}'`);
    } else if (candidate.testId.includes(target.testId)) {
      score += 0.05;
      reasons.push(`testId partially matches '${target.testId}'`);
    }
  }

  return { score: Number(score.toFixed(3)), reasons };
}

/**
 * 从当前快照节点列表中自适应定位最符合预期 Target 的节点
 */
export function findAdaptiveTarget(
  nodes: readonly SemanticNode[],
  target: SemanticTarget,
  options: AdaptiveLocatorOptions = {},
): AdaptiveMatchResult | undefined {
  const minThreshold = options.minScoreThreshold ?? 0.65;
  const scoreMargin = options.scoreMargin ?? 0.12;

  const scored: AdaptiveMatchResult[] = [];

  for (const node of nodes) {
    const { score, reasons } = scoreCandidate(target, node);
    if (score >= minThreshold) {
      scored.push({
        score,
        node,
        confidence: score >= 0.8 ? 'HIGH' : score >= 0.7 ? 'MEDIUM' : 'LOW',
        matchedReasons: reasons,
      });
    }
  }

  if (scored.length === 0) return undefined;

  // 按得分降序排列
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return undefined;

  if (scored.length > 1) {
    const second = scored[1];
    if (second && (best.score - second.score) < scoreMargin) {
      return undefined;
    }
  }

  return best;
}
