/**
 * Theme presets and token generation. Pure (no Electron/DOM): the main process uses it to
 * validate settings, the renderer turns its output into CSS custom properties.
 */

export type Scheme = "dark" | "light";
export type Density = "compact" | "comfortable";
export type ThemeMode = "system" | "dark" | "light";

export interface ThemePreset {
  id: string;
  name: string;
  scheme: Scheme;
  /** Palette: background, three surface steps, text ramp, accent and status colors (#rrggbb). */
  bg: string;
  surface: string;
  surface2: string;
  surface3: string;
  text: string;
  text2: string;
  text3: string;
  accent: string;
  danger: string;
  success: string;
  warning: string;
  /** Multiplier for borders/hover/selection strength (high contrast > 1). */
  contrast?: number;
}

export interface AppearanceSettings {
  darkTheme: string;
  lightTheme: string;
  /** "" = use the preset's accent, else #rrggbb. */
  accent: string;
  density: Density;
  /** Base font size of list rows in px (12–17). */
  fontSize: number;
  /** Panel corner radius in px (0–22). */
  radius: number;
  /** Launcher width in px (640–980). */
  width: number;
  /** 0 = opaque panel, 100 = most see-through. */
  translucency: number;
  /** macOS window vibrancy behind the launcher. */
  vibrancy: boolean;
  /** Subtle motion (always off when the OS asks for reduced motion). */
  animations: boolean;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  darkTheme: "glide-dark",
  lightTheme: "glide-light",
  accent: "",
  density: "comfortable",
  fontSize: 14,
  radius: 14,
  width: 760,
  translucency: 35,
  vibrancy: true,
  animations: true,
};

export const LIMITS = {
  fontSize: [12, 17],
  radius: [0, 22],
  width: [640, 980],
  translucency: [0, 100],
} as const;

const status = { danger: "#ff6b5e", success: "#4ade80", warning: "#fbbf24" };

export const PRESETS: ThemePreset[] = [
  { id: "glide-dark", name: "Glide Dark", scheme: "dark", bg: "#161618", surface: "#202023", surface2: "#2a2a2e", surface3: "#343439", text: "#f4f4f6", text2: "#a9a9b3", text3: "#8b8b95", accent: "#f5a524", ...status },
  { id: "glide-light", name: "Glide Light", scheme: "light", bg: "#f6f6f8", surface: "#ffffff", surface2: "#f0f0f3", surface3: "#e4e4e9", text: "#18181c", text2: "#585862", text3: "#71717b", accent: "#e08e0b", danger: "#d63b2f", success: "#1f9d55", warning: "#c77700" },
  { id: "midnight", name: "Midnight", scheme: "dark", bg: "#0b0e17", surface: "#121726", surface2: "#1a2033", surface3: "#242b42", text: "#e8ebf5", text2: "#9aa3bd", text3: "#7f88a3", accent: "#7c8cff", ...status },
  { id: "nord", name: "Nord", scheme: "dark", bg: "#2e3440", surface: "#3b4252", surface2: "#434c5e", surface3: "#4c566a", text: "#eceff4", text2: "#c5cddb", text3: "#8a93a6", accent: "#88c0d0", danger: "#bf616a", success: "#a3be8c", warning: "#ebcb8b" },
  { id: "solarized", name: "Solarized", scheme: "dark", bg: "#002b36", surface: "#073642", surface2: "#0d4250", surface3: "#164e5c", text: "#eee8d5", text2: "#93a1a1", text3: "#839496", accent: "#268bd2", danger: "#dc322f", success: "#859900", warning: "#b58900" },
  { id: "dracula", name: "Dracula", scheme: "dark", bg: "#21222c", surface: "#282a36", surface2: "#343746", surface3: "#44475a", text: "#f8f8f2", text2: "#c6c8d6", text3: "#7a84b8", accent: "#bd93f9", danger: "#ff5555", success: "#50fa7b", warning: "#f1fa8c" },
  { id: "mocha", name: "Mocha", scheme: "dark", bg: "#181825", surface: "#1e1e2e", surface2: "#313244", surface3: "#45475a", text: "#cdd6f4", text2: "#a6adc8", text3: "#7f849c", accent: "#cba6f7", danger: "#f38ba8", success: "#a6e3a1", warning: "#f9e2af" },
  { id: "dawn", name: "Dawn", scheme: "light", bg: "#faf4ed", surface: "#fffaf3", surface2: "#f2e9e1", surface3: "#e4dcd6", text: "#4b466c", text2: "#6e6a88", text3: "#77738e", accent: "#d7827e", danger: "#b4637a", success: "#286983", warning: "#ea9d34" },
  { id: "high-contrast", name: "High Contrast", scheme: "dark", bg: "#000000", surface: "#0a0a0a", surface2: "#1a1a1a", surface3: "#2b2b2b", text: "#ffffff", text2: "#e8e8e8", text3: "#c2c2c2", accent: "#ffd60a", danger: "#ff6b6b", success: "#5dff9a", warning: "#ffd60a", contrast: 2.2 },
];

