import { SessionManager } from '../src/browser/session-manager.js';
import { UrlPolicy } from '../src/policy/url-policy.js';
import { ChallengePolicy } from '../src/challenge/policy.js';
import { runBenchmarkSuite } from './benchmark-results.js';

async function testAmIUnique() {
  const manager = new SessionManager({
    maxSessions: 1,
    urlPolicy: new UrlPolicy({
      allowedHosts: ['*.amiunique.org', 'amiunique.org', '127.0.0.1'],
      resourceHosts: ['*.amiunique.org', 'amiunique.org', '*.cloudflare.com', '*.gstatic.com', '*.googleapis.com', '127.0.0.1'],
      allowHttp: true,
      allowPrivateNetwork: true,
    }),
    challengePolicy: new ChallengePolicy(),
  });
  await runBenchmarkSuite(manager, [{
    name: 'AmIUnique', url: 'https://amiunique.org/fingerprint',
    focus: 'Observed fingerprint and sample distribution; uniqueness is not automation detection',
  }], 'amiunique', 123456);
}

testAmIUnique().catch((error: unknown) => {
  console.error('AmIUnique benchmark fatal error:', error);
  process.exitCode = 1;
});
