import type { FeatureUI } from "../types";
import { MoveView } from "./MoveView";
import { NewFileView } from "./NewFileView";
import { OpenWithView } from "./OpenWithView";
import { FinderSettingsPage } from "./SettingsPage";
import "./style.css";

export const ui: FeatureUI = {
  views: { newFile: NewFileView, move: MoveView, openWith: OpenWithView },
  settingsPage: { title: "Finder & Wi‑Fi", icon: "🗂️", component: FinderSettingsPage },
};
