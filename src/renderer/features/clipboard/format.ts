/** Display helpers for clipboard history (pure). */
import type { ClipType } from "../../../main/features/clipboard/model";

const DAY = 86_400_000;
const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "Today", "Yesterday", weekday within a week, else "Mar 4" / "Mar 4, 2025". */
export function dayLabel(t: number, now = Date.now()): string {
  const diff = Math.round((startOfDay(now) - startOfDay(t)) / DAY);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  const d = new Date(t);
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

export function relativeTime(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const TYPE_LABEL: Record<ClipType, string> = { text: "Text", link: "Link", color: "Color", file: "File", image: "Image" };

/** Heuristic: show monospace for text that looks like code, JSON, shell or tabular data. */
export function looksLikeCode(text: string): boolean {
  const sample = text.slice(0, 4000);
  const lines = sample.split("\n");
  if (/^\s*[[{]/.test(sample) && /[\]}]\s*$/.test(sample.trim())) return true;
  const signals = lines.filter((l) => /^(\s{2,}|\t)\S/.test(l) || /[;{}]\s*$/.test(l) || /^\s*(\$ |#!|import |export |const |let |def |func |class |fn |SELECT |<\/?[a-z])/i.test(l)).length;
  if (lines.length >= 2 && signals / lines.length >= 0.3) return true;
  return lines.length === 1 && /(=>|::|\(\)|&&|\|\||==)/.test(sample) && !/\s{2,}/.test(sample);
}
