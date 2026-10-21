import type { MatchRange } from "@shared/types";

/** Title text with matched ranges wrapped in <mark>. */
export function Highlight({ text, ranges }: { text: string; ranges: MatchRange[] }) {
  if (!ranges.length) return <>{text}</>;
  const sorted = [...ranges].filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: React.ReactNode[] = [];
  let cursor = 0;
  sorted.forEach((r, i) => {
    const start = Math.max(r.start, cursor);
    const end = Math.min(r.end, text.length);
    if (start >= end) return;
    if (start > cursor) out.push(text.slice(cursor, start));
    out.push(<mark key={i}>{text.slice(start, end)}</mark>);
    cursor = end;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return <>{out}</>;
}
