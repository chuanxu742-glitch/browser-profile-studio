import type { UnifiedFingerprintProfile } from './types.js';

export interface OrthogonalityPairResult {
  readonly score: number; // 0 (完全相同/严重关联) 到 100 (完全独立正交)
  readonly canvasDistance: number;
  readonly gpuMatched: boolean;
  readonly resolutionMatched: boolean;
  readonly riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface BatchOrthogonalityReport {
  readonly averageScore: number;
  readonly overallRisk: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly minScorePair?: { indexA: number; indexB: number; score: number } | undefined;
  readonly pairs: readonly { indexA: number; indexB: number; result: OrthogonalityPairResult }[];
}

/**
 * 计算两个指纹画像之间的特征欧氏距离与正交度得分。
 * 综合评估 Canvas 噪点扰动、WebGL 显卡画像、屏幕几何、并发硬件与时区差异。
 */
export function calculateProfileOrthogonality(
  a: UnifiedFingerprintProfile,
  b: UnifiedFingerprintProfile,
): OrthogonalityPairResult {
  let score = 0;

  // 1. Canvas 种子差异（权重 25%）
  const canvasDiff = Math.abs((a.canvas?.seed ?? 0) - (b.canvas?.seed ?? 0));
  const canvasDistance = canvasDiff > 0 ? 1 : 0;
  score += canvasDistance * 25;

  // 2. WebGL 显卡画像（权重 25%）
  const gpuMatched = a.webgl?.unmaskedRenderer === b.webgl?.unmaskedRenderer;
  if (!gpuMatched) {
    score += 25;
  } else {
    // 同显卡型号但 vendor 不同也可加部分分
    if (a.webgl?.vendor !== b.webgl?.vendor) score += 10;
  }

  // 3. 屏幕分辨率与比例（权重 20%）
  const resolutionMatched = a.screen.width === b.screen.width && a.screen.height === b.screen.height;
  if (!resolutionMatched) {
    score += 20;
  } else if (a.screen.devicePixelRatio !== b.screen.devicePixelRatio) {
    score += 10;
  }

  // 4. 硬件核心数与内存（权重 15%）
  const hwDiff = Math.abs(a.hardware.hardwareConcurrency - b.hardware.hardwareConcurrency) +
                 Math.abs((a.hardware.deviceMemory ?? 8) - (b.hardware.deviceMemory ?? 8));
  if (hwDiff >= 4) {
    score += 15;
  } else if (hwDiff > 0) {
    score += 8;
  }

  // 5. 地理位置与时区（权重 15%）
  if (a.geo.timezoneId !== b.geo.timezoneId) {
    score += 15;
  } else if (a.geo.locale !== b.geo.locale) {
    score += 8;
  }

  const riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' =
    score >= 70 ? 'LOW' : score >= 45 ? 'MEDIUM' : 'HIGH';

  return {
    score,
    canvasDistance,
    gpuMatched,
    resolutionMatched,
    riskLevel,
  };
}

/**
 * 批量分析多个 Profile 的互不关联度（正交防重矩阵）。
 */
export function analyzeBatchOrthogonality(
  profiles: readonly UnifiedFingerprintProfile[],
): BatchOrthogonalityReport {
  if (profiles.length < 2) {
    return {
      averageScore: 100,
      overallRisk: 'LOW',
      pairs: [],
    };
  }

  const pairs: { indexA: number; indexB: number; result: OrthogonalityPairResult }[] = [];
  let totalScore = 0;
  let minScore = Infinity;
  let minPair: { indexA: number; indexB: number; score: number } | undefined;

  for (let i = 0; i < profiles.length; i += 1) {
    for (let j = i + 1; j < profiles.length; j += 1) {
      const result = calculateProfileOrthogonality(profiles[i]!, profiles[j]!);
      pairs.push({ indexA: i, indexB: j, result });
      totalScore += result.score;
      if (result.score < minScore) {
        minScore = result.score;
        minPair = { indexA: i, indexB: j, score: result.score };
      }
    }
  }

  const averageScore = Math.round(totalScore / pairs.length);
  const overallRisk: 'LOW' | 'MEDIUM' | 'HIGH' =
    minScore < 45 ? 'HIGH' : averageScore < 60 ? 'MEDIUM' : 'LOW';

  return {
    averageScore,
    overallRisk,
    minScorePair: minPair,
    pairs,
  };
}
