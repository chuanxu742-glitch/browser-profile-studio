/**
 * Read-only challenge signatures.  These are fixed internal locators, not
 * selector input accepted from an MCP caller.  In particular, none of these
 * signatures is used to click or otherwise interact with a challenge.
 */
export const CHALLENGE_IFRAME_SELECTORS = [
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="turnstile"]',
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
] as const;

export const CHALLENGE_CONTAINER_SELECTORS = [
  '#cf-chl-widget',
  '#challenge-stage',
  '[id*="cf-chl-"]',
  '[class*="cf-chl-"]',
  '[data-cf-challenge]',
  '[data-turnstile-widget]',
  '.g-recaptcha',
  '[id*="recaptcha"]',
  '.h-captcha',
  '[id*="hcaptcha"]',
  '[data-sitekey]',
  '[data-captcha]',
] as const;

export const CHALLENGE_URL_PATTERNS = [
  /challenges\.cloudflare\.com/i,
  /cdn-cgi\/challenge-platform/i,
  /(?:^|[/?_.-])turnstile(?:[/?_.-]|$)/i,
  /(?:^|[/?_.-])(?:re)?captcha(?:[/?_.-]|$)/i,
  /(?:^|[/?_.-])hcaptcha(?:[/?_.-]|$)/i,
  /(?:^|[/?_.-])challenge(?:[/?_.-]|$)/i,
] as const;

export const CHALLENGE_TITLE_PATTERNS = [
  /just a moment/i,
  /verify (?:you are|that you(?:'re| are)) human/i,
  /checking your browser/i,
  /security check/i,
  /attention required/i,
  /captcha/i,
  /recaptcha/i,
  /hcaptcha/i,
  /turnstile/i,
  /robot check/i,
  /验证访问者/i,
  /安全检查/i,
  /验证码/i,
] as const;

export const CHALLENGE_TEXT_PATTERNS = [
  /verify (?:you are|that you(?:'re| are)) human/i,
  /checking (?:your|if you are) browser/i,
  /complete the security check/i,
  /security verification required/i,
  /prove you(?:'re| are) not a robot/i,
  /enable javascript and cookies to continue/i,
  /captcha/i,
  /recaptcha/i,
  /hcaptcha/i,
  /turnstile/i,
  /验证码/i,
  /请验证你是人类/i,
] as const;

