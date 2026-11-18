// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/account/user-agent.test.ts
// Pure checks of the device label in Settings > Account; nothing leaves the machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deviceLabel } from "./user-agent";

const UA = {
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  safariIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  chromeIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
  ipadWebview: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  edgeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
  firefoxIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15",
  chromeAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  samsung: "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  operaWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
  chromeOs: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  nativeIos: "Falcon/1 CFNetwork/1568.200.51 Darwin/24.1.0",
  node: "node",
};

test("browser and system", () => {
  assert.equal(deviceLabel(UA.chromeMac), "Chrome (macOS)");
  assert.equal(deviceLabel(UA.safariMac), "Safari (macOS)");
  assert.equal(deviceLabel(UA.safariIphone), "Safari (iPhone)");
  assert.equal(deviceLabel(UA.chromeIphone), "Chrome (iPhone)");
  assert.equal(deviceLabel(UA.ipadWebview), "Safari (iPad)");
  assert.equal(deviceLabel(UA.edgeWin), "Edge (Windows)");
  assert.equal(deviceLabel(UA.firefoxLinux), "Firefox (Linux)");
  assert.equal(deviceLabel(UA.firefoxIphone), "Firefox (iPhone)");
  assert.equal(deviceLabel(UA.chromeAndroid), "Chrome (Android)");
  assert.equal(deviceLabel(UA.samsung), "Samsung Internet (Android)");
  assert.equal(deviceLabel(UA.operaWin), "Opera (Windows)");
  assert.equal(deviceLabel(UA.chromeOs), "Chrome (ChromeOS)");
});

test("apps and clients", () => {
  assert.equal(deviceLabel(UA.nativeIos), "Falcon app (iOS)");
  assert.equal(deviceLabel(UA.node), "API client");
});

test("missing or unknown", () => {
  assert.equal(deviceLabel(null), "Unknown device");
  assert.equal(deviceLabel(undefined), "Unknown device");
  assert.equal(deviceLabel("   "), "Unknown device");
  assert.equal(deviceLabel("SomethingElse/1.0"), "Unknown device");
});
