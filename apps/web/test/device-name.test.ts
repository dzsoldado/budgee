import { describe, expect, test } from "bun:test";
import { defaultDeviceName, describeUserAgent } from "../src/lib/device-name";

const UA = {
  chromeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  samsung:
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  chromeIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
  firefoxMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:132.0) Gecko/20100101 Firefox/132.0",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
  operaWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
  chromebook:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

describe("describeUserAgent", () => {
  test("names the browser and the system", () => {
    expect(describeUserAgent(UA.chromeWindows)).toEqual({ browser: "Chrome", os: "Windows" });
    expect(describeUserAgent(UA.edgeWindows)).toEqual({ browser: "Edge", os: "Windows" });
    expect(describeUserAgent(UA.chromeAndroid)).toEqual({ browser: "Chrome", os: "Android" });
    expect(describeUserAgent(UA.samsung)).toEqual({ browser: "Samsung Internet", os: "Android" });
    expect(describeUserAgent(UA.safariIphone)).toEqual({ browser: "Safari", os: "iPhone" });
    expect(describeUserAgent(UA.chromeIphone)).toEqual({ browser: "Chrome", os: "iPhone" });
    expect(describeUserAgent(UA.firefoxMac)).toEqual({ browser: "Firefox", os: "macOS" });
    expect(describeUserAgent(UA.safariMac)).toEqual({ browser: "Safari", os: "macOS" });
    expect(describeUserAgent(UA.firefoxLinux)).toEqual({ browser: "Firefox", os: "Linux" });
    expect(describeUserAgent(UA.operaWindows)).toEqual({ browser: "Opera", os: "Windows" });
    expect(describeUserAgent(UA.chromebook)).toEqual({ browser: "Chrome", os: "ChromeOS" });
  });

  test("leaves out what it cannot tell", () => {
    expect(describeUserAgent("")).toEqual({});
    expect(describeUserAgent("curl/8.0")).toEqual({});
  });
});

describe("defaultDeviceName", () => {
  test('"Chrome on Windows", or whichever part is known', () => {
    expect(defaultDeviceName(UA.chromeWindows)).toBe("Chrome on Windows");
    expect(defaultDeviceName("Mozilla/5.0 (Windows NT 10.0) Unknown/1.0")).toBe("Windows");
    expect(defaultDeviceName("")).toBe("This browser");
  });
});
