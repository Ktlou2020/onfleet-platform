'use strict';

/**
 * Turns a User-Agent header into something a support agent can read.
 *
 * Hand-rolled rather than pulling in a parser library, because the set of
 * browsers that actually reach this platform is small and the whole risk of
 * doing it by hand is ordering, which is pinned by tests. The ordering is not
 * optional: nearly every UA lies about the others.
 *
 *   - Edge says "Chrome" AND "Safari"
 *   - Chrome says "Safari"
 *   - Opera and Samsung Internet both say "Chrome"
 *   - Every iOS browser says "Safari" and "like Gecko", because iOS forces
 *     WebKit — Chrome on iPhone is "CriOS", Firefox on iPhone "FxiOS"
 *
 * So each check must exclude the ones that impersonate it, most specific
 * first. Anything unrecognised returns null rather than a wrong guess: for
 * support, "unknown" is honest and a wrong browser name sends someone down the
 * wrong path.
 */

function detectBrowser(ua) {
  if (!ua) return null;
  // Most specific first — each of these also claims to be something below it.
  if (/EdgA?\//i.test(ua) || /Edge\//i.test(ua)) return 'Edge';
  if (/OPR\/|Opera/i.test(ua)) return 'Opera';
  if (/SamsungBrowser\//i.test(ua)) return 'Samsung Internet';
  if (/CriOS\//i.test(ua)) return 'Chrome (iOS)';
  if (/FxiOS\//i.test(ua)) return 'Firefox (iOS)';
  if (/UCBrowser\//i.test(ua)) return 'UC Browser';
  if (/Firefox\//i.test(ua)) return 'Firefox';
  if (/Chrome\//i.test(ua)) return 'Chrome';
  // Only reached once every Chromium-based browser above is excluded.
  if (/Safari\//i.test(ua) && /Version\//i.test(ua)) return 'Safari';
  return null;
}

function detectOs(ua) {
  if (!ua) return null;
  // Android must precede Linux — every Android UA also says Linux.
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Windows NT/i.test(ua)) return 'Windows';
  // "Mac OS X" appears in iOS UAs too, so it comes after the iPhone check.
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
  if (/CrOS/i.test(ua)) return 'ChromeOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return null;
}

function detectDeviceType(ua) {
  if (!ua) return null;
  if (/iPad|Tablet/i.test(ua)) return 'Tablet';
  // An Android tablet omits "Mobile"; a phone includes it.
  if (/Mobile|iPhone|iPod/i.test(ua)) return 'Phone';
  if (/Android/i.test(ua)) return 'Tablet';
  return 'Desktop';
}

/** @returns {{browser: string|null, os: string|null, deviceType: string|null}} */
function parseUserAgent(ua) {
  const value = typeof ua === 'string' ? ua.slice(0, 1000) : '';
  return {
    browser: detectBrowser(value),
    os: detectOs(value),
    deviceType: value ? detectDeviceType(value) : null,
  };
}

/** "Chrome on Android (Phone)" — or as much of it as is known. */
function describeUserAgent(ua) {
  const { browser, os, deviceType } = parseUserAgent(ua);
  if (!browser && !os) return 'Unknown device';
  const base = browser && os ? `${browser} on ${os}` : (browser || os);
  return deviceType && deviceType !== 'Desktop' ? `${base} (${deviceType})` : base;
}

module.exports = { parseUserAgent, describeUserAgent, detectBrowser, detectOs, detectDeviceType };
