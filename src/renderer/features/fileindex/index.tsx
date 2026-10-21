import type { FeatureUI } from "../types";
import { OpenWithView } from "./OpenWithView";
import { SearchView } from "./SearchView";
import { SettingsPage } from "./SettingsPage";
import { StatusView } from "./StatusView";
import "./style.css";

export const ui: FeatureUI = {
  views: { search: SearchView, status: StatusView, openWith: OpenWithView },
  settingsPage: { title: "File Search", icon: "📂", component: SettingsPage },
};
