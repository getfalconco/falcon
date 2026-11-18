/**
 * A session's device as Settings shows it, read from the user agent Supabase
 * recorded at sign-in: "Chrome (macOS)", "Safari (iPhone)". Pure; the user
 * agent itself is never shown or logged.
 */

function browser(ua: string): string | null {
  if (/^Falcon\b|\bExpo\b|okhttp|CFNetwork|Dalvik/i.test(ua) && !/Mozilla/.test(ua)) return "Falcon app";
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return "Edge";
  if (/\bOPR\/|\bOpera\b/.test(ua)) return "Opera";
  if (/SamsungBrowser\//.test(ua)) return "Samsung Internet";
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return "Firefox";
  if (/\bCriOS\//.test(ua)) return "Chrome";
  if (/\bChrome\/|\bChromium\//.test(ua)) return "Chrome";
  if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) return "Safari";
  if (/AppleWebKit/.test(ua) && /\b(iPhone|iPad|iPod)\b/.test(ua)) return "Safari";
  if (/^node|undici|axios|curl|python|Go-http/i.test(ua)) return "API client";
  return null;
}

function system(ua: string): string | null {
  if (/\biPhone\b|\biPod\b/.test(ua)) return "iPhone";
  if (/\biPad\b/.test(ua)) return "iPad";
  if (/\bAndroid\b/.test(ua)) return "Android";
  if (/\bCrOS\b/.test(ua)) return "ChromeOS";
  if (/\bWindows\b/.test(ua)) return "Windows";
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return "macOS";
  if (/\bDarwin\//.test(ua)) return "iOS";
  if (/\bLinux\b|\bX11\b/.test(ua)) return "Linux";
  return null;
}

export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? "").trim();
  if (!ua) return "Unknown device";
  const b = browser(ua);
  const s = system(ua);
  if (b && s) return `${b} (${s})`;
  return b ?? s ?? "Unknown device";
}
