import type { FeatureUI } from "../types";
import { SyncPage } from "./SyncPage";
import "./style.css";

export const ui: FeatureUI = {
  settingsPage: { title: "Sync & Backup", icon: "☁️", component: SyncPage },
};
