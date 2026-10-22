import { describe, expect, it } from "vitest";
import { accelToDisplay, modifierOnlyDisplay } from "./keys";

describe("accelToDisplay for native hotkeys", () => {
  it("shows modifier-only and double-tap shortcuts", () => {
    expect(accelToDisplay("Double+Cmd")).toBe("Double ⌘");
    expect(accelToDisplay("Right+Alt")).toBe("Right ⌥");
    expect(accelToDisplay("Hyper")).toBe("Hyper");
    expect(accelToDisplay("Double+Hyper")).toBe("Double Hyper");
    expect(modifierOnlyDisplay("Cmd+K")).toBeNull();
    expect(modifierOnlyDisplay("Cmd+Right")).toBeNull();
  });
  it("expands Hyper combos and keeps existing combos", () => {
    expect(accelToDisplay("Hyper+K")).toBe("⌃⌥⇧⌘K");
    expect(accelToDisplay("Alt+Space")).toBe("⌥ Space");
    expect(accelToDisplay("Cmd+Shift+K")).toBe("⇧⌘K");
  });
});
