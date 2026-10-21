import type { ComponentType } from "react";
import type { FeatureUI, ViewProps } from "../types";
import { BrowserSettingsPage } from "./SettingsPage";
import { BookmarksView, HistoryView } from "./SearchView";
import "./style.css";

export const ui: FeatureUI = {
  views: {
    bookmarks: BookmarksView as ComponentType<ViewProps>,
    history: HistoryView as ComponentType<ViewProps>,
  },
  settingsPage: { title: "Browser", icon: "🔖", component: BrowserSettingsPage },
};
