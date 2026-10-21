import type { ComponentType } from "react";
import type { FeatureUI, ViewProps } from "../types";
import { AutomationsView } from "./AutomationsView";
import { AutomationsSettingsPage } from "./SettingsPage";
import "./style.css";

export const ui: FeatureUI = {
  views: { list: AutomationsView as ComponentType<ViewProps> },
  settingsPage: { title: "Automations", icon: "⚡️", component: AutomationsSettingsPage },
};
