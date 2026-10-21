import { glide } from "../../lib/glide";
import type { OnboardingState } from "../../../main/features/onboarding";
import type { OnboardingSettings, StepId } from "../../../main/features/onboarding/steps";
import type { PermissionKind, PermissionsSnapshot } from "../../../main/features/onboarding/system";

export type { OnboardingState };

const call = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("onboarding", method, ...args);

export interface HotkeyResult {
  ok: boolean;
  hotkey: string;
  error?: string;
}

export interface AiKeyStatus {
  hasKey: boolean;
  encryptionAvailable: boolean;
}

export interface AiTestResult {
  ok: boolean;
  message: string;
  kind?: string;
}

export const onboardingApi = {
  getState: () => call<OnboardingState>("getState"),
  setStep: (step: StepId) => call<OnboardingSettings>("setStep", step),
  finish: (openLauncher: boolean) => call<OnboardingSettings>("finish", { openLauncher }),
  skip: () => call<OnboardingSettings>("skip"),
  close: () => call<boolean>("close"),
  setHotkey: (accel: string) => call<HotkeyResult>("setHotkey", accel),
  useCommandSpace: () => call<HotkeyResult>("useCommandSpace"),
  permissions: () => call<PermissionsSnapshot>("permissions"),
  openPermissionSettings: (kind: PermissionKind) => call<{ ok: boolean; url: string }>("openPermissionSettings", kind),
};

/** The AI feature's own methods (same ones its Settings page uses). */
export const aiApi = {
  hasApiKey: () => glide().feature<AiKeyStatus>("ai", "hasApiKey"),
  setApiKey: (key: string) => glide().feature<AiKeyStatus>("ai", "setApiKey", key),
  clearApiKey: () => glide().feature<AiKeyStatus>("ai", "clearApiKey"),
  testConnection: () => glide().feature<AiTestResult>("ai", "testConnection"),
  openUrl: (url: string) => glide().feature<boolean>("ai", "openUrl", url),
};
