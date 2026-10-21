import { useCallback, useMemo, useRef } from "react";

const KEY = "glide:query-history";
const MAX = 64;

function load(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function save(list: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)));
  } catch {
    /* storage unavailable */
  }
}

/** Ring of the last 64 executed search terms; ArrowUp walks backwards through it. */
export function useQueryHistory(): { push: (term: string) => void; restoreNext: () => string | null; reset: () => void } {
  const cursor = useRef<number | null>(null);
  const push = useCallback((term: string) => {
    const t = term.trim();
    if (!t) return;
    const list = load().filter((x) => x !== t);
    list.push(t);
    save(list);
    cursor.current = null;
  }, []);
  const restoreNext = useCallback((): string | null => {
    const list = load();
    if (!list.length) return null;
    const next = cursor.current === null ? list.length - 1 : Math.max(0, cursor.current - 1);
    if (cursor.current === next) return null;
    cursor.current = next;
    return list[next] ?? null;
  }, []);
  const reset = useCallback(() => {
    cursor.current = null;
  }, []);
  return useMemo(() => ({ push, restoreNext, reset }), [push, restoreNext, reset]);
}
