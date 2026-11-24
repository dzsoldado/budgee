import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { FAVICON, iconPixels, iconSvg, PNG_ICONS, PUBLIC_DIR, ROUNDED, token } from "./gen-icons";

/**
 * Size and RGBA pixels of an 8-bit RGBA, non-interlaced PNG with unfiltered rows, as gen:icons
 * writes them. Compared by pixels, not bytes: another zlib may compress the same rows differently.
 */
function decodePng(bytes: Uint8Array): { size: number; pixels: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  for (let at = 8; at < bytes.length; ) {
    const length = view.getUint32(at);
    const type = new TextDecoder().decode(bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      expect(Array.from(data.subarray(8, 13))).toEqual([8, 6, 0, 0, 0]);
    } else if (type === "IDAT") idat.push(data);
    at += 12 + length;
  }
  expect(width).toBe(height);
  const rows = inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(rows[y * stride]).toBe(0); // filter: none
    pixels.set(rows.subarray(y * stride + 1, (y + 1) * stride), y * width * 4);
  }
  return { size: width, pixels };
}

describe("app icons", () => {
  test("the committed favicon is what `bun run gen:icons` draws now", () => {
    expect(readFileSync(join(PUBLIC_DIR, "favicon.svg"), "utf8")).toBe(iconSvg(FAVICON));
  });

  // resvg's antialiasing may differ by a step between platforms, so allow it.
  test("the committed PNGs have the pixels `bun run gen:icons` draws now", () => {
    for (const [name, { size, style }] of Object.entries(PNG_ICONS)) {
      const committed = decodePng(readFileSync(join(PUBLIC_DIR, name)));
      expect([name, committed.size]).toEqual([name, size]);
      const drawn = iconPixels(size, style);
      let worst = 0;
      for (let i = 0; i < drawn.length; i++) {
        worst = Math.max(worst, Math.abs((drawn[i] ?? 0) - (committed.pixels[i] ?? 0)));
      }
      expect([name, worst <= 2]).toEqual([name, true]);
    }
  });

  test("the cat accountant on a primary square with transparent rounded corners", () => {
    const size = 128;
    const pixels = iconPixels(size, ROUNDED);
    const at = (x: number, y: number) =>
      Array.from(pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4));
    const hex = (value: string) => [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
    expect(at(0, 0)[3]).toBe(0);
    expect(at(2, size / 2)).toEqual([...hex(token("--primary")), 255]);
    expect(at(82, 38)).toEqual([...hex("#c9c4d8"), 255]); // the fur
    expect(at(91, 107)).toEqual([...hex("#e89a12"), 255]); // the coin stack
    expect(at(32, 74)).toEqual([...hex("#ffffff"), 255]); // the front invoice
  });
});
