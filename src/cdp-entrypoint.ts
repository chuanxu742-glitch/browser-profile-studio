import { startCdpService } from './cdp/service.js';

try {
  const service = await startCdpService();
  console.log(JSON.stringify({ event: 'cdp-ready', port: service.port, browserVersion: service.metadata.browserVersion }));
  process.once('SIGTERM', () => { void service.stop(); });
  process.once('SIGINT', () => { void service.stop(); });
  await service.closed;
} catch (error) {
  // Proxy URLs and browser launch diagnostics can contain credentials.
  const code = error instanceof Error ? error.message.match(/^CDP_[A-Z_]+(?::[a-zA-Z]+)?/)?.[0] ?? error.name : 'Error';
  console.error(JSON.stringify({ event: 'cdp-start-failed', error: code }));
  process.exitCode = 1;
}
