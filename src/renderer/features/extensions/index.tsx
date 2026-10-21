import { useEffect } from "react";
import type { ComponentType } from "react";
import type { FeatureUI, ViewProps } from "../types";
import { RunView } from "./RunView";
import { StoreView } from "./StoreView";
import { ArgumentsView, InstallUrlView, ManageView, PreferencesView, RaycastImportView } from "./ManageViews";
import { SettingsPage } from "./SettingsPage";
import "./style.css";

/** Frameless HUD window ("#/extensions/hud/<text>") shown by showHUD and copy actions. */
function Hud() {
  const text = decodeURIComponent(location.hash.split("/").slice(3).join("/") || "");
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);
  return (
    <div className="extensions-hud" role="status">
      {text}
    </div>
  );
}

export const ui: FeatureUI = {
  views: {
    run: RunView as ComponentType<ViewProps>,
    store: StoreView,
    manage: ManageView,
    preferences: PreferencesView,
    arguments: ArgumentsView,
    installUrl: InstallUrlView,
    importRaycast: RaycastImportView,
  },
  settingsPage: { title: "Extensions", icon: "🧩", component: SettingsPage },
  windows: { hud: Hud },
};
