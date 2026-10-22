/**
 * Whether the keyboard tap should turn ⌘V into "paste the next Paste Stack item". Written by the
 * clipboard feature (stack has items), read by the keyboard feature when it builds keys.configure.
 */
let intercept = false;
const listeners = new Set<() => void>();

export function setPasteStackIntercept(on: boolean): void {
  if (on === intercept) return;
  intercept = on;
  for (const l of listeners) l();
}

export function pasteStackIntercept(): boolean {
  return intercept;
}

export function onPasteStackInterceptChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
