import { describe, expect, it } from 'vitest';
import { assessBenchmarkSnapshot } from '../../scripts/benchmark-results.js';
import type { SemanticSnapshot } from '../../src/browser/semantic-snapshot.js';

const results = [
  { domain: 'iphey.com', text: '85 MX Score Your Digital Identity Looks Trustworthy', status: 'passed', ready: true },
  { domain: 'whoer.net', text: 'Your disguise: 100%', status: 'inconclusive', ready: true },
  { domain: 'browserscan.net', text: 'Browser fingerprint authenticity: 100%', status: 'inconclusive', ready: false },
  { domain: 'amiunique.org', text: 'Only 1 browsers out of the 100 observed browsers have exactly the same fingerprint as yours (1%) Javascript attributes', status: 'inconclusive', ready: true },
] as const;

function assess(host: string, text: string) {
  const snapshot: SemanticSnapshot = { generation: 1, targets: [], elements: [], text };
  return assessBenchmarkSnapshot({ name: host, url: `https://${host}/` }, snapshot, [], 'firefox');
}

describe('benchmark result origin selection', () => {
  it.each(results)('recognizes $domain apex and subdomain results without accepting lookalike hosts', ({ domain, text, status, ready }) => {
    for (const host of [domain, `www.${domain}`]) {
      expect(assess(host, text)).toMatchObject({ status, ready, evidence: expect.any(Object) });
    }
    for (const host of [`not${domain}`, `${domain}.attacker.test`]) {
      const result = assess(host, text);
      expect(result).toMatchObject({ status: 'inconclusive', ready: false });
      expect(result.evidence).toBeUndefined();
    }
  });
});
