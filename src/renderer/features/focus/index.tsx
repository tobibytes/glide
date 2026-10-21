import type { ComponentType } from "react";
import type { FeatureUI, ViewProps } from "../types";
import { FocusStart } from "./Start";
import { FocusBlocklist } from "./Blocklist";
import { FocusStats } from "./Stats";
import { FocusBlocked } from "./Blocked";
import { FocusSettingsPage } from "./SettingsPage";
import "./style.css";

export const ui: FeatureUI = {
  views: {
    start: FocusStart as ComponentType<ViewProps>,
    blocklist: FocusBlocklist,
    stats: FocusStats,
  },
  windows: { blocked: FocusBlocked },
  settingsPage: { title: "Focus", icon: "🎯", component: FocusSettingsPage },
};
