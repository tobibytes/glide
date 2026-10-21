/**
 * Chromium dispatches a synthetic mousemove when content changes under a stationary
 * cursor (new results, scrolling, the window appearing under it). Hover-to-select
 * must ignore those, or the row under the cursor steals the selection from the
 * first result. The first event only records the position.
 */
let lastX = Number.NaN;
let lastY = Number.NaN;

export function pointerReallyMoved(e: { screenX: number; screenY: number }): boolean {
  const first = Number.isNaN(lastX);
  const moved = e.screenX !== lastX || e.screenY !== lastY;
  lastX = e.screenX;
  lastY = e.screenY;
  return moved && !first;
}
