import type { FeatureUI } from "../types";
import { AgentView } from "./AgentView";
import { AgentSettingsPage } from "./SettingsPage";
import "./style.css";

export const ui: FeatureUI = {
  views: { run: AgentView },
  settingsPage: { title: "Agent", icon: "🪄", component: AgentSettingsPage },
};
