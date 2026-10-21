/**
 * Paste Stack (pure): "Start Paste Stack" collects the next N copies; "Paste Next from Stack"
 * pastes them one by one. `items` is always kept in paste order (head = next), so FIFO appends
 * new copies and LIFO prepends them; reordering in the UI just moves ids in that array.
 */

export type StackOrder = "fifo" | "lifo";

export interface PasteStack {
  /** Collecting new copies into the stack. */
  collecting: boolean;
  /** Stop collecting after this many copies (0 = until stopped). */
  limit: number;
  /** Copies collected since the stack started (counts towards `limit`). */
  collected: number;
  order: StackOrder;
  /** Entry ids in paste order. */
  items: string[];
}

export const EMPTY_STACK: PasteStack = { collecting: false, limit: 0, collected: 0, order: "fifo", items: [] };

export function startStack(order: StackOrder, limit = 0): PasteStack {
  return { collecting: true, limit: Math.max(0, Math.floor(limit)), collected: 0, order, items: [] };
}

export function stopStack(s: PasteStack): PasteStack {
  return { ...s, collecting: false };
}

/** Add a copied entry. A re-copy of an id already waiting moves it to where a new copy would go. */
export function pushStack(s: PasteStack, id: string): PasteStack {
  if (!s.collecting) return s;
  const rest = s.items.filter((x) => x !== id);
  const items = s.order === "fifo" ? [...rest, id] : [id, ...rest];
  const collected = s.collected + 1;
  return { ...s, items, collected, collecting: s.limit > 0 ? collected < s.limit : true };
}

/** Add an entry chosen from history by hand (works whether or not the stack is collecting). */
export function addToStack(s: PasteStack, id: string): PasteStack {
  const rest = s.items.filter((x) => x !== id);
  return { ...s, items: s.order === "fifo" ? [...rest, id] : [id, ...rest] };
}

/**
 * Take the next id to paste. Ids for which `exists` is false (deleted from history) are dropped.
 * Returns null when nothing is left.
 */
export function takeNext(s: PasteStack, exists: (id: string) => boolean = () => true): { id: string | null; stack: PasteStack } {
  const items = s.items.filter(exists);
  const [id = null, ...rest] = items;
  return { id, stack: { ...s, items: id === null ? items : rest } };
}

export function removeFromStack(s: PasteStack, id: string): PasteStack {
  return { ...s, items: s.items.filter((x) => x !== id) };
}

/** Move an id up (-1) or down (+1) in paste order; clamped at the ends. */
export function moveInStack(s: PasteStack, id: string, dir: -1 | 1): PasteStack {
  const i = s.items.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= s.items.length) return s;
  const items = [...s.items];
  [items[i], items[j]] = [items[j]!, items[i]!];
  return { ...s, items };
}

/** Switch order. Waiting items are reversed so "next" follows the new rule. */
export function setStackOrder(s: PasteStack, order: StackOrder): PasteStack {
  if (order === s.order) return s;
  return { ...s, order, items: [...s.items].reverse() };
}

export function clearStack(s: PasteStack): PasteStack {
  return { ...s, items: [], collecting: false, collected: 0 };
}

export function normalizeStack(raw: unknown): PasteStack {
  if (!raw || typeof raw !== "object") return EMPTY_STACK;
  const r = raw as Partial<PasteStack>;
  return {
    collecting: r.collecting === true,
    limit: typeof r.limit === "number" && r.limit > 0 ? Math.floor(r.limit) : 0,
    collected: typeof r.collected === "number" && r.collected > 0 ? Math.floor(r.collected) : 0,
    order: r.order === "lifo" ? "lifo" : "fifo",
    items: Array.isArray(r.items) ? r.items.filter((x): x is string => typeof x === "string") : [],
  };
}
