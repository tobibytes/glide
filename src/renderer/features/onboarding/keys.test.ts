import { describe, expect, it } from "vitest";
import { tourKey, type TourKeyInput } from "./keys";

const k = (key: string, over: Partial<TourKeyInput> = {}): TourKeyInput => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: "other", ...over });

describe("tour keyboard model", () => {
  it("Enter continues unless a button or text field owns it", () => {
    expect(tourKey(k("Enter"))).toBe("next");
    expect(tourKey(k("Enter", { target: "option" }))).toBe("next");
    expect(tourKey(k("Enter", { target: "button" }))).toBeNull();
    expect(tourKey(k("Enter", { target: "text" }))).toBeNull();
    expect(tourKey(k("Enter", { target: "text", metaKey: true }))).toBe("next");
  });

  it("Esc and ⌘[ go back, ⌘] forward", () => {
    expect(tourKey(k("Escape"))).toBe("back");
    expect(tourKey(k("[", { metaKey: true }))).toBe("back");
    expect(tourKey(k("]", { metaKey: true }))).toBe("next");
    expect(tourKey(k("[", {}))).toBeNull();
  });

  it("j/k and arrows move in lists, but not while typing", () => {
    expect(tourKey(k("j"))).toBe("listNext");
    expect(tourKey(k("k", { target: "option" }))).toBe("listPrev");
    expect(tourKey(k("ArrowDown", { target: "button" }))).toBe("listNext");
    expect(tourKey(k("j", { ctrlKey: true, target: "text" }))).toBeNull();
    expect(tourKey(k("j", { ctrlKey: true }))).toBe("listNext");
    expect(tourKey(k("j", { target: "text" }))).toBeNull();
    expect(tourKey(k("J", { shiftKey: true }))).toBeNull();
  });
});
