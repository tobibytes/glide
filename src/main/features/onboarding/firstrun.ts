/** First-run detection (pure). The IO that gathers the signals lives in index.ts. */
import { DEFAULT_SETTINGS, type Settings } from "@shared/types";
import type { OnboardingSettings } from "./steps";

export interface FirstRunSignals {
  onboarding: Pick<OnboardingSettings, "completed" | "skipped" | "started">;
  /** GLIDE_SKIP_ONBOARDING=1 (test runners, managed installs). */
  envSkip: boolean;
  /** Some file in the data directory is older than this launch (an existing install). */
  dataPredatesLaunch: boolean;
  /** Number of usage (frecency) records. */
  usageCount: number;
  /** Any global setting differs from the defaults. */
  settingsCustomised: boolean;
}

export type FirstRunReason = "completed" | "skipped" | "env-skip" | "resume" | "existing-install" | "first-run";

export interface FirstRunDecision {
  show: boolean;
  reason: FirstRunReason;
}

export function decideFirstRun(s: FirstRunSignals): FirstRunDecision {
  if (s.onboarding.completed) return { show: false, reason: "completed" };
  if (s.onboarding.skipped) return { show: false, reason: "skipped" };
  if (s.envSkip) return { show: false, reason: "env-skip" };
  // Opened before but not finished (e.g. quit half-way): pick up where the user left off.
  if (s.onboarding.started) return { show: true, reason: "resume" };
  if (s.dataPredatesLaunch || s.usageCount > 0 || s.settingsCustomised) return { show: false, reason: "existing-install" };
  return { show: true, reason: "first-run" };
}

/** True when a global setting (other than the per-feature bags) differs from DEFAULT_SETTINGS. */
export function settingsCustomised(settings: Settings, defaults: Settings = DEFAULT_SETTINGS): boolean {
  for (const key of Object.keys(defaults) as Array<keyof Settings>) {
    if (key === "features") continue;
    if (JSON.stringify(settings[key]) !== JSON.stringify(defaults[key])) return true;
  }
  return false;
}

/** Whether any of `mtimesMs` is older than the launch (with slack for clock/fs rounding). */
export function predatesLaunch(mtimesMs: number[], launchedAtMs: number, slackMs = 2000): boolean {
  return mtimesMs.some((t) => t < launchedAtMs - slackMs);
}
