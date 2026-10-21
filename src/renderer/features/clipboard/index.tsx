import type { FeatureUI } from "../types";
import { HistoryView } from "./HistoryView";
import { ClipboardSettingsPage } from "./SettingsPage";
import "./style.css";

export const ui: FeatureUI = {
  views: { history: HistoryView },
  settingsPage: { title: "Clipboard History", icon: "📋", component: ClipboardSettingsPage },
};
