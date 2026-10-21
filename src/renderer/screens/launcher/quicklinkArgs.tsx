/**
 * Multi-argument entry for quicklinks in the launcher: Tab / ⇧Tab step through
 * `{argument name="…"}` fields, ↑/↓ cycle a field's options, Backspace on an empty field goes back.
 * The search field edits the current argument; the other values show as pills next to it.
 */
import type { ScoredItem } from "@shared/types";
import "./quicklinkArgs.css";

export interface QlArgDef {
  name: string;
  placeholder: string;
  default?: string;
  options?: string[];
  optional: boolean;
}

export interface MultiArg {
  defs: QlArgDef[];
  values: string[];
  index: number;
}

const isDef = (v: unknown): v is QlArgDef => typeof v === "object" && v !== null && typeof (v as QlArgDef).name === "string" && typeof (v as QlArgDef).placeholder === "string";

export function argDefsOf(scored: ScoredItem | null | undefined): QlArgDef[] {
  const raw = scored?.item.data?.arguments;
  return Array.isArray(raw) ? raw.filter(isDef) : [];
}

/** Legacy single-`{query}` links keep the classic one-field entry. */
export function wantsMultiArg(scored: ScoredItem | null | undefined): boolean {
  const defs = argDefsOf(scored);
  return defs.length > 1 || (defs.length === 1 && (defs[0]!.name !== "query" || !!defs[0]!.options || defs[0]!.default !== undefined));
}

/** Enter on the row should open the argument fields first (a required named argument is empty). */
export function needsArgEntry(scored: ScoredItem | null | undefined): boolean {
  if (!scored || !wantsMultiArg(scored)) return false;
  const first = argDefsOf(scored)[0];
  return argDefsOf(scored).some((d, i) => !d.optional && !(i === 0 && first && scored.argument?.trim()));
}

export function initMultiArg(scored: ScoredItem): { multi: MultiArg; text: string } | undefined {
  if (!wantsMultiArg(scored)) return undefined;
  const defs = argDefsOf(scored);
  const values = defs.map((d, i) => (i === 0 && scored.argument?.trim() ? scored.argument.trim() : (d.default ?? "")));
  return { multi: { defs, values, index: 0 }, text: values[0] ?? "" };
}

export function multiArgValues(m: MultiArg, text: string): Record<string, string> {
  const out: Record<string, string> = {};
  m.defs.forEach((d, i) => {
    const v = i === m.index ? text : m.values[i];
    if (v) out[d.name] = v;
  });
  return out;
}

interface KeyLike {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/** Handle a key in multi-argument mode; null when the key is not ours. */
export function multiArgKey(m: MultiArg, e: KeyLike, text: string): { multi: MultiArg; text: string } | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const values = m.values.slice();
  values[m.index] = text;
  const go = (index: number) => ({ multi: { ...m, values, index }, text: values[index] ?? "" });
  if (e.key === "Tab") {
    const next = e.shiftKey ? m.index - 1 : m.index + 1;
    return next >= 0 && next < m.defs.length ? go(next) : { multi: { ...m, values }, text };
  }
  if (e.key === "Backspace" && !text && m.index > 0) return go(m.index - 1);
  const opts = m.defs[m.index]?.options;
  if (opts?.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    const cur = opts.indexOf(text);
    const step = e.key === "ArrowDown" ? 1 : -1;
    const next = cur < 0 ? (step > 0 ? 0 : opts.length - 1) : (cur + step + opts.length) % opts.length;
    values[m.index] = opts[next]!;
    return { multi: { ...m, values }, text: opts[next]! };
  }
  return null;
}

export function argPlaceholder(m: MultiArg): string {
  const d = m.defs[m.index];
  if (!d) return "Argument…";
  if (d.options?.length) return `${d.placeholder}: ${d.options.join(" / ")} (↑↓)`;
  return d.default !== undefined ? `${d.placeholder} (default ${d.default || "empty"})` : `${d.placeholder}${d.optional ? "" : " *"}`;
}

/** Pills for every argument; the current one is highlighted. */
export function ArgFields({ multi, text }: { multi: MultiArg; text: string }) {
  return (
    <span className="qlargs" data-qlargs={multi.defs.length} aria-label="Quicklink arguments">
      {multi.defs.map((d, i) => {
        const v = i === multi.index ? text : multi.values[i];
        return (
          <span key={d.name} className={`qlargs__arg ${i === multi.index ? "qlargs__arg--on" : ""} ${!v && !d.optional ? "qlargs__arg--missing" : ""}`} data-arg={d.name} title={`${d.placeholder} — Tab / ⇧Tab to move`}>
            <span className="qlargs__name">{d.placeholder}</span>
            <span className="qlargs__value">{v || d.default || "…"}</span>
          </span>
        );
      })}
      <span className="qlargs__hint">⇥</span>
    </span>
  );
}
