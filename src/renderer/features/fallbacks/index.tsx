import type { FeatureUI } from "../types";
import { FallbacksSettings } from "./SettingsPage";
import "./style.css";

export const ui: FeatureUI = {
  settingsPage: { title: "Fallback Commands", icon: "🪂", component: FallbacksSettings },
};
