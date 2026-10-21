import type { ComponentType } from "react";
import type { FeatureUI, ViewProps } from "../types";
import { ScriptOutput } from "./Output";
import { ScriptArguments } from "./Arguments";
import { ScriptsSettings } from "./SettingsPage";
import "./style.css";

export const ui: FeatureUI = {
  views: {
    output: ScriptOutput as ComponentType<ViewProps>,
    arguments: ScriptArguments as ComponentType<ViewProps>,
  },
  settingsPage: { title: "Script Commands", icon: "📜", component: ScriptsSettings },
};
