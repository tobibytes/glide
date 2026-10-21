import type { FeatureUI } from "../types";
import { EditView } from "./EditView";
import { HistoryView } from "./HistoryView";
import { ClipboardSettingsPage } from "./SettingsPage";
import { StackView } from "./StackView";
import "./style.css";

export const ui: FeatureUI = {
  views: { history: HistoryView, stack: StackView, edit: EditView },
  settingsPage: { title: "Clipboard History", icon: "📋", component: ClipboardSettingsPage },
};
