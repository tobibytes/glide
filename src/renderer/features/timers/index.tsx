import type { ComponentType } from "react";
import type { FeatureUI, ViewProps } from "../types";
import { TimersView } from "./TimersView";
import { TimersSettingsPage } from "./SettingsPage";
import "./style.css";

export const ui: FeatureUI = {
  views: { list: TimersView as ComponentType<ViewProps> },
  settingsPage: { title: "Timers", icon: "⏱️", component: TimersSettingsPage },
};
