import { describe, it, expect, beforeEach } from 'vitest';
import { AccountMetrics } from '../../src/operations/account-metrics.js';

describe('AccountMetrics', () => {
    let mockTime = 1000000;
    const mockClock = { now: () => mockTime };
    let metrics: AccountMetrics;

    beforeEach(() => {
        mockTime = 1000000;
        metrics = new AccountMetrics({ clock: mockClock, bucketSizeMs: 60000, maxCardinality: 5 });
    });

    it('records counters and aggregates in snapshot, redacting identifiers', () => {
        metrics.increment('starts', { tenant: 't1', profileId: 'p1', proxyId: 'prx1' });
        metrics.increment('starts', { tenant: 't1', profileId: 'p2', proxyId: 'prx2' });

        const snap = metrics.snapshot();
        const expectedKey = JSON.stringify(['starts', 't1', 'unknown', 'unknown']);
        
        expect(snap.counters[expectedKey]).toBe(2);
        
        // Ensure no profile or proxy id in the key
        const keys = Object.keys(snap.counters);
        expect(keys.some(k => k.includes('p1') || k.includes('prx1'))).toBe(false);
    });

    it('records histograms accurately', () => {
        metrics.observeHistogram('durations', { tenant: 't1' }, 150);
        metrics.observeHistogram('durations', { tenant: 't1' }, 2000);
        metrics.observeHistogram('durations', { tenant: 't1' }, 15000);

        const snap = metrics.snapshot();
        const expectedKey = JSON.stringify(['durations', 't1', 'unknown', 'unknown']);
        
        const hist = snap.histograms[expectedKey]!;
        expect(hist.sum).toBe(17150);
        expect(hist.count).toBe(3);
        expect(hist.buckets['500']).toBe(1); // 150
        expect(hist.buckets['5000']).toBe(1); // 2000
        expect(hist.buckets['30000']).toBe(1); // 15000
    });

    it('handles cardinality cap', () => {
        metrics.increment('starts', { tenant: 't1' });
        metrics.increment('starts', { tenant: 't2' });
        metrics.increment('starts', { tenant: 't3' });
        metrics.increment('starts', { tenant: 't4' });
        metrics.increment('starts', { tenant: 't5' });
        // This one should be ignored due to cardinality cap of 5
        metrics.increment('starts', { tenant: 't6' });

        const snap = metrics.snapshot();
        expect(Object.keys(snap.counters).length).toBe(5);
        expect(snap.counters[JSON.stringify(['starts', 't6', 'unknown', 'unknown'])]).toBeUndefined();
    });

    it('evaluates alerts and handles rolling expiry/recovery', () => {
        metrics.addAlertRule({
            id: 'high_starts',
            metric: 'starts',
            threshold: 10,
            windowMs: 120000 // 2 minutes
        });

        // Add 5 in current bucket
        metrics.increment('starts', { tenant: 't1' }, 5);
        
        let alerts = metrics.evaluateAlerts();
        expect(alerts[0]!.active).toBe(false);
        expect(alerts[0]!.value).toBe(5);

        // Move time by 1 minute, add 6 more
        mockTime += 60000;
        metrics.increment('starts', { tenant: 't1' }, 6);

        alerts = metrics.evaluateAlerts();
        expect(alerts[0]!.active).toBe(true); // Total 11
        expect(alerts[0]!.value).toBe(11);

        // Move beyond the two-minute window plus bucket granularity.
        mockTime += 180001;
        alerts = metrics.evaluateAlerts();
        expect(alerts[0]!.active).toBe(false);
        expect(alerts[0]!.value).toBe(0);
    });

    it('handles gauge metrics', () => {
        metrics.setGauge('state_totals', { tenant: 't1' }, 42);
        metrics.setGauge('state_totals', { tenant: 't1', profileId: 'p1' }, 10);
        
        const snap = metrics.snapshot();
        const expectedKey = JSON.stringify(['state_totals', 't1', 'unknown', 'unknown']);
        
        // Gauge identity excludes raw profile IDs, so the latest value wins.
        expect(snap.gauges[expectedKey]).toBe(10);
    });
});
