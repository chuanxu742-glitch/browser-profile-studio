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
  '#login',
  '.login-box',
  '#J_Static2Quick',
] as const;

export const CHALLENGE_STRONG_URL_PATTERNS = [
  /challenges\.cloudflare\.com/i,
  /cdn-cgi\/challenge-platform/i,
  /(?:^|[/?_.-])login\.taobao\.com/i,
  /(?:^|[/?_.-])passport\.(?:jd|baidu|weibo)\.com/i,
] as const;

export const CHALLENGE_WEAK_URL_PATTERNS = [
  /(?:^|[/?_.-])turnstile(?:[/?_.-]|$)/i,
  /(?:^|[/?_.-])(?:re)?captcha(?:[/?_.-]|$)/i,
  /(?:^|[/?_.-])hcaptcha(?:[/?_.-]|$)/i,
  /(?:^|[/?_.-])challenge(?:[/?_.-]|$)/i,
] as const;

export const CHALLENGE_URL_PATTERNS = [
  ...CHALLENGE_STRONG_URL_PATTERNS,
  ...CHALLENGE_WEAK_URL_PATTERNS,
] as const;

export const CHALLENGE_STRONG_TITLE_PATTERNS = [
  /just a moment/i,
  /verify (?:you are|that you(?:'re| are)) human/i,
  /checking your browser/i,
  /security check/i,
  /attention required/i,
  /robot check/i,
  /验证访问者/i,
  /安全检查/i,
  /请验证你是人类/i,
] as const;

export const CHALLENGE_WEAK_TITLE_PATTERNS = [
  /(?:^|\s)captcha(?:\s|$|[.:?!])/i,
  /(?:^|\s)recaptcha(?:\s|$|[.:?!])/i,
  /(?:^|\s)hcaptcha(?:\s|$|[.:?!])/i,
  /(?:^|\s)turnstile(?:\s|$|[.:?!])/i,
  /验证码/i,
  /请登录/i,
  /账号登录/i,
] as const;

export const CHALLENGE_TITLE_PATTERNS = [
  ...CHALLENGE_STRONG_TITLE_PATTERNS,
  ...CHALLENGE_WEAK_TITLE_PATTERNS,
] as const;

export const CHALLENGE_STRONG_TEXT_PATTERNS = [
  /verify (?:you are|that you(?:'re| are)) human/i,
  /checking (?:your|if you are) browser/i,
  /complete the security check/i,
  /security verification required/i,
  /prove you(?:'re| are) not a robot/i,
  /enable javascript and cookies to continue/i,
  /请验证你是人类/i,
  /安全检查中/i,
  /请完成安全验证/i,
] as const;

export const CHALLENGE_WEAK_TEXT_PATTERNS = [
  /(?:^|\s)captcha(?:\s|$|[.:?!])/i,
  /(?:^|\s)recaptcha(?:\s|$|[.:?!])/i,
  /(?:^|\s)hcaptcha(?:\s|$|[.:?!])/i,
  /(?:^|\s)turnstile(?:\s|$|[.:?!])/i,
  /验证码/i,
  /网络出了点问题/i,
  /网络开了小差/i,
  /亲，请登录/i,
  /亲，访问受限/i,
  /请登录后查看/i,
] as const;

export const CHALLENGE_TEXT_PATTERNS = [
  ...CHALLENGE_STRONG_TEXT_PATTERNS,
  ...CHALLENGE_WEAK_TEXT_PATTERNS,
] as const;

