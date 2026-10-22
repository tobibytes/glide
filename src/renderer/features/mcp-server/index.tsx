import type { ComponentType } from "react";
import type { FeatureUI, ViewProps } from "../types";
import { ConfirmView } from "./ConfirmView";
import { McpServerSettingsPage } from "./SettingsPage";
import "./style.css";

export const ui: FeatureUI = {
  views: { confirm: ConfirmView as ComponentType<ViewProps> },
  settingsPage: { title: "MCP Server", icon: "🔌", component: McpServerSettingsPage },
};
