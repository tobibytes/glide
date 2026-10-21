import type { FeatureUI } from "../types";
import { Hud } from "./Hud";
import { UpdatesPage } from "./UpdatesPage";
import "./style.css";

export const ui: FeatureUI = {
  settingsPage: { title: "Updates & App", icon: "⬆︎", component: UpdatesPage },
  windows: { hud: Hud },
};
