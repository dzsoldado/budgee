// Draws the app icons into apps/web/public from one drawing, scripts/icon-cat.svg (a cat in glasses
// doing the books), on a --primary background read from the Plain Ledger tokens. Each icon places the
// drawing at its own scale for its platform; resvg renders the PNGs. Run after changing the
// drawing or the tokens: `bun run gen:icons`. A test checks the committed files are current.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";
import en from "../apps/web/src/i18n/en.json";

const root = join(import.meta.dir, "..");
export const PUBLIC_DIR = join(root, "apps", "web", "public");

/** A light-theme token's value from tokens.css, e.g. `token("--primary")` → "#5b2bb8". */
export function token(name: string): string {
  const css = readFileSync(join(root, "apps", "web", "src", "styles", "tokens.css"), "utf8");
  const light = css.slice(0, css.indexOf('[data-theme="dark"]'));
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(light);
  if (!match?.[1]) throw new Error(`${name} not found in tokens.css`);
  return match[1].toLowerCase();
}

// ─── The drawing ────────────────────────────────────────────────────────

/** The drawing's markup inside its <svg>, on a 512 square. */
function art(): string {
  const svg = readFileSync(join(import.meta.dir, "icon-cat.svg"), "utf8");
  const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(svg)?.[1];
  if (!inner) throw new Error("icon-cat.svg has no <svg> element");
  // Its <title> names the file on its own; the icon has one of its own.
  return inner.replace(/<title>[\s\S]*?<\/title>/, "").trim();
}

/** Center of the drawing's ink, outlines included, in its own 512 square. */
const ART_CENTER = { x: 253.5, y: 265 };
/** Half the drawing's ink height below its center: where the feet touch the ground shadow. */
const ART_FEET = 227;

export interface IconStyle {
  /** Corner radius as a share of the size; 0 for a full-bleed square (maskable, Apple). */
  radius: number;
  /** The drawing's scale; at 1 its 455×454 ink fills about 89% of the icon's height. */
  scale: number;
  /** Where the drawing's center goes, from the top, as a share of the size. */
  center: number;
}

/** The browser tab: as large as the rounded corners allow, since it shows at 16–32px. */
export const FAVICON: IconStyle = { radius: 144 / 512, scale: 1, center: 246 / 512 };
/** Installed-app icons on platforms that keep the icon's own shape. */
export const ROUNDED: IconStyle = { radius: 144 / 512, scale: 0.88, center: 248 / 512 };
/** Android masks it to a circle or other shape: everything inside the central 80% circle. */
export const MASKABLE: IconStyle = { radius: 0, scale: 0.72, center: 252 / 512 };
/** iOS rounds the corners itself and shows black where a PNG is transparent. */
export const FULL_BLEED: IconStyle = { radius: 0, scale: 0.84, center: 250 / 512 };

// ─── SVG ────────────────────────────────────────────────────────────────

const n = (value: number) => String(Math.round(value * 100) / 100);

export function iconSvg(style: IconStyle = FAVICON): string {
  const size = 512;
  const { scale: s } = style;
  const cy = style.center * size;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">`,
    `<title>${en["app.name"]}</title>`,
    `<rect width="${size}" height="${size}" rx="${n(style.radius * size)}" fill="${token("--primary")}"/>`,
    `<ellipse cx="${size / 2}" cy="${n(cy + ART_FEET * s)}" rx="${n(196 * s)}" ry="${n(16 * s)}" fill="${token("--primary-ink")}"/>`,
    `<g transform="translate(${size / 2} ${n(cy)}) scale(${s}) translate(${-ART_CENTER.x} ${-ART_CENTER.y})">`,
    art(),
    "</g>",
    "</svg>",
    "",
  ].join("\n");
}

// ─── PNG ────────────────────────────────────────────────────────────────

/** RGBA pixels of the icon, `size` square, not premultiplied. */
export function iconPixels(size: number, style: IconStyle = ROUNDED): Uint8Array {
  const image = new Resvg(iconSvg(style), { fitTo: { mode: "width", value: size } }).render();
  if (image.width !== size || image.height !== size) throw new Error("resvg rendered a wrong size");
  // resvg's pixels are premultiplied; PNG wants them straight.
  const pixels = new Uint8Array(image.pixels);
  for (let at = 0; at < pixels.length; at += 4) {
    const alpha = pixels[at + 3] ?? 0;
    if (alpha === 0 || alpha === 255) continue;
    for (let c = 0; c < 3; c++) {
      pixels[at + c] = Math.min(255, Math.round(((pixels[at + c] ?? 0) * 255) / alpha));
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** The icon as a PNG file, `size` square, 8-bit RGBA. */
export function iconPng(size: number, style: IconStyle = ROUNDED): Uint8Array {
  const pixels = iconPixels(size, style);
  const rows = new Uint8Array(size * (size * 4 + 1)); // each row: filter 0, then its pixels
  for (let y = 0; y < size; y++) {
    rows.set(pixels.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA, deflate, no filter method, no interlace
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ];
  const png = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

/** The PNG icons in apps/web/public, by name. */
export const PNG_ICONS: Record<string, { size: number; style: IconStyle }> = {
  "pwa-192.png": { size: 192, style: ROUNDED },
  "pwa-512.png": { size: 512, style: ROUNDED },
  "maskable-512.png": { size: 512, style: MASKABLE },
  "apple-touch-icon.png": { size: 180, style: FULL_BLEED },
};

/** Every generated file in apps/web/public, by name. */
export function icons(): Record<string, string | Uint8Array> {
  return {
    "favicon.svg": iconSvg(FAVICON),
    ...Object.fromEntries(
      Object.entries(PNG_ICONS).map(([name, { size, style }]) => [name, iconPng(size, style)]),
    ),
  };
}

if (import.meta.main) {
  for (const [name, content] of Object.entries(icons())) {
    writeFileSync(join(PUBLIC_DIR, name), content);
    console.log(`apps/web/public/${name}`);
  }
}
