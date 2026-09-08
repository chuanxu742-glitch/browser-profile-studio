import { SessionManager } from '../src/browser/session-manager.js';
import { UrlPolicy } from '../src/policy/url-policy.js';
import { ChallengePolicy } from '../src/challenge/policy.js';
import { runBenchmarkSuite } from './benchmark-results.js';

async function runScoreBenchmarks() {
  const manager = new SessionManager({
    maxSessions: 1,
    urlPolicy: new UrlPolicy({
      allowedHosts: ['*.browserscan.net', 'browserscan.net', '*.whoer.net', 'whoer.net', '127.0.0.1'],
      resourceHosts: [
        '*.browserscan.net', 'browserscan.net', '*.whoer.net', 'whoer.net',
        '*.cloudflare.com', '*.gstatic.com', '*.googleapis.com', '*.google.com', '127.0.0.1',
      ],
      allowHttp: true,
      allowPrivateNetwork: true,
    }),
    challengePolicy: new ChallengePolicy(),
  });
  await runBenchmarkSuite(manager, [
    { name: 'BrowserScan', url: 'https://www.browserscan.net/', focus: 'Site-reported fingerprint authenticity rating; not a ban probability' },
    { name: 'Whoer', url: 'https://whoer.net/', focus: 'Site-reported disguise rating; IP alignment is not assumed' },
  ], 'scores', 654321);
}

runScoreBenchmarks().catch((error: unknown) => {
  console.error('Score benchmark fatal error:', error);
  process.exitCode = 1;
});
