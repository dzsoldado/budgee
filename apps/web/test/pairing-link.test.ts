import { describe, expect, test } from "bun:test";
import { toBase64Url } from "@budgee/core";
import { buildPairingLink, parsePairingLink, readPairingParams } from "../src/sync/link";

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
const SERVER_ID = "9b2f4c1e-0d6a-4f3b-8c55-2a7e1f0b6d42";
/** The origin this app runs on in most tests. */
const APP = "https://b.example";

const linkAt = (origin: string) =>
  buildPairingLink({ origin, code: "ABCD1234", key: KEY, serverId: SERVER_ID });

describe("pairing link", () => {
  test("puts code, key and serverId in the fragment, never in the path or query", () => {
    const link = linkAt("https://budgee.example");
    expect(link).toBe(
      `https://budgee.example/#/pair?c=ABCD1234&k=${toBase64Url(KEY)}&s=${SERVER_ID}`,
    );
    const url = new URL(link);
    expect(url.pathname).toBe("/");
    expect(url.search).toBe("");
  });

  test("round-trips, with whitespace around a pasted link", () => {
    const link = linkAt("http://localhost:5174");
    expect(parsePairingLink(`  ${link}  `, "http://localhost:5174")).toEqual({
      ok: true,
      link: { origin: "http://localhost:5174", code: "ABCD1234", key: KEY, serverId: SERVER_ID },
    });
  });

  test("refuses text that is not a web pairing link", () => {
    for (const text of [
      "",
      "hello",
      "https://budgee.example/",
      "https://budgee.example/#/settings",
      // Not web links at all, even with a pairing route in them.
      "javascript:alert(1)//#/pair?c=A&k=B&s=C",
      "file:///C:/budgee/index.html#/pair?c=A&k=B&s=C",
      "data:text/html,x#/pair?c=A&k=B&s=C",
    ]) {
      expect([text, parsePairingLink(text, APP)]).toEqual([
        text,
        { ok: false, problem: "not_link" },
      ]);
    }
  });

  test("refuses a link for another origin than this app's, naming the link's host", () => {
    expect(parsePairingLink(linkAt("https://evil.example"), "https://budgee.example")).toEqual({
      ok: false,
      problem: "other_origin",
      host: "evil.example",
    });
    // Same host on another port or scheme is another origin too.
    expect(
      parsePairingLink(linkAt("https://budgee.example:8443"), "https://budgee.example"),
    ).toMatchObject({ ok: false, problem: "other_origin" });
  });

  test("reads the real host: userinfo, punycode and a trailing dot can't pass for this app", () => {
    const k = toBase64Url(KEY);
    const route = `#/pair?c=ABCD1234&k=${k}&s=${SERVER_ID}`;
    // `b.example@` is a user name; the host is evil.example.
    expect(parsePairingLink(`https://b.example@evil.example/${route}`, APP)).toEqual({
      ok: false,
      problem: "other_origin",
      host: "evil.example",
    });
    expect(parsePairingLink(`https://app@evil/${route}`, APP)).toEqual({
      ok: false,
      problem: "other_origin",
      host: "evil",
    });
    // A look-alike with a Cyrillic "а" is another (punycode) host.
    expect(parsePairingLink(`https://b.exаmple/${route}`, APP)).toMatchObject({
      ok: false,
      problem: "other_origin",
      host: expect.stringMatching(/^b\.xn--/),
    });
    // The same internationalised host, typed in Unicode or punycode, is the same origin.
    const unicode = "https://bücher.example";
    expect(parsePairingLink(`https://xn--bcher-kva.example/${route}`, unicode)).toMatchObject({
      ok: true,
      link: { origin: "https://xn--bcher-kva.example" },
    });
    // A trailing dot names the same DNS host but another origin.
    expect(parsePairingLink(`https://b.example./${route}`, APP)).toEqual({
      ok: false,
      problem: "other_origin",
      host: "b.example.",
    });
    // A user name on this app's own host changes nothing about where it syncs.
    expect(parsePairingLink(`https://someone@b.example/${route}`, APP)).toMatchObject({
      ok: true,
      link: { origin: APP },
    });
  });

  test("refuses plain http except on localhost and 127.0.0.1", () => {
    expect(parsePairingLink(linkAt("http://budgee.example"), "http://budgee.example")).toEqual({
      ok: false,
      problem: "insecure",
      host: "budgee.example",
    });
    expect(
      parsePairingLink(linkAt("http://192.168.1.5:8787"), "http://192.168.1.5:8787"),
    ).toMatchObject({ ok: false, problem: "insecure" });
    for (const origin of ["http://localhost:5174", "http://127.0.0.1:8787"]) {
      expect(parsePairingLink(linkAt(origin), origin)).toMatchObject({ ok: true });
    }
    expect(
      readPairingParams({ c: "C", k: toBase64Url(KEY), s: "s" }, "http://budgee.example"),
    ).toMatchObject({ ok: false, problem: "insecure" });
  });

  test("refuses a link with a part missing or a key that is not 32 bytes", () => {
    const k = toBase64Url(KEY);
    expect(parsePairingLink(`${APP}/#/pair?c=ABCD1234&k=${k}`, APP)).toEqual({
      ok: false,
      problem: "incomplete",
    });
    expect(parsePairingLink(`${APP}/#/pair?k=${k}&s=x`, APP)).toEqual({
      ok: false,
      problem: "incomplete",
    });
    expect(parsePairingLink(`${APP}/#/pair?c=A&k=${toBase64Url(KEY.slice(1))}&s=x`, APP)).toEqual({
      ok: false,
      problem: "bad_key",
    });
    expect(parsePairingLink(`${APP}/#/pair?c=A&k=not+base64&s=x`, APP)).toEqual({
      ok: false,
      problem: "bad_key",
    });
  });

  test("readPairingParams reads the route's query (no params at all: nothing to read)", () => {
    expect(readPairingParams({}, APP)).toBeUndefined();
    expect(readPairingParams({ c: "ABCD1234", k: toBase64Url(KEY), s: SERVER_ID }, APP)).toEqual({
      ok: true,
      link: { origin: APP, code: "ABCD1234", key: KEY, serverId: SERVER_ID },
    });
    expect(readPairingParams({ c: "ABCD1234" }, APP)).toEqual({ ok: false, problem: "incomplete" });
  });
});
