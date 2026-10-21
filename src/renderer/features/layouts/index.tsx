import type { ComponentType } from "react";
import type { FeatureUI, ViewProps } from "../types";
import { ConfirmWorkspace } from "./ConfirmWorkspace";
import { LayoutsList } from "./LayoutsList";
import { SaveLayout } from "./SaveLayout";
import { LayoutsSettingsPage } from "./SettingsPage";
import "./style.css";

export const ui: FeatureUI = {
  views: { list: LayoutsList, save: SaveLayout, confirm: ConfirmWorkspace as ComponentType<ViewProps> },
  settingsPage: { title: "Window Layouts", icon: "🗂️", component: LayoutsSettingsPage },
};
