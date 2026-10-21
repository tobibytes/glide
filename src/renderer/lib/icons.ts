import type { ItemIcon, ItemKind, SearchItem } from "@shared/types";

/** Resolve app/file icons through the privileged glide-icon scheme registered by main. */
export function iconUrl(icon: ItemIcon): string | null {
  if (icon.kind === "app" || icon.kind === "file") return `glide-icon://icon/?path=${encodeURIComponent(icon.value)}`;
  if (icon.kind === "url") return icon.value;
  return null;
}

export const KIND_LABEL: Record<ItemKind, string> = {
  app: "Application",
  system: "Command",
  workflow: "Workflow",
  quicklink: "Quicklink",
  snippet: "Snippet",
  file: "File",
  calculator: "Calculator",
  setting: "Setting",
  fallback: "Fallback",
  command: "Command", // overridden per item by item.kindLabel
};

/** Label for the kind column: the feature-provided kindLabel wins over the generic kind name. */
export function kindLabel(item: Pick<SearchItem, "kind" | "kindLabel">): string {
  return item.kindLabel || KIND_LABEL[item.kind];
}

/** Minimal set of named symbols for icon.kind === "symbol" (SF-Symbol-like names mapped to glyphs). */
const SYMBOLS: Record<string, string> = {
  gear: "⚙︎",
  gearshape: "⚙︎",
  star: "★",
  "star.fill": "★",
  bolt: "⚡︎",
  link: "⛓",
  doc: "▤",
  folder: "▣",
  terminal: ">_",
  globe: "◍",
  magnifyingglass: "⌕",
  clipboard: "▤",
  keyboard: "⌨",
  calculator: "=",
  app: "▢",
  command: "⌘",
  play: "▶",
  bell: "♪",
  trash: "✕",
  lock: "⚿",
  moon: "☾",
  sun: "☀",
  speaker: "♫",
};

export function symbolGlyph(name: string): string {
  return SYMBOLS[name] ?? name.slice(0, 2).toUpperCase();
}

export const EMOJI_CHOICES = [
  "🧩", "⚡️", "🚀", "☀️", "🌙", "📝", "📋", "🔎", "🌐", "💻", "📜", "⌨️", "🔔", "⏳", "❓", "🏷️", "🔀", "📡", "🪟", "📂", "🔊",
  "🎯", "🛠️", "🧠", "📅", "✉️", "💬", "🎵", "🎬", "📷", "🗂️", "🧪", "🔐", "🧹", "🧭", "🌈", "🔥", "💡", "🪄", "🐙", "▶️", "⭐️",
  "❤️", "✅", "🚫", "🏁", "📦", "🎁", "🧾", "💰", "🧮", "🗒️", "🖥️", "📱", "🎧", "☕️", "🍎", "🌱", "🐛", "🦄",
];

export const COLOR_CHOICES = ["#F5A524", "#F97066", "#F670C7", "#9B8AFB", "#528BFF", "#2ED3B7", "#32D583", "#FDB022", "#98A2B3", "#1D2939"];
