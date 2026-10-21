import type { FeatureUI } from "../types";
import { CreateView } from "./CreateView";
import { RemindersView } from "./RemindersView";
import { RemindersSettingsPage } from "./SettingsPage";
import "./style.css";

export const ui: FeatureUI = {
  views: { list: RemindersView, create: CreateView },
  settingsPage: { title: "Reminders", icon: "☑️", component: RemindersSettingsPage },
};
