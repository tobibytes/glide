import type { WindowAction } from "../../native/helper";

export interface WindowCommand {
  action: WindowAction;
  title: string;
  /** Glyph rendered through the "symbol" icon kind. */
  glyph: string;
  keywords: string[];
}

const SNAP = ["snap", "resize", "tile", "window", "move"];

/** One launcher command per WindowAction, in the order Raycast lists them. */
export const WINDOW_COMMANDS: WindowCommand[] = [
  { action: "left-half", title: "Left Half", glyph: "◧", keywords: [...SNAP, "left", "half", "split"] },
  { action: "right-half", title: "Right Half", glyph: "◨", keywords: [...SNAP, "right", "half", "split"] },
  { action: "top-half", title: "Top Half", glyph: "⬒", keywords: [...SNAP, "top", "upper", "half"] },
  { action: "bottom-half", title: "Bottom Half", glyph: "⬓", keywords: [...SNAP, "bottom", "lower", "half"] },
  { action: "top-left", title: "Top Left Quarter", glyph: "◰", keywords: [...SNAP, "quarter", "corner"] },
  { action: "top-right", title: "Top Right Quarter", glyph: "◳", keywords: [...SNAP, "quarter", "corner"] },
  { action: "bottom-left", title: "Bottom Left Quarter", glyph: "◱", keywords: [...SNAP, "quarter", "corner"] },
  { action: "bottom-right", title: "Bottom Right Quarter", glyph: "◲", keywords: [...SNAP, "quarter", "corner"] },
  { action: "left-third", title: "First Third", glyph: "▌", keywords: [...SNAP, "left", "third"] },
  { action: "center-third", title: "Center Third", glyph: "┃", keywords: [...SNAP, "middle", "third"] },
  { action: "right-third", title: "Last Third", glyph: "▐", keywords: [...SNAP, "right", "third"] },
  { action: "left-two-thirds", title: "First Two Thirds", glyph: "◧", keywords: [...SNAP, "left", "two thirds"] },
  { action: "right-two-thirds", title: "Last Two Thirds", glyph: "◨", keywords: [...SNAP, "right", "two thirds"] },
  { action: "maximize", title: "Maximize", glyph: "▣", keywords: [...SNAP, "fill", "zoom", "full"] },
  { action: "almost-maximize", title: "Almost Maximize", glyph: "▢", keywords: [...SNAP, "fill", "large"] },
  { action: "center", title: "Center", glyph: "⊡", keywords: [...SNAP, "middle", "centre"] },
  { action: "reasonable-size", title: "Reasonable Size", glyph: "▭", keywords: [...SNAP, "medium", "default"] },
  { action: "restore", title: "Restore", glyph: "↺", keywords: [...SNAP, "undo", "previous", "original"] },
  { action: "next-display", title: "Next Display", glyph: "⇥", keywords: [...SNAP, "monitor", "screen", "display"] },
  { action: "previous-display", title: "Previous Display", glyph: "⇤", keywords: [...SNAP, "monitor", "screen", "display"] },
  { action: "make-larger", title: "Make Larger", glyph: "⊕", keywords: [...SNAP, "bigger", "grow", "increase"] },
  { action: "make-smaller", title: "Make Smaller", glyph: "⊖", keywords: [...SNAP, "shrink", "decrease"] },
  { action: "toggle-fullscreen", title: "Toggle Fullscreen", glyph: "⤢", keywords: ["window", "fullscreen", "full screen", "zoom"] },
  { action: "minimize", title: "Minimize", glyph: "▁", keywords: ["window", "minimise", "hide", "dock"] },
];

/** Default-off suggested hotkeys (⌃⌥ + arrows / Return), enabled with one toggle. */
export const SUGGESTED_HOTKEYS: Array<{ accelerator: string; display: string; action: WindowAction }> = [
  { accelerator: "Control+Alt+Left", display: "⌃⌥←", action: "left-half" },
  { accelerator: "Control+Alt+Right", display: "⌃⌥→", action: "right-half" },
  { accelerator: "Control+Alt+Up", display: "⌃⌥↑", action: "top-half" },
  { accelerator: "Control+Alt+Down", display: "⌃⌥↓", action: "bottom-half" },
  { accelerator: "Control+Alt+Enter", display: "⌃⌥↩", action: "maximize" },
];

export const itemId = (action: WindowAction) => `windows.${action}`;
