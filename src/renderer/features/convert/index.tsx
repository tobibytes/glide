import type { FeatureUI } from "../types";
import { ConvertSettingsPage } from "./SettingsPage";
import "./style.css";

export const ui: FeatureUI = {
  settingsPage: { title: "Conversions", icon: "🔁", component: ConvertSettingsPage },
};
