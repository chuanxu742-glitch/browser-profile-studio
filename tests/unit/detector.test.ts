import { describe, expect, it } from 'vitest';

import { ChallengeDetector } from '../../src/challenge/detector.js';

describe('ChallengeDetector', () => {
  it('detects a local fixture challenge from read-only page signals', async () => {
    const detector = new ChallengeDetector({ now: () => new Date('2026-08-30T00:00:00.000Z') });
    const result = await detector.detect({
      url: 'https://fixture.test/check',
      title: 'Verify you are human',
      text: 'Complete the security check to continue.',
      containers: [{ selector: '#challenge-stage', text: 'security check' }],
    });
    expect(result.detected).toBe(true);
    expect(result.isChallenge).toBe(true);
    expect(result.signals.some((signal) => signal.source === 'title')).toBe(true);
    expect(result.signals.some((signal) => signal.source === 'container')).toBe(true);
  });

  it('does not pause for a bare 403/429 response signal', async () => {
    const detector = new ChallengeDetector();
    const result = await detector.detect({ url: 'https://fixture.test/page', responseStatus: 403 });
    expect(result.detected).toBe(false);
    expect(result.signals).toHaveLength(1);
  });

  it('detects known challenge iframe origins without interacting with the iframe', async () => {
    const detector = new ChallengeDetector();
    const result = await detector.detect({
      url: 'https://fixture.test/form',
      iframeUrls: ['https://challenges.cloudflare.com/cdn-cgi/challenge-platform/frame'],
    });
    expect(result.detected).toBe(true);
    expect(result.signals[0]?.source).toBe('iframe');
    expect(result.signals[0]?.origin).toBe('https://challenges.cloudflare.com');
  });

  it('does not pause for documentation or test pages merely mentioning captcha or turnstile in text', async () => {
    const detector = new ChallengeDetector();
    const result = await detector.detect({
      url: 'https://fixture.test/docs/security',
      title: 'Security Architecture Overview',
      text: 'This documentation explains how CAPTCHA and Turnstile protect against automated bot attacks.',
    });
    expect(result.detected).toBe(false);
    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.signals.every((s) => s.confidence === 'low')).toBe(true);
  });

  it('correctly detects challenge when weak text signal is paired with a challenge container or iframe', async () => {
    const detector = new ChallengeDetector();
    const result = await detector.detect({
      url: 'https://fixture.test/verify',
      text: 'Please solve the captcha below.',
      containers: [{ selector: '#cf-chl-widget', marker: '#cf-chl-widget' }],
    });
    expect(result.detected).toBe(true);
  });

  it('does not pause for documentation URLs containing turnstile or captcha in path without challenge DOM', async () => {
    const detector = new ChallengeDetector();
    const result = await detector.detect({
      url: 'https://developers.cloudflare.com/turnstile/troubleshooting/testing/',
      title: 'Testing Turnstile · Cloudflare Turnstile docs',
      text: 'Learn how to test Turnstile in your development and staging environments.',
    });
    expect(result.detected).toBe(false);
  });
});

