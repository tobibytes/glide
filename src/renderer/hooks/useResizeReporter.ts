import { useEffect, type RefObject } from "react";
import { glide } from "../lib/glide";

export const LAUNCHER_MIN_HEIGHT = 60;
export const LAUNCHER_MAX_HEIGHT = 620;

/** Report the panel's content height to main whenever it changes (ResizeObserver). */
export function useResizeReporter(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let last = -1;
    const report = () => {
      const h = Math.min(LAUNCHER_MAX_HEIGHT, Math.max(LAUNCHER_MIN_HEIGHT, Math.ceil(el.getBoundingClientRect().height)));
      if (h !== last) {
        last = h;
        glide().resize(h);
      }
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
}
