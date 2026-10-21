import { useEffect, useRef } from "react";
import type { ExecuteResult } from "@shared/ipc";
import type { ViewProps } from "../types";
import { glide } from "../../lib/glide";

export const FEATURE = "extensions";

/** Call a main-process method of the extensions feature. */
export function ext<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
  return glide().feature<T>(FEATURE, method, ...args);
}

/** Subscribe to an extensions feature event for the component's lifetime. */
export function useExtEvent<P>(event: string, cb: (payload: P) => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(
    () =>
      glide().onFeatureEvent((e) => {
        if (e.feature === FEATURE && e.event === event) ref.current(e.payload as P);
      }),
    [event],
  );
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));

/** Apply an ExecuteResult from runCommand inside a launcher view: replace this view, close, or toast. */
export function applyResult(res: ExecuteResult, v: Pick<ViewProps, "push" | "pop" | "close" | "toast">, replace = true) {
  if (res.error) return v.toast(res.error, "error");
  if (res.view) {
    if (replace) v.pop();
    v.push(res.view);
    return;
  }
  if (res.message) v.toast(res.message);
  if (res.hide) v.close();
}

export const SECURITY_NOTE =
  "Extensions run with your user's privileges in a separate process: they can read your files and use the network. Installing from a URL runs that author's code — only install extensions you trust.";
