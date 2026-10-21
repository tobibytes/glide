import type { GlideApi } from "@shared/ipc";

/** Typed accessor for the preload bridge (or the dev mock installed by main.tsx). */
export function glide(): GlideApi {
  return window.glide;
}
