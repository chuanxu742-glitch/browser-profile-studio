export interface Clock {
  now(): number;
}

export const DefaultClock: Clock = { now: () => Date.now() };

export type CounterMetric =
  | 'starts'
  | 'stops'
  | 'login_restore'
  | 'checkpoint_failures'
  | 'lease_loss'
  | 'proxy_quarantine'
  | 'admission_rejection';
export type GaugeMetric = 'state_totals';
export type HistogramMetric = 'durations';

export interface Labels {
  tenant?: string;
  accountGroup?: string;
  domain?: string;
  /** Accepted for caller compatibility but deliberately excluded from all metric keys. */
  profileId?: string;
  /** Accepted for caller compatibility but deliberately excluded from all metric keys. */
  proxyId?: string;
}

export interface AlertRule {
  id: string;
  metric: CounterMetric;
  threshold: number;
  windowMs: number;
}

export interface AlertState {
  ruleId: string;
  active: boolean;
  value: number;
}

interface HistogramSnapshot {
  sum: number;
  count: number;
  buckets: Record<string, number>;
}

export interface AccountMetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, HistogramSnapshot>;
}

const HISTOGRAM_BUCKETS = [100, 500, 1_000, 5_000, 10_000, 30_000, 60_000] as const;
const SAFE_RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function dimension(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 128) : 'unknown';
}

export class AccountMetrics {
  private readonly clock: Clock;
  private readonly maxCardinality: number;
  private readonly bucketSizeMs: number;
  private readonly maxRollingBuckets: number;
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, { sum: number; count: number; buckets: Map<string, number> }>();
  private readonly rollingCounters = new Map<string, Map<number, number>>();
  private readonly alertRules: AlertRule[] = [];
  private readonly labelKeys = new Set<string>();

  constructor(options: { clock?: Clock; maxCardinality?: number; bucketSizeMs?: number; maxRollingBuckets?: number } = {}) {
    this.clock = options.clock ?? DefaultClock;
    this.maxCardinality = options.maxCardinality ?? 1_000;
    this.bucketSizeMs = options.bucketSizeMs ?? 60_000;
    this.maxRollingBuckets = options.maxRollingBuckets ?? 1_440;
    if (!Number.isSafeInteger(this.maxCardinality) || this.maxCardinality < 1 || this.maxCardinality > 100_000) {
      throw new Error('maxCardinality must be an integer between 1 and 100000');
    }
    if (!Number.isSafeInteger(this.bucketSizeMs) || this.bucketSizeMs < 1_000 || this.bucketSizeMs > 3_600_000) {
      throw new Error('bucketSizeMs must be an integer between 1000 and 3600000');
    }
    if (!Number.isSafeInteger(this.maxRollingBuckets) || this.maxRollingBuckets < 1 || this.maxRollingBuckets > 10_000) {
      throw new Error('maxRollingBuckets must be an integer between 1 and 10000');
    }
  }

  addAlertRule(rule: AlertRule): void {
    if (!SAFE_RULE_ID.test(rule.id)) throw new Error('Alert rule id is invalid');
    if (!Number.isFinite(rule.threshold) || rule.threshold <= 0) throw new Error('Alert threshold must be positive');
    if (!Number.isSafeInteger(rule.windowMs) || rule.windowMs < this.bucketSizeMs || rule.windowMs > this.bucketSizeMs * this.maxRollingBuckets) {
      throw new Error('Alert window is outside the retained metrics horizon');
    }
    if (this.alertRules.length >= 100) throw new Error('Alert rule limit reached');
    if (this.alertRules.some((candidate) => candidate.id === rule.id)) throw new Error(`Duplicate alert rule: ${rule.id}`);
    this.alertRules.push({ ...rule });
  }

  increment(metric: CounterMetric, labels: Labels, value = 1): void {
    if (!Number.isFinite(value) || value <= 0) throw new Error('Counter increment must be positive and finite');
    const key = this.metricKey(metric, labels);
    if (!this.admitKey(key)) return;
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);

    const bucket = Math.floor(this.clock.now() / this.bucketSizeMs) * this.bucketSizeMs;
    let rolling = this.rollingCounters.get(key);
    if (!rolling) {
      rolling = new Map<number, number>();
      this.rollingCounters.set(key, rolling);
    }
    rolling.set(bucket, (rolling.get(bucket) ?? 0) + value);
    while (rolling.size > this.maxRollingBuckets) {
      const oldest = rolling.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      rolling.delete(oldest);
    }
  }

  setGauge(metric: GaugeMetric, labels: Labels, value: number): void {
    if (!Number.isFinite(value)) throw new Error('Gauge value must be finite');
    const key = this.metricKey(metric, labels);
    if (this.admitKey(key)) this.gauges.set(key, value);
  }

  observeHistogram(metric: HistogramMetric, labels: Labels, value: number): void {
    if (!Number.isFinite(value) || value < 0) throw new Error('Histogram value must be nonnegative and finite');
    const key = this.metricKey(metric, labels);
    if (!this.admitKey(key)) return;

    let histogram = this.histograms.get(key);
    if (!histogram) {
      histogram = { sum: 0, count: 0, buckets: new Map(HISTOGRAM_BUCKETS.map((bucket) => [String(bucket), 0])) };
      histogram.buckets.set('Infinity', 0);
      this.histograms.set(key, histogram);
    }
    histogram.sum += value;
    histogram.count += 1;
    const bucket = HISTOGRAM_BUCKETS.find((candidate) => value <= candidate);
    const bucketKey = bucket === undefined ? 'Infinity' : String(bucket);
    histogram.buckets.set(bucketKey, (histogram.buckets.get(bucketKey) ?? 0) + 1);
  }

  evaluateAlerts(): AlertState[] {
    const now = this.clock.now();
    return this.alertRules.map((rule) => {
      const windowStart = now - rule.windowMs;
      let maximum = 0;
      for (const [key, rolling] of this.rollingCounters) {
        const parsed = JSON.parse(key) as [string, string, string, string];
        if (parsed[0] !== rule.metric) continue;
        let total = 0;
        for (const [bucket, value] of rolling) {
          if (bucket + this.bucketSizeMs > windowStart && bucket <= now) total += value;
        }
        maximum = Math.max(maximum, total);
      }
      return { ruleId: rule.id, active: maximum >= rule.threshold, value: maximum };
    });
  }

  snapshot(): AccountMetricsSnapshot {
    const histograms: Record<string, HistogramSnapshot> = {};
    for (const [key, histogram] of this.histograms) {
      histograms[key] = {
        sum: histogram.sum,
        count: histogram.count,
        buckets: Object.fromEntries(histogram.buckets),
      };
    }
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms,
    };
  }

  private metricKey(metric: string, labels: Labels): string {
    return JSON.stringify([metric, dimension(labels.tenant), dimension(labels.accountGroup), dimension(labels.domain)]);
  }

  private admitKey(key: string): boolean {
    if (this.labelKeys.has(key)) return true;
    if (this.labelKeys.size >= this.maxCardinality) return false;
    this.labelKeys.add(key);
    return true;
  }
}
