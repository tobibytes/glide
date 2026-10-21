import type { Settings } from "@shared/types";
import { glide } from "../../lib/glide";
import type { AppearanceSettings, ThemePreset } from "../../../main/features/appearance/themes";

export interface AppearanceState {
  settings: AppearanceSettings;
  mode: Settings["theme"];
  systemDark: boolean;
  presets: ThemePreset[];
}

const call = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("appearance", method, ...args);

export const appearanceApi = {
  get: () => call<AppearanceState>("get"),
  set: (patch: Partial<AppearanceSettings>) => call<AppearanceSettings>("set", patch),
  setMode: (mode: Settings["theme"]) => call<Settings["theme"]>("setMode", mode),
  applyPreset: (id: string) => call<{ ok: boolean; mode: Settings["theme"] }>("applyPreset", id),
  toggle: () => call<Settings["theme"]>("toggle"),
  reset: () => call<AppearanceSettings>("reset"),
};
