import { SessionManager } from '../src/browser/session-manager.js';
import { UrlPolicy } from '../src/policy/url-policy.js';
import { ChallengePolicy } from '../src/challenge/policy.js';
import { runBenchmarkSuite } from './benchmark-results.js';

async function testIpheyCoherence() {
  const manager = new SessionManager({
    maxSessions: 1,
    urlPolicy: new UrlPolicy({
      allowedHosts: ['*.iphey.com', 'iphey.com', '127.0.0.1'],
      resourceHosts: ['*.iphey.com', 'iphey.com', '*.cloudflare.com', '*.gstatic.com', '*.googleapis.com', '127.0.0.1'],
      allowHttp: true,
      allowPrivateNetwork: true,
    }),
    challengePolicy: new ChallengePolicy(),
  });
  await runBenchmarkSuite(manager, [{
    name: 'IPhey coherence', url: 'https://iphey.com/',
    focus: 'Final identity verdict; BENCHMARK_COUNTRY/TIMEZONE/PROXY are explicit inputs, not proof of IP alignment',
  }], 'iphey-coherence', 888123);
}

testIpheyCoherence().catch((error: unknown) => {
  console.error('IPhey benchmark fatal error:', error);
  process.exitCode = 1;
});