export const presetById = (id: string): ThemePreset | undefined => PRESETS.find((p) => p.id === id);

// --- colors -------------------------------------------------------------------

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export function parseHex(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

export const toHex = ({ r, g, b }: RGB): string => `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;

const rgba = (c: RGB, a: number) => `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${+a.toFixed(3)})`;

/** Linear mix: t = 0 → a, t = 1 → b. */
export function mix(a: RGB, b: RGB, t: number): RGB {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

export function luminance({ r, g, b }: RGB): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Readable accent-colored text on the panel: nudge the accent toward the text color until it reaches ~4.5:1. */
export function readableOn(color: RGB, bg: RGB, text: RGB, target = 4.5): RGB {
  let c = color;
  for (let i = 0; i < 10 && contrastRatio(c, bg) < target; i++) c = mix(c, text, 0.15);
  return c;
}

// --- settings -----------------------------------------------------------------

const clampNum = (v: unknown, [lo, hi]: readonly [number, number], d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);

/** Validate an untrusted settings bag (from disk, IPC or sync) into AppearanceSettings. */
export function normalizeAppearance(raw: unknown): AppearanceSettings {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_APPEARANCE;
  const theme = (v: unknown, fallback: string) => (typeof v === "string" && presetById(v) ? v : fallback);
  return {
    darkTheme: theme(r.darkTheme, d.darkTheme),
    lightTheme: theme(r.lightTheme, d.lightTheme),
    accent: typeof r.accent === "string" && parseHex(r.accent) ? toHex(parseHex(r.accent)!) : "",
    density: r.density === "compact" ? "compact" : "comfortable",
    fontSize: clampNum(r.fontSize, LIMITS.fontSize, d.fontSize),
    radius: clampNum(r.radius, LIMITS.radius, d.radius),
    width: clampNum(r.width, LIMITS.width, d.width),
    translucency: clampNum(r.translucency, LIMITS.translucency, d.translucency),
    vibrancy: typeof r.vibrancy === "boolean" ? r.vibrancy : d.vibrancy,
    animations: typeof r.animations === "boolean" ? r.animations : d.animations,
  };
}

/** The preset in effect for a mode ("system" follows the OS appearance). */
export function resolvePreset(mode: ThemeMode, systemDark: boolean, s: AppearanceSettings): ThemePreset {
  const dark = mode === "dark" || (mode === "system" && systemDark);
  const id = dark ? s.darkTheme : s.lightTheme;
  return presetById(id) ?? presetById(dark ? DEFAULT_APPEARANCE.darkTheme : DEFAULT_APPEARANCE.lightTheme)!;
}

/** Every CSS custom property the stylesheets read, for one preset + the user's adjustments. */
export function themeTokens(p: ThemePreset, s: AppearanceSettings): Record<string, string> {
  const dark = p.scheme === "dark";
  const k = p.contrast ?? 1;
  const bg = parseHex(p.bg)!;
  const surface = parseHex(p.surface)!;
  const text = parseHex(p.text)!;
  const accent = parseHex(s.accent) ?? parseHex(p.accent)!;
  const ink = dark ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
  // Opaque panel color = bg nudged toward surface; translucency lowers its alpha so vibrancy shows through.
  const panel = mix(bg, surface, 0.35);
  const alpha = 1 - (s.translucency / 100) * 0.5;
  const onAccent = contrastRatio(accent, { r: 255, g: 255, b: 255 }) >= 3 ? "#ffffff" : "#16130c";
  const compact = s.density === "compact";
  const fs = s.fontSize;

  return {
    "--accent": toHex(accent),
    "--accent-soft": rgba(accent, dark ? 0.2 : 0.16),
    "--accent-text": toHex(readableOn(accent, panel, text)),
    "--accent-contrast": onAccent,
    "--accent-glow": rgba(accent, 0.35),
    "--bg": p.bg,
    "--panel": rgba(panel, alpha),
    "--panel-solid": toHex(mix(panel, surface, 0.4)),
    "--surface": p.surface,
    "--surface-2": p.surface2,
    "--surface-3": p.surface3,
    "--hover": rgba(ink, Math.min(0.2, (dark ? 0.045 : 0.04) * k)),
    "--selected": rgba(ink, Math.min(0.3, (dark ? 0.085 : 0.065) * k)),
    "--selected-ring": rgba(ink, Math.min(0.4, (dark ? 0.06 : 0.05) * k)),
    "--border": rgba(ink, Math.min(0.35, (dark ? 0.08 : 0.085) * k)),
    "--border-strong": rgba(ink, Math.min(0.5, (dark ? 0.15 : 0.16) * k)),
    "--shadow": dark
      ? "0 24px 64px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.06)"
      : "0 24px 64px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.7)",
    "--text": p.text,
    "--text-2": p.text2,
    "--text-3": p.text3,
    "--kbd-bg": rgba(ink, dark ? 0.09 : 0.065),
    "--kbd-text": p.text2,
    "--tag-bg": rgba(ink, dark ? 0.1 : 0.07),
    "--danger": p.danger,
    "--success": p.success,
    "--warning": p.warning,
    "--sidebar": rgba(mix(bg, surface, 0.2), dark ? 0.6 : 0.7),
    "--input-bg": dark ? toHex(mix(bg, surface, 0.6)) : p.surface,
    "--icon-bg": rgba(ink, dark ? 0.07 : 0.05),
    "--color-scheme": p.scheme,
    // Metrics
    "--launcher-width": `${s.width}px`,
    "--radius": `${s.radius}px`,
    "--radius-sm": `${Math.max(0, Math.round(s.radius * 0.6))}px`,
    "--radius-xs": `${Math.max(0, Math.round(s.radius * 0.36))}px`,
    "--row-radius": `${Math.max(0, Math.round(s.radius * 0.66))}px`,
    "--row-h": `${(compact ? 34 : 42) + (fs - 14) * 2}px`,
    "--row-gap": compact ? "8px" : "12px",
    "--head-h": `${(compact ? 50 : 58) + (fs - 14) * 2}px`,
    "--fs-title": `${fs}px`,
    "--fs-sub": `${+(fs - 1.25).toFixed(2)}px`,
    "--fs-input": `${fs + (compact ? 4 : 6)}px`,
    "--fs-section": `${Math.max(10.5, fs - 2.5)}px`,
    "--icon-size": `${compact ? 20 : 24}px`,
    "--list-pad": compact ? "4px 6px 6px" : "6px 8px 8px",
  };
}

/** Tokens for a mode + settings in one call (what the renderer applies). */
export function tokensFor(mode: ThemeMode, systemDark: boolean, raw: unknown, previewId?: string | null): { preset: ThemePreset; tokens: Record<string, string> } {
  const s = normalizeAppearance(raw);
  const preset = (previewId && presetById(previewId)) || resolvePreset(mode, systemDark, s);
  return { preset, tokens: themeTokens(preset, s) };
}
