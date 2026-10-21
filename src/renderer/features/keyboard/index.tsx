import type { FeatureUI } from "../types";
import { KeyboardSettingsPage } from "./SettingsPage";
import "./style.css";

export const ui: FeatureUI = {
  settingsPage: { title: "Keyboard", icon: "⌨️", component: KeyboardSettingsPage },
};
