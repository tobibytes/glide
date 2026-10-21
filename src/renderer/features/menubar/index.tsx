import type { FeatureUI } from "../types";
import { MenuBarSettingsPage } from "./SettingsPage";
import "./style.css";

export const ui: FeatureUI = {
  settingsPage: { title: "Menu Bar", icon: "🧭", component: MenuBarSettingsPage },
};
