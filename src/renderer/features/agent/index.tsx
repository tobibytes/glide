import type { FeatureUI } from "../types";
import { AgentView } from "./AgentView";
import { HistoryView } from "./HistoryView";
import { installLauncherShortcut } from "./launcherShortcut";
import { AgentSettingsPage } from "./SettingsPage";
import "./style.css";

installLauncherShortcut();

export const ui: FeatureUI = {
  views: { run: AgentView, history: HistoryView },
  settingsPage: { title: "Agent", icon: "🪄", component: AgentSettingsPage },
};
