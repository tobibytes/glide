import type { FeatureUI } from "../types";
import { AppearancePage } from "./AppearancePage";
import { SwitchThemeView } from "./SwitchThemeView";
import "./style.css";

export const ui: FeatureUI = {
  views: { switch: SwitchThemeView },
  settingsPage: { title: "Appearance", icon: "🎨", component: AppearancePage },
};
