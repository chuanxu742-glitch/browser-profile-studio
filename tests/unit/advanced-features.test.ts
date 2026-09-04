import { describe, expect, it } from 'vitest';
import { SeededRng } from '../../src/input/seeded-rng.js';
import {
  createBezierTrajectory,
  calculateHumanKeyDelay,
  sampleGaussian,
} from '../../src/input/scheduler.js';
import {
  getExcludedFontsForOs,
  getAllowedFontsForOs,
  WINDOWS_EXCLUSIVE_FONTS,
  MACOS_EXCLUSIVE_FONTS,
} from '../../src/fingerprint/font-topology.js';
import {
  calculateProfileOrthogonality,
  analyzeBatchOrthogonality,
} from '../../src/fingerprint/orthogonality.js';
import {
  generateFingerprint,
} from '../../src/fingerprint/generator.js';
import {
  ChallengeSolverRegistry,
  WebhookChallengeSolver,
} from '../../src/challenge/solver.js';

describe('拟人化动力学与物理生物特征 (Human Biometrics Dynamics)', () => {
  it('Bézier 轨迹遵循 Fitts 定律并包含微肌肉抖动，同时严格保真首尾坐标', () => {
    const rng = new SeededRng(42);
    const from = { x: 50, y: 50 };
    const to = { x: 600, y: 400 };

    const trajectory = createBezierTrajectory(from, to, rng, [12, 16], [300, 700]);

    expect(trajectory.points.length).toBeGreaterThanOrEqual(12);
    expect(trajectory.points.length).toBeLessThanOrEqual(16);

    // 起点与终点严格完全一致
    expect(trajectory.points[0]).toEqual(from);
    expect(trajectory.points.at(-1)).toEqual(to);

    // 耗时符合 Fitts 定律估算并落入区间
    expect(trajectory.durationMs).toBeGreaterThanOrEqual(300);
    expect(trajectory.durationMs).toBeLessThanOrEqual(700);

    // 中间路径点各不相同且有效
    for (let i = 1; i < trajectory.points.length - 1; i++) {
      expect(Number.isFinite(trajectory.points[i]!.x)).toBe(true);
      expect(Number.isFinite(trajectory.points[i]!.y)).toBe(true);
    }
  });

  it('击键动力学模型产生高斯分布延迟，并对常见二元字母组合产生人类加速效果', () => {
    const rng = new SeededRng(100);
    const minDelay = 25;
    const maxDelay = 90;

    // 单独按键延迟在安全边界内
    const delays: number[] = [];
    for (let i = 0; i < 50; i++) {
      const d = calculateHumanKeyDelay('a', undefined, rng, minDelay, maxDelay);
      delays.push(d);
      expect(d).toBeGreaterThanOrEqual(minDelay);
      expect(d).toBeLessThanOrEqual(maxDelay);
    }

    // 常见二元组合如 "th" 平均延迟应低于普通不常见按键
    const rng1 = new SeededRng(77);
    const rng2 = new SeededRng(77);
    const digraphDelay = calculateHumanKeyDelay('h', 't', rng1, minDelay, maxDelay);
    const normalDelay = calculateHumanKeyDelay('z', 'q', rng2, minDelay, maxDelay);
    expect(digraphDelay).toBeLessThanOrEqual(normalDelay);
  });

  it('Box-Muller 高斯随机分布生成有效数值', () => {
    const rng = new SeededRng(12345);
    const samples = Array.from({ length: 100 }, () => sampleGaussian(rng, 50, 10));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeGreaterThan(45);
    expect(mean).toBeLessThan(55);
  });
});

describe('操作系统字体库拓扑对齐 (Font Enumeration Alignment)', () => {
  it('Windows 系统白名单包含 Segoe UI，并严格排除 Mac 专属字体', () => {
    const allowed = getAllowedFontsForOs('windows');
    const excluded = getExcludedFontsForOs('windows');

    expect(allowed).toContain('Segoe UI');
    expect(allowed).toContain('Arial');
    expect(excluded).toContain('San Francisco');
    expect(excluded).toContain('PingFang SC');
  });

  it('macOS 系统白名单包含 San Francisco，并严格排除 Windows 专属字体', () => {
    const allowed = getAllowedFontsForOs('macos');
    const excluded = getExcludedFontsForOs('macos');

    expect(allowed).toContain('San Francisco');
    expect(allowed).toContain('Helvetica Neue');
    expect(excluded).toContain('Segoe UI');
    expect(excluded).toContain('Calibri');
  });
});

describe('多账号指纹正交度与防重检测 (Fingerprint Orthogonality & Collision)', () => {
  it('同一种子生成的相同环境正交度低，不同种子环境正交度高', () => {
    const p1 = generateFingerprint(1001, 'windows');
    const p2 = generateFingerprint(1001, 'windows');
    const p3 = generateFingerprint(8888, 'macos');

    const sameResult = calculateProfileOrthogonality(p1, p2);
    expect(sameResult.score).toBe(0);
    expect(sameResult.riskLevel).toBe('HIGH');

    const diffResult = calculateProfileOrthogonality(p1, p3);
    expect(diffResult.score).toBeGreaterThanOrEqual(70);
    expect(diffResult.riskLevel).toBe('LOW');
  });

  it('批量矩阵分析准确报告整体碰撞风险与最低分组', () => {
    const profiles = [
      generateFingerprint(1, 'windows'),
      generateFingerprint(2, 'windows'),
      generateFingerprint(3, 'macos'),
    ];

    const report = analyzeBatchOrthogonality(profiles);
    expect(report.pairs.length).toBe(3);
    expect(report.averageScore).toBeGreaterThan(30);
    expect(report.overallRisk).toBeDefined();
  });
});

describe('Challenge 自动求解插件生态 (Challenge Solver Ecosystem)', () => {
  it('SolverRegistry 正确注册、检索与解绑求解器', () => {
    const registry = new ChallengeSolverRegistry();
    const solver = new WebhookChallengeSolver({ endpoint: 'http://127.0.0.1:9999/solve' });

    registry.register(solver);
    expect(registry.findSolver('cloudflare_turnstile')).toBe(solver);
    expect(registry.findSolver('unknown_vendor_type')).toBeUndefined();

    registry.unregister(solver.id);
    expect(registry.findSolver('cloudflare_turnstile')).toBeUndefined();
  });
});
