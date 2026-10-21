/** Color parsing and formatting (pure). Shared by the main feature and the renderer views. */

export interface RGBA {
  r: number; // 0-255
  g: number;
  b: number;
  a: number; // 0-1
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export function rgbToHsl({ r, g, b }: RGBA): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: Math.round(l * 100) };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  h = Math.round(h * 60);
  if (h < 0) h += 360;
  return { h, s: Math.round(s * 100), l: Math.round(l * 100) };
}

const num = (s: string, max: number): number | undefined => {
  const t = s.trim();
  if (t.endsWith("%")) {
    const v = Number(t.slice(0, -1));
    return Number.isFinite(v) ? (clamp(v, 0, 100) / 100) * max : undefined;
  }
  const v = Number(t);
  return t !== "" && Number.isFinite(v) ? clamp(v, 0, max) : undefined;
};

/** "#f80", "#ff8800", "#ff880080", "rgb(255, 136, 0)", "rgba(255 136 0 / 50%)", "hsl(32, 100%, 50%)". */
export function parseColor(input: string): RGBA | undefined {
  const t = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(t);
  if (hex) {
    let h = hex[1]!;
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? Math.round((parseInt(h.slice(6, 8), 16) / 255) * 100) / 100 : 1 };
  }
  const fn = /^(rgba?|hsla?)\(\s*([^)]*)\)$/.exec(t);
  if (!fn) return undefined;
  const parts = fn[2]!.split(/\s*[,/]\s*|\s+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return undefined;
  const alpha = parts[3] !== undefined ? num(parts[3], 1) : 1;
  if (alpha === undefined) return undefined;
  if (fn[1]!.startsWith("rgb")) {
    const [r, g, b] = parts.slice(0, 3).map((p) => num(p, 255));
    if (r === undefined || g === undefined || b === undefined) return undefined;
    return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a: alpha };
  }
  const h = Number(parts[0]!.replace(/deg$/, ""));
  const s = num(parts[1]!, 1);
  const l = num(parts[2]!, 1);
  if (!Number.isFinite(h) || s === undefined || l === undefined || !parts[1]!.endsWith("%") || !parts[2]!.endsWith("%")) return undefined;
  const [r, g, b] = hslToRgb(h, s, l);
  return { r, g, b, a: alpha };
}

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, "0");
const f3 = (n: number) => String(Math.round(n * 1000) / 1000);

export type ColorFormat = "hex" | "hexLower" | "rgb" | "hsl" | "swiftui" | "nscolor" | "css";

export const FORMAT_TITLES: Record<ColorFormat, string> = {
  hex: "HEX",
  hexLower: "HEX (lowercase)",
  rgb: "RGB",
  hsl: "HSL",
  swiftui: "SwiftUI",
  nscolor: "NSColor",
  css: "CSS",
};

export function formatColor(c: RGBA, format: ColorFormat): string {
  const alpha = c.a < 1;
  switch (format) {
    case "hex":
      return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${alpha ? hex2(c.a * 255) : ""}`.toUpperCase();
    case "hexLower":
      return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${alpha ? hex2(c.a * 255) : ""}`;
    case "rgb":
      return alpha ? `rgba(${c.r}, ${c.g}, ${c.b}, ${f3(c.a)})` : `rgb(${c.r}, ${c.g}, ${c.b})`;
    case "hsl": {
      const { h, s, l } = rgbToHsl(c);
      return alpha ? `hsla(${h}, ${s}%, ${l}%, ${f3(c.a)})` : `hsl(${h}, ${s}%, ${l}%)`;
    }
    case "swiftui":
      return `Color(red: ${f3(c.r / 255)}, green: ${f3(c.g / 255)}, blue: ${f3(c.b / 255)}${alpha ? `, opacity: ${f3(c.a)}` : ""})`;
    case "nscolor":
      return `NSColor(srgbRed: ${f3(c.r / 255)}, green: ${f3(c.g / 255)}, blue: ${f3(c.b / 255)}, alpha: ${f3(c.a)})`;
    case "css":
      return `color: ${formatColor(c, "hexLower")};`;
  }
}

export const ALL_FORMATS: ColorFormat[] = ["hex", "rgb", "hsl", "swiftui", "css", "nscolor", "hexLower"];

/** Relative luminance (WCAG) — used to pick readable text on a swatch. */
export function luminance({ r, g, b }: RGBA): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** Opaque "#RRGGBB" for icons and history keys. */
export const hexOf = (c: RGBA) => formatColor({ ...c, a: 1 }, "hex");
