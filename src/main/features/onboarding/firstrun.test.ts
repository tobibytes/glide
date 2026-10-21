import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@shared/types";
import { decideFirstRun, predatesLaunch, settingsCustomised, type FirstRunSignals } from "./firstrun";

const fresh: FirstRunSignals = {
  onboarding: { completed: false, skipped: false, started: false },
  envSkip: false,
  dataPredatesLaunch: false,
  usageCount: 0,
  settingsCustomised: false,
};

describe("first-run detection", () => {
  it("shows on a fresh install", () => {
    expect(decideFirstRun(fresh)).toEqual({ show: true, reason: "first-run" });
  });

  it("never shows again after completion or skip", () => {
    expect(decideFirstRun({ ...fresh, onboarding: { ...fresh.onboarding, completed: true } })).toEqual({ show: false, reason: "completed" });
    expect(decideFirstRun({ ...fresh, onboarding: { ...fresh.onboarding, skipped: true, started: true } })).toEqual({ show: false, reason: "skipped" });
  });

  it("honours GLIDE_SKIP_ONBOARDING even mid-tour", () => {
    expect(decideFirstRun({ ...fresh, envSkip: true })).toEqual({ show: false, reason: "env-skip" });
    expect(decideFirstRun({ ...fresh, envSkip: true, onboarding: { ...fresh.onboarding, started: true } }).show).toBe(false);
  });

  it("resumes an unfinished tour even though data now exists", () => {
    expect(decideFirstRun({ ...fresh, dataPredatesLaunch: true, usageCount: 4, onboarding: { ...fresh.onboarding, started: true } })).toEqual({ show: true, reason: "resume" });
  });

  it("does not force existing installs through it", () => {
    expect(decideFirstRun({ ...fresh, dataPredatesLaunch: true }).reason).toBe("existing-install");
    expect(decideFirstRun({ ...fresh, usageCount: 1 }).reason).toBe("existing-install");
    expect(decideFirstRun({ ...fresh, settingsCustomised: true }).reason).toBe("existing-install");
  });

  it("detects customised settings but ignores per-feature bags", () => {
    expect(settingsCustomised({ ...DEFAULT_SETTINGS })).toBe(false);
    expect(settingsCustomised({ ...DEFAULT_SETTINGS, features: { clipboard: { x: 1 } } })).toBe(false);
    expect(settingsCustomised({ ...DEFAULT_SETTINGS, hotkey: "Command+Space" })).toBe(true);
    expect(settingsCustomised({ ...DEFAULT_SETTINGS, appDirectories: ["/Applications"] })).toBe(true);
  });

  it("compares file times against the launch with slack", () => {
    expect(predatesLaunch([], 10_000)).toBe(false);
    expect(predatesLaunch([9_500, 12_000], 10_000)).toBe(false);
    expect(predatesLaunch([5_000, 12_000], 10_000)).toBe(true);
  });
});
